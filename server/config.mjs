import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const CONFIG = {
  dbPath: process.env.LY_DB || here('../data/ly.db'),
  webDist: here('../web/dist'),
  port: Number(process.env.PORT || 8787),
  // 實測：預設函式庫 UA（python-requests / Go-http-client / Python-urllib）會被 WAF 回 403，
  // 具名且可聯絡的 UA 才會 200。這是禮貌也是必要條件。
  // 注意：HTTP header 只能是 latin-1，UA 不可放中文，否則 Node 會丟 Invalid character in header content。
  userAgent:
    process.env.LY_UA ||
    'ly-dashboard/1.0 (+https://github.com/local/ly-dashboard; legislative-yuan-open-data-sync; contact: local-admin)',
  endpoints: {
    id9: 'https://data.ly.gov.tw/odw/ID9Action.action?fileType=json',
    id14: 'https://data.ly.gov.tw/odw/ID14Action.action?fileType=json',
  },
  // 議案：g0v 社群維護的立法院 API（非官方），已把議案與提案委員對好，官方 data.ly.gov.tw 沒有這層關聯。
  bills: {
    url: 'https://ly.govapi.tw/v2/bills',
    pageSize: 1000,
    name: 'g0v 立法院 API',
    homepage: 'https://ly.govapi.tw/',
  },
  source: {
    name: '立法院開放資料',
    url: 'https://data.ly.gov.tw/',
    license: '政府資料開放授權條款第 1 版',
  },
  staleAfterHours: Number(process.env.LY_STALE_HOURS || 36),
  syncIntervalMs: Number(process.env.LY_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000),
  fetchTimeoutMs: Number(process.env.LY_FETCH_TIMEOUT_MS || 30_000),
  fetchRetries: Number(process.env.LY_FETCH_RETRIES || 3),
};
