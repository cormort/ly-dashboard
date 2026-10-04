/**
 * 媒體 RSS 收集檔（news-data 分支）的格式：收集端（scripts/collect-news-rss.mjs，GitHub Actions 每小時跑）
 * 與匯入端（ingest.mjs runNewsFeedImport）共用這一份定義，兩邊不會各寫一套。
 *
 * 每天一個檔 `news/YYYY-MM-DD.ndjson`（日期以臺灣時間的發布日為準），一行一則：
 *   { url, title, summary, source, published_at, collected_at[, origin] }
 * origin 只有從「下載 CSV」匯入的歷史新聞才有（'google'＝Google 新聞的轉址連結），沒有＝媒體 RSS。
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

/**
 * 新聞頁「下載 CSV」的內容 → 收集檔的 items（把手動匯出的歷史新聞併進 news-data 用，見 scripts/import-news-csv.mjs）。
 * rows 是 parseCsv 的結果（第一列是表頭）；發布時間是臺灣時間「YYYY-MM-DD HH:mm」。CSV 沒有摘要。
 * 欄位以表頭名稱找，不寫死位置（機關新聞的 CSV 多一欄「提到的機關」）。
 */
export function csvRowsToFeedItems(rows) {
  const [header = [], ...body] = rows;
  const col = (name) => header.findIndex((h) => h.trim() === name);
  const at = { time: col('發布時間'), source: col('媒體'), title: col('標題'), url: col('連結') };
  const missing = Object.entries(at).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`CSV 缺少欄位：${missing.join('、')}（要用新聞頁「下載 CSV」匯出的檔）`);
  const items = [];
  for (const r of body) {
    const published = Date.parse(`${String(r[at.time] ?? '').trim().replace(' ', 'T')}:00+08:00`);
    const url = String(r[at.url] ?? '').trim();
    const title = String(r[at.title] ?? '').trim();
    if (!url || !title || Number.isNaN(published)) continue;
    items.push({ url, title, summary: '', source: String(r[at.source] ?? '').trim(), published_at: new Date(published).toISOString(), origin: url.startsWith('https://news.google.com/') ? 'google' : 'outlet' });
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
      ...((i.origin ?? old?.origin) ? { origin: i.origin ?? old.origin } : {}),
    });
  }
  const lines = [...byUrl.values()]
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.url.localeCompare(b.url))
    .map((i) => JSON.stringify(i));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
