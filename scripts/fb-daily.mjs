#!/usr/bin/env node
/**
 * 每日自動抓取立委臉書粉專的「最新一則貼文」——**跨平台版**（macOS launchd 與 Windows 工作排程器共用同一份）。
 *
 *   node scripts/fb-daily.mjs                  # 排程用的正常路徑：抓 113 位、寫 .cache/posts-<今天>.csv
 *   node scripts/fb-daily.mjs --ids 1,18 --limit 5   # 手動試跑（參數直接轉給 fetch-fb-posts.mjs）
 *
 * 為什麼是 .mjs（原本是 scripts/fb-daily.sh）：
 *   這一輪要把立委觀測站搬到 Windows 上跑，而這支腳本用的全是 Windows 沒有的東西：
 *   bash 的 `source`、`mkdir` 當鎖、`find -mmin`、`sed`、`awk`、`date`、`trap`。
 *   與其寫第二份 PowerShell 版本（同樣的邏輯兩份，之後修一邊忘一邊），不如搬到兩平台都能跑的 Node；
 *   scripts/fb-daily.sh 從此只是一行 exec 的薄殼（launchd 的 plist 與既有測試都還指著它）。
 *
 * 退出碼：0 成功／1 環境或執行失敗／2 一列都沒抓到（幾乎一定是沒登入 Facebook）／3 找不到必要檔案
 *
 * 前置（各一次就好）：
 *   npm i -D playwright-core
 *   node scripts/fetch-fb-posts.mjs --login          # 開有畫面的瀏覽器登入一次 Facebook
 *
 * 環境變數：
 *   LY_FB_PROFILE           Chrome 設定檔（預設 ~/.ly-dashboard/fb-profile）
 *   LY_SHEET_WEBAPP_URL     Apps Script Web App 的 /exec 網址（寫回試算表用；見 apps-script/）
 *   LY_SHEET_TOKEN          同一個 Web App 的共享密鑰（兩者都有才會寫回）
 *   LY_FB_SERVICE_ACCOUNT   服務帳號金鑰；沒有 Web App 設定時才用這條（檔案存在才會 --write-sheet）
 *   LY_FB_DATA_PUSH         要不要把抓取結果推上遠端資料分支（預設 1；設 0 關掉）
 *   LY_FB_DATA_BRANCH       資料分支名稱（預設 fb-data）
 *   LY_NOTIFY               要不要送 Telegram 成敗通知（預設 1；設 0 關掉）
 *   LY_NOTIFY_ENV           通知憑證檔（預設 ~/.ly-dashboard/notify.env）
 *   LY_SYNC_SCOPE           寫回表之後要觸發哪一種同步（預設 social：只重讀整理表）
 *   LY_SYNC_TOKEN           本機伺服器有設 token 時，觸發同步要帶同一組
 *   LY_SYNC_TRIGGER_ATTEMPTS / LY_SYNC_TRIGGER_DELAY_MS   觸發同步的等待：次數／間隔（預設 10 次／60 秒）
 *   LY_FB_LOCAL_INGEST      抓完直接寫進本機資料庫（預設 1；設 0 就只寫回試算表並觸發同步）
 *   LY_FB_LOG_DIR           輸出目錄（log／CSV／鎖；預設 <repo>/.cache）。測試要用免洗目錄，見下面 LOG_DIR
 *   LY_FB_LOCK              要不要用「同時只允許一輪」的抓取鎖（預設 1；測試或刻意並行時設 0）
 *   LY_FB_LOCK_STALE_MIN    超過幾分鐘的鎖視為殘留（預設 90）
 *   LY_FB_PROBE_ATTEMPTS / LY_FB_PROBE_DELAY_MS   開跑前的整理表連線檢查：次數／間隔（預設 5 次／30 秒）
 *   LY_FB_FETCH_ATTEMPTS / LY_FB_FETCH_DELAY_MS   抓取腳本讀來源 CSV 的重試：次數／間隔（預設 3 次／10 秒）
 *
 * 寫回用的網址與密鑰放在 ~/.ly-dashboard/sheet.env（repo 外、權限 600），下面會自動載入。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnvFile } from './notify-telegram.mjs';
import { describeError, sheetCsvUrl, sleep, waitForCsv } from './social-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NOTIFY_SCRIPT = join(ROOT, 'scripts', 'notify-telegram.mjs');

/** 手動試跑常帶 --csv：連線檢查要跟抓取腳本看同一份來源。 */
export function argvCsv(argv) {
  const i = argv.indexOf('--csv');
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * 觸發本機伺服器重新同步（只跑指定範圍），回傳給通知用的短句。
 *
 * 2026-10-10 實例：排程在 08:55 觸發時，伺服器正在跑**新聞同步**（單一同步原則），
 * 端點回 409 `sync_in_progress`；舊程式把任何失敗都寫成「沒有回應」就放棄 ——
 * 結果資料庫裡還是兩天前的貼文，站上看不到當天抓到的東西（後來手動觸發才補上）。
 *
 * 現在的行為：
 *   ‧ 一律帶 `force=1`：這一輪才剛把新資料寫回試算表，就算同一個範圍 5 分鐘內同步過，
 *     也必須再讀一次（冷卻防呆是給人按按鈕用的，見 server/sync-guard.mjs）。
 *   ‧ `409 sync_in_progress` 不是失敗，是「排隊」：等它跑完再試，預設最多等 10 分鐘
 *     （`LY_SYNC_TRIGGER_ATTEMPTS`／`LY_SYNC_TRIGGER_DELAY_MS` 可調）。
 *   ‧ 最後仍失敗就照實寫出來，並說明伺服器自己的排程會接手。
 */
export async function triggerSync(port, scope, log, {
  attempts,
  timeoutMs,
  delayMs,
} = {}) {
  const n = Number(attempts ?? process.env.LY_SYNC_TRIGGER_ATTEMPTS ?? 10);
  const wait = Number(delayMs ?? process.env.LY_SYNC_TRIGGER_DELAY_MS ?? 60_000);
  const timeout = Number(timeoutMs ?? process.env.LY_SYNC_TRIGGER_TIMEOUT_MS ?? 60_000);
  const url = `http://127.0.0.1:${port}/api/v1/sync?scope=${scope}&force=1`;
  let lastReason = '';
  for (let i = 1; i <= n; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: process.env.LY_SYNC_TOKEN ? { 'x-sync-token': process.env.LY_SYNC_TOKEN } : {},
        signal: AbortSignal.timeout(timeout),
      });
      const body = await response.text().catch(() => '');
      if (response.status === 202) {
        log(`已觸發本機伺服器（:${port}，範圍 ${scope}）重新同步，畫面會拿到剛寫回試算表的貼文`);
        return `已觸發（${scope}）`;
      }
      if (response.status === 409 && /sync_in_progress/.test(body)) {
        lastReason = '伺服器正在跑其他同步（等一下再試）';
      } else {
        lastReason = `HTTP ${response.status}${body ? ` ${body.slice(0, 100)}` : ''}`;
      }
    } catch (err) {
      lastReason = describeError(err);
    }
    log(`觸發同步未成（第 ${i}/${n} 次）：${lastReason}`
      + (i < n ? `；${Math.round(wait / 1000)} 秒後再試` : ''));
    if (i < n) await sleep(wait);
  }
  log(`本機伺服器（:${port}）一直沒能觸發同步；它自己的排程會讀到同一份試算表`);
  return `未觸發（${lastReason}）`;
}

