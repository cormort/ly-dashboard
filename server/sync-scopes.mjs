import { CONFIG } from './config.mjs';

/**
 * 同步階段（canonical 順序）。`runAll` 認得的就是這幾個代號，
 * server/ingest.mjs 的 runner 表與這裡必須一一對應（測試會檢查）。
 */
export const SYNC_STAGES = ['roster', 'bills', 'budget', 'budget_reports', 'meetings', 'records', 'social', 'social_posts', 'council_social', 'news', 'progress', 'committees'];

/**
 * 同步範圍（下拉選單的選項）。`stages` 是 `runAll` 認得的階段代號；
 * 順序即選單順序，第一個是預設（「全部」）。
 *
 * 為什麼要有這個：粉專牆的資料是「本機抓完寫回 Google 整理表」，跟政府開放資料無關，
 * 但按一次同步原本要跑完整 9 個階段（實測光新聞就 763 秒）。這裡讓呼叫端只跑需要的階段。
 */
export const SYNC_SCOPES = [
  {
    id: 'all',
    label: '全部',
    stages: SYNC_STAGES,
    cooldownMinutes: 30,
    cadence: '政府開放資料一天更新一次（立法院開放資料平台多在凌晨 04:00–05:00 更新）',
  },
  // cooldownMinutes／cadence：按「更新」時的防呆用（見 server/sync-guard.mjs）——
  // 這麼短時間內重按不可能有新資料，就直接告訴使用者，不要讓它白跑。
  { id: 'social', label: '只重讀社群粉專', stages: ['social', 'social_posts', 'council_social'], cooldownMinutes: 5, cadence: '委員粉專是本機每天 08:00 抓取後寫回整理表，一天只有一輪' },
  { id: 'news', label: '只同步新聞', stages: ['news'], cooldownMinutes: 10, cadence: '新聞來源雖然持續更新，但這麼短時間內再抓通常還是同一批' },
  { id: 'roster', label: '只同步名錄', stages: ['roster'], cooldownMinutes: 30, cadence: '名錄（立法院開放資料 id9／id14）一天更新一次' },
  { id: 'legislative', label: '議事與預算', stages: ['bills', 'budget', 'budget_reports', 'meetings', 'records', 'progress', 'committees'], cooldownMinutes: 30, cadence: '議事資料一天更新一次（g0v 與立法院開放資料都是每日更新）' },
];

export const DEFAULT_SCOPE = 'all';

/** 每個階段會寫進 `sync_runs.dataset` 的代號（查「上次同步時間」用） */
export const STAGE_DATASETS = {
  roster: Object.keys(CONFIG.endpoints), // id9、id14
  bills: ['bills'],
  budget: ['budget'],
  budget_reports: ['budget_reports'],
  meetings: ['meetings'],
  records: ['records'],
  social: ['social'],
  social_posts: ['social_posts'],
  council_social: ['council_social'],
  news: ['news'],
  progress: ['ppg_progress'],
  committees: ['bill_committees'],
};

/** 認不得的 scope 一律退回預設（前端舊版沒帶參數的情況也走這條） */
export function resolveScope(id) {
  return SYNC_SCOPES.find((scope) => scope.id === id) ?? SYNC_SCOPES[0];
}

export function scopeStages(id) {
  return resolveScope(id).stages;
}

/** 這個 scope 涵蓋哪些 sync_runs.dataset */
export function scopeDatasets(id) {
  return resolveScope(id).stages.flatMap((stage) => STAGE_DATASETS[stage] ?? [stage]);
}

export function isKnownScope(id) {
  return SYNC_SCOPES.some((scope) => scope.id === id);
}

/** `sync_runs.dataset` → 顯示名稱（下拉選單的細項與同步紀錄都用這份） */
const DATASET_LABELS = {
  id9: 'ID9 立法委員名錄',
  id14: 'ID14 委員會委員名單',
  bills: '議案',
  budget: '預算',
  budget_reports: '預算評估報告',
  meetings: '會議',
  records: '會議紀錄',
  social: '委員粉專',
  social_posts: '委員貼文（貼文層級）',
  council_social: '議員粉專',
  news: '新聞',
  ppg_progress: '議事進度（補日期）',
  bill_committees: '預算議案委員會',
};

export function datasetLabel(dataset) {
  return DATASET_LABELS[dataset] ?? dataset;
}
