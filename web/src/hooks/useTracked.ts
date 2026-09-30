import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadTrackedIds, saveTrackedIds } from '../lib/storage';

export interface TrackedApi {
  ids: readonly string[];
  set: ReadonlySet<string>;
  count: number;
  isTracked: (id: string) => boolean;
  toggle: (id: string) => void;
}

/**
 * ⭐ 追蹤名單（localStorage）。key 為後端回傳的穩定 Legislator.id。
 * localStorage 的寫入放在 effect，而非 setState updater —— StrictMode 下
 * updater 會被呼叫兩次，寫在那裡會產生重複／競態。
 */
export function useTracked(): TrackedApi {
  const [ids, setIds] = useState<string[]>(() => loadTrackedIds());

  useEffect(() => {
    saveTrackedIds(ids);
  }, [ids]);

  const set = useMemo(() => new Set(ids), [ids]);

  const toggle = useCallback((id: string) => {
    setIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }, []);

  const isTracked = useCallback((id: string) => set.has(id), [set]);

  return { ids, set, count: ids.length, isTracked, toggle };
}
