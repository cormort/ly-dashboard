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
  attempt: number | null;
  http_status: number | null;
  error: string | null;
  duration_ms: number | null;
  ua: string | null;
}

export interface HealthDbCounts {
  legislators: number;
  memberships: number;
  committee_seats: number;
  sessions: number;
  committees: number;
  changes: number;
  snapshots: number;
  bills: number;
  news: number;
  social_accounts: number;
}

export interface DatasetStatus {
  /** 該資料集最後成功同步時間（ISO 8601），可能為 null */
  fetched_at: string | null;
  count: number;
  /** 僅新聞：complete:113/113 或 partial:40/113 */
  status?: string | null;
}

export interface HealthResponse {
  meta: Meta;
  ok: boolean;
  db: HealthDbCounts;
  /** 每個資料集的最後同步時間與筆數（後端 /api/v1/health） */
  datasets: Record<'id9' | 'id14' | 'bills' | 'news' | 'social', DatasetStatus>;
  last_runs: SyncRun[];
  warnings: string[];
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
  /** 黨籍 → 席次（加總等於 count） */
  parties: Record<string, number>;
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

export interface LegislatorContact {
  /** 處所名稱，如「國會研究室」「虎尾聯合服務處」 */
  label: string;
  tel: string;
  fax: string;
  addr: string;
}

export interface LegislatorSocial {
  platform: 'facebook' | 'threads';
  /** 專頁名稱 */
  name: string;
  url: string;
  /** 最新貼文日期（YYYY-MM-DD，來自人工整理表） */
  latest_post_date: string;
  latest_post_summary: string;
}

export interface Legislator {
  /** 穩定識別（lgno → ename → name），不是陣列索引 */
  id: string;
  name: string;
  ename: string | null;
  party: string | null;
  caucus: string | null;
  area_name: string | null;
  /** 選區歸併後的縣市層級（「雲林縣」「全國不分區」「山地原住民」），供篩選用 */
  region: string;
  sex: string;
  onboard_date: string;
  contacts: LegislatorContact[];
  social: LegislatorSocial[];
  /** 本屆提案數（含共同提案） */
  bill_count: number;
  /** 近 180 天新聞則數 */
  news_count: number;
  photo_url: string | null;
  degree: string | null;
  experience: string | null;
  term: number;
  /** 該屆曾參與的會期 id 清單 */
  sessions: string[];
  committees: LegislatorCommittee[];
  is_convener: boolean;
  /** 已離職或被罷免 */
  former: boolean;
  leave_date: string;
  leave_reason: string;
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

export interface LegislatorQuery {
  id?: string;
  term?: number;
  session?: string;
  q?: string;
  party?: string;
  region?: string;
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

/* ---------- /bills ---------- */

export interface BillItem {
  /** 議案編號 */
  id: string;
  name: string;
  /** 議案狀態，如「交付審查」「三讀」 */
  status: string;
  category: string;
  session: number | null;
  /** 涉及的法律名稱（＝主題） */
  laws: string[];
  /** 最新進度日期（YYYY-MM-DD） */
  latest_date: string;
  /** 該委員是否為主提案人（未指定委員時一律 false） */
  is_lead: boolean;
  url: string;
  /** 提案人（主提案在前）；對不到委員的黨團不列 */
  sponsors: BillSponsor[];
}

export interface BillSponsor {
  id: string;
  name: string;
  party: string;
  is_lead: boolean;
}

export interface BillLawCount {
  name: string;
  count: number;
}

export interface BillsResponse {
  meta: Meta & { bills_fetched_at: string | null; bills_source: { name: string; url: string } };
  /** 符合條件的議案總數 */
  total: number;
  count: number;
  /** 最常涉及的法律（依件數排序，最多 8 項） */
  laws: BillLawCount[];
  /** 符合結果的議案狀態分布 */
  statuses: BillLawCount[];
  /** 主提案人黨籍 → 件數（黨團提案歸「黨團／其他」） */
  parties: Record<string, number>;
  /** 符合結果中最早的進度日期 */
  first_date: string | null;
  items: BillItem[];
}

/* ---------- /cosponsors ---------- */

export interface CosponsorPartner {
  id: string;
  name: string;
  party: string;
  /** 一起列名的議案數 */
  count: number;
}

export interface CosponsorsResponse {
  meta: Meta;
  legislator: string;
  total_bills: number;
  /** 有他黨委員一起列名的議案數 */
  cross_party_bills: number;
  items: CosponsorPartner[];
}

export interface CosponsorMatrixResponse {
  meta: Meta;
  /** 主提案人黨籍 → 連署人黨籍 → 人次 */
  matrix: Record<string, Record<string, number>>;
}

/* ---------- /compare ---------- */

export interface CompareItem {
  legislator: { id: string; name: string; party: string; area_name: string | null; region: string | null; photo_url: string | null; former: boolean };
  bills: number;
  lead_bills: number;
  passed_bills: number;
  news_30d: number;
  committees: { id: string; is_convener: boolean }[];
  top_laws: BillLawCount[];
}

export interface CompareResponse {
  meta: Meta;
  count: number;
  items: CompareItem[];
  shared: { bills: number; committees: string[] };
}

/* ---------- /news ---------- */

export interface NewsItem {
  legislator_id: string;
  legislator_name: string;
  legislator_party: string;
  title: string;
  /** 媒體名稱 */
  source: string;
  url: string;
  published_at: string;
}

export interface NewsResponse {
  meta: Meta & { news_fetched_at: string | null; news_source: { name: string; url: string } };
  total: number;
  count: number;
  items: NewsItem[];
}

/* ---------- /topics ---------- */

export interface TopicItem {
  /** 法律名稱 */
  law: string;
  /** 期間內有進度的議案件數 */
  count: number;
  /** 其中三讀件數 */
  passed: number;
  latest_date: string;
  /** 主提案人黨籍 → 件數 */
  parties: Record<string, number>;
}

export interface TopicsResponse {
  meta: Meta;
  /** 統計起始日（YYYY-MM-DD） */
  since: string | null;
  count: number;
  items: TopicItem[];
}

/* ---------- /activity ---------- */

export interface ActivityItem {
  legislator: {
    id: string;
    name: string;
    party: string;
    area_name: string;
    region: string;
    photo_url: string;
    is_convener: boolean;
  };
  /** 最新一筆動態的日期（YYYY-MM-DD） */
  activity_date: string;
  news_7d: number;
  post: { platform: string; url: string; date: string; summary: string } | null;
  news: { title: string; source: string; url: string; published_at: string } | null;
  bill: Omit<BillItem, 'is_lead' | 'sponsors'> | null;
}

export interface ActivityResponse {
  meta: Meta;
  count: number;
  items: ActivityItem[];
}

/* ---------- /rankings ---------- */

export type RankingType = 'news' | 'facebook' | 'bills';

export interface RankingLegislator {
  id: string;
  name: string;
  party: string;
  area_name: string;
  region: string;
  photo_url: string;
}

export interface RankingItem {
  rank: number;
  /** 0–1，相對第一名的長條長度（後端算好，前端不自行推導） */
  intensity: number;
  /** 排序依據的數值：新聞／法案為件數，臉書為「新鮮度」（60 − 天數） */
  value: number;
  /** 直接顯示用的字串（例：「87 則」「3 天前」） */
  value_display: string;
  legislator: RankingLegislator;
  /** 僅法案榜：主提案件數 */
  lead_count?: number;
  /** 僅臉書榜：距最新貼文的天數 */
  raw_days?: number;
  detail: { label: string; text: string; url: string };
}

export interface RankingBoard {
  type: RankingType;
  title: string;
  note: string;
  unit: string;
  items: RankingItem[];
}

export interface RankingsResponse {
  meta: Meta & { bills_fetched_at?: string | null; news_fetched_at?: string | null };
  days: number;
  limit: number;
  boards: Partial<Record<RankingType, RankingBoard>>;
}
