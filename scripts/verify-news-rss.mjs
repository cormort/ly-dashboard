#!/usr/bin/env node
/**
 * 驗證媒體官方 RSS（CONFIG.news.outlets）：打真網路，逐家看「抓不抓得到 → 解析得出來嗎 → 真的對得上委員／機關嗎」。
 *
 * 用法：
 *   node scripts/verify-news-rss.mjs                 # 驗 CONFIG 裡的四家
 *   node scripts/verify-news-rss.mjs <url> [<url>…]  # 另外試其他 feed（例如比較 udn 的分類 id）
 *
 * 為什麼要有這支：`runOutletNews` 抓不到只記一則 warning（D96），畫面上完全看不出來 ——
 * 2026-10-03 實測時公視的 Atom 被整家丟掉、聯合的 feed id 指到「全球」分類，
 * 兩件事都不會讓測試變紅，只有真的打出去才會發現。這裡**只讀**：DB 用 in-memory，
 * 不動 data/ 底下的正式資料庫。
 *
 * 每家會打兩次（一次走 `runOutletNews` 的真實路徑、一次看原始 XML 的格式），
 * 四家共 8 個請求，不是拿來排程用的。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { runOutletNews } from '../server/ingest.mjs';
import { fetchJson } from '../server/fetch-ly.mjs';
import { CONFIG } from '../server/config.mjs';

const root = new URL('../', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`test/fixtures/${name}`, root)), 'utf8'));

/** 用測試 fixture 的名錄 seed 一個 in-memory DB：要判斷「這則新聞對不對得上人」就得有委員名單 */
function seeded() {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  applyDataset(db, dataset, { fetchedAt: new Date().toISOString(), sourceUrl: 'https://data.ly.gov.tw/' });
  return db;
}

/** 直接抓原始 bytes（不經過 runOutletNews 的 upsert），只為了看格式是 RSS 還是 Atom。
 *  用專案的 fetchJson 而不是全域 fetch：它才有逾時與重試 —— 全域 fetch 對 feedburner
 *  這種偶爾卡住的來源會一直等下去（實測卡超過 60 秒）。 */
async function rawFetch(url) {
  const { text } = await fetchJson(url, { text: true, retries: 2 });
  return { text };
}

const extra = process.argv.slice(2).filter((a) => a.startsWith('http'));
const outlets = extra.length ? extra.map((url) => ({ name: url, url })) : CONFIG.news.outlets;

const cutoff = new Date(Date.now() - CONFIG.news.keepDays * 86_400_000).toISOString();
const silent = { log() {}, warn() {}, error() {} };
// 中文是全形字（終端機佔 2 格），用 String.length 排版會歪掉
const width = (s) => [...String(s)].reduce((n, c) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);

console.log(`媒體官方 RSS 驗證（cutoff＝${cutoff.slice(0, 10)}，保存 ${CONFIG.news.keepDays} 天）\n`);
console.log(pad('媒體', 16), pad('格式', 10), padL('則數', 6), padL('委員新聞', 10), padL('主題新聞', 10), ' 狀態');

let failed = 0;
for (const outlet of outlets) {
  const row = { name: outlet.name, kind: '—', items: '—', news: '—', topics: '—', status: 'OK' };
  try {
    // 只判斷標籤、不解析：RSS／Atom 混用最容易在這裡發現（公視就是 Atom）
    const { text } = await rawFetch(outlet.url);
    const kind = /<rss[\s>]/.test(text) ? 'RSS 2.0' : /<feed[\s>]/.test(text) ? 'Atom' : '不認得的格式';
    if (kind === '不認得的格式') {
      row.kind = '壞';
      row.status = '失敗：回應不是 RSS 也不是 Atom';
      failed += 1;
    } else {
      row.kind = kind;
      // 走真實路徑：抓 → parseNewsRss → 對委員／機關 → 寫進 in-memory DB
      const db = seeded();
      const result = await runOutletNews(db, { logger: silent, now: () => new Date(), cutoff, outlets: [outlet] });
      row.items = result.items;
      row.news = db.prepare('SELECT COUNT(*) c FROM news').get().c;
      row.topics = db.prepare('SELECT COUNT(*) c FROM topic_news').get().c;
      if (result.failures) {
        row.status = '失敗（解析或抓取錯誤）';
        failed += 1;
      } else if (result.items === 0) {
        row.status = '警告：0 則（feed 空、格式不認得、或全部過期）';
        failed += 1;
      } else if (row.news === 0) {
        // 解析得出來但一則委員新聞都沒對上：通常是 feed 指到錯的分類（D101 的 udn 7225 就是這樣）
        row.status = '警告：完全沒對上委員（分類可能選錯，見 D101）';
        failed += 1;
      }
    }
  } catch (error) {
    row.status = `失敗：${error?.message || error}`;
    failed += 1;
  }
  console.log(
    pad(row.name, 16),
    pad(row.kind, 10),
    padL(row.items, 6),
    padL(row.news, 10),
    padL(row.topics, 10),
    ' ',
    row.status,
  );
  console.log(pad('', 16), `└ ${outlet.url}`);
}

console.log(failed ? `\n結果：${failed} 家／項有問題` : '\n結果：全部正常');
process.exit(failed ? 1 : 0);
