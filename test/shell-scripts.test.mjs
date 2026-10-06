import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('每日抓取腳本：搶不到鎖就跳過（不可以失敗，也不可以刪掉別人的鎖）', async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const lock = join(repo, '.cache', 'fb-daily.lock');
  mkdirSync(lock, { recursive: true });
  try {
    const result = spawnSync('bash', [join(repo, 'scripts/fb-daily.sh'), '--ids', '1'], {
      cwd: repo,
      env: { ...process.env, LY_NOTIFY: '0' }, // 測試不送 Telegram
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, '搶不到鎖要乾淨跳過（exit 0），不是失敗');
    assert.ok(existsSync(lock), '別人的鎖不可以被這次跳過刪掉');
    const log = readFileSync(join(repo, '.cache', 'fb-daily.log'), 'utf8');
    assert.match(log, /已有另一輪抓取在跑/);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});
