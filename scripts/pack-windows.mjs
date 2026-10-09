/**
 * 打包「免安裝 Node」的 Windows 版（可以在 macOS 或 Windows 上執行）。
 *
 *   node scripts/pack-windows.mjs                      # 產出 dist/ly-dashboard-windows-x64-<日期>.zip
 *   node scripts/pack-windows.mjs --node-version 24.11.0
 *   node scripts/pack-windows.mjs --no-build           # 沿用現有的 web/dist
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

export function parseArgs(argv) {
  const opts = { nodeVersion: DEFAULT_NODE_VERSION, build: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--node-version') opts.nodeVersion = argv[++i];
    else if (argv[i] === '--no-build') opts.build = false;
    else throw new Error(`不認得的參數：${argv[i]}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(opts.nodeVersion ?? '')) throw new Error('--node-version 要像 24.11.0');
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

  if (opts.build) run('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT });
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('web/dist 不存在；請先建置（不要加 --no-build）');

  const { zipPath, fileName } = await ensureNodeZip(opts.nodeVersion, cacheDir);

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `ly-dashboard-windows-x64-${stamp}`;
  const stage = join(cacheDir, 'stage');
  const pkg = join(stage, 'ly-dashboard');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(pkg, 'runtime'), { recursive: true });

  for (const rel of INCLUDE) {
    cpSync(join(ROOT, rel), join(pkg, rel), { recursive: true, filter: (src) => !/[\\/](\.DS_Store|node_modules)$/.test(src) });
  }

  const inner = fileName.replace(/\.zip$/, '');
  const nodeZip = readFileSync(zipPath);
  for (const f of ['node.exe', 'LICENSE']) writeFileSync(join(pkg, 'runtime', f), readZipEntry(nodeZip, `${inner}/${f}`));
  if (!existsSync(join(pkg, 'runtime', 'node.exe'))) throw new Error('解出 node.exe 失敗');

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || 'unknown';
  writeFileSync(join(pkg, 'PACKAGED'), `ly-dashboard windows package\ncommit=${commit}\nnode=${opts.nodeVersion}\nbuilt=${new Date().toISOString()}\n`);

  const outZip = join(outDir, `${name}.zip`);
  rmSync(outZip, { force: true });
  const files = listFiles(pkg).map((full) => ({ name: 'ly-dashboard/' + relative(pkg, full).split(sep).join('/'), data: readFileSync(full) }));
  writeFileSync(outZip, buildZip(files));
  console.log(`\n完成：${outZip}\n  解壓縮後雙擊 ly-dashboard\\windows\\start.cmd（Node ${opts.nodeVersion} 已內附，commit ${commit}）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`打包失敗：${e.message}`); process.exit(1); });
}
