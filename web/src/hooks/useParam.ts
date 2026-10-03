import { useCallback, useState } from 'react';

/**
 * 頁面層的網址狀態：`?key=`（replaceState，可分享、重整後一致、上一頁不會被灌滿）。
 *
 * 用法與全站的篩選條件（`useQueryState` 的 `FilterState`）不同：
 * - `FilterState` 是**委員查詢**共用的條件（屆次、會期、黨籍…），跨頁沿用。
 * - 這裡是**單一頁面自己的**檢視狀態（哪個縣市、哪個屆次、地圖配色…），別頁不需要知道，
 *   所以不進 `FilterState` —— 否則那一份共用狀態會被各頁的私有欄位愈長愈大，
 *   而且序列化順序會變成別頁的責任。
 *
 * 網址參數是使用者可以隨手改的：不合法的值要落回預設，不能帶進 render
 * （例如未知的地圖色階會讓整頁被 ErrorBoundary 蓋掉）。
 */
export function useParam<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (value: T) => void] {
  const read = (): T => {
    const raw = new URLSearchParams(window.location.search).get(key) as T | null;
    if (raw === null || raw === '') return fallback;
    if (allowed && !allowed.includes(raw)) return fallback;
    return raw;
  };
  const [value, setValue] = useState<T>(read);
  const update = useCallback((next: T) => {
    setValue(next);
    const params = new URLSearchParams(window.location.search);
    // 空字串＝回到預設值，直接拿掉參數，網址不留 `?key=`
    if (next === '') params.delete(key);
    else params.set(key, next);
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [key]);
  return [value, update];
}
