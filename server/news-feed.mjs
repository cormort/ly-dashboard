/**
 * 媒體 RSS 收集檔（news-data 分支）的格式：收集端（scripts/collect-news-rss.mjs，GitHub Actions 每小時跑）
 * 與匯入端（ingest.mjs runNewsFeedImport）共用這一份定義，兩邊不會各寫一套。
 *
 * 每天一個檔 `news/YYYY-MM-DD.ndjson`（日期以臺灣時間的發布日為準），一行一則：
 *   { url, title, summary, source, published_at, collected_at }
 * - 同網址只留一行；再抓到時更新標題、媒體，新摘要是空的就保留舊的，collected_at 保留第一次抓到的時間。
 * - 依 published_at、url 排序，同樣的內容寫出來一模一樣，git diff 只會出現真的新增或變動的行。
 */

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 這則新聞歸到哪一天的檔：臺灣時間的發布日 */
export const feedDate = (publishedAt) => new Date(Date.parse(publishedAt) + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);

/** 收集檔的網址（base 例如 https://raw.githubusercontent.com/cormort/ly-dashboard/news-data） */
export const feedFileUrl = (base, date) => `${base.replace(/\/$/, '')}/news/${date}.ndjson`;

/** 讀一個收集檔；壞掉的行（例如寫到一半）略過，不讓一行拖垮整天 */
export function parseFeedFile(text) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.url && item.title && item.published_at && !Number.isNaN(Date.parse(item.published_at))) items.push(item);
    } catch {
      // 略過壞行
    }
  }
  return items;
}

/** 把新抓到的 items 併進某一天既有的檔案內容，回傳新內容 */
export function mergeFeedFile(text, items, collectedAt) {
  const byUrl = new Map(parseFeedFile(text).map((i) => [i.url, i]));
  for (const i of items) {
    const old = byUrl.get(i.url);
    byUrl.set(i.url, {
      url: i.url,
      title: i.title,
      summary: i.summary || old?.summary || '',
      source: i.source || old?.source || '',
      published_at: i.published_at,
      collected_at: old?.collected_at ?? collectedAt,
    });
  }
  const lines = [...byUrl.values()]
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.url.localeCompare(b.url))
    .map((i) => JSON.stringify(i));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
