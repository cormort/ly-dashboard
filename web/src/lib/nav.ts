/**
 * 第二層頁籤點下去要「直接換頁」還是「開卡片」的決策。
 *
 * 為什麼：手機上一次只看得到 5 格頁籤，點下去整頁換掉就看不到剛才那一頁；
 * 使用者的要求是「點第二層頁籤跳出卡片、右上角一個關閉鈕，關掉回到原來那一頁」
 * （跟委員檔案同一個模式）。桌機不變：一律直接換頁（桌機的頁籤全部看得到，不需要這個）。
 *
 * 決策抽成純函式、行為留給真實瀏覽器驗（render smoke 不執行 useEffect，也點不到連結）。
 */

/** 與 styles.css 的 `@media (max-width: 760px)`、lib/scroll.ts 的 MOBILE_MAX_WIDTH 同一條界線 */
export const CARD_MAX_WIDTH = 760;

export function shouldOpenInCard({ viewportWidth }: { viewportWidth: number }): boolean {
  return viewportWidth > 0 && viewportWidth <= CARD_MAX_WIDTH;
}
