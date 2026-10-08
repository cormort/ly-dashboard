import { useEffect, useState } from 'react';

/**
 * 離線提示（T11）。
 *
 * Service Worker 只快取靜態外框、**不快取 /api/v1/***，所以離線時畫面外框還在、
 * 但資料一定抓不到。這裡明講「目前離線，資料需連線取得」——
 * 不讓使用者把殘缺畫面誤以為是最新資料。
 */
export function OfflineNotice() {
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-notice" role="status" aria-live="polite">
      <b>目前離線，資料需連線取得</b>
      <small>畫面外框仍在，但數字無法更新；連上網路後重新整理即可。</small>
    </div>
  );
}
