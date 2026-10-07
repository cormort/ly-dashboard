#!/usr/bin/env node
/**
 * 把本機抓到的新聞推回 GitHub 的資料分支（`news-data`）—— 邏輯在 `server/news-push.mjs`，
 * 這支只是執行入口（伺服器在同步流程裡也會直接呼叫同一個函式，見 server/ingest.mjs 的 maybePushNews）。
 *
 * 用法：
 *   node scripts/push-news-data.mjs                 # 近 7 天的新聞，有變就 commit＋push
 *   node scripts/push-news-data.mjs --days 14       # 往前多推幾天
 *   node scripts/push-news-data.mjs --dry-run       # 只預演（會說會更新幾個檔、新增幾則）
 *   node scripts/push-news-data.mjs --remote <url>  # 換遠端（預設抓本專案的 origin）
 *   node scripts/push-news-data.mjs --db <path>     # 換資料庫（預設 CONFIG.dbPath）
 *
 * 需要能寫 repo 的憑證（git remote 自帶，或走系統的 credential helper）——跟每日抓粉專推 fb-data 一樣。
 * 沒有變動就不 commit、不 push；失敗以非零 exit 回報，讓呼叫端只記 log。
 */
import { parseArgs as parseNodeArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../server/config.mjs';
import { openDb } from '../server/db.mjs';
import { syncNewsData, workDirFor, DEFAULT_NEWS_BRANCH } from '../server/news-push.mjs';
import { runGit, redact } from './push-fb-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      days: { type: 'string' },
      branch: { type: 'string' },
      remote: { type: 'string' },
      db: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  return {
    days: Number(values.days ?? 7),
    branch: values.branch || DEFAULT_NEWS_BRANCH,
    remote: values.remote || '',
    dbPath: values.db || CONFIG.dbPath,
    workDir: values.dir || '',
    dryRun: values['dry-run'],
  };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const repoUrl = args.remote || runGit(['remote', 'get-url', 'origin'], ROOT);
  const db = openDb(args.dbPath);
  try {
    const result = await syncNewsData({
      db,
      days: args.days,
      branch: args.branch,
      repoUrl,
      workDir: args.workDir ? resolve(args.workDir) : workDirFor(args.branch),
      dryRun: args.dryRun,
      log: (message) => console.error(message),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'unchanged') console.error(`[news-data] 沒有新東西要推（近 ${args.days} 天 ${result.items} 則）`);
  } catch (error) {
    console.error(`[news-data] 失敗：${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
