/*
 * App 層登入（cookie session）的單元測試。
 *
 * 只測沒有 I/O 的純函式：簽章、雜湊、公開路徑判斷、next 消毒、節流。
 * 真正的 HTTP 行為（401／303／Set-Cookie）用 curl 驗，見部署紀錄。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoginThrottle,
  hashPassword,
  isPublicOrigin,
  isPublicPath,
  loginPageHtml,
  readCookie,
  safeEqual,
  safeNext,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  SESSION_COOKIE,
  verifyPassword,
  verifySession,
} from '../server/auth.mjs';

const SECRET = 'test-secret-please-ignore';

test('session：簽完可以驗回，過期或改字就失效', () => {
  const now = 1_700_000_000_000;
  const value = signSession(now + 60_000, SECRET);
  assert.equal(verifySession(value, SECRET, now), true);
  // 過期
  assert.equal(verifySession(value, SECRET, now + 120_000), false);
  // 換密鑰
  assert.equal(verifySession(value, 'other-secret', now), false);
  // 改一個字
  const tampered = value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
  assert.equal(verifySession(tampered, SECRET, now), false);
  // 亂七八糟
  assert.equal(verifySession('', SECRET, now), false);
  assert.equal(verifySession('v1.123', SECRET, now), false);
  assert.equal(verifySession(null, SECRET, now), false);
  // 直接把過期時間往後改（沒有重算簽章）也要擋
  const [v, exp, mac] = value.split('.');
  assert.equal(verifySession(`${v}.${Number(exp) + 999_999}.${mac}`, SECRET, now), false);
});

test('密碼：scrypt 雜湊可驗，錯的密碼不行，格式壞掉不會丟錯', async () => {
  const hashed = await hashPassword('test-password-1');
  assert.match(hashed, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword('test-password-1', hashed), true);
  assert.equal(await verifyPassword('test-password-2', hashed), false);
  assert.equal(await verifyPassword('', hashed), false);
  assert.equal(await verifyPassword('test-password-1', 'not-a-hash'), false);
  assert.equal(await verifyPassword('test-password-1', 'scrypt$1$2$3$$'), false);
  // 同一個密碼每次雜湊都不同（有 salt）
  assert.notEqual(await hashPassword('test-password-1'), await hashPassword('test-password-1'));
});

test('帳號比較：相同為真、長度不同也不會丟錯', () => {
  assert.equal(safeEqual('DGBAS', 'DGBAS'), true);
  assert.equal(safeEqual('DGBAS', 'DGBAs'), false);
  assert.equal(safeEqual('', 'DGBAS'), false);
});

test('公開路徑：PWA 安裝檔與登入頁本身不用登入，其餘要', () => {
  for (const path of ['/login', '/logout', '/api/v1/login', '/manifest.webmanifest', '/sw.js', '/icon-192-v2.png', '/icon-maskable-512-v2.png', '/apple-touch-icon-v2.png', '/favicon.ico']) {
    assert.equal(isPublicPath(path), true, path);
  }
  for (const path of ['/', '/legislators', '/api/v1/health', '/api/v1/news/articles', '/assets/index-abc.js', '/loginx']) {
    assert.equal(isPublicPath(path), false, path);
  }
});

test('公開來源：只有經過 Caddy（X-Ly-Public: 1）才算，XFF 不算', () => {
  assert.equal(isPublicOrigin({}), false);
  assert.equal(isPublicOrigin({ 'x-forwarded-for': '1.2.3.4' }), false);
  assert.equal(isPublicOrigin({ 'x-ly-public': '1' }), true);
  assert.equal(isPublicOrigin({ 'X-Ly-Public': '1' }), true);
  assert.equal(isPublicOrigin({ 'x-ly-public': '0' }), false);
});

test('next 消毒：只留站內路徑，擋掉 open redirect 與 API', () => {
  assert.equal(safeNext('/legislators'), '/legislators');
  assert.equal(safeNext('/news?q=x'), '/news?q=x');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('/api/v1/health'), '/');
  assert.equal(safeNext('/logout'), '/');
  assert.equal(safeNext(null), '/');
  assert.equal(safeNext('/legislators', '/x'), '/legislators');
});

test('cookie：HttpOnly + Secure + SameSite=Lax，清除時 Max-Age=0', () => {
  const set = sessionSetCookie('v1.123.abc', 3600);
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);
  assert.match(set, /Max-Age=3600/);
  assert.match(sessionClearCookie(), /Max-Age=0/);
});

test('readCookie 只抓指定名稱', () => {
  assert.equal(readCookie('a=1; ly_session=abc%2Edef; b=2', SESSION_COOKIE), 'abc.def');
  assert.equal(readCookie('a=1', SESSION_COOKIE), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
});

test('登入節流：同一時間窗內失敗太多次要等，成功後可重置', () => {
  let now = 1_000_000;
  const throttle = createLoginThrottle({ max: 3, windowMs: 60_000, now: () => now });
  assert.equal(throttle.retryAfterSeconds(), 0);
  throttle.fail();
  throttle.fail();
  now += 1_000;
  throttle.fail();
  assert.ok(throttle.retryAfterSeconds() > 0);
  // 時間過了就解開
  now += 61_000;
  assert.equal(throttle.retryAfterSeconds(), 0);
  // 成功登入重置
  throttle.fail();
  throttle.fail();
  throttle.fail();
  throttle.reset();
  assert.equal(throttle.retryAfterSeconds(), 0);
});

test('登入頁：有帳號／密碼欄位，錯誤訊息與 next 都會跳脫', () => {
  const html = loginPageHtml({ error: '<script>alert(1)</script>', next: '/x?a=1&b="2"', user: 'DGBAS' });
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /action="\/api\/v1\/login"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /value="\/x\?a=1&amp;b=&quot;2&quot;"/);
});
