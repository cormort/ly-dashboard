/**
 * 純顯示用的格式化工具。
 *
 * 注意：這裡**不做任何資料清洗**。委員會名稱、屆次、會期一律照後端回傳的值顯示，
 * 前端不切字串、不剝前綴、不合併跨屆資料（舊版 B3/B4 的成因）。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 解析後端各種日期寫法（ISO 時間、`2026-09-27`、`2024/02/01`）；不合法回 null */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 後端可能回 null／空字串，畫面統一到「未提供」 */
export function text(value: string | null | undefined, fallback = '未提供'): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? fallback : trimmed;
}

/**
 * **清單裡的日期一律用這支**：今年的不寫年份（`04/29`），不同年才補（`2025/04/29`）。
 *
 * 2026-10-08 使用者：「現在日期表達方式沒有統一，今年的就不用加上年度」——
 * 原本同一份資料在不同頁面分別出現 `04/29`、`2026/04/29`、`2026/04/29 09:20`、`2026-04-29` 四種寫法。
 * 一律走這裡，跨年時仍然看得出年份（別把 2025 的資料讀成今年）。
 * `now` 只給測試注入固定日期用。
 */
export function formatDay(value: string | null | undefined, fallback = '—', now: Date = new Date()): string {
  const date = parseDate(value);
  if (!date) return fallback;
  const monthDay = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}/${monthDay}`;
}

/** 日期＋時間（同步時間、異動紀錄）：年份規則同 formatDay */
export function formatDateTime(value: string | null | undefined, fallback = '尚無紀錄', now: Date = new Date()): string {
  const date = parseDate(value);
  if (!date) return fallback;
  const monthDay = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}/${monthDay}`} ${clock}`;
}

/** 只到日的日期（formatDay 的別名；年份規則一樣） */
export function formatDate(value: string | null | undefined, fallback = '尚無紀錄', now: Date = new Date()): string {
  return formatDay(value, fallback, now);
}

/** 「3 小時前」這類相對時間；無法解析時退回 fallback */
/** 毫秒 → 人看得懂的時間（同步耗時用；不知道就回 fallback） */
export function formatDuration(ms: number | null | undefined, fallback = '—'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return fallback;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘`;
  return `${(minutes / 60).toFixed(1)} 小時`;
}

export function formatRelative(value: string | null | undefined, fallback = '尚無紀錄'): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(value, fallback);
}

/**
 * 圖表 X 軸的短標籤（**只影響顯示，不動資料**）：
 * 「內政委員會」→「內政」。完整名稱仍會在 tooltip 與文字替代中出現。
 */
/**
 * 委員會顯示用的短名（去掉尾端的「委員會」）。
 * 只在顯示層使用；送進 API 的永遠是完整 id（乾淨名稱，不含會期前綴）。
 */
export function shortCommittee(id: string): string {
  const trimmed = String(id ?? '').trim();
  const short = trimmed.replace(/委員會$/, '');
  return short === '' ? trimmed : short;
}

/** 異動紀錄的值：null／空字串以「（無）」呈現，布林語意欄位轉中文 */
export function formatChangeValue(field: string, value: string | null): string {
  if (value === null || value.trim() === '') return '（無）';
  if (field === 'is_convener') {
    if (value === '1' || value.toLowerCase() === 'true') return '是';
    if (value === '0' || value.toLowerCase() === 'false') return '否';
  }
  return value;
}

/** 資料集代號 → 顯示名稱（後端 dataset 值為 id9/id14 等） */
/** 跟後端 server/sync-scopes.mjs 的對照表一致（同一批 dataset 名稱） */
const DATASET_LABELS: Record<string, string> = {
  id9: 'ID9 立法委員名錄',
  id14: 'ID14 委員會委員名單',
  bills: '議案',
  budget: '預算',
  budget_reports: '預算評估報告',
  meetings: '會議',
  records: '會議紀錄',
  social: '委員粉專',
  council_social: '議員粉專',
  news: '新聞',
};

export function datasetLabel(dataset: string): string {
  return DATASET_LABELS[dataset] ?? dataset;
}

export const SYNC_STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失敗',
  skipped: '內容未變更',
};

/** 議案名稱去掉固定的「，請審議案。」尾綴，只留案由 */
export function billTitle(name: string): string {
  return name.replace(/[，,]?\s*請審議案。?$/, '').trim() || name;
}

/**
 * 同步進行中的細部進度字串，例如 `新聞 137/601`。
 * 單一資料集內部有幾百個請求（新聞就是），只靠 sync_runs 會十幾分鐘都停在「已完成 0 個來源」，
 * 看起來像卡住，所以畫面上要顯示這種「跑到哪」的數字。
 */
export function syncProgressText(progress: { phase?: string; done?: number; total?: number } | null | undefined): string | null {
  if (!progress) return null;
  const total = Number(progress.total) || 0;
  const done = Number(progress.done) || 0;
  const phase = progress.phase ? `${progress.phase} ` : '';
  if (total > 0) return `${phase}${done}/${total}`;
  return progress.phase || null;
}

/**
 * 頁首的「同步中…」文字。`detail` 是有細部進度時要顯示的內容（例如 `新聞 137/601`），
 * 沒有的話退回已完成幾個來源；後面一律補上「已跑多久」，讓使用者知道它還活著。
 */
export function syncRunningText({
  scopeLabel = null,
  detail = null,
  finished = 0,
  elapsedMs = 0,
}: {
  scopeLabel?: string | null;
  detail?: string | null;
  finished?: number;
  elapsedMs?: number;
}): string {
  const where = scopeLabel ? `（${scopeLabel}）` : '';
  const what = detail ? `（${detail}・已跑 ${formatDuration(elapsedMs)}）` : `（已完成 ${finished} 個來源・已跑 ${formatDuration(elapsedMs)}）`;
  return `同步中…${where}${what}`;
}
