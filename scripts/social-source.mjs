/**
 * 立委社群整理表的來源位置與連線檢查（單一來源）。
 *
 * 為什麼要獨立一支：
 *   ‧ 抓取腳本（fetch-fb-posts.mjs）與每日排程的連線檢查（fb-daily.mjs）必須指向同一份表，
 *     預設值寫兩份，總有一天只改一邊。
 *   ‧ 2026-10-10 08:00 的失敗是**連線層**的（`fetch failed`，UND_ERR_CONNECT_TIMEOUT）：
 *     一開跑就死，整天沒有資料，而且 log 只有 “fetch failed” 四個字 —— undici 把真正的原因
 *     放在 err.cause，`err.message` 本身沒有資訊。兩件事都在這裡處理：
 *     有重試的等待（waitForCsv）＋把 cause 帶出來的錯誤描述（describeError）。
 *
 * 用函式而不是模組常數：呼叫端要讀完 ~/.ly-dashboard/sheet.env 之後才問網址，常數會太早定型。
 */

const DEFAULT_SHEET_ID = '11XrvNGMKZb_8rekFdGIg5VsXcV8rdJkZjyzd1I4gAMM';

/** 整理表 CSV 的網址（LY_SOCIAL_CSV 可整串覆寫）。 */
export function sheetCsvUrl(env = process.env) {
  if (env.LY_SOCIAL_CSV) return env.LY_SOCIAL_CSV;
  const id = env.LY_SOCIAL_SHEET_ID ?? DEFAULT_SHEET_ID;
  const gid = Number(env.LY_SOCIAL_GID ?? 1325033898);
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/**
 * 錯誤的可讀描述。Node 的 fetch 失敗時 message 一律是 “fetch failed”，
 * 真正的原因（ENOTFOUND／UND_ERR_CONNECT_TIMEOUT／CERT_…）在 err.cause。
 */
export function describeError(err) {
  const cause = err?.cause;
  const detail = cause?.code || cause?.message || (cause ? String(cause) : '');
  const message = err?.message ?? String(err);
  return detail && !message.includes(detail) ? `${message}（${detail}）` : message;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 抓一次來源：確認連得到、而且回來的真的是整理表 CSV。 */
export async function probeCsv(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('姓名')) throw new Error('回傳內容不是整理表 CSV');
  return text.length;
}

/**
 * 等整理表連得到再開跑：暫時性的斷線不該讓一整天沒有資料。
 * 每次失敗都把原因（含 cause）寫進 log；全部試完回 false。
 */
export async function waitForCsv(url, log, { attempts, delayMs, timeoutMs } = {}) {
  const n = Number(attempts ?? process.env.LY_FB_PROBE_ATTEMPTS ?? 5);
  const wait = Number(delayMs ?? process.env.LY_FB_PROBE_DELAY_MS ?? 30_000);
  const timeout = Number(timeoutMs ?? process.env.LY_FB_PROBE_TIMEOUT_MS ?? 30_000);
  for (let i = 1; i <= n; i++) {
    try {
      await probeCsv(url, { timeoutMs: timeout });
      if (i > 1) log(`整理表連線恢復（第 ${i} 次嘗試）`);
      return true;
    } catch (err) {
      log(`整理表連線檢查失敗（第 ${i}/${n} 次）：${describeError(err)}`);
      if (i < n) await sleep(wait);
    }
  }
  return false;
}
