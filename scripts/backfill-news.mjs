#!/usr/bin/env node
/**
 * 近半年新聞回補（一次性；每日同步只看近 30 天）。用 Google 新聞的日期區間查詢，
 * 補委員、機關首長、主計、基金機關四類新聞，寫入規則與每日同步相同（見 server/ingest.mjs runNewsBackfill）。
 *
 *   node scripts/backfill-news.mjs                 # 跑 30 分鐘，用完就停，下次接續
 *   node scripts/backfill-news.mjs --minutes 90    # 跑久一點
 *   node scripts/backfill-news.mjs --delay-ms 3000 # 被限流時放慢
 *   node scripts/backfill-news.mjs --reset         # 忘掉進度、從頭再來
 *   node scripts/backfill-news.mjs --status        # 只看進度，不抓
 *
 * 約 224 組對象 × 6 個月，新聞多的月份再細切成週／日，全部約 1,500～2,000 個請求。
 * 連續 5 次失敗（多半是被 Google 限流）會停下並記住進度，隔一段時間再跑就會接續。
 * 「其他」類（沒提到任何人的媒體新聞）補不回來：媒體 RSS 沒有歷史。
 * 伺服器可以同時開著（SQLite 會等鎖），但不要同時跑兩支回補。
 */
import { parseArgs } from 'node:util';
import { CONFIG } from '../server/config.mjs';
import { openDb, getMeta } from '../server/db.mjs';
import { backfillTargets, runNewsBackfill } from '../server/ingest.mjs';

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string', default: '30' },
    'delay-ms': { type: 'string', default: '2000' },
    reset: { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
  },
});

const db = openDb(CONFIG.dbPath);
const total = backfillTargets(db).length;
const saved = JSON.parse(getMeta(db, 'news_backfill', 'null') ?? 'null');
const doneAt = getMeta(db, 'news_backfill_done_at');

if (args.status) {
  if (!saved) console.log(`尚未開始（共 ${total} 組對象）`);
  else console.log(`區間 ${saved.from.slice(0, 10)}～${saved.to.slice(0, 10)}：已完成 ${saved.done.length}/${total} 組${saved.current ? `，進行中：${saved.current.key} 第 ${saved.current.month + 1} 個月` : ''}${doneAt ? `（${doneAt} 全部完成）` : ''}`);
  process.exit(0);
}

const minutes = Number(args.minutes);
const delayMs = Number(args['delay-ms']);
if (!(minutes > 0) || !(delayMs >= 0)) {
  console.error('--minutes 要大於 0、--delay-ms 不可為負');
  process.exit(2);
}
console.log(`[backfill] 開始：共 ${total} 組對象，已完成 ${args.reset ? 0 : saved?.done.length ?? 0} 組；時間預算 ${minutes} 分鐘、間隔 ${delayMs} ms`);
const result = await runNewsBackfill(db, { delayMs, budgetMs: minutes * 60 * 1000, reset: args.reset });
const summary = `請求 ${result.requests} 次、失敗 ${result.failures} 次、新增委員新聞 ${result.added} 則；完成 ${result.completed}/${result.targets} 組`;
if (result.stopped === 'budget') console.log(`[backfill] 時間到，先停在這裡（${summary}）。再跑一次就會接續。`);
else if (result.stopped === 'failures') {
  console.error(`[backfill] 連續失敗，多半是被 Google 限流，已停下並記住進度（${summary}）。隔一段時間再跑，或加 --delay-ms 3000 放慢。`);
  process.exit(1);
} else console.log(`[backfill] 全部完成（${summary}）。`);