/**
 * 把剛抓到的結果**直接寫進本機資料庫**，不繞 Google 整理表。
 *
 * 原本的路徑是：抓完 → 寫回整理表（Apps Script）→ 觸發伺服器 → 伺服器再把整理表抓回來。
 * 中間有三個會壞的地方（寫回、伺服器有沒有在跑、同步的 409 排隊），而抓取端手上本來就有
 * 完整、格式相同的兩份 CSV（`posts-<日期>.csv` 是整理表格式、`posts-detail-<日期>.csv`
 * 是貼文層級），直接匯入就少掉這些環節；整理表照樣會寫（人工要看的紀錄）。
 *
 * 驗證（筆數掉太多就 fail closed）與人工更正表都在 `runSocialIngest`／`runSocialPostsIngest`
 * 裡，這裡只是把來源從網路換成檔案。
 */
export async function ingestLocally({ accountsCsv, postsCsv = null, dbPath = null, logger = console } = {}) {
  const { CONFIG } = await import('../server/config.mjs');
  const { openDb } = await import('../server/db.mjs');
  const { runSocialIngest, runSocialPostsIngest } = await import('../server/ingest.mjs');
  const db = openDb(dbPath ?? CONFIG.dbPath);
  try {
    const accounts = await runSocialIngest(db, { logger, csvText: readFileSync(accountsCsv, 'utf8') });
    const posts = postsCsv && existsSync(postsCsv)
      ? await runSocialPostsIngest(db, { logger, csvText: readFileSync(postsCsv, 'utf8') })
      : null;
    return { accounts, posts };
  } finally {
    db.close();
  }
}

