/**
 * Facebook 官方的粉專嵌入框（Page Plugin）：不需要 API 金鑰、不違反條款，直接顯示粉專最近的貼文。
 * 只對「粉絲專頁」有效；`profile.php?id=` 的個人檔案顯示不出來（只能點連結）。
 * 由呼叫端決定何時顯示：粉專牆是「卡片捲進畫面就自動載入」（見 web/src/lib/embedPolicy.ts），
 * 立委詳情側欄仍是按「看貼文」才載入 —— 一次載入幾十個嵌入框會很慢，而且每一個都會讓瀏覽器連到 Facebook。
 * 立委側欄與議員近期動態共用。
 */
export const facebookPluginUrl = (page: string) =>
  `https://www.facebook.com/plugins/page.php?${new URLSearchParams({ href: page, tabs: 'timeline', width: '340', height: '520', small_header: 'true', hide_cover: 'true', adapt_container_width: 'true' })}`;

export function FacebookEmbed({ url, name }: { url: string; name: string }) {
  return <iframe className="fb-embed" title={`${name} 的 Facebook 貼文`} src={facebookPluginUrl(url)} width={340} height={520} loading="lazy" allow="encrypted-media" />;
}
