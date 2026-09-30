import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, getMeta } from './db.mjs';
import { getHealth, getMetaPayload, listChanges, listCommittees, listLegislators, listSyncRuns } from './queries.mjs';
import { runIngest } from './ingest.mjs';

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
          case '/api/v1/changes':
            return sendJson(res, 200, listChanges(db, { since: q.since ?? null, limit: q.limit ?? 100 }));
          case '/api/v1/sync-runs':
            return sendJson(res, 200, listSyncRuns(db, { limit: q.limit ?? 50 }));
          case '/api/v1/sync': {
            const result = await runIngest(db);
            return sendJson(res, result.status === 'failed' ? 502 : 200, result, { 'cache-control': 'no-store' });
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
    runIngest(db, { logger }).catch((error) => logger.error('[scheduler] 同步失敗', error));
  }
  const timer = setInterval(() => {
    runIngest(db, { logger }).catch((error) => logger.error('[scheduler] 排程同步失敗', error));
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
