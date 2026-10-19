/**
 * 使用者行為：**頁面瀏覽**的最小統計（2026-10-20 使用者要求「知道昨天 user 的行為」）。
 *
 * 設計原則（為什麼長這樣）：
 *  - **不存 IP、不存 cookie 原文**：只存 cookie 的 HMAC 前 8 碼（`viewerHash`）算「幾個 session」，
 *    換一把 `LY_SESSION_SECRET` 就整批對不起來。隱私優先，這是自家站的取捨。
 *  - **只記「瀏覽頁面」**（Accept 含 text/html 的 GET）與**登入成功**，不記 API／靜態檔，
 *    否則一次開頁面會灌進幾十筆 API 請求，看不出行為。
 *  - **當地日期與小時另外存**（`day`／`hour`）：每日統計要用台北時間切日，不能靠 UTC 換算，
 *    存下來也讓查詢不必每次轉時區。
 *  - 資料量小（個位數使用者），直接寫 SQLite；不需要外部 analytics 服務。
 */
import { createHmac } from 'node:crypto';

/** 只接受這幾種；`login` 是登入成功（不算瀏覽，但要看得出「有人開過」） */
export const PAGE_VIEW_KINDS = ['page', 'login'];

/** 常見路徑的中文名稱（給日報文字用；沒列到的照原路徑顯示） */
const PATH_LABELS = {
  '/': '總覽',
  '/budget': '預算審議',
  '/activity': '最近動態',
  '/legislators': '委員',
  '/agencies': '機關／基金',
  '/news': '新聞',
  '/news/all': '新聞（全部）',
  '/news/agencies': '新聞（機關）',
  '/bills': '法案',
  '/votes': '表決',
  '/resolutions': '附帶決議',
  '/facebook/wall': '粉專牆',
  '/my': '我的機關',
  '/login': '登入頁',
  '/council': '議員',
  '/counties': '縣市地圖',
};

const pad2 = (n) => String(n).padStart(2, '0');

