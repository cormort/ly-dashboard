import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, getMeta, setMeta } from './db.mjs';
import {
  billsCsv, budgetCsv, newsCsv, compareLegislators, listBudget, listCounties, listLegislatorVotes, listSplitTicket, listDemographics, listPopulationTrend, getTownMap, listRegions, listFunds, getAgencyHome, listCommitteeActivity, listBudgetMeetings, listBudgetTimeline, listBudgetReports, getHealth, getMetaPayload, listActivity, listBills, listCosponsors, listNews, listNewsArticles, listTopics, listChanges,
  listCommittees, listLegislators, listRankings, listSyncRuns, listRecalls, listCouncil, listCouncilActivity, councilCounties,
  listSocialWall, listRollcalls, listResolutions,
  listSyncSources,
} from './queries.mjs';
import { runAll, runOutletPoll } from './ingest.mjs';
import { resolveScope, scopeStages } from './sync-scopes.mjs';
import { checkSyncGuard } from './sync-guard.mjs';
import { getProgress, clearProgress } from './sync-progress.mjs';
import {
  SESSION_COOKIE,
  createLoginThrottle,
  needsRenewal,
  sessionExpiresAt,
  isPublicOrigin,
  isPublicPath,
  loginPageHtml,
  readCookie,
  safeEqual,
  safeNext,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.mjs';
import { warmUp } from './warmup.mjs';
import { listUpcomingMeetings } from './forecast.mjs';
import {
  classifyUa,
  dailyPageViews,
  ensurePageViewTable,
  pageViewsText,
  previousDay,
  prunePageViews,
  recordPageView,
  viewerHash,
} from './page-views.mjs';
import { DEFAULT_ENV_FILE as NOTIFY_ENV_FILE, parseEnvFile, sendTelegram } from '../scripts/notify-telegram.mjs';

let inflight = null;
let inflightScope = null;

/** 目前進行中的同步範圍（見 server/sync-scopes.mjs 的 id），沒有同步時為 null */
export function getInflightScope() {
  return inflightScope;
}

/**
 * Single-flight：同時只允許一個同步在跑（M3）。
 * `scope` 見 server/sync-scopes.mjs：'all'＝全部 9 個階段（實測約 13 分鐘，其中新聞 763 秒），
 * 'social'＝只重讀社群粉專（實測 2 秒）、'roster'、'news'、'legislative'。認不得的值一律退回 'all'。
 */
/**
 * 資料寫入（同步、媒體 RSS 輪詢）結束後要做的事；只有真正的伺服器行程會設（用來預熱，見 server/warmup.mjs），
 * 測試不設，所以 syncOnce 在測試裡的行為不變。
 */
let afterDataWrite = null;
export function setAfterDataWrite(fn) {
  afterDataWrite = fn;
}

export function syncOnce(db, options = {}) {
  if (!inflight) {
    const scope = resolveScope(options.scope).id;
    inflightScope = scope;
    inflight = runAll(db, { ...options, stages: scopeStages(scope) }).finally(() => {
      inflight = null;
      inflightScope = null;
      clearProgress();
      afterDataWrite?.();
    });
  }
  return inflight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // PWA 的 manifest 一定要用這個 MIME，否則部分瀏覽器不認（T11）
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 所有回應都加上：不要讓瀏覽器猜 content-type（靜態檔可能是使用者上傳以外的內容）
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' };

/** 常數時間比對，避免用前綴或長度差異時間側錄 token（CR-7） */
export function syncTokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * CR-7／D8：`POST /api/v1/sync` 的授權判斷（純函式，可單獨測試）。回傳 null 代表放行。
 *
 * 規則刻意做成「不安全就不開放」而不是「不安全就警告」：
 * - 設了 `LY_SYNC_TOKEN` → 一律要求 `x-sync-token` 且正確，否則 401。
 * - 沒設 token → 只有綁在 loopback 時才開放；一旦 `LY_HOST` 指向外部，直接 403 停用，
 *   而不是讓任何人按一下就把伺服器的工作排程塞滿。
 */
export function authorizeSync(headers = {}, { host = CONFIG.host, token = CONFIG.syncToken } = {}) {
  if (token) {
    return syncTokenMatches(headers['x-sync-token'], token)
      ? null
      : { status: 401, code: 'unauthorized', message: 'POST /api/v1/sync 需要正確的 x-sync-token 標頭' };
  }
  if (!LOOPBACK_HOSTS.has(String(host))) {
    return {
      status: 403,
      code: 'sync_disabled',
      message: `未設定 LY_SYNC_TOKEN 時僅允許從 loopback 觸發同步（目前 LY_HOST=${host}）`,
    };
  }
  return null;
}

const sendJson = (res, status, payload, extraHeaders = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'public, max-age=300',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
};

// Excel 要 BOM 才會把 UTF-8 當中文；不快取，每次都是當下條件的完整結果
const sendCsv = (res, filename, body) => {
  const buf = Buffer.from(`\uFEFF${body}`, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': buf.length,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(buf);
};

const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } }, { 'cache-control': 'no-store' });

