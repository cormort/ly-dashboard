import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');

/**
 * 這一組測試有不少需要 bash（`bash -n`、跑 shell 腳本）或 macOS 的 plutil。
 * Windows 上沒有這兩個東西，硬要跑會變成「紅燈但不是真的壞掉」——所以沒有工具時**跳過那幾條**，
 * 純 JS 的檢查（全形字元、薄殼、plist 內容）照跑。這是「搬得動」的一部分：
 * `npm test` 在 Windows 上要能全綠（見 test/windows-port.test.mjs）。
 */
function hasCommand(command) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const HAS_BASH = hasCommand('bash');
const HAS_PLUTIL = hasCommand('plutil');
const NO_BASH = HAS_BASH ? false : '這台機器沒有 bash（Windows 沒裝 Git Bash）';
const NO_PLUTIL = HAS_PLUTIL ? false : '這台機器沒有 plutil（macOS 才有）';
/**
 * 遞迴收集 scripts/ 下所有 .sh（含 scripts/launchd/）：
 * 之前只掃最上層，結果子目錄的 install.sh 逃過「$VAR 接全形字」那條檢查。
 */
function collectShellScripts(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? collectShellScripts(join(dir, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.sh')
        ? [`${prefix}${entry.name}`]
        : [],
  );
}

const shellScripts = collectShellScripts(SCRIPTS);

test('shell：scripts/ 下的 .sh 都要通過 bash -n（語法檢查）', { skip: NO_BASH }, () => {
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

test('每日抓取腳本：搶不到鎖就跳過（不可以失敗，也不可以刪掉別人的鎖）', { skip: NO_BASH }, async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  // 鎖放免洗目錄（LY_FB_LOG_DIR）：原本用正式的 .cache/fb-daily.lock，測試的 finally 會把它刪掉，
  // 於是「每日排程跑到一半」時跑一次測試，就把那一輪的鎖偷走了（2026-10-07 實際發生）。
  const dir = mkdtempSync(join(tmpdir(), 'ly-fb-lock-'));
  const lock = join(dir, 'fb-daily.lock');
  // 正式路徑的鎖「現在存不存在」不重要（排程跑到一半時它真的存在）；重點是測試不可以動它。
  const prodLock = join(repo, '.cache', 'fb-daily.lock');
  const prodBefore = existsSync(prodLock);
  mkdirSync(lock, { recursive: true });
  try {
    const result = spawnSync('bash', [join(repo, 'scripts/fb-daily.sh'), '--ids', '1'], {
      cwd: repo,
      env: { ...process.env, LY_NOTIFY: '0', LY_FB_LOG_DIR: dir }, // 測試不送 Telegram、不碰正式目錄
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, '搶不到鎖要乾淨跳過（exit 0），不是失敗');
    assert.ok(existsSync(lock), '別人的鎖不可以被這次跳過刪掉');
    const log = readFileSync(join(dir, 'fb-daily.log'), 'utf8');
    assert.match(log, /已有另一輪抓取在跑/);
    assert.equal(existsSync(prodLock), prodBefore, '測試不可以動到正式路徑的鎖（那可能是正在跑的那一輪的）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launchd：plist 樣板要合法、要有 RunAtLoad 與 KeepAlive，且不可寫死絕對路徑', () => {
  const dir = join(SCRIPTS, 'launchd');
  const plists = readdirSync(dir).filter((f) => f.endsWith('.plist'));
  assert.ok(plists.length >= 2, 'API 伺服器與每日抓取都要有樣板');
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  for (const name of plists) {
    const raw = readFileSync(join(dir, name), 'utf8');
    assert.ok(raw.includes('__REPO_ROOT__'), `${name} 要用 __REPO_ROOT__ 佔位（由 install.sh 換成實際路徑）`);
    assert.ok(!/\/Users\/[a-z]+\/ly-dashboard/.test(raw), `${name} 不可以寫死某台機器的絕對路徑`);
    assert.ok(raw.includes('<key>RunAtLoad</key>'), `${name} 少了 RunAtLoad`);
    if (!HAS_PLUTIL) continue; // Windows 沒有 plutil：內容檢查照跑，語法驗證跳過
    const tmp = join(ROOT, '.cache', `test-${name}`);
    writeFileSync(tmp, raw.replaceAll('__REPO_ROOT__', ROOT));
    try {
      execFileSync('plutil', ['-lint', tmp], { stdio: 'pipe' });
    } catch (error) {
      assert.fail(`${name} 產生的 plist 不合法：${String(error.stderr || error.message).slice(0, 200)}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
});

test('API 伺服器包裝腳本：連接埠已被占用時要 exit 0（否則 launchd 會 crash-loop）', { skip: NO_BASH }, async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = spawnSync('bash', [join(ROOT, 'scripts/ly-dashboard-server.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, LY_PORT: String(port) },
    });
    assert.equal(result.status, 0, `應該 exit 0（實際 ${result.status}）：${result.stderr}`);
    assert.match(result.stdout, /已經有伺服器在跑/, '要說清楚為什麼沒啟動');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('shell：啟動腳本要把埠號 export 給 node（不然 LY_PORT 只管到檢查，node 還是聽 8787）', () => {
  const script = readFileSync(join(SCRIPTS, 'ly-dashboard-server.sh'), 'utf8');
  // server 讀的是 PORT（見 server/config.mjs）；只設 LY_PORT 會讓「檢查的埠」與「監聽的埠」不一致，
  // 2026-10-07 真的發生過：LY_PORT=8788 啟動，結果佔用 8787，接著判定「已經有伺服器在跑」而混淆
  assert.match(script, /export PORT/, 'ly-dashboard-server.sh 要把 PORT export 出去');
  assert.match(script, /PORT="\$\{LY_PORT:-8787\}"/, 'PORT 預設值仍要可由 LY_PORT 覆寫');
});
