import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const shellScripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'));

test('shell：scripts/ 下的 .sh 都要通過 bash -n（語法檢查）', () => {
  assert.ok(shellScripts.length >= 2, '至少要有排程用的 shell 腳本');
  for (const name of shellScripts) {
    try {
      execFileSync('bash', ['-n', join(SCRIPTS, name)], { stdio: 'pipe' });
    } catch (error) {
      assert.fail(`${name} 語法錯誤：${String(error.stderr || error.message).slice(0, 300)}`);
    }
  }
});

test('shell：$VAR 後面直接接全形字元要寫成 ${VAR}（否則 bash 會把全形字當變數名，set -u 直接爆掉）', () => {
  const offenders = [];
  for (const name of shellScripts) {
    const lines = readFileSync(join(SCRIPTS, name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // $PORT）這種寫法：bash 會去找變數 "PORT）" → unbound variable
      const re = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/g;
      for (const m of line.matchAll(re)) offenders.push(`${name}:${i + 1} ${m[0]} ← ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(offenders, [], `要改成 \${VAR} 的寫法：\n${offenders.join('\n')}`);
});