/* ---------- App 層登入（cookie session）----------
 * 沒設 LY_LOGIN_PASSWORD_HASH／LY_SESSION_SECRET 就維持舊行為（不啟用登入），
 * 這樣本機開發與既有測試完全不受影響；正式站由 ~/.ly-dashboard/server.env 打開。 */
const AUTH = {
  user: process.env.LY_LOGIN_USER || 'DGBAS',
  hash: process.env.LY_LOGIN_PASSWORD_HASH || '',
  secret: process.env.LY_SESSION_SECRET || '',
  days: Math.max(1, Math.min(3650, Number(process.env.LY_SESSION_DAYS) || 180)),
  renewDays: Math.max(0, Math.min(3650, Number(process.env.LY_SESSION_RENEW_DAYS) || 30)),
};
const authEnabled = () => Boolean(AUTH.hash && AUTH.secret);
const loginThrottle = createLoginThrottle();

/* ---------- 這個入口提供哪幾區 ----------
 * LY_HIDE_COUNTIES=1／LY_HIDE_COUNCIL=1：整台機器都不提供（例如沒有排人口更新的主機）。
 * 另外「公開入口」（經過 Caddy、帶 X-Ly-Public）預設不提供縣市地圖與議員，
 * 內網／tailnet 的 :10000 不受影響。 */
const FEATURES = {
  counties: process.env.LY_HIDE_COUNTIES !== '1',
  council: process.env.LY_HIDE_COUNCIL !== '1',
};

const sendLoginPage = (res, status, options = {}) => {
  const body = Buffer.from(loginPageHtml({ ...options, user: AUTH.user, days: AUTH.days }), 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    ...SECURITY_HEADERS,
  });
  res.end(body);
};

const readFormBody = (req, limit = 8192) =>
  new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve('');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
    req.on('aborted', () => resolve(''));
  });

async function handleLogin(req, res, db) {
  const retryAfter = loginThrottle.retryAfterSeconds();
  if (retryAfter > 0) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(retryAfter), 'cache-control': 'no-store' });
    res.end(`嘗試次數過多，請約 ${Math.ceil(retryAfter / 60)} 分鐘後再試。`);
    return;
  }
  const form = new URLSearchParams(await readFormBody(req));
  const next = safeNext(form.get('next'));
  const okUser = safeEqual(form.get('username') ?? '', AUTH.user);
  const okPass = await verifyPassword(form.get('password') ?? '', AUTH.hash);
  if (!(okUser && okPass)) {
    loginThrottle.fail();
    await new Promise((resolve) => setTimeout(resolve, 300)); // 讓暴力嘗試變慢
    sendLoginPage(res, 401, { error: '帳號或密碼不正確', next });
    return;
  }
  loginThrottle.reset();
  const expiresAt = Date.now() + AUTH.days * 86_400_000;
  const freshSession = signSession(expiresAt, AUTH.secret);
  // 登入成功另記一筆（kind=login）：看得到「誰開了站」而不只是「頁面被看幾次」
  try {
    if (db) {
      recordPageView(db, {
        path: '/login',
        kind: 'login',
        sessionHash: viewerHash(freshSession, AUTH.secret),
        ua: classifyUa(req.headers['user-agent']),
      });
    }
  } catch (error) {
    console.error(`[page-views] 登入記錄失敗：${error?.message ?? error}`);
  }
  res.writeHead(303, {
    'set-cookie': sessionSetCookie(freshSession, AUTH.days * 86_400),
    location: next,
    'cache-control': 'no-store',
  });
  res.end();
}

