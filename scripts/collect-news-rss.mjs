#!/usr/bin/env node
/**
 * 媒體 RSS 收集端：抓 CONFIG.news.outlets 的各家 RSS（中央社有多個分類 feed），併進 `<out>/news/YYYY-MM-DD.ndjson`（格式見 server/news-feed.mjs）。
 * 由 GitHub Actions 每小時執行（.github/workflows/collect-news.yml），結果 commit 到 news-data 分支，
 * 儀表板同步時再匯入（ingest.mjs runNewsFeedImport）。這樣手機／伺服器沒開的時候也不會漏收。
 *
 *   node scripts/collect-news-rss.mjs --out ../news-data
 *
 * 只用 node 內建模組（不需要 npm install），不碰資料庫。
 * 一家抓不到只印警告（GitHub Actions 的 ::warning::）；全部失敗才 exit 1，讓 Actions 顯示紅燈。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG } from '../server/config.mjs';
import { fetchJson } from '../server/fetch-ly.mjs';
import { parseNewsRss } from '../server/normalize.mjs';
import { feedDate, mergeFeedFile, outletLabel } from '../server/news-feed.mjs';

const { values: args } = parseArgs({ options: { out: { type: 'string', default: 'news-data' } } });

const collectedAt = new Date().toISOString();
// 比保存期限還舊的不收（RSS 偶爾會冒出很久以前的更正稿）
const cutoff = new Date(Date.now() - CONFIG.news.keepDays * 86_400_000).toISOString();
const byDate = new Map();
let failures = 0;
for (const outlet of CONFIG.news.outlets) {
  try {
    const { text } = await fetchJson(outlet.url, { text: true, retries: 2 });
    const items = parseNewsRss(text, { match: () => true, source: outlet.name }).filter((i) => i.published_at >= cutoff);
    for (const i of items) {
      const date = feedDate(i.published_at);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(i);
    }
    console.log(`${outletLabel(outlet)}：${items.length} 則`);
  } catch (error) {
    failures += 1;
    console.log(`::warning::${outletLabel(outlet)} RSS 抓取失敗：${error?.message || error}`);
  }
}

const dir = join(args.out, 'news');
mkdirSync(dir, { recursive: true });
let changed = 0;
for (const [date, items] of byDate) {
  const file = join(dir, `${date}.ndjson`);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = mergeFeedFile(before, items, collectedAt);
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
  }
}
console.log(`寫入 ${changed} 個檔（${[...byDate.keys()].sort().join('、') || '無'}）`);
if (failures === CONFIG.news.outlets.length) {
  console.log('::error::所有 RSS 全部抓取失敗');
  process.exit(1);
}
