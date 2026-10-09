import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acquireLock, dataRows, dateStamp, stampLocal, writeLineFrom, dataLineFrom } from '../scripts/fb-daily.mjs';
import { parseEnvFile, redact } from '../scripts/notify-telegram.mjs';
import { chromeCandidates, findChromePath } from '../scripts/find-chrome.mjs';

/**
 * 「Windows 上也要跑得動」的守門測試。
 *
 * 為什麼要有這一組：這個專案本來是 macOS only（launchd、bash、curl、sed、awk）。
 * 搬到 Windows 之後，最容易復發的不是功能，而是**平台假設**：
 * 又有人在腳本裡寫死 `/Users/xxx` 的 Chrome 路徑、又把邏輯寫回 .sh、又讓排程參數漏掉「錯過補跑」。
 * 這些都不需要 Windows 才能驗 —— 用純函式、檔案內容與行程呼叫就能守住。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = join(ROOT, 'windows');

/** 檔案內容（找不到就回空字串，讓下面每一條斷言自己給出好讀的訊息）。 */
function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/* ------------------------------------------------------------------ Windows 部署檔 */

test('Windows：部署需要的檔案都在（雙擊用的 .cmd、腳本、說明）', () => {
  for (const name of ['start.cmd', 'start-lan.cmd', 'start.ps1', 'server-supervisor.ps1', 'fb-daily.ps1', 'install-tasks.ps1', 'lint.ps1', 'PSScriptAnalyzerSettings.psd1', 'README-zh-TW.md']) {
    assert.ok(existsSync(join(WINDOWS, name)), `windows/${name} 不見了`);
  }
});

test('Windows：腳本不可以寫死某台機器的路徑，一律用 $PSScriptRoot 自己找', () => {
  const offenders = [];
  for (const name of readdirSync(WINDOWS).filter((f) => f.endsWith('.ps1'))) {
    const text = read(join(WINDOWS, name));
    if (/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i.test(text)) offenders.push(`${name}：寫死了 C:\\Users\\<某個使用者>`);
    if (/\/Users\/[a-z]+/i.test(text)) offenders.push(`${name}：寫死了 macOS 的使用者路徑`);
    if (!text.includes('$PSScriptRoot')) offenders.push(`${name}：沒有用 $PSScriptRoot 定位專案根目錄`);
  }
  assert.deepEqual(offenders, [], `這些要修：\n${offenders.join('\n')}`);
});

test('Windows：.ps1 一定要是 UTF-8 with BOM（PowerShell 5.1 沒有 BOM 會用 ANSI 字碼頁讀，中文變亂碼）', () => {
  const offenders = [];
  for (const name of readdirSync(WINDOWS).filter((f) => f.endsWith('.ps1'))) {
    const raw = readFileSync(join(WINDOWS, name));
    const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    if (!hasBom) offenders.push(`${name}：少了 UTF-8 BOM`);
  }
  assert.deepEqual(offenders, [], `這些檔案要存成 UTF-8 with BOM：\n${offenders.join('\n')}`);
});