async function serveStatic(res, urlPath) {
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const candidates = [join(CONFIG.webDist, safePath === '/' ? 'index.html' : safePath)];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      const body = await readFile(candidate);
      const ext = extname(candidate);
      const filename = candidate.slice(candidate.lastIndexOf('/') + 1);
      // Service Worker 一定要能被更新：絕不長快取（否則使用者會卡在舊版 SW，改了也拿不到）。
      const isServiceWorker = filename === 'sw.js';
      const immutable = !isServiceWorker && candidate.includes('/assets/');
      const cacheControl = isServiceWorker
        ? 'no-cache, no-store, must-revalidate'
        : immutable
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': cacheControl,
        ...SECURITY_HEADERS,
      });
      res.end(body);
      return true;
    } catch {
      /* 繼續找 */
    }
  }
  return false;
}

/**
 * 記錄一次「頁面瀏覽」（見 server/page-views.mjs 為什麼只記這些）。
 *
 * 只算 **Accept 含 text/html 的 GET**：PWA／瀏覽器開頁面會帶，Service Worker 預抓的資產、
 * API 呼叫、圖片都不會。SW 的離線導覽也是導覽請求，所以照算。
 * 記錄失敗不能影響請求（統計是加分項，不是功能）。
 */
function recordViewIfPage(db, req, path) {
  try {
    if (req.method !== 'GET') return;
    if (!String(req.headers.accept ?? '').includes('text/html')) return;
    if (path.startsWith('/api/') || path.includes('.')) return; // 靜態檔（.js/.css/.png…）不算
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    recordPageView(db, {
      path,
      sessionHash: viewerHash(session, AUTH.secret),
      ua: classifyUa(req.headers['user-agent']),
    });
  } catch (error) {
    console.error(`[page-views] 記錄失敗：${error?.message ?? error}`);
  }
}

