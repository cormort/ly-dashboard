import { connectionHint } from '../lib/connectionHint';

/** 目前的來源主機；server render（render smoke）沒有 window，一律回空字串 */
export function currentHostname(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.hostname ?? '';
}

/**
 * 錯誤卡裡那句「所以現在該做什麼」。
 *
 * 為什麼要有：手機沒開 Tailscale 時，畫面上只有「無法連線到 API 伺服器（network_error）」——
 * 使用者看到的是「網站壞了」，而不是「去開啟手機的 Tailscale」。這句話就是把那個缺口補起來。
 *
 * `hostname` 可以覆寫，只為了測試（render smoke 是 server render，沒有 window）。
 */
export function ConnectionHint({ code, hostname = currentHostname() }: { code: string | null; hostname?: string }) {
  const hint = connectionHint({ hostname, code });
  if (!hint) return null;
  return <small className="connection-hint">{hint}</small>;
}
