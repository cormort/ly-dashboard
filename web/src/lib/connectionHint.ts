/**
 * 「連不上」的時候，畫面要講出**最可能的原因**，而不是只丟一句「網路錯誤」。
 *
 * 實測情境（2026-10-09）：這個站只在 Tailscale 的 tailnet 內提供（`tailscale serve`，
 * hostname 長得像 `mac-mini.tail1ac930.ts.net`）。手機沒開 Tailscale app 時，
 * Service Worker 照樣會把外殼從快取畫出來（所以畫面是完整的、只缺資料），
 * 但 `/api/v1/*` 一定連不上 —— 使用者看到的就是那張紅色的「無法連線到 API 伺服器」卡片，
 * 而畫面上沒有任何線索指向「去開手機的 Tailscale」。
 *
 * 這裡只做純判斷（給定 hostname 與錯誤碼 → 一句話或 null）；渲染在 components/ConnectionHint。
 */

export type ConnectionCode = string | null | undefined;

/** 只有這兩種錯誤碼算「連不上」；HTTP 4xx/5xx、壞 JSON 都不要給連線建議（那會誤導） */
const CONNECTIVITY_CODES = new Set(['network_error', 'timeout']);

/** Tailscale 的 MagicDNS 名稱一律是 `*.ts.net` */
export function isTailnetHost(hostname: string): boolean {
  return /\.ts\.net$/i.test(String(hostname ?? '').trim());
}

/** 這台裝置「不是」在 tailnet 裡時，最可能的原因是伺服器沒在跑或裝置根本沒網路 */
export function connectionHint({ hostname, code }: { hostname: string; code: ConnectionCode }): string | null {
  if (!code || !CONNECTIVITY_CODES.has(code)) return null;
  const host = String(hostname ?? '').trim();

  if (isTailnetHost(host)) {
    return `這個站只在 Tailscale 網路內（${host}）。請確認這台裝置的 Tailscale 已開啟 —— 連上之後會自動重新載入，不必手動重新整理。`;
  }
  if (code === 'timeout') {
    return '連線逾時：可能是伺服器正在同步（忙碌）或這台裝置的網路太慢。稍後會自動重試，也可以按「重試」。';
  }
  return '連不上 API 伺服器：請確認伺服器還在執行（node server/index.mjs）與這台裝置的網路。恢復後會自動重新載入。';
}