export function createServer(db) {
  ensurePageViewTable(db);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());
    recordViewIfPage(db, req, path);

    try {
      if (authEnabled()) {
        if (path === '/api/v1/login' && req.method === 'POST') return void (await handleLogin(req, res, db));
        if (path === '/login') return sendLoginPage(res, 200, { next: safeNext(q.next) });
        if (path === '/logout') {
          res.writeHead(303, { 'set-cookie': sessionClearCookie(), location: '/login', 'cache-control': 'no-store' });
          return res.end();
        }
        // 公開來源＝經過 Caddy（有 x-forwarded-for）。loopback／tailnet 本來就只有自己連得到。
        if (!isPublicPath(path) && isPublicOrigin(req.headers)) {
          const session = readCookie(req.headers.cookie, SESSION_COOKIE);
          if (!verifySession(session, AUTH.secret)) {
            if (path.startsWith('/api/')) return sendError(res, 401, 'login_required', '請先登入');
            // 導覽請求回 401 + 登入頁：Service Worker 不會快取非 2xx，所以不會把登入頁記成外框
            return sendLoginPage(res, 401, { next: safeNext(path) });
          }
          // 滑動續期：剩不到 N 天就換一張新的，PWA 有在用就一直不用重新登入
          const expiresAt = sessionExpiresAt(session);
          if (AUTH.renewDays > 0 && needsRenewal(expiresAt, Date.now(), AUTH.renewDays * 86_400_000)) {
            const fresh = Date.now() + AUTH.days * 86_400_000;
            res.setHeader('set-cookie', sessionSetCookie(signSession(fresh, AUTH.secret), AUTH.days * 86_400));
            res.setHeader('cache-control', 'no-store');
          }
        }
      }
      if (path.startsWith('/api/')) {
        if (req.method !== 'GET' && !(path === '/api/v1/sync' && req.method === 'POST')) {
          return sendError(res, 405, 'method_not_allowed', `${req.method} 不支援`);
        }
        switch (path) {
          case '/api/v1/page-views': {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date ?? '')) ? String(q.date) : previousDay();
            return sendJson(res, 200, dailyPageViews(db, { date }));
          }
          case '/api/v1/health':
            // progress：現在跑到哪（例如新聞 137/601）。單一資料集內部一大串請求時，
            // 只靠 sync_runs 會十幾分鐘都是「已完成 0 個來源」，所以另外回報細部進度。
            const publicEntry = isPublicOrigin(req.headers);
            // 公開入口不提供縣市地圖與議員（D-公開站收斂）；純讀取端點照舊，只是前端不顯示
            return sendJson(res, 200, {
              ...getHealth(db),
              sync_enabled: authorizeSync({}) === null,
              counties_enabled: FEATURES.counties && !publicEntry,
              council_enabled: FEATURES.council && !publicEntry,
              syncing: getInflightScope(),
              progress: getProgress(),
            });
          case '/api/v1/meta':
            return sendJson(res, 200, getMetaPayload(db));
          case '/api/v1/legislators':
            return sendJson(res, 200, listLegislators(db, q));
          case '/api/v1/committees':
            return sendJson(res, 200, listCommittees(db, q));
          case '/api/v1/bills': {
            const filters = { legislator: q.legislator || null, q: q.q, law: q.law, status: q.status, session: q.session, from: q.from, to: q.to };
            if (q.format === 'csv') return sendCsv(res, 'bills.csv', billsCsv(listBills(db, { ...filters, all: true }).items));
            return sendJson(res, 200, listBills(db, { ...filters, limit: q.limit, offset: q.offset }));
          }
          case '/api/v1/budget': {
            const filters = {
              category: q.category,
              type: q.type,
              q: q.q,
              year: q.year,
              proposer: q.proposer,
              state: q.state,
              // 分年度呈現：group_by=year 會回 groups（每年統計＋前幾筆）
              groupBy: q.group_by,
              perGroup: q.per_group,
              // 統計範圍：bills（預設，只算預算案本身）／all（含決議書面報告等報告類）
              scope: q.scope,
              // 一案一列（預設）／merge=none 每筆議案都列
              merge: q.merge,
              // 勘誤表這類附件預設排除；include_attachments=1 看回來
              includeAttachments: q.include_attachments === '1',
            };
            if (q.format === 'csv') return sendCsv(res, 'budget.csv', budgetCsv(listBudget(db, { ...filters, all: true }).items));
            return sendJson(res, 200, listBudget(db, { ...filters, limit: q.limit, offset: q.offset }));
          }
          case '/api/v1/budget/reports':
            return sendJson(res, 200, listBudgetReports(db, { type: q.type, q: q.q, limit: q.limit, offset: q.offset }));
          case '/api/v1/budget/meetings':
            return sendJson(res, 200, listBudgetMeetings(db, { limit: q.limit }));
          case '/api/v1/budget/timeline':
            // 同一個預算年度在委員會／聯席／公聽會／黨團協商開過的會議（依時間排）
            return sendJson(res, 200, listBudgetTimeline(db, { year: q.year }));
          case '/api/v1/regions':
            return sendJson(res, 200, listRegions(db, { per: q.per }));
          case '/api/v1/counties':
            return sendJson(res, 200, listCounties(db));
          case '/api/v1/council/activity':
            return sendJson(res, 200, listCouncilActivity(db, { county: q.county, councilor: q.councilor, q: q.q, source: q.source, limit: q.limit, offset: q.offset }));
          case '/api/v1/social/wall':
            // 沒給 limit 時只回「本日及昨日」有更新貼文的委員（見 listSocialWall）；committee 用目前會期的常設委員會席位
            return sendJson(res, 200, listSocialWall(db, { party: q.party, region: q.region, committee: q.committee, limit: q.limit, offset: q.offset }));
          case '/api/v1/council': {
            // ?only=counties：只回有建置的縣市清單（縣市地圖判斷要不要連到議員頁用，不必抓整包選舉資料）
            if (q.only === 'counties') return sendJson(res, 200, { counties: councilCounties() });
            // 沒有建置的縣市回 404 而不是空殼，前端才分得出「沒這個縣市」與「沒資料」；
            // 訊息要列出真的有哪些，否則使用者只知道錯、不知道能查什麼
            const council = listCouncil(db, { county: q.county });
            if (!council) {
              const available = councilCounties();
              return sendError(res, 404, 'county_not_found', `沒有「${q.county ?? ''}」的議員選舉資料（目前建置：${available.join('、') || '無'}）`);
            }
            return sendJson(res, 200, council);
          }
          case '/api/v1/town-map':
            return sendJson(res, 200, getTownMap(db));
          case '/api/v1/population-trend':
            return sendJson(res, 200, listPopulationTrend(db));
          case '/api/v1/demographics':
            return sendJson(res, 200, listDemographics(db));
          case '/api/v1/split-ticket':
            return sendJson(res, 200, listSplitTicket(db, { year: q.year }));
          case '/api/v1/legislator-votes':
            return sendJson(res, 200, listLegislatorVotes(db, { id: q.id || null }));
          case '/api/v1/votes':
            return sendJson(res, 200, listRollcalls(db, { term: q.term, q: q.q, legislator: q.legislator, from: q.from, to: q.to, limit: q.limit, offset: q.offset }));
          case '/api/v1/resolutions':
            return sendJson(res, 200, listResolutions(db, { term: q.term, q: q.q, limit: q.limit, offset: q.offset }));
          case '/api/v1/meetings/upcoming':
            return sendJson(res, 200, listUpcomingMeetings(db, { days: q.days, limit: q.limit }));
          case '/api/v1/committee-activity':
            return sendJson(res, 200, listCommitteeActivity(db, { committee: q.committee, q: q.q, limit: q.limit }));
          case '/api/v1/agency':
            return sendJson(res, 200, getAgencyHome(db, { name: q.name, per: q.per, watch: q.watch }));
          case '/api/v1/funds':
            return sendJson(res, 200, listFunds(db, { type: q.type, fund: q.fund, kind: q.kind, limit: q.limit, offset: q.offset }));
          case '/api/v1/cosponsors':
            return sendJson(res, 200, listCosponsors(db, { legislator: q.legislator || null, limit: q.limit }));
          case '/api/v1/compare':
            return sendJson(res, 200, compareLegislators(db, { ids: q.ids }));
          case '/api/v1/topics':
            return sendJson(res, 200, listTopics(db, { days: q.days, limit: q.limit, vocab: q.vocab }));
          case '/api/v1/activity':
            return sendJson(res, 200, listActivity(db, { limit: q.limit, ids: q.ids || null }));
          case '/api/v1/news':
            return sendJson(res, 200, listNews(db, { legislator: q.legislator || null, limit: q.limit }));
          case '/api/v1/news/articles': {
            const filters = { q: q.q, source: q.source, legislator: q.legislator, scope: q.scope, kind: q.kind };
            if (q.format === 'csv') {
              const scope = ['all', 'officials', 'agencies'].includes(q.scope) ? q.scope : 'legislators';
              return sendCsv(res, `news-${scope}.csv`, newsCsv(listNewsArticles(db, { ...filters, all: true }).items, scope));
            }
            return sendJson(res, 200, listNewsArticles(db, { ...filters, limit: q.limit, offset: q.offset }));
          }
          case '/api/v1/recalls':
            return sendJson(res, 200, listRecalls(db));
          case '/api/v1/rankings':
            return sendJson(res, 200, listRankings(db, { type: q.type || 'all', days: q.days, limit: q.limit }));
          case '/api/v1/changes':
            return sendJson(res, 200, listChanges(db, { since: q.since ?? null, limit: q.limit ?? 100 }));
          case '/api/v1/sync-runs':
            return sendJson(res, 200, listSyncRuns(db, { limit: q.limit ?? 50 }));
          // 同步範圍（下拉選單）：每個範圍涵蓋哪些來源、上次同步時間、上次耗時
          case '/api/v1/sync-sources':
            return sendJson(res, 200, listSyncSources(db), { 'cache-control': 'no-store' });
          case '/api/v1/sync': {
            // CR-7：這個端點會讓伺服器去打政府 API，不能無條件開放（沒設 token 時只限 loopback）。
            const denied = authorizeSync(req.headers);
            if (denied) return sendError(res, denied.status, denied.code, denied.message);
            // M3：同步可能長達數分鐘，不能在請求裡等。改回 202 並讓它跑在背景，進度看 /sync-runs。
            const scope = resolveScope(q.scope).id;
            // 防呆：按下去不會取得更新的資訊（已在同步／剛同步過）就回 409 明講，不要白跑一趟。
            // 使用者可以用 force=1 強制重跑（見 server/sync-guard.mjs）。
            const force = q.force === '1' || q.force === 'true';
            const guard = checkSyncGuard(db, scope, { force, inflight: getInflightScope() });
            if (!guard.allow) return sendError(res, 409, guard.reason, guard.message);
            const started = true;
            syncOnce(db, { scope }).catch((error) => console.error('[sync] 背景同步失敗', error));
            return sendJson(
              res,
              202,
              {
                accepted: true,
                started,
                scope,
                inflight_scope: getInflightScope(),
                forced: force,
                message: '同步已在背景執行',
                poll: '/api/v1/sync-runs',
              },
              { 'cache-control': 'no-store' },
            );
          }
          default:
            return sendError(res, 404, 'not_found', `未知端點 ${path}`);
        }
      }

      if (await serveStatic(res, path)) return;
      if (await serveStatic(res, '/index.html')) return; // SPA fallback
      return sendError(res, 404, 'not_found', '前端尚未建置：請在 web/ 執行 npm run build');
    } catch (error) {
      // F6：不要把錯誤訊息原封不動回給客戶端 —— 靜態檔的 ENOENT／JSON 解析錯誤會讓它
      // 變成常態路徑，而訊息裡含伺服器的絕對路徑。完整錯誤留在伺服器日誌。
      console.error('[api] 未預期錯誤', error);
      return sendError(res, 500, 'internal_error', '伺服器內部錯誤（詳見伺服器日誌）');
    }
  });
}