/** 當地日期 YYYY-MM-DD（伺服器在台北，用本地時間切日） */
export function localDay(input = Date.now()) {
  const d = new Date(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 前一天的字串（日報預設看昨天） */
export function previousDay(input = Date.now()) {
  return localDay(new Date(input).getTime() - 86_400_000);
}

/**
 * User-Agent 只要分三類就夠回答「手機還是電腦在看」：
 * `mobile`（iPhone／Android／iPad）、`desktop`、`bot`（排程、預覽、curl 這類）。
 */
export function classifyUa(ua = '') {
  const s = String(ua ?? '').toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/bot|crawler|spider|curl\/|wget\/|python-requests|headless|facebookexternalhit|slackbot|telegrambot/.test(s)) return 'bot';
  if (/iphone|ipad|android|mobile|tablet/.test(s)) return 'mobile';
  return 'desktop';
}

/**
 * cookie → 8 碼識別碼（同一張 cookie 同一個碼；沒有 cookie 回空字串）。
 * 用 HMAC 而不是直接 hash：沒有 secret 的人沒辦法用名單反推。
 */
export function viewerHash(cookieValue, secret) {
  const value = String(cookieValue ?? '');
  if (!value || !secret) return '';
  return createHmac('sha256', String(secret)).update(value).digest('hex').slice(0, 8);
}

export function ensurePageViewTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page',
  -- cookie 的 HMAC 前 8 碼；'' ＝ 沒有 cookie（未登入或已過期）
  session TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_views(day);
`);
}

/** 記一筆。`ts` 可指定（測試用），其餘由呼叫端決定 */
export function recordPageView(db, { path, kind = 'page', sessionHash = '', ua = 'unknown', ts = Date.now() }) {
  if (!PAGE_VIEW_KINDS.includes(kind)) throw new Error(`未知的 kind：${kind}`);
  const date = new Date(ts);
  db.prepare('INSERT INTO page_views(ts, day, hour, path, kind, session, ua) VALUES(?, ?, ?, ?, ?, ?, ?)').run(
    date.toISOString(),
    localDay(ts),
    date.getHours(),
    String(path ?? '/'),
    kind,
    String(sessionHash ?? ''),
    String(ua ?? 'unknown'),
  );
}

/**
 * 某一天的統計：
 * - `pv` 瀏覽次數（含登入那筆？不含——`logins` 另外算，`pv` 只算頁面）
 * - `visitors` 不同 session 數（沒有 cookie 的另外算 `anonymous`）
 * - `paths` 熱門頁面（次數、幾個 session）
 * - `ua` 裝置分類、`hourly` 24 格的瀏覽次數
 */
export function dailyPageViews(db, { date }) {
  const rows = db.prepare('SELECT path, kind, session, ua, hour, ts FROM page_views WHERE day = ? ORDER BY ts').all(String(date));
  const pages = rows.filter((r) => r.kind === 'page');
  const logins = rows.filter((r) => r.kind === 'login');
  const sessions = new Set(pages.map((r) => r.session).filter(Boolean));
  const byPath = new Map();
  for (const r of pages) {
    const entry = byPath.get(r.path) ?? { path: r.path, views: 0, sessions: new Set() };
    entry.views += 1;
    if (r.session) entry.sessions.add(r.session);
    byPath.set(r.path, entry);
  }
  const ua = { mobile: 0, desktop: 0, bot: 0, unknown: 0 };
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const r of pages) {
    ua[r.ua in ua ? r.ua : 'unknown'] += 1;
    if (r.hour >= 0 && r.hour < 24) hourly[r.hour] += 1;
  }
  const labelled = (path) => PATH_LABELS[path] ?? path;
  return {
    date: String(date),
    pv: pages.length,
    visitors: sessions.size,
    anonymous: pages.filter((r) => !r.session).length,
    logins: logins.length,
    loginVisitors: new Set(logins.map((r) => r.session).filter(Boolean)).size,
    paths: [...byPath.values()]
      .map((e) => ({ path: e.path, label: labelled(e.path), views: e.views, visitors: e.sessions.size }))
      .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path)),
    ua,
    hourly,
    first: rows[0]?.ts ?? null,
    last: rows.at(-1)?.ts ?? null,
  };
}

/** 清掉太舊的資料（預設留 400 天）；回傳刪掉幾筆 */
export function prunePageViews(db, { keepDays = 400, now = Date.now() } = {}) {
  const cutoff = localDay(now - Math.max(1, Number(keepDays) || 400) * 86_400_000);
  const info = db.prepare('DELETE FROM page_views WHERE day < ?').run(cutoff);
  return Number(info.changes ?? 0);
}

/** 一天裡最忙的時段（給日報一句話） */
export function busiestHours(summary, { width = 3, top = 1 } = {}) {
  const buckets = [];
  for (let h = 0; h < 24; h += width) {
    const views = summary.hourly.slice(h, h + width).reduce((n, v) => n + v, 0);
    if (views > 0) buckets.push({ from: h, to: h + width - 1, views });
  }
  return buckets.sort((a, b) => b.views - a.views || a.from - b.from).slice(0, top);
}

/** 給 Telegram／終端機看的一段文字（沒有資料也要講清楚是「沒人來」而不是壞掉） */
export function pageViewsText(summary) {
  const lines = [];
  lines.push(`📊 立委觀測站 ${summary.date}`);
  if (summary.pv === 0) {
    lines.push('昨天沒有人開站（0 次瀏覽）');
    return lines.join('\n');
  }
  lines.push(`瀏覽 ${summary.pv} 次・${summary.visitors} 個登入者${summary.anonymous > 0 ? `・未登入 ${summary.anonymous} 次` : ''}`);
  if (summary.logins > 0) lines.push(`登入 ${summary.logins} 次`);
  const top = summary.paths.slice(0, 5).map((p) => `${p.label} ${p.views}`);
  if (top.length) lines.push(`熱門：${top.join('｜')}`);
  const ua = [];
  if (summary.ua.mobile) ua.push(`手機 ${summary.ua.mobile}`);
  if (summary.ua.desktop) ua.push(`電腦 ${summary.ua.desktop}`);
  if (summary.ua.bot) ua.push(`機器人 ${summary.ua.bot}`);
  if (ua.length) lines.push(`裝置：${ua.join('・')}`);
  const busiest = busiestHours(summary)[0];
  if (busiest) lines.push(`最忙：${pad2(busiest.from)}–${pad2(busiest.to)} 時（${busiest.views} 次）`);
  if (summary.first && summary.last) {
    // ts 存 UTC；這裡換成當地時間（伺服器在台北）
    const fmt = (iso) => {
      const d = new Date(iso);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };
    lines.push(`最早 ${fmt(summary.first)}・最晚 ${fmt(summary.last)}`);
  }
  return lines.join('\n');
}
