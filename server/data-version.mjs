/**
 * 資料版本號（行程內）。
 *
 * 「中間結果快取」（見 queries.mjs 的 memoized）只跟「資料有沒有變」有關，跟 query 參數無關。
 * 每次寫入資料（同步的每個階段、媒體輪詢、法律對照、議員與臉書資料…）就把版本 +1，
 * 下一個查詢自動重算；沒寫入就一直沿用。
 *
 * 放在獨立模組是為了避開循環匯入：db.mjs（寫入端）與 queries.mjs（讀取端）都要用它，
 * 而 queries.mjs 反過來會 import db.mjs。
 */
let version = 0;

/** 資料寫入後呼叫（db.mjs 的每個 apply* 都會叫一次） */
export function bump() {
  version += 1;
  return version;
}

/** 目前版本（讀取端拿來當快取的有效性判斷） */
export function current() {
  return version;
}