/**
 * 媒體 RSS 的每小時輪詢（feed 只留最新幾十則，一天抓一次會漏）。
 * 完整同步正在跑時跳過：完整同步本身就會抓媒體 RSS，兩邊同時寫只是重工。
 */
let outletInflight = null;
export function pollOutletsOnce(db, options = {}) {
  if (CONFIG.skip.news || inflight || outletInflight) return Promise.resolve({ status: 'skipped' });
  outletInflight = runOutletPoll(db, options).finally(() => {
    outletInflight = null;
    // 每小時的 RSS 會寫進 articles → 合併新聞的快取版本變了，下一個請求要重算，所以也預熱
    afterDataWrite?.();
  });
  return outletInflight;
}

/**
 * 現在該不該同步？「資料超過 syncIntervalMs（預設 24 小時）沒成功更新，而且沒有同步在跑」才要。
 *
 * 原本是固定 24 小時的 setInterval：某輪失敗要再等整整一天才會重試，Mac 睡著時 Node 的 timer
 * 也不會補跑（只有啟動時檢查一次 fresh）。改成每小時問一次這個問題，就同時解掉這兩個缺口，
 * 而資料新鮮時一次 API 都不會打。
 */
export function shouldSyncNow(db, { inflightScope = getInflightScope(), now = Date.now() } = {}) {
  if (inflightScope) return false;
  const last = getMeta(db, 'last_success_at');
  if (!last) return true;
  const at = new Date(last).getTime();
  return !Number.isFinite(at) || now - at >= CONFIG.syncIntervalMs;
}

