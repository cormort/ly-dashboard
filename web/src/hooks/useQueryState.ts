import { useCallback, useEffect, useRef, useState } from 'react';
import { filtersEqual, parseFilters, serializeFilters, type FilterState } from '../lib/urlState';

export type NavigateMode = 'push' | 'replace';

export interface QueryStateApi {
  filters: FilterState;
  /** 以 patch 更新篩選條件（預設 push，可用 replace 避免把每個字都塞進上一頁歷史） */
  update: (patch: Partial<FilterState>, mode?: NavigateMode) => void;
  /** 直接換成整組條件 */
  set: (next: FilterState, mode?: NavigateMode) => void;
}

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * 篩選條件雙向同步到 URL query string：
 * - 變更 → history.pushState / replaceState
 * - 上一頁／下一頁 → popstate 重新解析
 *
 * 注意：history 的呼叫**不放在 setState updater 內**。StrictMode 會把 updater
 * 呼叫兩次，副作用寫在那裡會被執行兩次（舊版同步紀錄重複的成因）。
 */
export function useQueryState(): QueryStateApi {
  const [filters, setFilters] = useState<FilterState>(() => parseFilters(window.location.search));
  const filtersRef = useRef(filters);

  const apply = useCallback((next: FilterState, mode: NavigateMode) => {
    const prev = filtersRef.current;
    if (filtersEqual(prev, next)) return;
    filtersRef.current = next;
    const target = `${window.location.pathname}${serializeFilters(next)}`;
    if (target !== currentLocation()) {
      if (mode === 'push') window.history.pushState(null, '', target);
      else window.history.replaceState(null, '', target);
    }
    setFilters(next);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const parsed = parseFilters(window.location.search);
      filtersRef.current = parsed;
      setFilters(parsed);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const update = useCallback(
    (patch: Partial<FilterState>, mode: NavigateMode = 'push') => {
      apply({ ...filtersRef.current, ...patch }, mode);
    },
    [apply],
  );

  const set = useCallback((next: FilterState, mode: NavigateMode = 'push') => apply(next, mode), [apply]);

  return { filters, update, set };
}
