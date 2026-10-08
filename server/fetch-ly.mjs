import https from 'node:https';
import crypto from 'node:crypto';
import { CONFIG } from './config.mjs';

/**
 * data.ly.gov.tw 要求 unsafe legacy renegotiation，Node/OpenSSL 預設拒絕
 * （實測錯誤：write EPROTO ... unsafe legacy renegotiation disabled）。
 * 同一個問題在 Python(OpenSSL 3) 也會出現，Deno 則不會。
 */
const legacyAgent = new https.Agent({
  keepAlive: true,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

export class FetchError extends Error {
  constructor(message, { status = null, attempts = 1 } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.attempts = attempts;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 可重試的 HTTP 狀態。429 是關鍵：g0v API（ly.govapi.tw）在短時間內連續抓多頁時會回
 * 429 Too Many Requests，這**不是**「重試沒有意義」的 4xx（實測踩到：預算與公報議程整批失敗）。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

/** 解析 Retry-After（秒數或 HTTP 日期），回傳毫秒；無法解析時回 null */
export function parseRetryAfter(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * 同一個 host 的最小請求間隔。對社群維運的 g0v API 客氣一點，也避免自己撞到 429。
 * 可用 LY_MIN_INTERVAL_MS 調整；設 0 可關閉。
 */
const hostGate = new Map();
async function pace(url) {
  const min = CONFIG.minRequestIntervalMs;
  if (!min || min <= 0) return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const now = Date.now();
  const last = hostGate.get(host) ?? 0;
  const wait = last + min - now;
  hostGate.set(host, now + Math.max(0, wait));
  if (wait > 0) await sleep(wait);
}

function once(url, { timeoutMs, ua, accept = 'application/json', headers: extra = {} }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        agent: legacyAgent,
        headers: { 'user-agent': ua, accept, ...extra },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 抓取一次 JSON 端點：具名 UA、逾時、同 host 節流、指數退避 + 抖動重試。
 * 可重試：網路錯誤、408/425/429 與 5xx（429 會尊重 Retry-After 並多給幾次機會）。
 */
export async function fetchJson(url, options = {}) {
  const {
    timeoutMs = CONFIG.fetchTimeoutMs,
    retries = CONFIG.fetchRetries,
    ua = CONFIG.userAgent,
    text: asText = false,
    // 二進位來源（例如法務部回 ZIP 的法律資料檔）：原樣回 Buffer，不做 utf8 轉換也不解析
    raw: asRaw = false,
    // 額外的 request header（例如讀私人 repo 的 Authorization）；轉址到別的網域時不帶，避免把憑證送出去
    headers: extraHeaders = {},
    // Retry-After 的等待上限；測試會注入小值，不必真的等
    retryAfterCapMs = CONFIG.retryAfterCapMs,
    // 測試注入點：讓單元測試能模擬 429 → 200 的重試序列，不必真的打網路
    once: request = once,
    sleepMs = sleep,
  } = options;
  let lastError = null;
  let guard = 0;

  // 迴圈上限不能寫 `attempt <= retries`：429 會把 maxAttempts 拉高到 5，
  // 但那個上限在迴圈條件裡永遠到不了（D41 的「多給幾次機會」會變成死碼）。
  // 改由下面的 `attempt >= maxAttempts` 負責結束，`guard` 只是防呆。
  for (let attempt = 1; guard++ < 50; attempt++) {
    try {
      let target = url;
      await pace(target);
      const origin = new URL(url).host;
      const headersFor = (href) => (new URL(href).host === origin ? extraHeaders : {});
      let res = await request(target, { timeoutMs, ua, accept: asText || asRaw ? '*/*' : 'application/json', headers: headersFor(target) });
      // 跟隨轉址（Google 試算表匯出會 307 到 googleusercontent）；上限 5 次防迴圈
      for (let hops = 0; [301, 302, 303, 307, 308].includes(res.status) && res.headers.location; hops++) {
        if (hops === 5) throw Object.assign(new FetchError('轉址過多', { status: res.status, attempts: attempt }), { retryable: false });
        target = new URL(res.headers.location, target).href;
        await pace(target);
        res = await request(target, { timeoutMs, ua, accept: asText || asRaw ? '*/*' : 'application/json', headers: headersFor(target) });
      }
      const { status, body, headers } = res;
      if (status !== 200) {
        const err = new FetchError(`HTTP ${status}`, { status, attempts: attempt });
        if (isRetryableStatus(status)) {
          // 429／5xx 等：重試，並尊重 Retry-After
          err.retryable = true;
          err.retryAfterMs = parseRetryAfter(headers['retry-after']);
        } else {
          // 其餘 4xx：重試沒有意義（實測 WAF 403 就是這一類），直接失敗
          err.retryable = false;
        }
        throw err;
      }
      const text = body.toString('utf8');
      // ponytail: RSS 等非 JSON 來源共用同一套逾時／重試，只是不解析
      if (asText) return { text, status, headers, bytes: body.length, sha256: sha256(body), attempts: attempt };
      if (asRaw) return { buffer: body, status, headers, bytes: body.length, sha256: sha256(body), attempts: attempt };
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new FetchError(`回應不是合法 JSON（前 80 字元：${text.slice(0, 80).replace(/\s+/g, ' ')}）`, {
          status,
          attempts: attempt,
        });
      }
      return { json, status, headers, bytes: body.length, sha256: sha256(body), attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      // 429 額外給幾次機會（伺服器要求節奏，不是拒絕服務）
      const maxAttempts = error.status === 429 ? Math.max(retries, 5) : retries;
      if (!retryable || attempt >= maxAttempts) break;
      const backoff = Math.round(500 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
      // Retry-After 可能是一小時（甚至更久）：尊重它，但不能讓一個標頭把整個同步階段卡死。
      // 上限預設 60 秒（LY_RETRY_AFTER_CAP_MS），超過就照上限等，之後仍會重試。
      const delay = Math.min(Math.max(backoff, error.retryAfterMs ?? 0), retryAfterCapMs);
      await sleepMs(delay);
    }
  }

  throw lastError instanceof FetchError
    ? lastError
    : new FetchError(String(lastError?.message || lastError), { attempts: retries });
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
