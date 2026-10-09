/**
 * 打包「免安裝 Node」的 Windows 版（可以在 macOS 或 Windows 上執行）。
 *
 *   node scripts/pack-windows.mjs                      # 產出 dist/ly-dashboard-windows-x64-<日期>.zip
 *   node scripts/pack-windows.mjs --node-version 24.11.0
 *   node scripts/pack-windows.mjs --no-build           # 沿用現有的 web/dist
 *   node scripts/pack-windows.mjs --target news        # 只打包「新聞收集端」（給別人單獨部署，見 news-collector/）
 *
 * 做的事：建置前端 → 從 nodejs.org 下載官方 Windows 版 node.exe（用 SHASUMS256.txt 驗 SHA-256）
 * → 把 server/、scripts/、windows/、web/dist 與 node.exe（放在 runtime/）整理成一個資料夾 → 壓成 zip。
 *
 * 對方解壓縮後雙擊 windows\start.cmd 即可，不必安裝 Node、Git、npm。
 * windows\*.ps1 會偵測 runtime\node.exe 並優先使用；根目錄的 PACKAGED 檔案告訴 start.ps1
 * 「這是打包版」，因此不會去 git pull、npm ci 或重新建置。
 *
 * 讀寫 zip 都只用 Node 內建的 zlib（讀的部分重用 server/zip.mjs），不依賴系統的 tar／zip／unzip
 * （Git Bash、Linux CI 的 GNU tar 不會處理 zip），所以 macOS、Windows、Linux 產出一樣的檔案。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { readZipEntry } from '../server/zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_NODE_VERSION = '24.11.0';

/** 放進打包版的東西（相對於專案根目錄）。刻意不含 data/（新機器第一次啟動會自己同步）、.cache/、web 原始碼。 */
export const INCLUDE = ['server', 'scripts', 'windows', 'web/dist', 'package.json', 'README.md'];

/**
 * 新聞收集端（--target news）：scripts/collect-news-rss.mjs 與它 import 的 4 支 server 檔。
 * 對應表 { 專案內路徑: 包內路徑 }；news-collector/ 底下的 cmd／ps1／README 放在包的根目錄。
 * 這份清單由 test/pack-windows.test.mjs 驗證：收集腳本 import 的每一個相對路徑都必須在裡面。
 */
export const NEWS_FILES = {
  'scripts/collect-news-rss.mjs': 'scripts/collect-news-rss.mjs',
  'server/config.mjs': 'server/config.mjs',
  'server/fetch-ly.mjs': 'server/fetch-ly.mjs',
  'server/normalize.mjs': 'server/normalize.mjs',
  'server/news-feed.mjs': 'server/news-feed.mjs',
  'news-collector': '.',
};

