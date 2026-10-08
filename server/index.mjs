import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, getMeta } from './db.mjs';
import {
  billsCsv, budgetCsv, newsCsv, compareLegislators, listBudget, listCounties, listLegislatorVotes, listSplitTicket, listDemographics, listPopulationTrend, getTownMap, listRegions, listFunds, getAgencyHome, listCommitteeActivity, listBudgetMeetings, listBudgetReports, getHealth, getMetaPayload, listActivity, listBills, listCosponsors, listNews, listNewsArticles, listTopics, listChanges,
  listCommittees, listLegislators, listRankings, listSyncRuns, listRecalls, listCouncil, listCouncilActivity, councilCounties,
  listSocialWall,
  listSyncSources,
} from './queries.mjs';
import { runAll, runOutletPoll } from './ingest.mjs';
import { resolveScope, scopeStages } from './sync-scopes.mjs';
import { checkSyncGuard } from './sync-guard.mjs';
import { getProgress, clearProgress } from './sync-progress.mjs';

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
export function syncOnce(db, options = {}) {
  if (!inflight) {
    const scope = resolveScope(options.scope).id;
    inflightScope = scope;
    inflight = runAll(db, { ...options, stages: scopeStages(scope) }).finally(() => {
      inflight = null;
      inflightScope = null;
      clearProgress();
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

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());

    try {
      if (path.startsWith('/api/')) {
        if (req.method !== 'GET' && !(path === '/api/v1/sync' && req.method === 'POST')) {
          return sendError(res, 405, 'method_not_allowed', `${req.method} 不支援`);
        }
        switch (path) {
          case '/api/v1/health':
            // progress：現在跑到哪（例如新聞 137/601）。單一資料集內部一大串請求時，
            // 只靠 sync_runs 會十幾分鐘都是「已完成 0 個來源」，所以另外回報細部進度。
            return sendJson(res, 200, { ...getHealth(db), sync_enabled: authorizeSync({}) === null, syncing: getInflightScope(), progress: getProgress() });
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
          case '/api/v1/regions':
            return sendJson(res, 200, listRegions(db, { per: q.per }));
          case '/api/v1/counties':
            return sendJson(res, 200, listCounties(db));
          case '/api/v1/council/activity':
            return sendJson(res, 200, listCouncilActivity(db, { county: q.county, councilor: q.councilor, q: q.q, source: q.source, limit: q.limit, offset: q.offset }));
          case '/api/v1/social/wall':
            // 沒給 limit 時只回最近更新的 5 位（見 listSocialWall）
            return sendJson(res, 200, listSocialWall(db, { party: q.party, region: q.region, limit: q.limit, offset: q.offset }));
          case '/api/v1/council': {
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
          case '/api/v1/committee-activity':
            return sendJson(res, 200, listCommitteeActivity(db, { committee: q.committee, q: q.q, limit: q.limit }));
          case '/api/v1/agency':
            return sendJson(res, 200, getAgencyHome(db, { name: q.name, per: q.per }));
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

export function startScheduler(db, { logger = console, checkEveryMs = CONFIG.schedulerCheckMs } = {}) {
  if (shouldSyncNow(db)) {
    logger.log('[scheduler] 資料不存在或已過期，啟動時先同步一次');
    syncOnce(db, { logger }).catch((error) => logger.error('[scheduler] 同步失敗', error));
  }
  const timer = setInterval(() => {
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
  return timer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  const server = createServer(db);
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[api] 立委觀測站 API 已啟動：http://${CONFIG.host}:${CONFIG.port}（靜態檔：${CONFIG.webDist}）`);
    if (CONFIG.syncToken) console.log('[api] POST /api/v1/sync 已啟用 LY_SYNC_TOKEN 驗證');
    else if (CONFIG.host !== '127.0.0.1' && CONFIG.host !== 'localhost' && CONFIG.host !== '::1') {
      console.log('[api] 注意：LY_HOST 非 loopback 且未設 LY_SYNC_TOKEN → POST /api/v1/sync 已停用（回 403）');
    }
  });
  if (!process.argv.includes('--no-scheduler')) startScheduler(db);
}
