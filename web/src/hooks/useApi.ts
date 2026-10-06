import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, toApiError, type ApiError } from '../api/client';

/**
 * 極簡資料層：帶 AbortController 的 JSON 取用 hook。
 *
 * 為什麼不用 @tanstack/react-query：本專案的資料需求只有「依 URL 取一份 JSON +
 * 手動重試」，60 行的 hook 就能滿足，少一層相依也少一個建置風險（見取捨說明）。
 *
 * 每個資料區塊都必須落在四態之一：loading / ready / empty / error。
 */
export type ApiPhase = 'loading' | 'ready' | 'empty' | 'error';

export interface ApiResource<T> {
  phase: ApiPhase;
  /** ready 時為本次資料；loading 期間保留上一份成功資料以避免畫面閃爍 */
  data: T | null;
  error: ApiError | null;
  /** 重新發送同一個請求 */
  reload: () => void;
}

export interface UseApiOptions<T> {
  /** 判斷「空資料」的規則；預設看 items.length */
  isEmpty?: (data: T) => boolean;
  /** 變動時強制重抓（供頁面層的「重新整理」使用） */
  refreshToken?: number;
  /** 這個端點允許的逾時（毫秒）；重的端點可以放寬，預設 15 秒 */
  timeoutMs?: number;
}

function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items.length === 0;
  }
  return false;
}

interface State<T> {
  phase: ApiPhase;
  data: T | null;
  error: ApiError | null;
}

/**
 * @param url 完整請求路徑（用 api/client 的 buildUrl 產生）；`null` 代表尚未啟用請求
 */
export function useApi<T>(url: string | null, options: UseApiOptions<T> = {}): ApiResource<T> {
  const { isEmpty, refreshToken = 0, timeoutMs } = options;
  const [state, setState] = useState<State<T>>({ phase: 'loading', data: null, error: null });
  const [nonce, setNonce] = useState(0);

  const isEmptyRef = useRef(isEmpty);
  useEffect(() => {
    isEmptyRef.current = isEmpty;
  });

  useEffect(() => {
    if (url === null) {
      setState({ phase: 'loading', data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ phase: 'loading', data: prev.data, error: null }));

    apiRequest<T>(url, { signal: controller.signal, timeoutMs })
      .then((data) => {
        if (controller.signal.aborted) return;
        const check = isEmptyRef.current ?? defaultIsEmpty;
        setState({ phase: check(data as never) ? 'empty' : 'ready', data, error: null });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = toApiError(cause);
        if (error.isAbort) return;
        setState({ phase: 'error', data: null, error });
      });

    return () => controller.abort();
  }, [url, nonce, refreshToken]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { phase: state.phase, data: state.data, error: state.error, reload };
}