/**
 * 新聞階段（Google 逐委員／逐機關那一路）現在該不該重跑？
 *
 * 為什麼不沿用 `shouldSyncNow`：那支看的是**全域** `last_success_at`。任何階段（名錄、議事…）
 * 剛跑完都會把它更新，於是新聞永遠排不到自己的重跑；這裡刻意只看
 * **新聞階段自己的最後成功時間**（`sync_runs` 逐 dataset 有紀錄）。
 *
 * 條件（全過才要跑）：
 *  - `intervalMs > 0`（0＝停用，只跟著 24 小時的全同步）；
 *  - 沒有同步在跑（single-flight）；
 *  - 從沒成功過，或距離上次成功已達 `intervalMs`。
 */
export function shouldRefreshNews(db, { now = Date.now(), intervalMs = CONFIG.newsRefreshMs, inflightScope = getInflightScope() } = {}) {
  if (!(intervalMs > 0)) return false;
  if (inflightScope) return false;
  const row = db.prepare("SELECT MAX(finished_at) AS at FROM sync_runs WHERE dataset = 'news' AND status = 'success'").get();
  const last = row?.at;
  if (!last) return true;
  const at = Date.parse(last);
  return !Number.isFinite(at) || now - at >= intervalMs;
}

/**
 * 每天一次把「昨天的使用狀況」推到 Telegram（使用者 2026-10-20 選的方案 A）。
 *
 * 為什麼放在伺服器排程而不是 launchd：`launchctl bootstrap` 不能在這個環境執行（見
 * scripts/launchd/install.sh 的說明），而伺服器本來就由 launchd 監管、一直開著；
 * 排程每小時醒一次，08:10 之後的第一個 tick 就推，時間誤差最多一小時，日報沒差。
 *
 * 規則：
 *  - 只在 08:10（當地）之後推，一天一次；已推過的日期記在 meta `page_views_reported_day`。
 *  - **先標記再送**：送失敗也不重試，避免每小時重推同一則（失敗訊息留在 log）。
 *  - 昨天 0 次瀏覽就不推（不要每天收到「沒有人開站」）。
 *  - 沒有 `~/.ly-dashboard/notify.env` 憑證時只寫 log。
 */
