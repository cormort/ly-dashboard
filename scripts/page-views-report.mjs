#!/usr/bin/env node
/**
 * 每天的使用狀況日報（配 server/page-views.mjs 的 page_views 表）。
 *
 *   node scripts/page-views-report.mjs                 # 昨天的統計，印在終端機
 *   node scripts/page-views-report.mjs --date 2026-10-19
 *   node scripts/page-views-report.mjs --push          # 順便推一則到 Telegram（排程用）
 *   node scripts/page-views-report.mjs --json          # 給其他程式吃
 *
 * 為什麼要有這支：使用者 2026-10-20 問「可以知道昨天 user 的行為嗎」——
 * 原本站上完全沒有請求紀錄（Caddy 沒開 access log、伺服器只記同步），所以加了 page_views。
 * 這支負責「把昨天的數字講成一句話」，排程每天早上 08:10 推一次。
 *
 * 離開碼：0 正常；1 資料庫打不開；2 用法錯誤。沒有資料不算失敗（回 0，訊息寫 0 次瀏覽）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CONFIG } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { dailyPageViews, ensurePageViewTable, pageViewsText, previousDay, prunePageViews } from '../server/page-views.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const run = promisify(execFile);
const NOTIFY_SCRIPT = join(ROOT, 'scripts', 'notify-telegram.mjs');

/** 保留幾天：將近一年（日報只會看昨天，留著是為了之後看趨勢） */
const KEEP_DAYS = 400;

function usage(message) {
  if (message) console.error(`✗ ${message}`);
  console.error('用法：node scripts/page-views-report.mjs [--date YYYY-MM-DD] [--push] [--json]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { date: '', push: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--push') out.push = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--date') {
      const value = argv[i + 1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) usage('--date 要 YYYY-MM-DD');
      out.date = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') usage();
    else usage(`看不懂的參數：${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.LY_DB || CONFIG.dbPath;
  if (!existsSync(dbPath)) {
    console.error(`✗ 找不到資料庫：${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  ensurePageViewTable(db);
  const pruned = prunePageViews(db, { keepDays: KEEP_DAYS });
  const date = args.date || previousDay();
  const summary = dailyPageViews(db, { date });
  if (args.json) {
    console.log(JSON.stringify({ ...summary, pruned }, null, 2));
    return;
  }
  const text = pageViewsText(summary);
  console.log(text);
  if (pruned > 0) console.log(`（清掉 ${pruned} 筆超過 ${KEEP_DAYS} 天的舊資料）`);

  if (args.push) {
    if (!existsSync(NOTIFY_SCRIPT)) {
      console.error('✗ 找不到 scripts/notify-telegram.mjs，沒有推播');
      return;
    }
    try {
      const { stdout } = await run(process.execPath, [NOTIFY_SCRIPT, text], { cwd: ROOT });
      if (stdout.trim()) console.log(stdout.trim());
    } catch (error) {
      // 推播失敗不影響日報本身（跟 notify-telegram.mjs 的約定一致）
      console.error(`⚠ 推播失敗：${error?.message ?? error}`);
    }
  }
}

main().catch((error) => {
  console.error(`✗ ${error?.stack ?? error}`);
  process.exit(1);
});
