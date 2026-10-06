/**
 * 同步「進行中」的細部進度（記憶體，不寫資料庫）。
 *
 * 為什麼需要：新聞同步是**單一資料集**底下一大串請求（委員＋基金／機關＋議員＋媒體，實測約 600 次），
 * 跑完才會有 sync_runs 紀錄，所以畫面上的「已完成 N 個來源」會停在 0 十幾分鐘 —— 看起來就像卡住。
 * 各階段在迴圈裡呼叫 `reportProgress`，`/api/v1/health` 的 `progress` 就讀得到，
 * 前端顯示「新聞 137/601・已跑 3:20」。
 *
 * 刻意只放記憶體：它是「現在跑到哪」的即時狀態，重啟就該忘記，不該進資料庫。
 */
let current = null;

/** 回報目前的進度；同一個階段會不斷覆蓋同一筆 */
export function reportProgress(update) {
  current = { ...current, ...update, at: new Date().toISOString() };
  return current;
}

/** 目前進行中的進度（沒有同步在跑時為 null） */
export function getProgress() {
  return current;
}

export function clearProgress() {
  current = null;
}

/** 給人看的進度字串，例如 `新聞 137/601`；沒有總數時只顯示階段名 */
export function progressText(progress) {
  if (!progress) return null;
  const total = Number(progress.total) || 0;
  const done = Number(progress.done) || 0;
  const phase = progress.phase ? `${progress.phase} ` : '';
  return total > 0 ? `${phase}${done}/${total}` : progress.phase || null;
}
