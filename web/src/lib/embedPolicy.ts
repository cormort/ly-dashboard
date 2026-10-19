/**
 * 粉專牆卡片上的 Facebook 嵌入框要不要載入 —— 抽成純函式，讓規則本身可以測，
 * 不必靠「server render 不執行 useEffect」的巧合來驗。
 *
 * 規則：
 *   - 使用者按過「收起貼文」→ 不載入（他自己收起來的，就不要再自動打開）。
 *   - 使用者手動按「看貼文」（`forced`）→ 一定載入。
 *   - 否則只有 `auto`（粉專牆的「自動載入貼文」開關，預設關）且捲進畫面才載入。
 *     粉專牆預設不自動載入：一次幾十個 facebook.com iframe 會讓頁面很慢。
 */
export function shouldMountEmbed({
  collapsed,
  inView,
  forced,
  auto = true,
}: {
  collapsed: boolean;
  inView: boolean;
  forced: boolean;
  auto?: boolean;
}): boolean {
  if (collapsed) return false;
  if (forced) return true;
  return auto && inView;
}

/** 按鈕文字：載入了就可以收起；還沒載入（捲到會自動載入）就是「看貼文」 */
export function embedButtonLabel(mounted: boolean): string {
  return mounted ? '收起貼文' : '看貼文';
}