test('Windows：.cmd 只能是純 ASCII（cmd.exe 用系統字碼頁讀，Big5 機器上中文會變亂碼）', () => {
  const offenders = [];
  for (const name of readdirSync(WINDOWS).filter((f) => f.endsWith('.cmd'))) {
    const raw = readFileSync(join(WINDOWS, name));
    const nonAscii = [...raw].filter((byte) => byte > 126).length;
    if (nonAscii) offenders.push(`${name}：有 ${nonAscii} 個非 ASCII 位元組（訊息請留在 .ps1 裡）`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('Windows：每日抓取只有一份實作（.ps1 必須呼叫 scripts/fb-daily.mjs）', () => {
  const text = read(join(WINDOWS, 'fb-daily.ps1'));
  assert.match(text, /fb-daily\.mjs/, 'windows/fb-daily.ps1 要呼叫 scripts/fb-daily.mjs，不要在 PowerShell 裡重寫一份');
  assert.match(text, /exit \$code|\$LASTEXITCODE/, '要把 fb-daily.mjs 的離開碼帶出去（工作排程器看的是它）');
});

test('Windows：排程要勾「錯過開始時間後盡快執行」，且只在使用者登入時執行', () => {
  const text = read(join(WINDOWS, 'install-tasks.ps1'));
  assert.match(text, /-StartWhenAvailable/, '少了 -StartWhenAvailable：關機／睡眠錯過之後不會補跑');
  assert.match(text, /-LogonType Interactive/, '抓粉專要讀已登入的 Chrome，工作必須在使用者工作階段裡跑；伺服器也一樣（比照 LaunchAgent）');
  assert.match(text, /schtasks/, '註冊失敗時要給 schtasks 的替代指令（受管電腦上 Register-ScheduledTask 會被拒）');
});

test('shell：scripts/fb-daily.sh 只能是薄殼（邏輯在 fb-daily.mjs，兩平台共用）', () => {
  const text = read(join(ROOT, 'scripts', 'fb-daily.sh'));
  assert.match(text, /exec node .*fb-daily\.mjs/, 'fb-daily.sh 要是 exec node scripts/fb-daily.mjs 的薄殼');
  const lines = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.ok(lines.length <= 12, `薄殼不該長回來（現在有 ${lines.length} 行非註解內容）：${lines.join(' / ')}`);
  assert.match(text, /export PATH=/, 'launchd 只給 /usr/bin:/bin，PATH 還是要在這支補（否則 exec 出去找不到 node）');
});

/* ------------------------------------------------------------------ 通知（Node 版） */

test('通知：--dry-run 只印不送，且印得出訊息（Windows 沒有 curl 也能預演）', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/notify-telegram.mjs'), '--dry-run', '測試訊息\n第二行'], {
    encoding: 'utf8',
    env: { ...process.env, LY_NOTIFY_ENV: join(tmpdir(), 'ly-notify-does-not-exist.env') },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /（預演）/);
  assert.match(result.stdout, /測試訊息/);
  assert.match(result.stdout, /第二行/);
});

test('通知：沒有憑證時只印不送，而且不可以讓排程失敗（exit 0）', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/notify-telegram.mjs'), '沒有憑證的情況'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LY_NOTIFY_ENV: join(tmpdir(), 'ly-notify-does-not-exist.env'),
      LY_TELEGRAM_BOT_TOKEN: '',
      LY_TELEGRAM_CHAT_ID: '',
    },
  });
  assert.equal(result.status, 0, '通知送不出去不該讓每日排程失敗');
  assert.match(result.stdout, /沒有憑證/);
});

test('通知：憑證檔解析與 token 遮蔽（.sh 版的 source 語意，但不執行檔內任何一行）', () => {
  const parsed = parseEnvFile(
    [
      '# 註解',
      '',
      'LY_TELEGRAM_BOT_TOKEN=123456:AAbbcc',
      'export LY_TELEGRAM_CHAT_ID=8853861608',
      'LY_SOMETHING="有 空白 與 # 井號"',
      'LY_PLAIN=值 # 行尾註解不算值',
    ].join('\n'),
  );
  assert.equal(parsed.LY_TELEGRAM_BOT_TOKEN, '123456:AAbbcc');
  assert.equal(parsed.LY_TELEGRAM_CHAT_ID, '8853861608');
  assert.equal(parsed.LY_SOMETHING, '有 空白 與 # 井號');
  assert.equal(parsed.LY_PLAIN, '值');
  assert.match(redact('https://api.telegram.org/bot123456:AAbbcc/sendMessage 失敗'), /bot<略>/);
  assert.ok(!redact('https://api.telegram.org/bot123456:AAbbcc/sendMessage').includes('AAbbcc'));
});

/* ------------------------------------------------------------------ Chrome 路徑 */

test('Chrome：不再寫死 macOS 的 Chromium 路徑，Windows 也找得到（找不到要回 null 讓呼叫端報錯）', () => {
  const mac = chromeCandidates('darwin', {}, '/Users/someone');
  assert.ok(mac.some((p) => p.endsWith('Google Chrome')), 'macOS 要找到 /Applications 的 Chrome');
  const win = chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }, 'C:\\Users\\someone');
  assert.ok(win.some((p) => p.endsWith('chrome.exe')), 'Windows 要找到 chrome.exe');
  assert.ok(findChromePath({ platform: 'win32', env: { CHROME_PATH: 'D:\\chrome.exe' }, home: '.' }) === 'D:\\chrome.exe', 'CHROME_PATH 永遠優先');
  // env 要明確指到不存在的地方：env 留空時會退回 C:\Program Files，裝了 Chrome 的機器（含 CI 的 windows-latest）就找得到
  const nowhere = join(tmpdir(), 'ly-no-such-home');
  const emptyEnv = { PROGRAMFILES: nowhere, 'PROGRAMFILES(X86)': nowhere, LOCALAPPDATA: nowhere };
  assert.equal(findChromePath({ platform: 'win32', env: emptyEnv, home: nowhere }), null);
});

