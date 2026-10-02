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
  /** 同步紀錄筆數（前端「同步紀錄」面板的來源） */
  sync_runs: number;
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
  datasets: Record<'id9' | 'id14' | 'bills' | 'budget' | 'news' | 'social', DatasetStatus>;
  /** 前端會顯示的兩種紀錄：目前筆數與保留上限 */
  retention: Record<'sync_runs' | 'change_log', { kept: number; current: number }>;
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
  /** 最新貼文日期（YYYY-MM-DD，來自人工整理表）；人工更正過的帳號會清空，因為舊摘要屬於舊網址 */
  latest_post_date: string;
  latest_post_summary: string;
  /** 'sheet'＝整理表、'override'＝人工更正表（server/social-overrides.json） */
  source?: 'sheet' | 'override';
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
  /** 該屆當選的選舉摘要（不分區委員為 null） */
  election: ElectionSummary | null;
  /** 報導最多的媒體（沒有新聞時為 null） */
  top_source: { name: string; count: number } | null;
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
  /** 屆次 */
  term: number | null;
  /** 會期（屆內序號） */
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
  /** 資料所屬屆次 */
  term: number | null;
  /** 各會期件數（在會期條件前算） */
  sessions: { seq: number; count: number }[];
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

export interface ElectionSummary {
  year: number;
  district: string;
  by_election: boolean;
  votes: number;
  pct: number;
  /** 對最高票落選者的領先票數／百分點 */
  margin: number | null;
  margin_pct: number | null;
  rival: { name: string; party: string; votes: number } | null;
  /** 與本人前一次參選的得票差 */
  change: number | null;
  /** 個人得票率 − 同選區同黨不分區政黨票得票率（百分點） */
  party_list_over_pct: number | null;
  president_over_pct: number | null;
}

export interface CompareItem {
  legislator: { id: string; name: string; party: string; area_name: string | null; region: string | null; photo_url: string | null; former: boolean };
  bills: number;
  lead_bills: number;
  passed_bills: number;
  news_30d: number;
  committees: { id: string; is_convener: boolean }[];
  /** 新聞最多的前 5 家媒體 */
  top_sources: { name: string; count: number }[];
  top_laws: BillLawCount[];
  election: ElectionSummary | null;
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
  /** 新聞來源分析：前 12 家媒體，count＝報導則數（同網址算一次），parties＝提到的委員黨籍人次 */
  sources: { name: string; count: number; parties: Record<string, number> }[];
  /** 媒體家數 */
  source_total: number;
  items: NewsItem[];
}

/* ---------- /news/articles ---------- */

export interface NewsArticle {
  url: string;
  title: string;
  source: string;
  published_at: string;
  legislators: { id: string; name: string; party: string }[];
}

export interface NewsArticlesResponse {
  meta: Meta & { news_fetched_at: string | null };
  total: number;
  source_total: number;
  /** 前 30 家媒體與報導則數（不受媒體條件影響） */
  sources: { name: string; count: number }[];
  /** 只有 scope=officials 才有：首長名單（依則數排序），party 欄放「機關＋職稱」 */
  people?: { id: string; name: string; party: string; count: number }[];
  items: NewsArticle[];
}

/* ---------- /topics ---------- */

export interface TopicItem {
  /** 詞彙（法律名稱／議案類別／委員會名稱） */
  name: string;
  /** 期間內件數（委員會詞彙為場次） */
  count: number;
  /** 近 7 天件數（不論所選區間，固定 7 天） */
  recent_count: number;
  /** 前一個等長區間的件數；本屆累計時為 0 */
  previous_count: number;
  /** count − previous_count */
  delta: number;
  /** 其中三讀件數 */
  passed: number;
  latest_date: string;
  latest_status: string;
  latest_name: string;
  latest_url: string;
  /** 主提案人黨籍 → 件數（委員會詞彙為空物件） */
  parties: Record<string, number>;
}

export interface TopicVocabulary {
  id: 'law' | 'category' | 'committee';
  label: string;
  unit: string;
  note: string;
}

