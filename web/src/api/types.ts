/**
 * 立法院開放資料 API v1 型別（逐字對應 docs/API.md，已凍結的契約）。
 *
 * 原則：
 * 1. 這裡只描述後端正規化後的形狀。前端**不得**再自行清洗委員會字串、
 *    也不得合併不同屆次／會期的資料 —— 那些是舊版 B3/B4 缺陷的來源。
 * 2. 後端有可能回 null 的欄位（例：學歷、經歷、照片）一律標為 `| null`，
 *    顯示層用 lib/format.ts 的 text() 轉成「未提供」。
 */

export interface SourceInfo {
  name: string;
  url: string;
  license: string;
}

export interface Meta {
  /** 本回應產生時間（ISO 8601） */
  generated_at: string;
  /** 資料最後成功同步時間（ISO 8601），可能為 null */
  fetched_at: string | null;
  /** 距離上次成功同步是否超過 36 小時 */
  stale: boolean;
  source: SourceInfo;
  /** 僅在有屆次語意的端點出現 */
  term?: number;
  /** 僅在有會期語意的端點出現，可能為 null */
  session?: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/* ---------- /health ---------- */

export type SyncRunStatus = 'success' | 'failed' | 'skipped';

export interface SyncRun {
  id: number;
  dataset: string;
  status: SyncRunStatus;
  started_at: string | null;
  finished_at: string | null;
  records: number | null;
  attempt: number;
  http_status: number | null;
  error: string | null;
  duration_ms: number | null;
  ua: string | null;
}

export interface HealthDbCounts {
  legislators: number;
  memberships: number;
  committee_seats: number;
  changes: number;
}

export interface HealthResponse {
  meta: Meta;
  ok: boolean;
  db: HealthDbCounts;
  last_runs: SyncRun[];
}

/* ---------- /meta ---------- */

export interface SessionInfo {
  /** 會期 id，如 "11-5" */
  id: string;
  seq: number;
  /** 如「第 11 屆第 5 會期」 */
  label: string;
}

export interface TermInfo {
  no: number;
  sessions: SessionInfo[];
}

export interface CurrentSelection {
  term: number;
  /** 該屆「有委員資料的最新會期」；無法判定時為 null */
  session: string | null;
}

export interface MetaResponse {
  meta: Meta;
  terms: TermInfo[];
  current: CurrentSelection;
  counts: { terms: number; sessions: number };
}

/* ---------- /committees ---------- */

export type CommitteeKind = 'standing' | 'special' | 'ad_hoc';

export interface CommitteeConvener {
  id: string;
  name: string;
}

export interface CommitteeItem {
  /** 乾淨的委員會名稱，不含「第N屆第M會期：」前綴 */
  id: string;
  kind: CommitteeKind;
  /** 該會期該委員會的席次數（後端算好，前端不得重新聚合） */
  count: number;
  conveners: CommitteeConvener[];
}

export interface CommitteesResponse {
  meta: Meta;
  count: number;
  items: CommitteeItem[];
}

/* ---------- /legislators ---------- */

export interface LegislatorCommittee {
  id: string;
  kind: CommitteeKind;
  /** 是否為**該會期**的召委 */
  is_convener: boolean;
}

export interface Legislator {
  /** 穩定識別（lgno → ename → name），不是陣列索引 */
  id: string;
  name: string;
  ename: string | null;
  party: string | null;
  caucus: string | null;
  area_name: string | null;
  photo_url: string | null;
  degree: string | null;
  experience: string | null;
  term: number;
  /** 該屆曾參與的會期 id 清單 */
  sessions: string[];
  committees: LegislatorCommittee[];
  is_convener: boolean;
  source_url: string;
}

export interface LegislatorsResponse {
  meta: Meta;
  /** 本頁回傳筆數 */
  count: number;
  /** 符合條件的總筆數 */
  total: number;
  items: Legislator[];
}

/** `session=all` 代表該屆全部會期 */
export const ALL_SESSIONS = 'all';

export interface LegislatorQuery {
  term?: number;
  session?: string;
  q?: string;
  party?: string;
  committee?: string;
  /** 只回傳本會期召委 */
  convener?: boolean;
  limit?: number;
  offset?: number;
}

/* ---------- /changes ---------- */

export interface ChangeItem {
  id: number;
  at: string;
  entity: string;
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
}

export interface ChangesResponse {
  meta: Meta;
  count: number;
  items: ChangeItem[];
}

/* ---------- /sync-runs ---------- */

export interface SyncRunsResponse {
  meta: Meta;
  count: number;
  items: SyncRun[];
}
