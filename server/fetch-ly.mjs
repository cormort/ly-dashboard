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

function once(url, { timeoutMs, ua }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        agent: legacyAgent,
        headers: { 'user-agent': ua, accept: 'application/json' },
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
 * 抓取一次 JSON 端點：具名 UA、逾時、指數退避 + 抖動重試（只重試 5xx / 網路錯誤）。
 */
export async function fetchJson(url, options = {}) {
  const { timeoutMs = CONFIG.fetchTimeoutMs, retries = CONFIG.fetchRetries, ua = CONFIG.userAgent } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { status, body, headers } = await once(url, { timeoutMs, ua });
      if (status >= 500) throw new FetchError(`HTTP ${status}`, { status, attempts: attempt });
      if (status !== 200) {
        // 4xx：重試沒有意義（實測 WAF 403 就是這一類），直接失敗
        const err = new FetchError(`HTTP ${status}`, { status, attempts: attempt });
        err.retryable = false;
        throw err;
      }
      const text = body.toString('utf8');
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
      if (!retryable || attempt === retries) break;
      const delay = Math.round(500 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
      await sleep(delay);
    }
  }

  throw lastError instanceof FetchError
    ? lastError
    : new FetchError(String(lastError?.message || lastError), { attempts: retries });
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
