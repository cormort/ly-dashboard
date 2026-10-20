/*
 * 立委輿情觀測站 Service Worker（T11）。
 *
 * 職責只有兩個：
 *  1. 快取靜態 app shell（HTML／JS／CSS／字型／圖示），採 stale-while-revalidate ——
 *     先回快取讓畫面秒開，同時在背景抓新的版本更新快取。
 *  2. 離線時讓外框還在（回快取），搭配前端的 OfflineNotice 明講「資料需連線取得」。
 *
 * **絕對不快取 /api/v1/***：本站的數字每天更新，快取 API 回應等於讓人看著過期數字
 * 卻以為是最新的。凡是 /api/ 一律直接放行給網路，不進快取、也不回舊值。
 *
 * **也絕不攔截「導覽請求」**：站上改用 cookie 登入後，未登入時伺服器回 401 + 登入頁；
 * Service Worker 若用快取的外框回應導覽，登入頁就永遠看不到（而且舊版還可能把登入頁
 * 記成外框）。導覽一律交給瀏覽器／伺服器決定，靜態資源照樣快取。
 */
// app shell 的快取名。**改了任何外框資源（尤其是圖示）就要 +1**：
// 不換快取名就不會重新 precache，主畫面上的 icon 會一直用舊的
// （跟 meowdoku 那次的 shell-v52→v53 同一個坑）。
// 2026-10-13 v2→v3：圖示改版（議事殿堂柱廊）且檔名加上版本（icon-192-v2.png…）。
// v3→v4：導覽請求改為不攔截（cookie 登入），舊外框快取會被 activate 刪掉
// v4→v5：2026-10-19 預算審議改版（統計範圍兩顆鈕、流程帶七關）——外框改了就要換名，否則畫面會一直是舊版
// v5→v6：2026-10-20 站名改為「立委輿情觀測站」（index.html／manifest 都改了）
// v6→v7：主畫面名稱改短為「立委輿情」（manifest short_name／apple-mobile-web-app-title）
const CACHE = 'ly-shell-v7';

// 安裝時先塞一份外框，確保「第一次離線就有東西」。
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192-v2.png',
  '/icon-512-v2.png',
  '/icon-maskable-512-v2.png',
  '/apple-touch-icon-v2.png',
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

  // 導覽（開頁、PWA 啟動、重新整理）不攔截：交給伺服器決定要回 app 還是登入頁
  if (req.mode === 'navigate') return;

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
