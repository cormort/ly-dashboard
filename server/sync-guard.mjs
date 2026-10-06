import { listSyncSources } from './queries.mjs';
import { resolveScope, SYNC_SCOPES } from './sync-scopes.mjs';

/**
 * 「更新」按鈕的防呆：按下去**不會取得更新的資訊**時，直接告訴使用者，不要讓它白跑一趟。
 *
 * 三種情況會擋：
 * 1. 已經有同步在跑 —— 同時只允許一個同步，再按也只是合併，不如講清楚。
 * 2. 同一個範圍剛同步過（各範圍有自己的 `cooldownMinutes`）—— 上游（政府開放資料、g0v）
 *    一天更新一次，剛抓完再抓一定一樣，只是浪費時間與對方頻寬。
 * 3. 上一次同步有來源失敗 → **不擋**（重試有意義，見下面的 failed_sources 判斷）。
 *
 * 使用者仍可按「仍要重跑」強制執行（`force`），防呆只擋「明顯沒有意義」的那一類。
 */

const timeOf = (value) =>
  new Date(value).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei', hour12: false });

/** 回傳 `{ allow: true }` 或 `{ allow: false, reason, message, … }` */
export function checkSyncGuard(db, scopeId, { now = new Date(), force = false, inflight = null } = {}) {
  const scope = resolveScope(scopeId);

  if (inflight) {
    const label = SYNC_SCOPES.find((item) => item.id === inflight)?.label ?? inflight;
    return {
      allow: false,
      reason: 'sync_in_progress',
      inflight_scope: inflight,
      message: `已經有同步在跑（${label}），同時只會跑一個 —— 現在按不會比較快，等它跑完再按。`,
    };
  }

  if (force) return { allow: true };

  const info = listSyncSources(db).scopes.find((item) => item.id === scope.id);
  if (!info?.last_run_at) return { allow: true };
  // 上次有來源失敗：讓使用者可以重試，不要擋
  if ((info.failed_sources ?? []).length > 0) return { allow: true };

  const last = Date.parse(info.last_run_at);
  if (!Number.isFinite(last)) return { allow: true };
  const minutesAgo = Math.floor((now.getTime() - last) / 60_000);
  if (minutesAgo >= scope.cooldownMinutes) return { allow: true };

  const ago = minutesAgo < 1 ? '剛剛' : `${minutesAgo} 分鐘前`;
  return {
    allow: false,
    reason: 'sync_too_soon',
    minutes_ago: minutesAgo,
    retry_after_minutes: scope.cooldownMinutes - minutesAgo,
    last_run_at: info.last_run_at,
    message:
      `「${scope.label}」${ago}（${timeOf(info.last_run_at)}）才同步過。` +
      `${scope.cadence}，現在按不會取得更新的資料。要強制重跑請按「仍要重跑」。`,
  };
}
