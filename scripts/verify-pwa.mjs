/*
 * T11（PWA）驗收：用真的 Chromium 從 HTTPS 來源開站，實測三件事——
 *   ① Service Worker 有註冊、manifest 有被讀到
 *   ② /api/v1/* 沒有進入 SW 快取（本站數字每天更新，快取 API 會看到過期數字）
 *   ③ 離線時外框還在，且出現「目前離線，資料需連線取得」
 *
 * 需要一個正在服務 web/dist 的伺服器（HTTPS 才能註冊 SW）。
 *   npm run verify:pwa                 # 預設打 https://mac-mini.tail1ac930.ts.net/
 *   PWA_URL=... CHROME_PATH=... npm run verify:pwa
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXE =
  process.env.CHROME_PATH ||
  '/Users/hermes/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TARGET = process.env.PWA_URL || 'https://mac-mini.tail1ac930.ts.net/';
const SHOT = process.env.PWA_SHOT || join(HERE, '..', '.cache', 'pwa-offline.png');

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: EXE });
const context = await browser.newContext();
const page = await context.newPage();

try {
  console.log(`目標：${TARGET}\n`);
  await page.goto(TARGET, { waitUntil: 'load' });

  // ① Service Worker 註冊 + manifest 讀取
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length > 0, null, { timeout: 20000 });
  // 等它真的「active」再繼續：active 之後任何新導覽都會受 SW 控制（下面的 reload 才會被接管）。
  await page.waitForFunction(async () => Boolean(await navigator.serviceWorker.ready), null, { timeout: 20000 });
  const regs = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, active: !!r.active, script: r.active?.scriptURL ?? null })),
  );
  check(regs.length > 0, `navigator.serviceWorker.getRegistrations() 數量 = ${regs.length}（scope=${regs[0]?.scope}）`);

  const head = await page.evaluate(() => ({
    title: document.title,
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
    apple: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content') ?? null,
  }));
  check(head.title === '立委觀測站', `document.title = ${head.title}`);
  check(head.manifest === '/manifest.webmanifest', `link[rel=manifest] href = ${head.manifest}`);
  check(head.themeColor === '#2563eb', `theme-color = ${head.themeColor}`);
  check(head.apple === 'yes', `apple-mobile-web-app-capable = ${head.apple}`);

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    return fetch(href).then((r) => r.json());
  });
  check(
    manifest.name === '立委觀測站' && manifest.display === 'standalone' && manifest.start_url === '/' && manifest.icons.length >= 3,
    `manifest 內容：name=${manifest.name} display=${manifest.display} start_url=${manifest.start_url} icons=${manifest.icons.length}`,
  );

  // 重新載入 → 讓頁面受 SW 控制，靜態資源才會經 SW 快取
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  await page.waitForFunction(
    async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        if ((await cache.keys()).some((r) => /\/assets\/.*\.js$/.test(r.url))) return true;
      }
      return false;
    },
    null,
    { timeout: 20000 },
  );

  // ② 明確打一個 API，再檢查快取裡沒有 /api/
  const apiStatus = await page.evaluate(() => fetch('/api/v1/health').then((r) => r.status));
  await page.waitForTimeout(600);
  const cacheReport = await page.evaluate(async () => {
    const keys = await caches.keys();
    const entries = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const req of await cache.keys()) entries.push(req.url);
    }
    return { keys, entries };
  });
  const apiUrls = cacheReport.entries.filter((u) => u.includes('/api/'));
  console.log(`快取名稱：${JSON.stringify(cacheReport.keys)}`);
  console.log(`快取項目（${cacheReport.entries.length}）：${JSON.stringify(cacheReport.entries.map((u) => u.replace(TARGET.replace(/\/$/, ''), '')))}`);
  check(apiStatus === 200, `頁面內 fetch('/api/v1/health') 回應 ${apiStatus}`);
  check(apiUrls.length === 0, `SW 快取裡的 /api/ 路徑數量 = ${apiUrls.length}（必須為 0）`);
  check(
    cacheReport.entries.some((u) => /\/assets\/.*\.js$/.test(u)),
    'app shell 的 JS 有進快取（離線才開得起來）',
  );
  check(
    cacheReport.entries.some((u) => u === new URL('/', TARGET).href),
    'app shell 的 HTML（/）有進快取',
  );

  // ③ 離線：外框由 SW 快取提供，前端顯示離線提示
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  // 佐證網路真的斷了：這個重新載入的外框只能來自 SW 快取（否則下面這隻 API 不會失敗）。
  // 一定要 no-store + 亂數查詢：/api/v1/health 允許快取 300 秒，會被瀏覽器 HTTP 快取救回來。
  const probe = await page.evaluate(() =>
    fetch(`/api/v1/health?_=${Date.now()}`, { cache: 'no-store' })
      .then(() => 'ONLINE')
      .catch(() => 'OFFLINE'),
  );
  check(probe === 'OFFLINE', `離線後 fetch('/api/v1/health') = ${probe}（外框是快取來的，不是連到網路）`);

  // Playwright 的 setOffline 在 reload 後會和「新文件」脫鉤（navigator.onLine 會跳回 true）；
  // 真機沒這個問題。這裡再切一次，讓新文件收到 offline 事件、顯示提示。
  await context.setOffline(false);
  await context.setOffline(true);
  await page.waitForSelector('.offline-notice', { timeout: 8000 });

  const offline = await page.evaluate(() => ({
    brand: document.querySelector('.brand b')?.textContent ?? null,
    notice: document.querySelector('.offline-notice')?.textContent ?? null,
    online: navigator.onLine,
  }));
  check(offline.online === false, `navigator.onLine = ${offline.online}`);
  check(offline.brand === '立委觀測站', `離線時畫面外框還在（.brand = ${offline.brand}）`);
  check(/目前離線，資料需連線取得/.test(offline.notice ?? ''), `離線提示文字 = ${JSON.stringify(offline.notice)}`);

  mkdirSync(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });
  console.log(`截圖：${SHOT}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} 項驗收失敗`);
  process.exit(1);
}
console.log('\n全部通過 ✓');
