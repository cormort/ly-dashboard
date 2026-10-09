import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INCLUDE, findChecksum, parseArgs } from '../scripts/pack-windows.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('打包：參數解析（Node 版本要像 24.11.0，不認得的參數要報錯）', () => {
  assert.deepEqual(parseArgs([]), { nodeVersion: '24.11.0', build: true });
  assert.deepEqual(parseArgs(['--node-version', '22.13.1', '--no-build']), { nodeVersion: '22.13.1', build: false });
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
