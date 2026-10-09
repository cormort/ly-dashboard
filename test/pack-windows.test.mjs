import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INCLUDE, NEWS_FILES, buildZip, findChecksum, parseArgs, toCrlf } from '../scripts/pack-windows.mjs';
import { readZipEntry } from '../server/zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('打包：參數解析（Node 版本要像 24.11.0，不認得的參數要報錯）', () => {
  assert.deepEqual(parseArgs([]), { nodeVersion: '24.11.0', build: true, target: 'full' });
  assert.deepEqual(parseArgs(['--node-version', '22.13.1', '--no-build']), { nodeVersion: '22.13.1', build: false, target: 'full' });
  assert.equal(parseArgs(['--target', 'news']).target, 'news');
  assert.throws(() => parseArgs(['--target', 'nope']));
  assert.throws(() => parseArgs(['--node-version', 'latest']));
  assert.throws(() => parseArgs(['--oops']));
});

test('打包：從 SHASUMS256.txt 找雜湊（認檔名全等，不可以用前綴誤抓）', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const text = `${a}  node-v24.11.0-win-x64.zip.sig\r\n${b}  node-v24.11.0-win-x64.zip\r\n`;
  assert.equal(findChecksum(text, 'node-v24.11.0-win-x64.zip'), b);
  assert.equal(findChecksum(text, 'node-v1.0.0-win-x64.zip'), null);
});

test('打包：要放進去的東西都存在（web/dist 是建置產物，除外），且不含 data／.cache', () => {
  for (const rel of INCLUDE.filter((p) => p !== 'web/dist')) assert.ok(existsSync(join(ROOT, rel)), `${rel} 不見了`);
  assert.ok(!INCLUDE.some((p) => /^(data|\.cache)/.test(p)));
});

test('打包：會用 node 的 .ps1 都要優先採用內附的 runtime\node.exe；start.ps1 在打包版不 pull／ci／build', () => {
  for (const name of ['start.ps1', 'fb-daily.ps1', 'server-supervisor.ps1']) {
    assert.match(read(`windows/${name}`), /runtime\\node\.exe/, `${name} 沒有偵測內附 node`);
  }
  const start = read('windows/start.ps1');
  assert.match(start, /\$NoPull\) -and \(-not \$Packaged\)/);
  assert.match(start, /\$needsInstall -and \(-not \$Packaged\)/);
  assert.match(start, /\$NoBuild\) -and \(-not \$Packaged\)/);
});

test('打包：install.cmd 只能是純 ASCII；release workflow 在推 v* 標籤時建立 Release', () => {
  assert.ok(!/[^\x00-\x7f]/.test(read('windows/install.cmd')), 'install.cmd 有非 ASCII 字元');
  const wf = read('.github/workflows/release-windows.yml');
  assert.match(wf, /tags: \['v\*'\]/);
  assert.match(wf, /gh release create/);
});

/* ------------------------------------------------------------------ 只含新聞收集的包（--target news） */

/** 一支 .mjs 的相對 import（只看 `from './x.mjs'` 與 `from '../x/y.mjs'`），解析成專案內的路徑。 */
function relativeImports(rel) {
  const text = read(rel);
  const found = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    found.push(join(dirname(rel), m[1]).split(String.fromCharCode(92)).join('/'));
  }
  return found;
}

/** 從進入點開始，遞迴找出會被載入的所有相對路徑檔案。 */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    queue.push(...relativeImports(rel));
  }
  return [...seen].sort();
}

test('新聞收集包：收集腳本會載入的每個檔案（含遞迴）都必須在包內 —— 少一個，別人那邊就跑不起來', () => {
  const closure = importClosure('scripts/collect-news-rss.mjs');
  assert.ok(closure.length >= 5, `應至少載入 5 個檔，實際：${closure.join('、')}`);
  const missing = closure.filter((rel) => !(rel in NEWS_FILES));
  assert.deepEqual(missing, [], `NEWS_FILES 少了：${missing.join('、')}（scripts/pack-windows.mjs）`);
});

test('新聞收集包：沒有偷帶不該有的東西（資料庫、前端、其他腳本、憑證）', () => {
  const sources = Object.keys(NEWS_FILES).filter((k) => k.endsWith('.mjs'));
  assert.ok(sources.every((p) => /^(server|scripts)\//.test(p)));
  assert.ok(!sources.some((p) => /db|ingest|index|push|fb-|notify/.test(p)), `不該包含：${sources.join('、')}`);
  assert.ok(!('web/dist' in NEWS_FILES) && !('data' in NEWS_FILES));
});

test('新聞收集包：cmd 純 ASCII、ps1 有 BOM、收集腳本有 Handle 修正與重試；README 在', () => {
  const dir = join(ROOT, 'news-collector');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.cmd'))) {
    assert.ok(!/[^\x00-\x7f]/.test(readFileSync(join(dir, name), 'utf8')), `${name} 有非 ASCII 字元`);
  }
  for (const name of readdirSync(join(dir, 'tools')).filter((f) => f.endsWith('.ps1'))) {
    const head = readFileSync(join(dir, 'tools', name)).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], `${name} 不是 UTF-8 with BOM（PowerShell 5.1 會把中文讀成亂碼）`);
  }
  const collect = read('news-collector/tools/collect.ps1');
  assert.match(collect, /\$null = \$process\.Handle/, '少了 ExitCode 修正');
  assert.match(collect, /\$Retries/, '少了重試');
  assert.ok(existsSync(join(dir, 'README.txt')) && existsSync(join(dir, 'install.cmd')));
});

test('新聞收集包：排程要每小時、錯過補跑、只在使用者登入時跑（不需要系統管理員）；release 同時掛兩個 zip', () => {
  const install = read('news-collector/tools/install.ps1');
  assert.match(install, /-RepetitionInterval \(New-TimeSpan -Hours 1\)/);
  assert.match(install, /-StartWhenAvailable/);
  assert.match(install, /-LogonType Interactive -RunLevel Limited/);
  assert.match(install, /schtasks\.exe \/Create .* \/SC HOURLY/, '少了 schtasks 後備');
  const wf = read('.github/workflows/release-windows.yml');
  assert.match(wf, /pack-windows\.mjs --target news/);
  assert.match(wf, /ly-news-collector-windows-x64-\*\.zip/);
});

test('zip 寫入器：讀回來的內容一模一樣（含中文檔名與中文內容、空檔）', () => {
  const files = [
    { name: 'a/中文.txt', data: Buffer.from('立委觀測站'.repeat(100)) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'bin.dat', data: Buffer.from([0, 1, 2, 255, 254]) },
  ];
  const zip = buildZip(files);
  for (const f of files) assert.deepEqual(readZipEntry(zip, f.name), f.data, f.name);
});

test('打包：toCrlf 只補單獨的 LF（CRLF 不重複、BOM 與 UTF-8 中文不動）', () => {
  assert.equal(toCrlf(Buffer.from('a\nb\r\nc\n')).toString(), 'a\r\nb\r\nc\r\n');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文\n')]);
  const out = toCrlf(withBom);
  assert.deepEqual([...out.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(out.subarray(3).toString(), '中文\r\n');
});

test('打包：.gitattributes 把 .cmd／.ps1 鎖成 CRLF', () => {
  const attrs = read('.gitattributes');
  assert.match(attrs, /\*\.cmd text eol=crlf/);
  assert.match(attrs, /\*\.ps1 text eol=crlf/);
});
