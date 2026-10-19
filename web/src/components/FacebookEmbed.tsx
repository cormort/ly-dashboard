/**
 * Facebook 官方的粉專嵌入框（Page Plugin）：不需要 API 金鑰、不違反條款，直接顯示粉專最近的貼文。
 * 只對「粉絲專頁」有效；`profile.php?id=` 的個人檔案顯示不出來（只能點連結）。
 * 一次載入很多個嵌入框會很慢（每一個都是一個 facebook.com 頁面），所以都只在使用者按「看貼文」時才掛：
 * 立委詳情側欄與議員近期動態共用。粉專牆（一面牆幾十張卡）刻意不用嵌入框，只顯示整理表裡的最新貼文文字。
 */
export const facebookPluginUrl = (page: string) =>
  `https://www.facebook.com/plugins/page.php?${new URLSearchParams({ href: page, tabs: 'timeline', width: '340', height: '520', small_header: 'true', hide_cover: 'true', adapt_container_width: 'true' })}`;

export function FacebookEmbed({ url, name }: { url: string; name: string }) {
  return <iframe className="fb-embed" title={`${name} 的 Facebook 貼文`} src={facebookPluginUrl(url)} width={340} height={520} loading="lazy" allow="encrypted-media" />;
}