async function maybeSendPageViewReport(db, { logger = console, now = new Date() } = {}) {
  try {
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    if (minutesNow < 8 * 60 + 10) return;
    const day = previousDay(now.getTime());
    if (getMeta(db, 'page_views_reported_day') === day) return;
    prunePageViews(db);
    setMeta(db, 'page_views_reported_day', day);
    const summary = dailyPageViews(db, { date: day });
    if (summary.pv === 0) {
      logger.log(`[page-views] ${day} 沒有人瀏覽，不推播`);
      return;
    }
    const text = pageViewsText(summary);
    const env = { ...parseEnvFile(process.env.LY_NOTIFY_ENV_TEXT ?? ''), ...readNotifyEnv() };
    const token = process.env.LY_TELEGRAM_BOT_TOKEN || env.LY_TELEGRAM_BOT_TOKEN;
    const chatId = process.env.LY_TELEGRAM_CHAT_ID || env.LY_TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      logger.log(`[page-views] 沒有通知憑證，日報只寫 log：\n${text}`);
      return;
    }
    const result = await sendTelegram({ token, chatId, text });
    logger.log(result.ok ? `[page-views] 日報已送出（${day}）` : `[page-views] 日報送出失敗（${day}）：${result.detail}`);
  } catch (error) {
    logger.error(`[page-views] 日報失敗：${error?.message ?? error}`);
  }
}

