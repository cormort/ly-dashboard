#!/usr/bin/env node
/**
 * 把新聞頁「下載 CSV」匯出的歷史新聞，併進 news-data 分支的收集檔（news/YYYY-MM-DD.ndjson，格式見 server/news-feed.mjs）。
 * 用途：回補抓到的半年歷史放上 GitHub 永久保存；任何伺服器第一次啟動時匯入收集檔（讀滿 180 天）就有這些新聞，不必重跑回補。
 *
 *   git clone --depth 1 --branch news-data https://github.com/cormort/ly-dashboard.git ../news-data
 *   node scripts/import-news-csv.mjs --csv news-all.csv --out ../news-data
 *   cd ../news-data && git add -A && git commit -m "news: 匯入歷史新聞" && git push
 *
 * 只補收集檔裡還沒有的網址：RSS 已經收過的那則不動（CSV 的時間只到分鐘，覆寫會讓既有的行無謂變動）。只用 node 內建模組。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsv } from '../server/normalize.mjs';
import { csvRowsToFeedItems, feedDate, mergeFeedFile, parseFeedFile } from '../server/news-feed.mjs';

const { values: args } = parseArgs({ options: { csv: { type: 'string' }, out: { type: 'string', default: 'news-data' }, 'collected-at': { type: 'string' } } });
if (!args.csv) {
  console.error('用法：node scripts/import-news-csv.mjs --csv news-all.csv --out ../news-data');
  process.exit(2);
}
const items = csvRowsToFeedItems(parseCsv(readFileSync(args.csv, 'utf8')));
const collectedAt = args['collected-at'] || new Date().toISOString();
const byDate = new Map();
for (const i of items) {
  const date = feedDate(i.published_at);
  if (!byDate.has(date)) byDate.set(date, []);
  byDate.get(date).push(i);
}
const dir = join(args.out, 'news');
mkdirSync(dir, { recursive: true });
let changed = 0;
let added = 0;
for (const [date, list] of [...byDate].sort()) {
  const file = join(dir, `${date}.ndjson`);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(parseFeedFile(before).map((i) => i.url));
  const fresh = list.filter((i) => !have.has(i.url));
  added += fresh.length;
  const after = fresh.length ? mergeFeedFile(before, fresh, collectedAt) : before;
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
  }
}
const dates = [...byDate.keys()].sort();
console.log(`讀到 ${items.length} 則（${dates[0] ?? '—'}～${dates.at(-1) ?? '—'}，${dates.length} 天），新增 ${added} 則、更新 ${changed} 個檔（其餘已在收集檔裡）`);
