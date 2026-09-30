import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, getMeta } from './db.mjs';
import {
  billsCsv, budgetCsv, compareLegislators, listBudget, listRegions, listFunds, listCommitteeActivity, listBudgetMeetings, listBudgetReports, getHealth, getMetaPayload, listActivity, listBills, listCosponsors, listNews, listTopics, listChanges,
  listCommittees, listLegislators, listRankings, listSyncRuns,
} from './queries.mjs';
import { runAll, runIngest } from './ingest.mjs';

let inflight = null;
let inflightScope = null;

/** 目前進行中的同步範圍（'all' | 'roster'），沒有同步時為 null */
export function getInflightScope() {
  return inflightScope;
}

/**
 * Single-flight：同時只允許一個同步在跑（M3）。
 * `scope === 'roster'` 只同步名錄（約 7 秒，離線可用）；預設 'all' 會跑議案／社群／新聞（約 4 分鐘）。
 */
export function syncOnce(db, options = {}) {
  if (!inflight) {
    const scope = options.scope === 'roster' ? 'roster' : 'all';
    inflightScope = scope;
    inflight = (scope === 'roster' ? runIngest(db, options) : runAll(db, options)).finally(() => {
      inflight = null;
      inflightScope = null;
    });
  }
  return inflight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const sendJson = (res, status, payload, extraHeaders = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'public, max-age=300',
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
      const immutable = candidate.includes('/assets/');
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
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
            return sendJson(res, 200, getHealth(db));
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
            const filters = { category: q.category, type: q.type, q: q.q, year: q.year, proposer: q.proposer, state: q.state };
            if (q.format === 'csv') return sendCsv(res, 'budget.csv', budgetCsv(listBudget(db, { ...filters, all: true }).items));
            return sendJson(res, 200, listBudget(db, { ...filters, limit: q.limit, offset: q.offset }));
          }
          case '/api/v1/budget/reports':
            return sendJson(res, 200, listBudgetReports(db, { type: q.type, q: q.q, limit: q.limit, offset: q.offset }));
          case '/api/v1/budget/meetings':
            return sendJson(res, 200, listBudgetMeetings(db, { limit: q.limit }));
          case '/api/v1/regions':
            return sendJson(res, 200, listRegions(db, { per: q.per }));
          case '/api/v1/committee-activity':
            return sendJson(res, 200, listCommitteeActivity(db, { committee: q.committee, limit: q.limit }));
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
          case '/api/v1/rankings':
            return sendJson(res, 200, listRankings(db, { type: q.type || 'all', days: q.days, limit: q.limit }));
          case '/api/v1/changes':
            return sendJson(res, 200, listChanges(db, { since: q.since ?? null, limit: q.limit ?? 100 }));
          case '/api/v1/sync-runs':
            return sendJson(res, 200, listSyncRuns(db, { limit: q.limit ?? 50 }));
          case '/api/v1/sync': {
            // M3：同步可能長達數分鐘，不能在請求裡等。改回 202 並讓它跑在背景，進度看 /sync-runs。
            const scope = q.scope === 'roster' ? 'roster' : 'all';
            const started = getInflightScope() === null;
            syncOnce(db, { scope }).catch((error) => console.error('[sync] 背景同步失敗', error));
            return sendJson(
              res,
              202,
              {
                accepted: true,
                started,
                scope,
                inflight_scope: getInflightScope(),
                message: started ? '同步已在背景執行' : '已有同步在進行中，本次請求已合併',
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
      console.error('[api] 未預期錯誤', error);
      return sendError(res, 500, 'internal_error', String(error?.message || error));
    }
  });
}

export function startScheduler(db, { logger = console } = {}) {
  const last = getMeta(db, 'last_success_at');
  const fresh = last && Date.now() - new Date(last).getTime() < CONFIG.syncIntervalMs;
  if (!fresh) {
    logger.log('[scheduler] 資料不存在或已過期，啟動時先同步一次');
    syncOnce(db, { logger }).catch((error) => logger.error('[scheduler] 同步失敗', error));
  }
  const timer = setInterval(() => {
    syncOnce(db, { logger }).catch((error) => logger.error('[scheduler] 排程同步失敗', error));
  }, CONFIG.syncIntervalMs);
  timer.unref();
  return timer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  const server = createServer(db);
  server.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`[api] 立委觀測站 API 已啟動：http://127.0.0.1:${CONFIG.port}（靜態檔：${CONFIG.webDist}）`);
  });
  if (!process.argv.includes('--no-scheduler')) startScheduler(db);
}
