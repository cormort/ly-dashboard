/*
 * 立委觀測站 Service Worker（T11）。
 *
 * 職責只有兩個：
 *  1. 快取靜態 app shell（HTML／JS／CSS／字型／圖示），採 stale-while-revalidate ——
 *     先回快取讓畫面秒開，同時在背景抓新的版本更新快取。
 *  2. 離線時讓外框還在（回快取），搭配前端的 OfflineNotice 明講「資料需連線取得」。
 *
 * **絕對不快取 /api/v1/***：本站的數字每天更新，快取 API 回應等於讓人看著過期數字
 * 卻以為是最新的。凡是 /api/ 一律直接放行給網路，不進快取、也不回舊值。
 */
const CACHE = 'ly-shell-v1';

// 安裝時先塞一份外框，確保「第一次離線就有東西」。
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 逐筆加、個別容忍失敗：任何一個 precache 網址（例如某張圖）暫時抓不到，
      // 都不該讓整個 Service Worker 裝不起來、連離線外框都沒有。
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** 只有同源、非 API 的 GET 才進快取；其餘（含跨來源與 /api/v1/*）一律放行。 */
function isCacheable(url) {
  return url.origin === self.location.origin && !url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!isCacheable(url)) return; // /api/v1/*：完全不碰，讓瀏覽器直接連網路

  // 導覽請求一律對到 shell 的 '/'（本站是 SPA，任何路徑都由同一份 index.html 進站）；
  // 其餘靜態資源用自身網址當快取鍵。
  const cacheKey = req.mode === 'navigate' ? new URL('/', self.location.origin).href : req.url;

  // revalidate：同步啟動、交給 waitUntil 保命（respondWith 先回快取時它仍能在背景跑完）。
  const revalidate = caches.open(CACHE).then((cache) =>
    fetch(req)
      .then((response) => {
        if (response && response.ok) cache.put(cacheKey, response.clone());
        return response;
      })
      .catch(() => null),
  );
  event.waitUntil(revalidate);

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(cacheKey);
      if (cached) return cached; // 有快取先回（stale）
      const fresh = await revalidate; // 沒快取才等網路
      return fresh || Response.error();
    })(),
  );
});
