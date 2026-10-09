/**
 * 「點圖例之後要不要把名錄帶到眼前」的決策。
 *
 * 為什麼需要：黨籍篩選只在席次圖的圖例上切換（見 FilterBar 的註解），而圖例在名錄**上方**。
 * 手機實測（390×844）：圖例在 y=616–697、名錄第一張卡在 y=780 以下，而手機瀏覽器上下各有工具列、
 * 實際可視高度只剩 650–700px —— 點下去真正變的是「那個看不到的清單」，眼前只有 12px 圓點由綠轉灰，
 * 使用者的結論就是「點圖例沒什麼用」。所以點選之後要把結果捲進視野。
 *
 * 決策抽成純函式，行為留給真實瀏覽器驗（render smoke 不執行 useEffect，也量不到捲動）。
 */

/** 與 styles.css 的 `@media (max-width: 760px)` 同一條界線：只有手機才需要自動捲動 */
export const MOBILE_MAX_WIDTH = 760;

/** 名錄錨點（`LegislatorsPage` 的包裝元素 id）；捲動與測試都靠它 */
export const DIRECTORY_ANCHOR_ID = 'directory';

/** 選了某個黨、而且視窗是手機寬度 → 把名錄捲到眼前。取消篩選時不捲（使用者正在圖上比較數字）。 */
export function shouldScrollToDirectory({
  selected,
  viewportWidth,
}: {
  selected: boolean;
  viewportWidth: number;
}): boolean {
  return selected && viewportWidth > 0 && viewportWidth <= MOBILE_MAX_WIDTH;
}

/** 使用者要求減少動態效果時用 'auto'（瞬間移動仍然是功能，不是裝飾，所以不取消捲動） */
export function scrollBehaviorFor(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

/** 目前的系統設定是不是「減少動態效果」（SSR 或舊瀏覽器一律當成否） */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 把名錄捲到視窗頂端；找不到錨點就什麼都不做。 */
export function scrollToDirectory({ behavior = 'smooth' }: { behavior?: ScrollBehavior } = {}): void {
  if (typeof document === 'undefined') return;
  const anchor = document.getElementById(DIRECTORY_ANCHOR_ID);
  if (!anchor) return;
  anchor.scrollIntoView({ block: 'start', behavior });
}
