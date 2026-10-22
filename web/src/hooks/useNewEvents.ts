import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, buildUrl } from '../api/client';

/**
 * 站內新事件（2026-10-22 使用者：「新增的事件可以推送或跑馬燈嗎，如果 user 在瀏覽網頁時」）。
 *
 * 為什麼是輪詢而不是 Web Push：
 *  - Web Push 要 VAPID 金鑰＋使用者按「允許通知」，iOS 還得先把網站加到主畫面，這個站是內網／Tailscale
 *    網域、同事大多直接開瀏覽器，成功率太低；
 *  - 使用者要的是「**正在看網頁時**」知道有新東西 —— 那在頁面上跳一行跑馬燈最直接，也不打擾其他時候。
 * 輪詢成本：`/api/v1/events` 只查索引、而且不進熱資料暫存，60 秒一次對這台機器是零頭。
 *
 * 三個容易踩的細節：
 *  1. **第一次進來不要廣播歷史**：沒有游標時先抓 `limit=1` 只取 `latest` 存起來，畫面上什麼都不顯示。
 *     否則新同事第一次開站會被 120 天的事件淹掉。
 *  2. **游標收到就前進**：不是等使用者按「知道了」才前進 —— 重新整理不該重播同一批。
 *  3. **分頁在背景時不要輪詢**：省電也省機器；切回來（visibilitychange）立刻補一次。
 */
export interface SiteEvent {
  id: number;
  at: string;
  /** meeting｜bill｜budget */
  kind: string;
  ref: string;
  title: string;
  url: string;
  detail: string;
}

export interface EventsResponse {
  latest: number;
  since: number;
  items: SiteEvent[];
}

const CURSOR_KEY = 'ly-dashboard:events-cursor:v1';
const POLL_MS = 60_000;
/** 最多同時顯示幾筆（超出的只留最新的，跑馬燈滾不完等於沒人看） */
const MAX_SHOWN = 6;

export const EVENT_KIND_LABEL: Record<string, string> = {
  meeting: '新排定會議',
  bill: '新提案',
  budget: '新預算案',
};

export function eventLabel(event: SiteEvent): string {
  const kind = EVENT_KIND_LABEL[event.kind] ?? '新事件';
  return `${kind}：${event.title || event.ref}`;
}

function readCursor(): number {
  try {
    const raw = window.localStorage.getItem(CURSOR_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function writeCursor(value: number): void {
  try {
    window.localStorage.setItem(CURSOR_KEY, String(value));
  } catch {
    // 私密模式／儲存空間已滿：不影響功能，下次進來會當成第一次
  }
}

export interface NewEventsState {
  items: SiteEvent[];
  dismiss: () => void;
}

export function useNewEvents({ enabled = true }: { enabled?: boolean } = {}): NewEventsState {
  const [items, setItems] = useState<SiteEvent[]>([]);
  const cursorRef = useRef<number>(0);
  const startedRef = useRef(false);

  const poll = useCallback(async (signal?: AbortSignal) => {
    const since = cursorRef.current;
    const res = await apiRequest<EventsResponse>(buildUrl('/events', { since, limit: MAX_SHOWN }), { signal, timeoutMs: 10_000 });
    // 游標以伺服器回報的 latest 為準：即使 limit 截掉一半，下次也不會重播
    cursorRef.current = Math.max(since, res.latest);
    writeCursor(cursorRef.current);
    if (res.items.length) {
      setItems((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const merged = [...res.items.filter((e) => !seen.has(e.id)), ...prev];
        return merged.slice(0, MAX_SHOWN);
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    cursorRef.current = readCursor();

    const boot = async () => {
      try {
        if (!cursorRef.current) {
          // 第一次：只記住「現在最新」，不把歷史當成新事件
          const res = await apiRequest<EventsResponse>(buildUrl('/events', { limit: 1 }), { signal: controller.signal });
          cursorRef.current = res.latest;
          writeCursor(res.latest);
          return;
        }
        await poll(controller.signal);
      } catch {
        // 抓不到就等下一輪；不要讓跑馬燈變成錯誤訊息
      }
    };
    void boot();

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void poll(controller.signal).catch(() => {});
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll(controller.signal).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      startedRef.current = false;
    };
  }, [enabled, poll]);

  const dismiss = useCallback(() => setItems([]), []);
  return { items, dismiss };
}