export interface TopicsResponse {
  meta: Meta;
  /** 目前採用的詞彙 */
  vocab: TopicVocabulary['id'];
  /** 可切換的詞彙清單（含單位與說明，前端不硬編） */
  vocabularies: TopicVocabulary[];
  window: { days: number; from: string | null; to: string | null; recent_from: string | null; previous_from: string | null };
  /** 是否能跟前一期比較（本屆累計、或前期早於資料起點時為 false） */
  comparable: boolean;
  /** 該詞彙的資料起點與截止日（各詞彙來源不同，例如公報紀錄比議案舊） */
  data_from: string | null;
  data_to: string | null;
  /** 期間內出現過的詞彙總數（用於「只有 N 種」的提示） */
  distinct: number;
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

export type RankingType = 'news' | 'facebook' | 'bills' | 'close' | 'drop';

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

/* ---------- /budget ---------- */

export type BudgetState = 'pending' | 'done' | 'returned';
/** 預算類型：總預算／附屬單位預算／特別預算／追加預算（後端由名稱主旨判斷，可複選） */
export type BudgetType = 'general' | 'subsidiary' | 'special' | 'supplementary';

export interface BudgetItem {
  id: string;
  category: string;
  types: BudgetType[];
  name: string;
  status: string;
  /** 後端分好的審議狀態：審議中／已結案／退回 */
  state: BudgetState;
  /** 提案單位（機關或委員會） */
  proposer: string;
  /** 從名稱抽出的預算年度（民國），抽不到為 null */
  fiscal_year: number | null;
  session: number | null;
  latest_date: string;
  url: string;
}

export interface BudgetResponse {
  meta: Meta & { budget_fetched_at: string | null; source: { name: string; url: string } };
  total: number;
  count: number;
  categories: BillLawCount[];
  years: BillLawCount[];
  proposers: BillLawCount[];
  states: Record<BudgetState, number>;
  types: Record<BudgetType, number>;
  items: BudgetItem[];
}

export interface BudgetReport {
  no: string;
  type: string;
  title: string;
  author: string;
  completed: string | null;
  url: string | null;
}

export interface BudgetReportsResponse {
  meta: Meta & { reports_fetched_at: string | null };
  total: number;
  types: BillLawCount[];
  items: BudgetReport[];
}

export interface BudgetMeeting {
  date: string | null;
  committee: string;
  joint: string | null;
  name: string;
  content: string;
  speakers: { name: string; id: string | null }[];
}

export interface BudgetMeetingsResponse {
  meta: Meta & { meetings_fetched_at: string | null };
  total: number;
  with_speakers: number;
  committees: BillLawCount[];
  speakers: { legislator: { id: string; name: string; party: string }; count: number }[];
  items: BudgetMeeting[];
}

/* ---------- /regions ---------- */

export interface RegionLatest {
  kind: 'post' | 'news' | 'bill';
  date: string;
  text: string;
  url: string;
  source?: string;
  status?: string;
  legislator: { id: string; name: string; party: string };
}

export interface RegionItem {
  /** 縣市，或「全國不分區」「平地原住民」「山地原住民」 */
  region: string;
  legislators: { id: string; name: string; party: string }[];
  /** 該區委員近 7 天新聞則數合計 */
  news_7d: number;
  latest: RegionLatest[];
  /** 縣市統計摘要；不分區、原住民為 null */
  stats: RegionStats | null;
}

export interface RegionWinner {
  name: string;
  party: string;
  pct: number;
  margin_pct: number | null;
}

export interface RegionStats {
  population: number;
  /** 65 歲以上人口比率（%） */
  elderly_ratio: number;
  president_2024: RegionWinner;
  mayor_2022: RegionWinner;
}

export interface RegionsResponse {
  meta: Meta;
  count: number;
  items: RegionItem[];
}

/* ---------- /counties ---------- */

export type CountyElectionKey = 'president_2024' | 'president_2020' | 'mayor_2022' | 'mayor_2018';

export interface CountyCandidate {
  name: string;
  party: string;
  votes: number;
  /** 得票率（%，佔有效票） */
  pct: number;
}

export interface CountyElection {
  /** 選舉人數（中選會原始檔；理論上不會是 null） */
  electorate: number | null;
  /** 投票率（%） */
  turnout: number | null;
  valid: number;
  /** 依得票數由高到低 */
  candidates: CountyCandidate[];
  /** 第一名與第二名的票數差 */
  margin: number | null;
  /** 第一名與第二名的得票率差（百分點） */
  margin_pct: number | null;
}

export type TrendType = 'president' | 'mayor' | 'party_list';

export interface TrendPoint {
  year: number;
  /** 顯示用年份（縣市長 2009 與 2010 五都合為一輪：「2009／10」） */
  label: string;
  valid: number;
  turnout: number | null;
  /** 政黨 → 得票數（無黨籍候選人合併為「無黨籍」） */
  votes: Record<string, number>;
}

export interface CountyItem {
  county: string;
  households: number;
  population: number;
  /** 20 歲以上（選舉年齡）人口 */
  voting_age: number;
  /** 65 歲以上人口 */
  elderly: number;
  elections: Record<CountyElectionKey, CountyElection>;
  /** 歷次得票（依政黨加總），依年份排序 */
  trends: Record<TrendType, TrendPoint[]>;
  /** 地圖輪廓（SVG path，座標約在 0–530 × 0–735；金門、連江已平移成插圖） */
  path: string;
  legislators: { id: string; name: string; party: string; area_name: string }[];
}

export interface CountiesResponse {
  meta: Meta;
  /** 人口統計年月（YYYY-MM） */
  population_month: string;
  elections: Record<CountyElectionKey, { label: string; date: string }>;
  trend_types: Record<TrendType, string>;
  sources: { label: string; url: string }[];
  count: number;
  items: CountyItem[];
}

/* ---------- /legislator-votes ---------- */

export interface LegislatorRace {
  year: number;
  kind: '區域' | '平地原住民' | '山地原住民';
  district: string;
  by_election: boolean;
  party: string;
  votes: number;
  pct: number;
  /** 選區內名次 */
  rank: number;
  elected: boolean;
  seats: number;
  candidates: number;
  /** 當選者對最高票落選者；落選者對最低票當選者 */
  rival: { name: string; party: string; votes: number } | null;
  margin: number | null;
  margin_pct: number | null;
  /** 與本人前一次參選的得票差 */
  change: number | null;
  /** 同選區同黨的總統得票（大選的區域立委才有；無黨籍為 null） */
  president: PartyShare | null;
  /** 同選區同黨的不分區政黨票 */
  party_list: PartyShare | null;
}

export interface PartyShare {
  votes: number;
  pct: number;
  /** 個人票 − 政黨票（票數）；正值表示個人比黨強 */
  over: number;
  /** 個人得票率 − 政黨得票率（百分點） */
  over_pct: number;
}

export interface LegislatorVotesResponse {
  meta: Meta;
  years: number[];
  sources: { label: string; url: string }[];
  count: number;
  items: { legislator: { id: string; name: string; party: string; area_name: string | null; region: string | null }; history: LegislatorRace[] }[];
}

/* ---------- /split-ticket ---------- */

export interface PartyBucket {
  valid: number;
  votes: Record<string, number>;
}

export interface SplitTicketResponse {
  meta: Meta;
  years: number[];
  year: number;
  count: number;
  items: {
    county: string;
    district: string;
    valid: number;
    candidates: { name: string; party: string; votes: number; pct: number; elected: boolean }[];
    /** 同選區總統票、不分區政黨票（投開票所加總） */
    president: PartyBucket;
    party_list: PartyBucket;
  }[];
}

/* ---------- /funds ---------- */

export type FundType = 'fund' | 'agency' | 'foundation' | 'administrative' | 'dgbas';

export type FundKind = 'news' | 'post' | 'bill' | 'budget' | 'report';

export interface FundItem {
  kind: FundKind;
  date: string;
  title: string;
  url: string;
  /** 預算：提案機關；報告：報告類型；新聞：媒體 */
  source?: string;
  status?: string;
  legislator: { id: string; name: string; party: string } | null;
  /** 命中的該類正式名稱；清單外含「基金」為「其他基金」，清單外的基金會為「其他基金會」 */
  funds: string[];
}

export interface FundsResponse {
  meta: Meta;
  total: number;
  kinds: Record<FundKind, number>;
  /** 各來源資料期間（YYYY-MM-DD），以全部資料計，不只命中的；沒資料的來源不會出現 */
  periods: Partial<Record<FundKind, { from: string; to: string }>>;
  funds: { name: string; count: number }[];
  items: FundItem[];
}

/* ---------- /committee-activity ---------- */

export interface CommitteeMeetingItem {
  date: string;
  name: string;
  content: string;
  /** 參與的委員會全名（聯席會議有多個） */
  committees: string[];
  /** 登記發言委員；對不到本屆委員者 id 為 null */
  speakers: { id: string | null; name: string; party: string }[];
  /** 會議影片（議事網資料，依會議名稱對上；對不到為 null） */
  video_url: string | null;
  /** 會議附件：開會通知單、議事日程、書面報告… */
  attachments: { title: string; url: string }[];
}

/** 機關回覆：部會對委員質詢的書面答復（議事網的會議附件） */
export interface CommitteeReplyItem {
  date: string | null;
  committees: string[];
  meeting: string;
  title: string;
  url: string;
  /** 標題提到的委員（對不到則為空陣列） */
  legislators: { id: string; name: string; party: string }[];
}

export interface CommitteeRecordItem {
  id: string;
  date: string | null;
  committees: string[];
  /** 公報議程案由（會議名稱＋議程） */
  title: string;
  gazette_url: string | null;
  html_url: string | null;
  pdf_url: string | null;
}

export interface CommitteeActivityResponse {
  meta: Meta & { meetings_fetched_at: string | null; records_fetched_at: string | null; meets_fetched_at: string | null };
  committees: { name: string; count: number }[];
  meetings: { total: number; period: { from: string; to: string } | null; items: CommitteeMeetingItem[] };
  replies: { total: number; period: { from: string; to: string } | null; items: CommitteeReplyItem[] };
  records: { total: number; period: { from: string; to: string } | null; items: CommitteeRecordItem[] };
}
