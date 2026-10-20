/*
 * App 層登入（cookie session）—— 取代 HTTP Basic Auth。
 *
 * 為什麼要換：Basic Auth 的帳密只活在「瀏覽 session」，獨立模式的 PWA 每次啟動都是新的
 * session，所以每次都要重打；更糟的是 Service Worker 攔截導覽請求時，fetch() 拿到的 401
 * 不會觸發帳密對話框，Chrome 只會顯示 ERR_HTTP_RESPONSE_CODE_FAILURE。
 *
 * 這裡的設計：
 *  - 密碼不比對明碼，存 scrypt 雜湊（LY_LOGIN_PASSWORD_HASH）。
 *  - 登入成功簽一個 HMAC 的 cookie（LY_SESSION_SECRET），預設 180 天，HttpOnly + Secure + SameSite=Lax；
 *    每次請求只要剩不到 30 天就自動重簽（滑動續期），有在用就不會過期。
 *  - 只有「經過 Caddy」的請求才需要登入：Caddy 會加上 `X-Ly-Public: 1`（見 Caddyfile）；
 *    loopback／tailnet（tailscale serve）本來就只有這台機器／自己的裝置連得到，直接放行
 *    —— 注意 tailscale serve 也會帶 x-forwarded-for，所以不能用那個當判斷依據。
 *  - 登入失敗有全域節流（弱密碼的下限保護），但成功後就重置。
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE = 'ly_session';
const SESSION_VERSION = 'v1';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;

/* ---------- 純函式：給測試用，沒有 I/O ---------- */

export function signSession(expiresAt, secret) {
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifySession(value, secret, now = Date.now()) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 取 cookie 裡的到期時間（毫秒）；格式不對回 0。呼叫前仍要 verifySession 驗簽章。 */
export function sessionExpiresAt(value) {
  if (typeof value !== 'string') return 0;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return 0;
  const expiresAt = Number(parts[1]);
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}

/**
 * 滑動續期：只要還有在用，就一直展延，不會「用得好好的突然被登出」。
 * 剩餘時間少於 renewBeforeMs 就重簽一個全新的 cookie。
 */
export function needsRenewal(expiresAt, now, renewBeforeMs) {
  return expiresAt > now && expiresAt - now < renewBeforeMs;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, KEY_BYTES, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, n, r, p, saltB64, keyB64] = stored.split('$');
  const salt = Buffer.from(saltB64 ?? '', 'base64url');
  const expected = Buffer.from(keyB64 ?? '', 'base64url');
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = await scrypt(String(password), salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 使用者名稱也要常數時間比較，避免用時間差列舉帳號。 */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

/** 免登入也必須拿得到：PWA 安裝檔、Service Worker、圖示、登入頁本身。 */
export function isPublicPath(pathname) {
  return (
    pathname === '/login' ||
    pathname === '/logout' ||
    pathname === '/api/v1/login' ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    /^\/icon-[^/]+\.png$/.test(pathname) ||
    /^\/apple-touch-icon[^/]*\.png$/.test(pathname)
  );
}

/**
 * 公開來源＝經過 Caddy 的請求。Caddyfile 用 `header_up X-Ly-Public 1` 標記，
 * 不依賴 x-forwarded-for（tailscale serve 也會送 XFF，兩者分不出來）。
 * 這個標記只會「增加」登入要求，不會繞過任何東西；只有能直接碰到 8787 的
 * loopback／tailnet 才可能自己帶，而那裡本來就受 Tailscale 保護。
 */
export function isPublicOrigin(headers = {}) {
  const marker = headers['x-ly-public'] ?? headers['X-Ly-Public'];
  return String(marker ?? '').trim() === '1';
}

/** 只接受站內路徑，擋掉 //evil.com 與 http://… 這類 open redirect。 */
export function safeNext(next, fallback = '/') {
  if (typeof next !== 'string' || !next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (next.startsWith('/api/') || next.startsWith('/logout')) return fallback;
  return next;
}

export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionSetCookie(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function sessionClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * 登入失敗節流：全域計算（因為經過 Caddy 時所有請求都來自 127.0.0.1，用 IP 分不出來源）。
 * 10 分鐘內失敗 10 次就暫時擋住；成功登入會清空。`now` 可注入方便測試。
 */
export function createLoginThrottle({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let failures = [];
  const prune = (t) => {
    failures = failures.filter((at) => t - at < windowMs);
  };
  return {
    /** 回傳 0 代表放行；>0 代表要再等幾秒。 */
    retryAfterSeconds() {
      const t = now();
      prune(t);
      if (failures.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (t - failures[0])) / 1000));
    },
    fail() {
      failures.push(now());
    },
    reset() {
      failures = [];
    },
  };
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function loginPageHtml({ next = '/', error = '', user = 'DGBAS', days = 180 } = {}) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>登入 · 立委輿情觀測站</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #141518; color: #e9e7e2;
         font: 15px/1.5 -apple-system, "PingFang TC", "Noto Sans TC", system-ui, sans-serif; padding: 24px; }
  form { width: min(360px, 100%); background: #1d1f24; border: 1px solid #33363d; border-radius: 16px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { margin: 0 0 18px; color: #9c9a94; font-size: 13px; }
  label { display: block; font-size: 12px; color: #9c9a94; margin-bottom: 12px; }
  input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px; font: inherit; color: #e9e7e2;
          background: #26282e; border: 1px solid #3a3d45; border-radius: 9px; }
  input:focus { outline: 2px solid #93d3e8; outline-offset: 1px; border-color: #93d3e8; }
  button { width: 100%; margin-top: 4px; padding: 11px 12px; font: inherit; font-weight: 600; cursor: pointer;
           color: #0e2a35; background: #93d3e8; border: 0; border-radius: 9px; }
  button:active { filter: brightness(.92); }
  .err { margin: 0 0 14px; padding: 9px 11px; font-size: 13px; color: #ffd2d2; background: rgba(239,68,68,.16);
         border: 1px solid rgba(239,68,68,.4); border-radius: 8px; }
  .hint { margin: 14px 0 0; font-size: 12px; color: #71747b; }
</style>
</head>
<body>
<form method="post" action="/api/v1/login">
  <h1>立委輿情觀測站</h1>
  <p class="sub">這個站需要登入才能看資料</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <label>帳號<input name="username" value="${escapeHtml(user)}" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
  <label>密碼<input name="password" type="password" autocomplete="current-password" required autofocus></label>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">登入</button>
  <p class="hint">登入一次會記住 ${Number(days)} 天，PWA 不用每次重打。</p>
</form>
</body>
</html>`;
}