test('Chrome：scripts/ 底下不可以再出現寫死的 /Users/<名字> 路徑', () => {
  const offenders = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /\/Users\/[a-z]+/.test(read(join(ROOT, 'scripts', f))));
  assert.deepEqual(offenders, [], `改用 scripts/find-chrome.mjs（CHROME_PATH 可覆寫）：${offenders.join('、')}`);
});

/* ------------------------------------------------------------------ 抓取鎖與日期 */

test('fb-daily：抓取鎖三態（新品／接手殘留／搶不到）都不需要 shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ly-lock-unit-'));
  const lock = join(dir, 'fb-daily.lock');
  try {
    assert.equal(acquireLock(lock), 'new', '第一次應該拿到鎖');
    assert.ok(existsSync(lock));
    assert.equal(acquireLock(lock), null, '鎖還在（而且很新）→ 搶不到，呼叫端要跳過而不是失敗');
    rmSync(lock, { recursive: true, force: true });

    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 小時前（預設 90 分鐘算殘留）
    utimesSync(lock, old, old);
    assert.equal(acquireLock(lock), 'stale', '超過 staleMin 的鎖視為上次被中斷 → 接手');
    assert.ok(existsSync(lock), '接手後鎖要重新建立，不能留空窗');
    assert.equal(acquireLock(lock, { enabled: false }), 'off', 'LY_FB_LOCK=0 時不用鎖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fb-daily：log 時間戳與日期格式跟原本的 `date` 一致（含時區位移）', () => {
  assert.equal(dateStamp(new Date(2026, 9, 6, 8, 0, 0)), '2026-10-06');
  assert.match(stampLocal(new Date(2026, 9, 6, 8, 0, 0)), /^2026-10-06T08:00:00[+-]\d{4}$/);
});

test('fb-daily：CSV 列數與兩段輸出解析（等於原本的 wc -l 與 sed）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ly-csv-unit-'));
  try {
    const path = join(dir, 'posts-2026-10-06.csv');
    writeFileSync(path, 'id,date\na,2026-10-06\nb,\n');
    assert.equal(dataRows(path), 2, '要扣掉表頭');
    assert.equal(dataRows(join(dir, '不存在.csv')), null);
    assert.equal(
      writeLineFrom('[寫回] 工作表「整理表」：更新 3、未變 5、留空跳過 2\n'),
      '更新 3、未變 5、留空跳過 2',
    );
    assert.equal(dataLineFrom('[fb-data] 已推上 fb-data：posts/2026-10-06.csv、posts/latest.csv（113 列有日期）\n'), 'posts/2026-10-06.csv、posts/latest.csv（113 列有日期）');
    assert.equal(writeLineFrom('沒有這一行'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fb-daily：直接呼叫 node（Windows 工作排程器走的路）搶不到鎖要 exit 0，且不動正式路徑的鎖', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'ly-fb-lock-win-'));
  const lock = join(dir, 'fb-daily.lock');
  const prodLock = join(repo, '.cache', 'fb-daily.lock');
  const prodBefore = existsSync(prodLock);
  mkdirSync(lock, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [join(repo, 'scripts/fb-daily.mjs'), '--ids', '1'], {
      cwd: repo,
      env: { ...process.env, LY_NOTIFY: '0', LY_FB_LOG_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `搶不到鎖要乾淨跳過（exit 0）：${result.stderr}`);
    assert.ok(existsSync(lock), '別人的鎖不可以被這次跳過刪掉');
    assert.match(readFileSync(join(dir, 'fb-daily.log'), 'utf8'), /已有另一輪抓取在跑/);
    assert.equal(existsSync(prodLock), prodBefore, '測試不可以動到正式路徑的鎖');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ Node 版本與相依 */

test('套件：runtime 零依賴（Windows 上不必編原生模組），且 Node 版本門檻寫著 ≥22.5', () => {
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  assert.equal(pkg.dependencies, undefined, '後端不該有 runtime 相依（node:sqlite／node:zlib 都是內建）');
  assert.match(pkg.engines.node, /22\.5/, 'engines.node 要保留 22.5（node:sqlite 的最低版本）');
  assert.equal(
    execFileSync(process.execPath, ['-e', "import('node:sqlite').then(()=>{},()=>process.exit(1))"], { stdio: 'pipe' }) && 0,
    0,
    '這個 Node 版本要能用 node:sqlite（Windows 也一樣）',
  );
});
