/**
 * API 回應的記憶體暫存（熱資料）。
 *
 * 2026-10-22 使用者：「把主計長、主計總處相關的資料定期下載到暫存，因為大部分的人都會先使用。」
 *
 * 為什麼要做：壓測顯示這台機器卡在**單核 18.5 req/s**（Node 單執行緒 ＋ 同步 SQLite），
 * 而「我的機關（行政院主計總處）」一支就要 **190 ms**、「最近動態」「新聞」各 89 ms ——
 * 同事一進站幾乎都先開那一頁。資料一天才更新一次，同一份 JSON 反覆重算完全沒有意義。
 *
 * 兩層：
 *  1. 一般 `/api/v1/*` GET：TTL 60 秒。同步寫入資料後整批清掉（見 index.mjs 的 setAfterDataWrite），
 *     所以「剛同步完還看到舊數字」最多 60 秒，而且真的同步完會立刻失效。
 *  2. 熱門（主計總處／主計長／**有預計會議的機關**）：由排程每 5 分鐘主動重跑一次，讓它一直是溫的，
 *     第一個人進來不必付那 190 ms。
 *
 * **不要快取的**：`/api/v1/health`（前端用它顯示同步進度，快取會讓進度停住）、
 * `/api/v1/sync-sources`（按鈕上的「上次同步」時間）、`/api/v1/page-views`（統計，量很小）。
 *
 * 金鑰一律**正規化**（參數排序、丟掉空值）：前端 `buildUrl()` 會省略空字串，但快取與預熱兩邊
 * 不見得用同一個順序組字串，不正規化就會「預熱了卻沒命中」。
 */
import { agencyMatchTerms, getAgencyHome, listActivity, listAgencies, listBills, listBudget, listCommitteeActivity, listLegislators, listNews, listNewsArticles } from './queries.mjs';
import { listUpcomingMeetings } from './forecast.mjs';

/** 一般回應的存活時間（毫秒） */
export const DEFAULT_TTL_MS = 60_000;
/** 熱門項目由排程重跑的間隔（毫秒） */
export const HOT_REFRESH_MS = 5 * 60_000;
/** 記憶體裡最多留幾個回應（每個 1 KB–200 KB，抓 400 個上限約 10 MB 級） */
export const MAX_ENTRIES = 400;

/** 這三個端點不快取：畫面要用它們判斷「現在」的狀態 */
export const CACHE_SKIP_PATHS = new Set(['/api/v1/health', '/api/v1/sync-sources', '/api/v1/page-views']);

const store = new Map();
let hits = 0;
let misses = 0;

/** 正規化的金鑰：參數排序、丟掉空值（`?a=1&b=` 與 `?a=1` 是同一份） */
export function cacheKey(path, search = '') {
  const params = [...new URLSearchParams(String(search ?? '').replace(/^\?/, '')).entries()].filter(([, value]) => value !== '');
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const qs = new URLSearchParams(params).toString();
  return qs ? `${path}?${qs}` : path;
}

export function isCacheable(path, method = 'GET') {
  return method === 'GET' && String(path).startsWith('/api/v1/') && !CACHE_SKIP_PATHS.has(String(path));
}

/** 金鑰一律正規化（存與取都要走這裡，否則「預熱時用人看得懂的字、請求時用 %XX」就永遠不命中） */
const normalize = (key) => {
  const raw = String(key ?? '');
  const at = raw.indexOf('?');
  return at < 0 ? cacheKey(raw) : cacheKey(raw.slice(0, at), raw.slice(at));
};

/** 取一份還沒過期的回應（回傳 JSON 字串）；過期就順手刪掉 */
export function cacheGet(key, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  key = normalize(key);
  const entry = store.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (now - entry.at > ttlMs) {
    store.delete(key);
    misses += 1;
    return null;
  }
  hits += 1;
  return entry.body;
}

