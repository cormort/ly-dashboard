import { useEffect, useRef } from 'react';

/**
 * 「連不上」時的自動重抓。
 *
 * 為什麼需要：Service Worker 會先把外殼從快取畫出來，所以連不上時畫面是**完整的、只缺資料**。
 * 使用者把（手機的）Tailscale 打開之後，原本的程式碼不會自己去抓 —— 要手動重新整理才會恢復，
 * 看起來就像網站壞掉。這裡補兩件事：
 *   ① 退避排程：連不上就照 RECONNECT_DELAYS_MS 的節奏一直重試（先快後慢，最多每 60 秒一次）
 *   ② 事件觸發：系統回報恢復網路（online）、切回前景（visibilitychange → visible）時立刻試一次
 * 一旦成功（呼叫端把 active 變 false）就停止。
 */

/** 重連後的自動重抓節奏（毫秒）：先快後慢，上限 60 秒 */
export const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 60000] as const;

/** 第 attempt 次（從 1 開始）要等多久；超過表格長度就固定用最後一個值 */
export function reconnectDelayMs(attempt: number): number {
  const last = RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
  if (!Number.isFinite(attempt) || attempt < 1) return RECONNECT_DELAYS_MS[0];
  return RECONNECT_DELAYS_MS[Math.min(Math.floor(attempt) - 1, RECONNECT_DELAYS_MS.length - 1)] ?? last;
}

/** 前景判定：只有真的可見才重抓（背景分頁不要浪費請求） */
export function isVisible(documentState: string): boolean {
  return documentState === 'visible';
}

export interface ReconnectRefreshOptions {
  /** 目前是否有資源處於「連不上」的錯誤狀態；false 時整段不啟用 */
  active: boolean;
  /** 重抓（呼叫端把 refreshToken +1 即可） */
  onRefresh: () => void;
}

export function useReconnectRefresh({ active, onRefresh }: ReconnectRefreshOptions): void {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  useEffect(() => {
    if (!active) return undefined;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      attempt += 1;
      timer = setTimeout(() => {
        onRefreshRef.current();
        schedule();
      }, reconnectDelayMs(attempt));
    };
    schedule();

    const onOnline = () => onRefreshRef.current();
    const onVisibility = () => {
      if (isVisible(document.visibilityState)) onRefreshRef.current();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);
}
