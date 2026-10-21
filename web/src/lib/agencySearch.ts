/**
 * 機關搜尋（我的機關的選擇器用）。
 *
 * 為什麼要這個：機關清單有 **355 筆**（2026-10-21 實測）。原生 `<select>` 在手機是系統滾輪，
 * 要從「大陸委員會」滑到「行政院主計總處」得滾很久 —— 使用者會問「這樣會不會要滾很久」。
 * 換成輸入兩個字就縮到十筆以內（實測「主計」2 筆、「財政」12 筆、「教育」9 筆）。
 *
 * 規則刻意簡單：**名稱包含**即符合，開頭符合的排前面、短的在前、再照筆畫排序；
 * 查不到就回空陣列（畫面明說「找不到」，不要退回全部，那會讓使用者以為搜尋沒生效）。
 */
export function filterAgencies(names: readonly string[], query: string, limit = 8): string[] {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const hits = names.filter((name) => name.includes(q));
  hits.sort(
    (a, b) =>
      Number(b.startsWith(q)) - Number(a.startsWith(q)) ||
      a.length - b.length ||
      a.localeCompare(b, 'zh-Hant'),
  );
  return hits.slice(0, Math.max(1, limit));
}

/** 最近切換過的機關：存這個瀏覽器（localStorage），最多 4 筆、去重、新的在前 */
export function pushRecent(list: readonly string[], name: string, max = 4): string[] {
  const next = [name, ...list.filter((item) => item !== name)].slice(0, Math.max(1, max));
  return next;
}