export function parseArgs(argv) {
  const opts = { nodeVersion: DEFAULT_NODE_VERSION, build: true, target: 'full' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--node-version') opts.nodeVersion = argv[++i];
    else if (argv[i] === '--no-build') opts.build = false;
    else if (argv[i] === '--target') opts.target = argv[++i];
    else throw new Error(`不認得的參數：${argv[i]}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(opts.nodeVersion ?? '')) throw new Error('--node-version 要像 24.11.0');
  if (!['full', 'news'].includes(opts.target)) throw new Error('--target 只能是 full 或 news');
  return opts;
}

/** 從 SHASUMS256.txt 找某個檔名的雜湊；找不到回 null。 */
export function findChecksum(shasums, fileName) {
  for (const line of shasums.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  return null;
}

/** 把資料夾裡的所有檔案寫成 zip（deflate、UTF-8 檔名、不支援 ZIP64；單檔與總量都遠小於 4GB）。 */
export function buildZip(files) {
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 固定時間戳，讓同一份內容每次打出一樣的 zip
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 把單獨的 LF 換成 CRLF（已經是 CRLF 的不動；逐位元組處理，BOM 與其他編碼不受影響）。 */
export function toCrlf(buf) {
  const out = [];
  let prev = -1;
  for (const byte of buf) {
    if (byte === 0x0a && prev !== 0x0d) out.push(0x0d);
    out.push(byte);
    prev = byte;
  }
  return Buffer.from(out);
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm', ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗（exit ${r.status}）`);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureNodeZip(version, cacheDir) {
  const base = `https://nodejs.org/dist/v${version}`;
  const fileName = `node-v${version}-win-x64.zip`;
  const zipPath = join(cacheDir, fileName);
  const shasums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = findChecksum(shasums, fileName);
  if (!expected) throw new Error(`SHASUMS256.txt 裡找不到 ${fileName}（版本是否存在？）`);

  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  if (existsSync(zipPath) && sha(readFileSync(zipPath)) === expected) {
    console.log(`沿用快取：${zipPath}`);
    return { zipPath, fileName };
  }
  console.log(`下載 ${base}/${fileName}`);
  const data = await download(`${base}/${fileName}`);
  if (sha(data) !== expected) throw new Error(`SHA-256 不符，已中止（預期 ${expected}）`);
  writeFileSync(zipPath, data);
  return { zipPath, fileName };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cacheDir = join(ROOT, '.cache', 'pack');
  const outDir = join(ROOT, 'dist');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const news = opts.target === 'news';
  if (!news) {
    if (opts.build) run('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT });
    if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('web/dist 不存在；請先建置（不要加 --no-build）');
  }

  const { zipPath, fileName } = await ensureNodeZip(opts.nodeVersion, cacheDir);

  const stamp = new Date().toISOString().slice(0, 10);
  const folder = news ? 'ly-news-collector' : 'ly-dashboard';
  const name = `${news ? 'ly-news-collector' : 'ly-dashboard'}-windows-x64-${stamp}`;
  const stage = join(cacheDir, news ? 'stage-news' : 'stage');
  const pkg = join(stage, folder);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(pkg, 'runtime'), { recursive: true });

  const skip = (src) => !/[\\/](\.DS_Store|node_modules)$/.test(src);
  if (news) {
    for (const [from, to] of Object.entries(NEWS_FILES)) cpSync(join(ROOT, from), join(pkg, to), { recursive: true, filter: skip });
    // 專案根目錄的 package.json 有很多別的東西；收集端只需要「.mjs 當 ES module」這一件事
    writeFileSync(join(pkg, 'package.json'), '{\n  "name": "ly-news-collector",\n  "private": true,\n  "type": "module"\n}\n');
  } else {
    for (const rel of INCLUDE) cpSync(join(ROOT, rel), join(pkg, rel), { recursive: true, filter: skip });
  }

  // .cmd／.ps1／.txt 一律 CRLF（在 Linux 上打包時 checkout 可能是 LF；cmd.exe 對純 LF 的批次檔不保證正常）
  for (const full of listFiles(pkg).filter((p) => /\.(cmd|ps1|txt)$/i.test(p))) writeFileSync(full, toCrlf(readFileSync(full)));

  const inner = fileName.replace(/\.zip$/, '');
  const nodeZip = readFileSync(zipPath);
  for (const f of ['node.exe', 'LICENSE']) writeFileSync(join(pkg, 'runtime', f), readZipEntry(nodeZip, `${inner}/${f}`));
  if (!existsSync(join(pkg, 'runtime', 'node.exe'))) throw new Error('解出 node.exe 失敗');

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || 'unknown';
  writeFileSync(join(pkg, 'PACKAGED'), `${news ? 'ly-news-collector' : 'ly-dashboard'} windows package\ncommit=${commit}\nnode=${opts.nodeVersion}\nbuilt=${new Date().toISOString()}\n`);

  const outZip = join(outDir, `${name}.zip`);
  rmSync(outZip, { force: true });
  const files = listFiles(pkg).map((full) => ({ name: `${folder}/` + relative(pkg, full).split(sep).join('/'), data: readFileSync(full) }));
  writeFileSync(outZip, buildZip(files));
  const entry = news ? `${folder}\\install.cmd` : `${folder}\\windows\\start.cmd`;
  console.log(`\n完成：${outZip}\n  解壓縮後雙擊 ${entry}（Node ${opts.nodeVersion} 已內附，commit ${commit}）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`打包失敗：${e.message}`); process.exit(1); });
}
