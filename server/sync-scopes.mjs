import { CONFIG } from './config.mjs';

/**
 * 同步階段（canonical 順序）。`runAll` 認得的就是這幾個代號，
 * server/ingest.mjs 的 runner 表與這裡必須一一對應（測試會檢查）。
 */
export const SYNC_STAGES = ['roster', 'bills', 'budget', 'budget_reports', 'meetings', 'records', 'social', 'council_social', 'news', 'progress'];

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
  },
  { id: 'social', label: '只重讀社群粉專', stages: ['social', 'council_social'] },
  { id: 'news', label: '只同步新聞', stages: ['news'] },
  { id: 'roster', label: '只同步名錄', stages: ['roster'] },
  { id: 'legislative', label: '議事與預算', stages: ['bills', 'budget', 'budget_reports', 'meetings', 'records', 'progress'] },
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
  council_social: ['council_social'],
  news: ['news'],
  progress: ['ppg_progress'],
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
  council_social: '議員粉專',
  news: '新聞',
  ppg_progress: '議事進度（補日期）',
};

export function datasetLabel(dataset) {
  return DATASET_LABELS[dataset] ?? dataset;
}