/** 讀 ~/.ly-dashboard/notify.env（沒有就回空物件；憑證只放那裡，不寫進 repo） */
function readNotifyEnv() {
  try {
    if (!existsSync(NOTIFY_ENV_FILE)) return {};
    return parseEnvFile(readFileSync(NOTIFY_ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function startScheduler(db, { logger = console, checkEveryMs = CONFIG.schedulerCheckMs } = {}) {
  if (shouldSyncNow(db)) {
    logger.log('[scheduler] 資料不存在或已過期，啟動時先同步一次');
    syncOnce(db, { logger }).catch((error) => logger.error('[scheduler] 同步失敗', error));
  }
  const timer = setInterval(() => {
    void maybeSendPageViewReport(db, { logger });
    if (!shouldSyncNow(db)) return;
    const hours = Math.round(CONFIG.syncIntervalMs / 3600_000);
    logger.log(`[scheduler] 資料已超過 ${hours} 小時未成功更新，開始同步`);
    syncOnce(db, { logger }).catch((error) => logger.error('[scheduler] 排程同步失敗', error));
  }, checkEveryMs);
  timer.unref();
  if (CONFIG.news.outletIntervalMs > 0) {
    const outletTimer = setInterval(() => {
      pollOutletsOnce(db, { logger }).catch((error) => logger.error('[scheduler] 媒體 RSS 輪詢失敗', error));
    }, CONFIG.news.outletIntervalMs);
    outletTimer.unref();
  }
  // 新聞階段（Google 那一路）自動重跑：只看新聞自己的上次成功時間，不看全域的 last_success_at。
  // 最多每小時醒一次（wake），真正要不要跑交給 shouldRefreshNews 決定 —— 資料還新就什麼都不做。
  if (CONFIG.newsRefreshMs > 0) {
    const newsTimer = setInterval(() => {
      if (!shouldRefreshNews(db)) return;
      const label =
        CONFIG.newsRefreshMs >= 3600_000
          ? `${Math.round(CONFIG.newsRefreshMs / 3600_000)} 小時`
          : `${Math.round(CONFIG.newsRefreshMs / 60_000)} 分鐘`;
      logger.log(`[scheduler] 新聞已超過 ${label} 未成功更新，開始新聞同步`);
      syncOnce(db, { logger, scope: 'news' }).catch((error) => logger.error('[scheduler] 新聞同步失敗', error));
    }, Math.min(CONFIG.newsRefreshMs, 60 * 60 * 1000));
    newsTimer.unref();
  }
  return timer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  const server = createServer(db);
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[api] 立委輿情觀測站 API 已啟動：http://${CONFIG.host}:${CONFIG.port}（靜態檔：${CONFIG.webDist}）`);
    if (CONFIG.syncToken) console.log('[api] POST /api/v1/sync 已啟用 LY_SYNC_TOKEN 驗證');
    else if (CONFIG.host !== '127.0.0.1' && CONFIG.host !== 'localhost' && CONFIG.host !== '::1') {
      console.log('[api] 注意：LY_HOST 非 loopback 且未設 LY_SYNC_TOKEN → POST /api/v1/sync 已停用（回 403）');
    }
  });
  if (!process.argv.includes('--no-scheduler')) startScheduler(db);

  // 預熱（server/warmup.mjs）：啟動後先跑一次，之後每次資料寫入完再跑；正在跑就不疊第二輪
  let warming = null;
  const warm = () => {
    warming ??= warmUp(db).catch((error) => console.error('[warmup] 失敗', error)).finally(() => {
      warming = null;
    });
  };
  setAfterDataWrite(warm);
  setTimeout(warm, 1000).unref();
}