/** 存一份回應；超過上限時丟掉最舊的（Map 的插入順序＝寫入順序） */
export function cacheSet(key, body, { now = Date.now() } = {}) {
  if (typeof body !== 'string' || !body) return;
  key = normalize(key);
  store.delete(key);
  store.set(key, { body, at: now });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

export function cacheClear() {
  store.clear();
}

export function cacheStats() {
  return { keys: store.size, hits, misses, limit: MAX_ENTRIES };
}

/**
 * 熱門資料：主計總處與主計長相關（同事一進站最常先看的那幾頁）＋總覽頁會打的便宜查詢。
 * `run(db)` 回傳的就是路由會回給前端的那個物件，`key` 則是前端實際會打的網址（正規化後）。
 */
export const FIXED_TARGETS = [
  { label: '我的機關（主計總處）', key: '/api/v1/agency?name=行政院主計總處', run: (db) => getAgencyHome(db, { name: '行政院主計總處' }) },
  { label: '主計長新聞（陳淑姿）', key: '/api/v1/news/articles?legislator=陳淑姿&limit=30&offset=0&scope=officials', run: (db) => listNewsArticles(db, { legislator: '陳淑姿', scope: 'officials', limit: 30, offset: 0 }) },
  { label: '機關首長新聞', key: '/api/v1/news/articles?limit=30&offset=0&scope=officials', run: (db) => listNewsArticles(db, { scope: 'officials', limit: 30, offset: 0 }) },
  { label: '主計相關委員會動態', key: '/api/v1/committee-activity?limit=20&q=行政院主計總處 主計總處 主計長', run: (db) => listCommitteeActivity(db, { q: '行政院主計總處 主計總處 主計長', limit: 20 }) },
  { label: '總覽：最近動態', key: '/api/v1/activity?limit=4', run: (db) => listActivity(db, { limit: 4 }) },
  { label: '總覽：新聞', key: '/api/v1/news?limit=8', run: (db) => listNews(db, { limit: 8 }) },
  { label: '總覽：法案', key: '/api/v1/bills?limit=3', run: (db) => listBills(db, { limit: 3 }) },
  { label: '總覽：預算', key: '/api/v1/budget?limit=3', run: (db) => listBudget(db, { limit: 3 }) },
  { label: '總覽：會議預告', key: '/api/v1/meetings/upcoming?days=10&limit=1', run: (db) => listUpcomingMeetings(db, { days: 10, limit: 1 }) },
  { label: '會議預告（委員會頁）', key: '/api/v1/meetings/upcoming?days=10', run: (db) => listUpcomingMeetings(db, { days: 10 }) },
  { label: '委員名錄', key: '/api/v1/legislators?session=all', run: (db) => listLegislators(db, { session: 'all' }) },
];

/** 動態名單最多預熱幾個機關（每次重跑約 25 ms／個，40 個約 1 秒，5 分鐘一次） */
export const UPCOMING_AGENCY_CAP = 40;

/**
 * 不進動態名單的機關。
 *
 * `立法院`：每一場的標題都含「立法院第11屆…」，比對起來永遠是場次最多的那個，會把真正的部會擠掉；
 * 而它是提問的一方，沒有人會開「立法院」那一頁查自己被誰備詢。
 * `行政院` 要留著（2026-10-22 使用者：行政院留著）—— 院會被要求報告、函送，是實實在在要備詢的機關。
 */
export const UPCOMING_AGENCY_SKIP = new Set(['立法院']);

/**
 * 有預計會議的機關（2026-10-22 使用者：「還有預計有會議的機關」）。
 *
 * 這些機關是下週真的有人要來備詢的，同事一定會先開那一頁；比「所有人平均」值得預熱。
 * 判定方式跟「我的機關」的即將召開完全一樣：用 `agencyMatchTerms()` 的詞去比對場次標題與議程
 * （簡稱也要算，例：議程寫「央行總裁」時中央銀行也要在名單裡）。
 * 回傳照「最早場次」排，超過上限就砍後面的。
 */
export function agenciesWithUpcoming(db, { days = 10, cap = UPCOMING_AGENCY_CAP, names = null, today = '' } = {}) {
  const upcoming = listUpcomingMeetings(db, { days, limit: 500, today });
  if (!upcoming.items.length) return [];
  const agencies = (names ?? listAgencies(db).map((a) => a.name)).filter((name) => !UPCOMING_AGENCY_SKIP.has(name));
  const found = [];
  for (const name of agencies) {
    const terms = agencyMatchTerms(name);
    let first = null;
    let count = 0;
    for (const meeting of upcoming.items) {
      const text = `${meeting.title ?? ''} ${meeting.agenda ?? ''} ${meeting.committee ?? ''}`;
      if (!terms.some((t) => text.includes(t))) continue;
      count += 1;
      const at = `${meeting.date} ${meeting.time ?? ''}`;
      if (!first || at < first) first = at;
    }
    if (count) found.push({ name, count, first });
  }
  found.sort((a, b) => a.first.localeCompare(b.first) || b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
  return found.slice(0, cap);
}

/**
 * 這一輪要預熱的清單：固定那幾支 ＋ 有預計會議的機關（每輪重算，會議過期就自動掉出名單）。
 */
export function buildTargets(db, { days = 10, cap = UPCOMING_AGENCY_CAP, today = '', names = null } = {}) {
  const dynamic = agenciesWithUpcoming(db, { days, cap, today, names }).map((a) => ({
    label: `${a.name}（有預計會議 ${a.count} 場）`,
    key: `/api/v1/agency?name=${a.name}`,
    run: (database) => getAgencyHome(database, { name: a.name }),
  }));
  return [...FIXED_TARGETS, ...dynamic];
}

/**
 * 重跑熱門查詢並寫回暫存。單一項失敗只記 log（暫存是加速，不是功能）。
 * 回傳每一項的耗時，方便 log 看得出來哪一支變慢了。
 */
export async function refreshHotCache(db, { logger = console, targets = null, yieldFn = () => new Promise((r) => setImmediate(r)) } = {}) {
  const started = Date.now();
  if (!targets) targets = buildTargets(db);
  const dynamic = targets.length - FIXED_TARGETS.length;
  const timings = [];
  let ok = 0;
  for (const target of targets) {
    await yieldFn(); // 讓真的使用者請求可以插隊
    const t0 = Date.now();
    try {
      const payload = target.run(db);
      cacheSet(target.key, JSON.stringify(payload));
      ok += 1;
      timings.push({ label: target.label, ms: Date.now() - t0 });
    } catch (error) {
      logger.warn(`[hot-cache] ${target.label} 失敗：${error?.message ?? error}`);
    }
  }
  const slowest = timings.sort((a, b) => b.ms - a.ms)[0];
  logger.log(
    `[hot-cache] 預熱 ${ok}/${targets.length}（固定 ${FIXED_TARGETS.length}＋有預計會議的機關 ${dynamic}），` +
      `${Date.now() - started} ms（最慢：${slowest?.label ?? '—'} ${slowest?.ms ?? 0} ms）`,
  );
  return { ok, total: targets.length, timings };
}
