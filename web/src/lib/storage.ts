/**
 * localStorage 存取（追蹤名單）。
 *
 * key 一律使用後端給的穩定 `item.id`（lgno → ename → name），
 * 絕不使用陣列索引 —— 排序一變就會對錯人（舊版缺陷 3-1）。
 */

const TRACKED_KEY = 'ly-dashboard:tracked:v1';

function readRaw(): string[] {
  try {
    const raw = window.localStorage.getItem(TRACKED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  } catch {
    return [];
  }
}

export function loadTrackedIds(): string[] {
  return readRaw();
}

export function saveTrackedIds(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(TRACKED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // 無痕模式或配額不足時靜默失敗：追蹤只是加分功能，不該讓整個頁面壞掉。
  }
}
