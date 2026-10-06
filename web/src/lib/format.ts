/**
 * 純顯示用的格式化工具。
 *
 * 注意：這裡**不做任何資料清洗**。委員會名稱、屆次、會期一律照後端回傳的值顯示，
 * 前端不切字串、不剝前綴、不合併跨屆資料（舊版 B3/B4 的成因）。
 */

const dateTimeFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 後端可能回 null／空字串，畫面統一到「未提供」 */
export function text(value: string | null | undefined, fallback = '未提供'): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? fallback : trimmed;
}

export function formatDateTime(value: string | null | undefined, fallback = '尚無紀錄'): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return dateTimeFormatter.format(date);
}

export function formatDate(value: string | null | undefined, fallback = '尚無紀錄'): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return dateFormatter.format(date);
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