/** `date '+%Y-%m-%dT%H:%M:%S%z'` 的對應（本機時區、`+0800` 這種格式）。 */
export function stampLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`
  );
}

/** `date '+%Y-%m-%d'`（本機時區）。 */
export function dateStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * 抓取鎖：同時只允許一輪（每輪 25–35 分鐘且獨佔 Chrome 設定檔，兩輪同時跑會互相搶，
 * 後啟動的那一輪會在幾秒內失敗 —— 2026-10-06 08:00 的每日排程就是這樣被 07:58 的另一輪擠掉）。
 * 用 `mkdir` 當原子操作（兩平台都一樣是原子的）；超過 staleMin 分鐘的鎖視為上次被中斷的殘留，直接接手。
 * 回傳 'new'｜'stale'｜'off'（沒用鎖）｜null（搶不到，本輪要跳過）。
 */
export function acquireLock(lockDir, { enabled = true, staleMin = 90, now = Date.now() } = {}) {
  if (!enabled) return 'off';
  try {
    mkdirSync(lockDir);
    return 'new';
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
  }
  let stale = false;
  try {
    stale = now - statSync(lockDir).mtimeMs > staleMin * 60_000;
  } catch {
    stale = false;
  }
  if (!stale) return null;
  rmSync(lockDir, { recursive: true, force: true });
  try {
    mkdirSync(lockDir);
    return 'stale';
  } catch {
    return null;
  }
}

/** `wc -l <csv` 的「幾列資料」（扣掉表頭）；檔案不存在時回 null（對應 bash 的空字串）。 */
export function dataRows(csvPath) {
  try {
    const text = readFileSync(csvPath, 'utf8');
    const lines = text.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '');
    return Math.max(0, lines.length - 1);
  } catch {
    return null;
  }
}

/** 從 `[寫回] 工作表「…」：更新 3、未變 5…` 取出「更新…」那一段（等於 bash 的 sed）。 */
export function writeLineFrom(output) {
  const matches = [...String(output ?? '').matchAll(/^\[寫回\] 工作表[^：]*：(.*)$/gm)];
  return matches.length ? matches.at(-1)[1].trim() : '';
}

/** 從 `[fb-data] 已推上 fb-data：posts/….csv…` 取出檔名那一段（等於 bash 的兩層 sed）。 */
export function dataLineFrom(output) {
  const matches = [...String(output ?? '').matchAll(/^\[fb-data\] (.*)$/gm)];
  if (!matches.length) return '';
  return matches.at(-1)[1].trim().replace(/^(已推上 )?[A-Za-z0-9._-]+：/, '').trim();
}

async function main(argv) {
  process.chdir(ROOT); // 相對路徑（scripts/…、.cache/…）一律以專案根為準
  const startedAt = new Date();
  const startedLabel = `${dateStamp(startedAt)} ${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}`;

  // 寫回試算表的密鑰檔（不在版控裡；沒有這個檔就只產生本機 CSV）。
  // 跟原本的 `set -a; . ~/.ly-dashboard/sheet.env` 一樣：檔案裡的值優先於既有環境變數。
  const envFile = join(homedir(), '.ly-dashboard', 'sheet.env');
  if (existsSync(envFile)) Object.assign(process.env, parseEnvFile(readFileSync(envFile, 'utf8')));

  const logDir = process.env.LY_FB_LOG_DIR || join(ROOT, '.cache');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'fb-daily.log');
  const log = (message) => writeFileSync(logPath, `${stampLocal()} ${message}\n`, { flag: 'a' });

  const profile = process.env.LY_FB_PROFILE || join(homedir(), '.ly-dashboard', 'fb-profile');
  const keyPath = process.env.LY_FB_SERVICE_ACCOUNT || join(ROOT, 'service_account.json');
  const stamp = dateStamp(startedAt);
  const outDated = join(logDir, `posts-${stamp}.csv`);
  const outLatest = join(logDir, 'posts-latest.csv');
  // 貼文層級（一列一則貼文）：整理表只收最新一則，這一份把同一頁的其他貼文也留下來，
  // 讓「機關」頁能把委員貼文歸到機關（只比對 60 字摘要幾乎比對不到）。
  const outDetail = join(logDir, `posts-detail-${stamp}.csv`);
  const outDetailLatest = join(logDir, 'posts-detail-latest.csv');

  // 成敗通知（Telegram）：成功、失敗都送一則。通知失敗只記 log —— 通知不該讓每日排程失敗。
  const notify = (message) => {
    if ((process.env.LY_NOTIFY ?? '1') !== '1') {
      log('（LY_NOTIFY=0，不送通知）');
      return;
    }
    const result = spawnSync(process.execPath, [NOTIFY_SCRIPT, message], { cwd: ROOT, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output) writeFileSync(logPath, `${output}\n`, { flag: 'a' });
    if (result.status !== 0) log('（通知送出失敗，不影響本輪）');
  };
  const notifyFail = (reason, fix) =>
    notify(`❌ 立委粉專每日更新失敗（${startedLabel}）\n原因：${reason}\n修復：${fix}\nlog：${logPath}`);

  log(`=== 開始（profile=${profile}）===`);

  // ---- 抓取鎖：同時只允許一輪 ------------------------------------------------------------
  const lockDir = join(logDir, 'fb-daily.lock');
  const lockState = acquireLock(lockDir, {
    enabled: (process.env.LY_FB_LOCK ?? '1') === '1',
    staleMin: Number(process.env.LY_FB_LOCK_STALE_MIN ?? 90),
  });
  if (lockState === null) {
    log(`已有另一輪抓取在跑（鎖：${lockDir}）→ 本輪跳過`);
    notify(
      `⏭ 立委粉專每日更新跳過（${startedLabel}）\n` +
        '原因：已經有另一輪在抓（同時只能有一輪，否則兩輪會搶 Chrome 設定檔而失敗）\n' +
        `強制重跑：把 ${lockDir} 刪掉再跑一次，或設 LY_FB_LOCK=0`,
    );
    return 0;
  }
  if (lockState === 'stale') log(`發現殘留的抓取鎖（超過 ${process.env.LY_FB_LOCK_STALE_MIN ?? 90} 分鐘）→ 接手`);
  const holdsLock = lockState !== 'off';
  if (holdsLock) writeFileSync(join(lockDir, 'started_at'), `${startedLabel}\n`);
  const releaseLock = () => {
    if (holdsLock) rmSync(lockDir, { recursive: true, force: true });
  };
  process.on('exit', releaseLock);

  try {
    // 先檢查 playwright-core，省下「跑了半小時才發現沒裝」這種事
    try {
      await import('playwright-core');
    } catch {
      log(`找不到 playwright-core：請先在 ${ROOT} 執行 npm i -D playwright-core；中止`);
      notifyFail('找不到 playwright-core', `cd ${ROOT} && npm i -D playwright-core`);
      return 1;
    }

    // 開跑前先確認整理表連得到：**連線層的暫時性失敗不該吃掉一整天**。
    // 2026-10-10 08:00 就是這樣：一開跑 `fetch failed`（UND_ERR_CONNECT_TIMEOUT），
    // 秒殺結束，當天完全沒有新資料（前一天也一樣）。這裡等到連上為止（預設 5 次／30 秒）。
    const sourceUrl = argvCsv(argv) ?? sheetCsvUrl(process.env);
    if (/^https?:/.test(sourceUrl) && !(await waitForCsv(sourceUrl, log))) {
      notifyFail(
        `連不上社群整理表（${sourceUrl}）`,
        `確認這台機器連得到網路與 docs.google.com 之後手動跑一次：cd ${ROOT} && npm run fb-daily`,
      );
      return 1;
    }

    // 驗證報告預設會寫進版控的 docs/fb-verification-<日期>.csv；排程每天跑的話會一直長新檔案，
    // 所以這裡改寫到 .cache/（已 gitignore）。要留哪一天的證據再自己搬進 docs/。
    const fetchArgs = [
      join(ROOT, 'scripts', 'fetch-fb-posts.mjs'),
      '--verify',
      '--verify-out',
      join(logDir, `fb-verification-${stamp}.csv`),
      '--profile',
      profile,
      '--out',
      outDated,
      '--detail-out',
      outDetail,
    ];
    let wroteSheet = 0;
    if (existsSync(keyPath)) {
      fetchArgs.push('--write-sheet', '--key', keyPath);
      wroteSheet = 1;
    } else if (!(process.env.LY_SHEET_WEBAPP_URL && process.env.LY_SHEET_TOKEN)) {
      // 有 Web App 設定時（~/.ly-dashboard/sheet.env）走的是 Apps Script，這裡不必嚇人：
      // 之前的寫法會在有 Web App 的情況下也印「不寫回試算表」，診斷時容易誤判。
      log(`沒有服務帳號金鑰（${keyPath}），也沒有 Web App 設定 → 只產生本機 CSV，不寫回試算表`);
    }

    // 呼叫端給的參數（例如手動試跑的 --ids）一律優先，方便縮小範圍
    if (argv.length) {
      fetchArgs.push(...argv);
      log(`額外參數：${argv.join(' ')}`);
    }

    const startedFetchAt = Date.now();
    let fetch = spawnSync(process.execPath, fetchArgs, { cwd: ROOT, encoding: 'utf8' });
    let fetchOutput = `${fetch.stdout ?? ''}${fetch.stderr ?? ''}`;
    // 秒殺型失敗（跑不到 90 秒、又沒有「完成：」）幾乎都是連線或 Chrome 一時被佔用 ——
    // 直接再跑一次；真的跑滿 30 分鐘才失敗就不要再重試。
    if ((fetch.status ?? 1) !== 0 && Date.now() - startedFetchAt < 90_000 && !fetchOutput.includes('完成：')) {
      log(`抓取在 ${Math.round((Date.now() - startedFetchAt) / 1000)} 秒內失敗且沒有產出 → 90 秒後重跑一次`);
      await sleep(90_000);
      fetch = spawnSync(process.execPath, fetchArgs, { cwd: ROOT, encoding: 'utf8' });
      fetchOutput += `${fetch.stdout ?? ''}${fetch.stderr ?? ''}`;
    }
    writeFileSync(logPath, fetchOutput, { flag: 'a' });
    const status = fetch.status ?? 1;

    if (status !== 0) {
      log(`抓取失敗（exit ${status}）；中止`);
      notifyFail(
        `抓取腳本失敗（exit ${status}）`,
        fetchOutput.includes('完成：')
          ? `看 ${logPath} 最後幾行（跑到最後才出問題）`
          : `連線類的失敗已自動重跑過一次；再看一次 log 最後幾行的原因，或用 cd ${ROOT} && npm run fb-daily 手動跑`,
      );
      return 1;
    }

    // fetch-fb-posts.mjs 收尾會印「完成：N 列有日期、M 列留空」，用那一行當作成功與否的判準。
    // 不直接數 CSV 的原因：CSV 欄位可能有引號包住的逗號，naive 切欄會數錯。
    const filledMatches = [...fetchOutput.matchAll(/完成：(\d+) 列有日期/g)];
    const filledRaw = filledMatches.length ? filledMatches.at(-1)[1] : '';
    if (!filledRaw) {
      log('抓不到「完成：…列有日期」的統計，無法確認結果；視為失敗');
      notifyFail('抓不到「完成：…列有日期」的統計', `看 ${logPath} 最後幾行`);
      return 1;
    }
    const filled = Number(filledRaw);

    copyFileSync(outDated, outLatest);
    if (existsSync(outDetail)) copyFileSync(outDetail, outDetailLatest);
    let detailLine = '';
    if (existsSync(outDetail)) {
      const detailRows = dataRows(outDetail);
      detailLine = `；貼文層級 ${detailRows} 則（${outDetail}）`;
    }
    log(`完成：${filled} 列有日期（${outDated}，另存一份 ${outLatest}）${detailLine}`);

    if (filled === 0) {
      // 抓不到任何日期最常見的原因就是設定檔沒登入：Facebook 對未登入的請求只回登入頁。
      // 這裡一定要留下可照著做的指令，否則排程只會安靜地每天產生一份空檔。
      log('0 列有日期 → 幾乎一定是這個設定檔沒登入 Facebook。請在有畫面的終端機跑一次：');
      log(`    node scripts/fetch-fb-posts.mjs --login --profile "${profile}"`);
      notifyFail(
        '0 列有日期 → 幾乎一定是這個設定檔沒登入 Facebook',
        `node scripts/fetch-fb-posts.mjs --login --profile "${profile}"（要在有畫面的終端機跑）`,
      );
      return 2;
    }

    // 寫回試算表：優先用 Apps Script Web App（LY_SHEET_WEBAPP_URL＋LY_SHEET_TOKEN），
    // 其次是抓取腳本自己的服務帳號模式（--write-sheet --key，需要有金鑰檔）。
    let pushOut = '';
    if (process.env.LY_SHEET_WEBAPP_URL && process.env.LY_SHEET_TOKEN) {
      const push = spawnSync(process.execPath, [join(ROOT, 'scripts', 'push-posts-to-sheet.mjs'), outDated], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      pushOut = `${push.stdout ?? ''}${push.stderr ?? ''}`;
      writeFileSync(logPath, pushOut, { flag: 'a' });
      if (push.status === 0) {
        wroteSheet = 1;
      } else {
        log(`Web App 寫回失敗（見上面幾行）；本機 CSV 仍在 ${outDated}，可手動重跑：node scripts/push-posts-to-sheet.mjs "${outDated}"`);
      }
    } else if (wroteSheet === 1) {
      wroteSheet = 1;
    }

    // 資料也推一份到遠端資料分支（預設 fb-data，比照 news-data）：遠端讀得到、也多一份備份。
    // 失敗只記 log，不讓每日排程整個失敗（本機 CSV 還在）。設 LY_FB_DATA_PUSH=0 可關掉。
    let dataOut = '';
    if ((process.env.LY_FB_DATA_PUSH ?? '1') === '1') {
      const push = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts', 'push-fb-data.mjs'), outDated, '--detail', outDetail],
        { cwd: ROOT, encoding: 'utf8' },
      );
      dataOut = `${push.stdout ?? ''}${push.stderr ?? ''}`;
      writeFileSync(logPath, dataOut, { flag: 'a' });
      if (push.status !== 0) log(`推 ${process.env.LY_FB_DATA_BRANCH || 'fb-data'} 分支失敗（見上面幾行）；本機 CSV 仍在 ${outDated}`);
    }

    // 直接把結果寫進本機資料庫（見 ingestLocally 的說明）：抓取端手上就有完整 CSV，
    // 不必等「寫回整理表 → 伺服器再抓回來」那條路，也不會被同步的 409 排隊卡住。
    // 寫成功就不必再觸發同步（伺服器是直接查資料庫的，沒有快取）。設 LY_FB_LOCAL_INGEST=0 可關掉。
    let localLine = '';
    let ingested = false;
    if ((process.env.LY_FB_LOCAL_INGEST ?? '1') === '1') {
      try {
        const result = await ingestLocally({
          accountsCsv: outDated,
          postsCsv: outDetail,
          logger: { log, warn: (m) => log(m), error: (m) => log(m) },
        });
        writeFileSync(logPath, `[本機] 帳號 ${result.accounts?.status}${result.posts ? `、貼文層級 ${result.posts.status}` : ''}\n`, { flag: 'a' });
        ingested = result.accounts?.status === 'success';
        localLine = ingested
          ? `已寫入（帳號 ${result.accounts.accounts} 筆`
            + `${result.posts?.status === 'success' ? `、貼文層級 ${result.posts.posts} 則` : ''}）`
          : `❌ 失敗（${result.accounts?.error ?? '看 log'}）`;
      } catch (error) {
        log(`寫入本機資料庫失敗：${error?.stack ?? error}`);
        localLine = `❌ 失敗（${error?.message ?? error}）`;
      }
    } else {
      localLine = '（已用 LY_FB_LOCAL_INGEST=0 關掉）';
    }

    // 真的寫不進本機時才回頭走舊路：觸發伺服器重讀整理表。
    let syncLine = ingested ? '不必觸發（本機已直接寫入）' : '未觸發（沒有寫回試算表）';
    if (!ingested && wroteSheet === 1) {
      const port = process.env.PORT || 8787;
      // 只觸發 social 範圍：這一輪改動的是 Google 整理表，跑「全部」等於白等 13 分鐘
      // （新聞一個階段就 763 秒）。完整同步交給伺服器自己的 24 小時排程。
      const scope = process.env.LY_SYNC_SCOPE || 'social';
      syncLine = await triggerSync(port, scope, log);
    }

    // 收尾通知：把「抓到幾列／寫回結果／資料分支／同步」一次講完，成功失敗都送。
    let writeLine = writeLineFrom(pushOut);
    if (!writeLine) {
      writeLine = process.env.LY_SHEET_WEBAPP_URL && process.env.LY_SHEET_TOKEN
        ? '❌ 寫回失敗（看 log）'
        : '（沒設定 Web App，只產生本機 CSV）';
    }
    let dataLine = dataLineFrom(dataOut);
    if (!dataLine) {
      dataLine = (process.env.LY_FB_DATA_PUSH ?? '1') === '1' ? '❌ 推送失敗（看 log）' : '（已用 LY_FB_DATA_PUSH=0 關掉）';
    }
    const totalRows = dataRows(outDated);
    const minutes = Math.floor((Date.now() - startedAt.getTime()) / 60_000);

    notify(
      `✅ 立委粉專每日更新完成（${startedLabel}，約 ${minutes} 分）\n` +
        `· 有日期 ${filled}${totalRows === null ? '' : ` / ${totalRows}`} 列\n` +
        `· 本機資料庫：${localLine || '（未寫入）'}\n` +
        `· 寫回整理表：${writeLine || '（未設定 Web App，只產生本機 CSV）'}\n` +
        `· 資料分支 ${process.env.LY_FB_DATA_BRANCH || 'fb-data'}：${dataLine || '（未推，設定 LY_FB_DATA_PUSH=0？）'}\n` +
        `· 本機同步：${syncLine}`,
    );

    log('=== 結束 ===');
    return 0;
  } finally {
    releaseLock();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // 未預期的例外也要留一則通知（原本的 .sh 會被 set -uo pipefail 直接中斷，只留 log）
    const direct = join(process.env.LY_FB_LOG_DIR || join(ROOT, '.cache'), 'fb-daily.log');
    try {
      mkdirSync(dirname(direct), { recursive: true });
      writeFileSync(direct, `${stampLocal()} 未預期的錯誤：${error?.stack ?? error}\n`, { flag: 'a' });
    } catch {
      /* log 寫不進去就算了，至少讓下面的訊息出去 */
    }
    if ((process.env.LY_NOTIFY ?? '1') === '1') {
      spawnSync(process.execPath, [join(ROOT, 'scripts', 'notify-telegram.mjs'), `❌ 立委粉專每日更新異常中止\n原因：${error?.message ?? error}\nlog：${direct}`], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    }
    process.exitCode = 1;
  }
}
