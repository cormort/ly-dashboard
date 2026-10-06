/**
 * 粉專牆卡片上的 Facebook 嵌入框要不要載入 —— 抽成純函式，讓規則本身可以測，
 * 不必靠「server render 不執行 useEffect」的巧合來驗。
 *
 * 規則：
 *   - 使用者按過「收起貼文」→ 不載入（他自己收起來的，就不要再自動打開）。
 *   - 否則元素捲進畫面（`inView`）就載入。
 *   - 或使用者手動按「看貼文」（`forced`）：還沒捲到的卡片也讓他直接看。
 */
export function shouldMountEmbed({ collapsed, inView, forced }: { collapsed: boolean; inView: boolean; forced: boolean }): boolean {
  if (collapsed) return false;
  return inView || forced;
}

/** 按鈕文字：載入了就可以收起；還沒載入（捲到會自動載入）就是「看貼文」 */
export function embedButtonLabel(mounted: boolean): string {
  return mounted ? '收起貼文' : '看貼文';
}
