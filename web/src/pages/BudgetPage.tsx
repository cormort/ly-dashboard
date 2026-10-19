import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BudgetItem, BudgetMeetingsResponse, BudgetReportsResponse, BudgetResponse, BudgetState, BudgetTimelineResponse, BudgetTimelineItem, BudgetType } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { InfoTip } from '../components/InfoTip';
import { YearProgressList, budgetProgressText, budgetRecordsText, hasReviewableItems, yearLabel } from '../components/BudgetProgress';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { SearchField } from '../components/SearchField';
import { RouteLink } from '../components/RouteLink';
import { useApi, type ApiPhase } from '../hooks/useApi';
import type { ApiError } from '../api/client';
import { pathFor } from '../hooks/useRoute';
import { formatDay, shortCommittee } from '../lib/format';
import { partyStyle } from '../lib/parties';

/**
 * 換類別時的統計範圍決策（抽出來才測得到，這裡是最容易搞錯的地方）：
 *
 * - 點到**報告類**的類別（決議書面報告）：一定要含報告類，否則「只算預算案」會是空清單。
 * - 點到**預算案類別**（或全部）：回到預設的「只算預算案」，但這次呼叫自己指定了 scope 就尊重它。
 */
export function scopeAfterCategoryChange({
  currentScope,
  isBillCategory,
  explicitScope,
}: {
  currentScope: string;
  isBillCategory: boolean;
  explicitScope?: string;
}): string {
  if (explicitScope === 'all' || explicitScope === 'bills') return explicitScope;
  if (!isBillCategory) return 'all';
  return currentScope === 'all' ? 'bills' : currentScope;
}

export interface BudgetPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  onNavigate: (href: string) => void;
}

/** 類別名稱太長，畫面上用短名 */
const CATEGORY_LABEL: Record<string, string> = {
  中央政府總預算案: '總預算案',
  '法人預(決)算案': '法人預算',
  '預(決) 算決議案、定期報告': '決議書面報告',
};
const STATE_LABEL: Record<BudgetState, string> = {
  reviewed: '已審竣',
  in_review: '審議中',
  pending: '待審查',
  letter: '函件處理',
  returned: '退回',
};
/** 狀態的定義要寫給使用者看（數字是我們由 g0v 的狀態字串歸類出來的） */
const STATE_HINT = `「已審竣」＝審查完畢（含逾審查期限）、三讀、視同審議通過；
「審議中」＝已交付審查／協商、復議、排入院會（討論事項）；
「待審查」＝已排入院會但還沒進審查程序；
「函件處理」＝交付查照／函復機關／復請查照，不經審查，所以不算審竣也不算待審查；
「退回」＝退回程序委員會。資料來源是立法院議案狀態（g0v LYAPI），每日同步。`;
const TYPE_LABEL: Record<BudgetType, string> = { general: '總預算', subsidiary: '附屬單位預算', special: '特別預算', supplementary: '追加預算' };
/**
 * 進度日期欄的文字。上游（g0v）對本會期的預算議案常常沒有「最新進度日期」（實測本會期 199/199
 * 都沒有），留白會讓人以為壞掉，所以明講「尚無進度日期」——排序上也把這種案子當成最新
 * （見後端 `budgetBillsByProgress`），因為它們正是剛送進來、還沒有人會進度的案子。
 */
export const progressDateText = (value: string | null | undefined): string => formatDay(value, '尚無進度日期');

/**
 * 「機關檢送報告」在預算頁的歸屬類別（g0v 的分類名稱，跟 server/config.mjs 的 categories 同一份）。
 * 機關自己函送的書面報告都掛在這一類底下，所以「我的機關」與「總覽」的看更多都連到這裡（再加 proposer）。
 * 上游改分類名稱時，這裡與 server 的 config 要一起改。
 */
export const AGENCY_REPORT_CATEGORY = '預(決) 算決議案、定期報告';
const DEFAULT_CATEGORY = '中央政府總預算案';
const ALL = 'all';
const PAGE = 30;
/** 分年度呈現時，每個年度先列幾筆（其餘用「看這一年全部」再查） */
const GROUP_PREVIEW = 4;
/**
 * 「期間」的日期一律寫完整年月日（2025/10/15）。
 * formatDay 對今年會縮成 10/15，一端縮一端不縮看起來像倒著，期間與摘要不用它。
 */
const fullDate = (d: string | null | undefined) => (d ? String(d).replace(/-/g, '/') : '—');

interface Filters {
  category: string;
  type: string;
  q: string;
  year: string;
  proposer: string;
  state: string;
  /** 統計範圍：bills（預設，只算預算案本身）／all（含決議書面報告等報告類） */
  scope: string;
  /** 一案一列（預設）／none＝每筆議案都列 */
  merge: string;
  /** '1'＝連勘誤表這類附件一起顯示（預設不顯示） */
  attachments: string;
}

const readFilters = (): Filters => {
  const p = new URLSearchParams(window.location.search);
  const get = (k: string) => p.get(k) ?? '';
  return {
    category: get('category') || DEFAULT_CATEGORY,
    type: get('type'),
    q: get('q'),
    year: get('year'),
    proposer: get('proposer'),
    state: get('state'),
    scope: get('scope') === 'all' ? 'all' : 'bills',
    merge: get('merge') === 'none' ? 'none' : 'name',
    attachments: get('attachments') === '1' ? '1' : '',
  };
};

/** 單筆預算議案（清單與分年度檢視共用） */
function BudgetItemRow({
  item,
  showCategory,
  onPickProposer,
}: {
  item: BudgetItem;
  showCategory: boolean;
  onPickProposer: (proposer: string) => void;
}) {
  return (
    <li>
      <a href={item.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={item.name}>
        {item.name}
        <ExternalLink aria-hidden="true" />
      </a>
      <p className="bill-meta">
        <span className={`state-tag ${item.state}`}>{STATE_LABEL[item.state]}</span>
        {item.types.map((t) => (
          <span key={t} className={`type-tag ${t}`}>
            {TYPE_LABEL[t]}
          </span>
        ))}
        {/* 合併多筆議案紀錄時，單一狀態不能代表整個案子 → 直接列出各狀態有幾筆 */}
        {item.records > 1 ? (
          <>
            <span className="status-tag">共 {item.records} 筆議案紀錄</span>
            <span className="muted">{budgetRecordsText(item.record_states, item.records)}</span>
          </>
        ) : (
          <span className="status-tag">{item.status}</span>
        )}
        {/* 上游（g0v）對本會期的預算議案常沒有「最新進度日期」，留白會像壞掉 */}
        {item.latest_date ? <span>{progressDateText(item.latest_date)}</span> : <span className="muted">{progressDateText(item.latest_date)}</span>}
        <button type="button" className="link-button" onClick={() => onPickProposer(item.proposer)}>
          {item.proposer}
        </button>
        {/* 交付哪個委員會：同一個預算案會有多筆議案紀錄（分別交付不同委員會），這是區分它們的關鍵 */}
        {item.committees.map((c) => (
          <span key={c} className="committee-tag">
            {c}
          </span>
        ))}
        {showCategory ? <span>{CATEGORY_LABEL[item.category] ?? item.category}</span> : null}
      </p>
    </li>
  );
}

/**
 * 預算審議：總預算案、法人預算、預算決議書面報告的審議狀態（g0v 立法院 API），
 * 加上委員會預算會議的發言委員（官方 ID223）與預算中心評估報告（官方 WebAPI）。
 */
export function BudgetPage({ refreshToken, onOpenId, onNavigate }: BudgetPageProps) {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const onPop = () => setFilters(readFilters());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);


  const query = {
    category: filters.category === ALL ? '' : filters.category,
    type: filters.type,
    q: filters.q.trim(),
    year: filters.year,
    proposer: filters.proposer,
    state: filters.state,
    scope: filters.scope,
    merge: filters.merge === 'none' ? 'none' : '',
    include_attachments: filters.attachments === '1' ? '1' : '',
  };
  // 全部年度時請後端分年度呈現（每年統計＋前幾筆）；選了某一年就用一般清單分頁
  const grouped = !filters.year;
  const budget = useApi<BudgetResponse>(
    buildUrl('/budget', { ...query, limit: PAGE, offset: page * PAGE, group_by: grouped ? 'year' : '', per_group: GROUP_PREVIEW }),
    { refreshToken },
  );
  const data = budget.data;
  /**
   * 審查歷程的階段：流程帶與歷程清單共用同一個狀態。
   * 以前「階段」是歷程區塊裡自己的 chips，跟頁面上方的年度、類別分散在三處，
   * 使用者要自己拼「現在走到哪一關」——流程帶把它收成一個入口。
   */
  const [stage, setStage] = useState('');
  /** 年度只有一個來源：頁面的 year 篩選（'' ＝全部年度）；歷程跟著它走，不再有第二組年度 chips */
  const timelineYear = filters.year === 'unknown' ? '' : filters.year;
  const timeline = useApi<BudgetTimelineResponse>(
    buildUrl('/budget/timeline', { year: timelineYear }),
    { refreshToken },
  );
  // 換年度就沒有「剛剛選的那一關」可言了
  useEffect(() => setStage(''), [filters.year]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  // 年度分兩組（見下方下拉與 YearProgressList 的說明）
  const reviewableYears = (data?.years ?? []).filter((y) => hasReviewableItems(y.progress));
  const letterOnlyYears = (data?.years ?? []).filter((y) => !hasReviewableItems(y.progress));
  const allCount = data?.categories.reduce((sum, c) => sum + c.count, 0) ?? 0;

  // 類別清單（含 is_bills：那一類是不是「議案本身」）。change 放在這裡才看得到 data。
  const categories = data?.categories ?? [];
  const change = (patch: Partial<Filters>) => {
    let next = { ...filters, ...patch };
    // 換類別時，年度與機關條件多半不再適用
    if (patch.category !== undefined && patch.category !== filters.category) {
      next = { ...next, year: '', proposer: '' };
      // 報告類的類別（決議書面報告）在「只算預算案」範圍下一定是空的 → 自動切到含報告；
      // 切回預算案類別（或全部）時回到預設的「只算預算案」（除非這次自己指定了 scope）
      const picked = categories.find((c) => c.name === patch.category);
      // ALL 是「全部類別」，不代表預算案；那種情況下的類別切換不動 scope
      if (patch.category !== ALL) {
        next = { ...next, scope: scopeAfterCategoryChange({ currentScope: filters.scope, isBillCategory: !!picked?.is_bills, explicitScope: patch.scope }) };
      }
    }
    setFilters(next);
    setPage(0);
    window.history.replaceState(null, '', pathFor('budget', { ...next, q: next.q.trim(), category: next.category === DEFAULT_CATEGORY ? '' : next.category }));
  };

  /**
   * 預算審查流程：不是獨立面板，而是「各年度審議進度」面板裡、選中那一年下面展開的內容。
   * 流程與年度是同一件事（「這一年走到哪一關」），分兩個面板等於年度又出現兩組控制。
   */
  const flow = (
    <BudgetProcessRail
      year={timelineYear}
      stages={timeline.data?.stages ?? []}
      total={timeline.data?.summary.total ?? 0}
      apiYear={timeline.data?.year ?? null}
      briefing={timeline.data?.stages.find((s) => s.id === 'briefing')?.count ?? 0}
      stage={stage}
      onStageChange={setStage}
      loading={timeline.phase === 'loading' && !timeline.data}
    />
  );

  return (
    <>
      <h1 className="sr-only">預算審議</h1>

      <div className="category-tiles" role="group" aria-label="預算類別">
        {[{ name: ALL, count: allCount }, ...(data?.categories ?? [])].map((c) => (
          <button key={c.name} type="button" className="stat-tile" aria-pressed={filters.category === c.name} onClick={() => change({ category: c.name })}>
            <b className="stat-value">{c.count.toLocaleString()}</b>
            <span className="stat-label">{c.name === ALL ? '全部' : CATEGORY_LABEL[c.name] ?? c.name}</span>
          </button>
        ))}
      </div>

      <div className="segmented type-switch" role="group" aria-label="預算類型">
        <button type="button" aria-pressed={!filters.type} onClick={() => change({ type: '' })}>
          全部類型
        </button>
        {(Object.keys(TYPE_LABEL) as BudgetType[]).map((t) => (
          <button key={t} type="button" aria-pressed={filters.type === t} onClick={() => change({ type: t })}>
            {TYPE_LABEL[t]} {data ? data.types[t].toLocaleString() : ''}
          </button>
        ))}
      </div>

      <section className="panel year-panel" aria-label="各年度審議進度">
        <div className="sectionhead">
          <h2>各年度審議進度</h2>
          <InfoTip align="inline-end" label="審議狀態的定義">
            {STATE_HINT}
          </InfoTip>
        </div>
        {data && data.years.length > 1 ? (
          <>
            <p className="muted year-summary">
              {budgetProgressText(filters.year ? data.years.find((y) => y.name === filters.year)?.progress : data.progress)}
            </p>
            <YearProgressList
              years={data.years}
              active={filters.year}
              progress={data.progress}
              onPick={(year) => change({ year, state: filters.state })}
              detail={flow}
            />
          </>
        ) : (
          flow
        )}
      </section>

      <BudgetTimeline
        key={timelineYear}
        data={timeline.data}
        phase={timeline.phase}
        error={timeline.error}
        reload={timeline.reload}
        stage={stage}
        onStageChange={setStage}
      />

      <div className="filters bill-filters" role="group" aria-label="預算篩選條件">
        <SearchField value={filters.q} onChange={(q) => change({ q })} ariaLabel="搜尋名稱或提案單位" placeholder="搜尋名稱或機關，例如：國防部、特別預算" />
        <label>
          <span className="sr-only">預算年度</span>
          <select value={filters.year} onChange={(event) => change({ year: event.target.value })}>
            <option value="">全部年度</option>
            {/* 年度分兩組：只有函件處理的年度（實測 103、105–110、119 年度）沒有需要審查的案子，
                混在真的預算年度之間會讓人誤會，所以放另一組 */}
            <optgroup label="年度">
              {reviewableYears.map((y) => (
                <option key={y.name} value={y.name}>
                  {yearLabel(y.name)}（{y.count}）
                </option>
              ))}
            </optgroup>
            {letterOnlyYears.length > 0 ? (
              <optgroup label="只有函件處理的年度（不經審查）">
                {letterOnlyYears.map((y) => (
                  <option key={y.name} value={y.name}>
                    {yearLabel(y.name)}（{y.count}）
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="審議狀態">
          <button type="button" aria-pressed={!filters.state} onClick={() => change({ state: '' })}>
            全部
          </button>
          {(Object.keys(STATE_LABEL) as BudgetState[]).map((s) => (
            <button key={s} type="button" aria-pressed={filters.state === s} onClick={() => change({ state: s })}>
              {STATE_LABEL[s]} {data ? data.progress[s].toLocaleString() : ''}
            </button>
          ))}
        </div>
        {/* 統計範圍：預設只算預算案本身；報告類（函送…請查照案的彙總表／執行情形報告）
            在 g0v 的狀態常是「交付審查」，照狀態分類會變成「審議中」，把統計灌大 */}
        <div className="segmented scope-switch" role="group" aria-label="統計範圍">
          <button type="button" aria-pressed={filters.scope === 'bills'} onClick={() => change({ scope: 'bills' })}>
            只算預算案 {data ? data.scope_totals.bills.toLocaleString() : ''}
          </button>
          <button type="button" aria-pressed={filters.scope === 'all'} onClick={() => change({ scope: 'all' })}>
            含報告類 {data ? data.scope_totals.all.toLocaleString() : ''}
          </button>
        </div>
        {/* 一案一列：同一個預算案會有多筆議案紀錄（實測 115 年度總預算案 24 筆，分別交付不同委員會／會期），
            不合併的話清單看起來就是同一行重複十幾次 */}
        <div className="segmented merge-switch" role="group" aria-label="議案呈現方式">
          <button type="button" aria-pressed={filters.merge !== 'none'} onClick={() => change({ merge: 'name' })}>
            一案一列 {data ? data.merged_total.toLocaleString() : ''}
          </button>
          <button type="button" aria-pressed={filters.merge === 'none'} onClick={() => change({ merge: 'none' })}>
            每筆議案 {data ? data.records_total.toLocaleString() : ''}
          </button>
        </div>
        {filters.proposer ? (
          <button type="button" aria-pressed="true" onClick={() => change({ proposer: '' })} aria-label={`取消機關條件：${filters.proposer}`}>
            {filters.proposer}
            <X aria-hidden="true" />
          </button>
        ) : null}
        <ClearFiltersButton
          active={Boolean(filters.q.trim() || filters.year || filters.state || filters.proposer || filters.type)}
          onClick={() => change({ q: '', year: '', state: '', proposer: '', type: '' })}
        />
      </div>

      {filters.proposer ? (
        <p className="muted cross-link">
          想看這個機關的整體摘要（近期會議、書面回覆、誰在關注、首長新聞）？
          <RouteLink href={pathFor('my', { agency: filters.proposer })} onNavigate={onNavigate}>
            在「我的機關」查看{filters.proposer}
          </RouteLink>
        </p>
      ) : null}

      {data ? (
        <p className="muted scope-note">
          {data.scope_note}
          {/* 勘誤表這種附件不是預算案本身（實測 9 筆被算成「審議中」）→ 預設排除，但要看得到 */}
          {data.attachment_count > 0 || data.include_attachments ? (
            <>
              {data.include_attachments
                ? `・已包含 ${data.attachment_count} 筆附件（${data.attachment_label}）`
                : `・已排除 ${data.attachment_count} 筆附件（${data.attachment_label}）`}
              <button type="button" className="link-button" onClick={() => change({ attachments: data.include_attachments ? '' : '1' })}>
                {data.include_attachments ? '不顯示' : '顯示'}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="budget-layout">
        <section className="panel" aria-label="預算案列表" id="budget-results">
          <div className="sectionhead">
            <h2>審議項目</h2>
            <div>
              {data ? <span className="muted">{data.total.toLocaleString()} 件</span> : null}
              {data && data.total > 0 ? (
                <a className="button" href={buildUrl('/budget', { ...query, format: 'csv' })} download="budget.csv">
                  <Download aria-hidden="true" />
                  下載 CSV
                </a>
              ) : null}
            </div>
          </div>
          {budget.phase === 'loading' && !data ? <LoadingState label="讀取預算審議…" /> : null}
          {budget.phase === 'error' ? <ErrorState title="無法取得預算資料（/api/v1/budget）" error={budget.error} onRetry={budget.reload} /> : null}
          {data && data.items.length === 0 ? <EmptyState message="沒有符合的項目" hint="換個關鍵字，或清除年度、機關、狀態條件。" /> : null}
          {/* 全部年度：分年度呈現（每年一段，附該年統計與前幾筆） */}
          {data && data.groups.length > 0
            ? data.groups.map((group) => (
                <section key={group.name} className="budget-group" aria-label={yearLabel(group.name)}>
                  <div className="budget-group-head">
                    <h3>{yearLabel(group.name)}</h3>
                    <span className="muted">{budgetProgressText(group.progress)}</span>
                    {group.total > group.items.length ? (
                      <button type="button" className="link-button" onClick={() => change({ year: group.name })}>
                        看這一年全部 {group.total} 件
                      </button>
                    ) : null}
                  </div>
                  <ol className="bill-results">
                    {group.items.map((item) => (
                      <BudgetItemRow
                        key={item.id}
                        item={item}
                        showCategory={filters.category === ALL}
                        onPickProposer={(proposer) => change({ proposer })}
                      />
                    ))}
                  </ol>
                </section>
              ))
            : null}
          {data && data.groups.length === 0 && data.items.length > 0 ? (
            <>
              <ol className="bill-results">
                {data.items.map((item) => (
                  <BudgetItemRow
                    key={item.id}
                    item={item}
                    showCategory={filters.category === ALL}
                    onPickProposer={(proposer) => change({ proposer })}
                  />
                ))}
              </ol>
              {pages > 1 ? (
                <nav className="pager" aria-label="分頁">
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => {
                      setPage(page - 1);
                      document.getElementById('budget-results')?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    上一頁
                  </button>
                  <span className="muted">
                    第 {page + 1} / {pages} 頁
                  </span>
                  <button
                    type="button"
                    disabled={page + 1 >= pages}
                    onClick={() => {
                      setPage(page + 1);
                      document.getElementById('budget-results')?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    下一頁
                  </button>
                </nav>
              ) : null}
            </>
          ) : null}
        </section>

        {/* 右欄：預算中心報告是備詢時最常翻的，放最上面；原本這兩塊排在 30 筆清單之後，要捲很久才看得到 */}
        <div className="home-side">
        <BudgetReports refreshToken={refreshToken} />
        <section className="panel" aria-label="提案單位">
          <h2>提案單位</h2>
          <p className="muted topic-note">點機關只看它送的項目</p>
          {data && data.proposers.length > 0 ? (
            <ol className="partner-list">
              {data.proposers.map((p) => (
                <li key={p.name}>
                  <button type="button" className="name-button" aria-pressed={filters.proposer === p.name} onClick={() => change({ proposer: filters.proposer === p.name ? '' : p.name })}>
                    {p.name}
                  </button>
                  <span />
                  <span className="partner-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((p.count / data.proposers[0].count) * 100)}%`, background: 'var(--accent)' }} />
                  </span>
                  <span className="partner-count">{p.count}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
        <BudgetMeetings refreshToken={refreshToken} onOpenId={onOpenId} />
        </div>
      </div>
    </>
  );
}

/**
 * 預算審查歷程：同一個預算年度在**委員會分組審查、聯席、公聽會、黨團協商**開過的會議，依時間排。
 * 實務上總預算不是一次會議審完，中間會開很多場；這裡把官方 ID223 的會議紀錄排成一條時間軸，
 * 有對到 IVOD 場次就附影片連結。（院會二讀／三讀不在 ID223 裡，看上面的審議進度。）
 */
/**
 * 預算審查流程的**實際順序**（畫面上的順序，不是 API 回傳的順序）：
 * 行政院編製概算 → 送立法院（報告、一讀、付委）→ 委員會分組審查 → 聯席 → 公聽會
 * → 黨團協商 → 院會二讀／三讀 → 總統公布；通過之後才輪到「決議處理」（凍結案解凍、附帶決議）。
 *
 * 官方會議資料沒有「階段」欄位，階段是後端 `budgetReviewStage()` 從會議名稱判斷的，
 * 所以某一關這一年度沒有會議是常態（實測 115 年度：聯席 0、公聽會 0）——照實顯示「無」，
 * 不要因為是 0 就整關藏起來，那會讓「這一年到底有沒有公聽會」變成猜謎。
 */
export const BUDGET_PROCESS_STEPS = [
  { id: 'committee', label: '委員會分組審查', hint: '各委員會分組審查主管機關的預算（主戰場）' },
  { id: 'joint', label: '聯席審查', hint: '兩個以上委員會聯席審查' },
  { id: 'hearing', label: '公聽會', hint: '審查期間舉行的公聽會' },
  { id: 'negotiation', label: '黨團協商', hint: '朝野黨團協商（保留案在這裡處理）' },
  { id: 'plenary', label: '院會二讀／三讀', hint: '院會逐案表決、三讀通過' },
  { id: 'resolution', label: '決議處理', hint: '通過後處理凍結案解凍、附帶決議' },
] as const;

/**
 * 流程帶：一列六關，每關顯示這一年度開過幾場會議，點一關就只看那一關（再點一次取消）。
 *
 * 為什麼要有它：原本「各年度審議進度」說的是**案子**完成幾件、下面的「審查歷程」說的是**會議**，
 * 而階段 chips 埋在歷程裡、年度又分兩處（篩選列與歷程各一組）。使用者得自己在心裡拼
 * 「115 年度走到協商了沒」。流程帶把「年度 ＋ 走到哪一關 ＋ 幾場」放在同一列。
 */
export function BudgetProcessRail({
  year,
  stages,
  total,
  /** 「邀請…專案報告／業務報告」的場次：不是預算審查的一關，放在流程帶外面 */
  briefing = 0,
  /** 後端實際回傳的會議年度（沒選年度時它就是最新年度，跟清單的「全部年度」不是同一件事） */
  apiYear,
  stage,
  onStageChange,
  loading = false,
}: {
  /** 目前選的年度（'' ＝全部年度）；年度是從上方的年度清單選的，這裡只讀來寫標題 */
  year: string;
  stages: { id: string; label: string; count: number }[];
  /** 這一年度的審查會議總場次 */
  total: number;
  apiYear: number | null;
  briefing?: number;
  stage: string;
  onStageChange: (stage: string) => void;
  loading?: boolean;
}) {
  const countOf = (id: string) => stages.find((s) => s.id === id)?.count ?? 0;
  const pickStage = (id: string) => {
    const next = stage === id ? '' : id;
    onStageChange(next);
    // 選了才帶使用者去看清單；取消時不要亂捲，免得把人帶離流程帶
    if (next) document.getElementById('budget-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="process-flow" aria-label="預算審查流程">
      <p className="muted process-caption">
        {loading
          ? '讀取會議資料…'
          : `${apiYear ? `${apiYear} 年度` : '會議年度不明'}的審查流程・${total.toLocaleString()} 場會議${
              briefing > 0 ? `（含 ${briefing} 場專案報告，非審查程序）` : ''
            }${year ? '' : '（清單是全部年度，會議以最新年度計）'}`}
      </p>

      <ol className="process-rail" role="list">
        <li className="process-context">行政院編製概算、送立法院</li>
        {BUDGET_PROCESS_STEPS.map((step, index) => {
          const count = countOf(step.id);
          const active = stage === step.id;
          return (
            <li key={step.id}>
              <button
                type="button"
                className={`process-step${active ? ' is-active' : ''}${count === 0 ? ' is-empty' : ''}`}
                aria-pressed={active}
                title={step.hint}
                onClick={() => pickStage(step.id)}
              >
                <span className="process-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="process-label">{step.label}</span>
                <span className="process-count">{count > 0 ? `${count} 場` : '無'}</span>
              </button>
            </li>
          );
        })}
        <li className="process-context">總統公布</li>
      </ol>

      {briefing > 0 ? (
        <p className="wall-bulk">
          <button
            type="button"
            className="quiet"
            aria-pressed={stage === 'briefing'}
            onClick={() => onStageChange(stage === 'briefing' ? '' : 'briefing')}
          >
            另有 {briefing} 場「邀請機關專案報告／業務報告」（不是預算審查的一關），{stage === 'briefing' ? '按這裡回到流程' : '點這裡只看那幾場'}
          </button>
        </p>
      ) : null}

      <p className="muted topic-note">
        點一關只看那一關的會議，再點一次取消。流程兩端是「行政院編製概算、送立法院」與「總統公布」（沒有會議紀錄）。
        「無」＝這一年度沒有那種會議紀錄（階段是從會議名稱判斷的，官方資料沒有階段欄位）；
        預算中心的評估報告在下方，與這裡的會議是不同來源。
      </p>
    </div>
  );
}

export function BudgetTimeline({
  data,
  phase,
  error,
  reload,
  stage,
  onStageChange,
}: {
  data: BudgetTimelineResponse | null;
  phase: ApiPhase;
  error: ApiError | null;
  reload: () => void;
  /** 目前選的階段（'' ＝全部）；由流程帶控制，這裡只讀 */
  stage: string;
  onStageChange: (stage: string) => void;
}) {
  /** 主管機關（審查單位）：例「國防部」「國軍退除役官兵輔導委員會」，空字串＝全部 */
  const [agency, setAgency] = useState('');
  /** 分組方式：依委員會（預設，實務上按委員會追）／依時間（看整體先後） */
  const [groupBy, setGroupBy] = useState<'committee' | 'date'>('committee');
  const [limit, setLimit] = useState(20);
  const res = { phase, error, reload };
  const allStages = data?.stages ?? [];
  /** 「專案報告／程序事項」不是審查：不列進「共 N 場審查會議」，也不預設出現在審查歷程裡 */
  const briefingCount = allStages.find((s) => s.id === 'briefing')?.count ?? 0;
  const reviewTotal = Math.max(0, (data?.summary.total ?? 0) - briefingCount);
  const stages = allStages.filter((s) => s.count > 0 && s.id !== 'briefing');
  const agencies = (data?.summary.agencies ?? []).filter((a) => a.count > 0);
  const items = (data?.items ?? []).filter(
    (m) =>
      // 沒指定階段時：非審查程序（專案報告）不進審查歷程，要看就從流程帶那一行切過去
      (!stage ? m.stage !== 'briefing' : m.stage === stage) &&
      (!agency || (m.agencies ?? []).includes(agency)),
  );
  /** 分組用的鍵：委員會名稱（去掉「第N次」「（台灣民眾黨黨團）」這種尾巴），院會／表決歸在「院會」 */
  const committeeKeyOf = (m: BudgetTimelineItem) =>
    shortCommittee(String(m.committee ?? '').replace(/[（(].*$/, '').trim()) || '（未標示委員會）';
  /** 每組顯示的期間，例「10/15 ～ 05/18」；只有一天就只寫那一天 */
  const rangeOf = (list: BudgetTimelineItem[]) => {
    const dates = list.map((m) => m.date).filter((d): d is string => Boolean(d)).sort();
    if (!dates.length) return '日期不明';
    const first = fullDate(dates[0]);
    const last = fullDate(dates[dates.length - 1]);
    return first === last ? first : `${first} ～ ${last}`;
  };

  // 依委員會：一場會議算在它自己的委員會底下，組內仍照時間排（才知道同一委員會審了幾輪）
  const committeeGroups = (() => {
    const map = new Map<string, BudgetTimelineItem[]>();
    for (const m of items) {
      const key = committeeKeyOf(m);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return [...map]
      .map(([key, list]) => ({ key, label: key, items: list, range: rangeOf(list) }))
      .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key, 'zh-Hant'));
  })();
  // 依時間：原本的「年 月」分段，先顯示前 N 場
  const shown = items.slice(0, limit);
  const dateGroups: { key: string; label: string; items: BudgetTimelineItem[] }[] = [];
  for (const m of shown) {
    const key = (m.date ?? '').slice(0, 7) || '未知';
    const label = key === '未知' ? '日期不明' : `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`;
    if (!dateGroups.length || dateGroups[dateGroups.length - 1].key !== key) dateGroups.push({ key, label, items: [m] });
    else dateGroups[dateGroups.length - 1].items.push(m);
  }

  /** 單場會議（依委員會與依時間兩種檢視共用） */
  const timelineItem = (m: BudgetTimelineItem) => (
    <li key={`${m.id}-${m.date}`}>
      <div className="timeline-head">
        <time dateTime={m.date ?? undefined}>{formatDay(m.date, '—')}</time>
        <span className={`stage-badge stage-${m.stage}`}>{m.stage_label}</span>
        {groupBy === 'date' ? <b>{m.stage === 'plenary' ? m.name : committeeKeyOf(m)}</b> : null}
        {m.joint ? <span className="muted">（聯席：{shortCommittee(m.joint)}）</span> : null}
        {(m.agencies ?? []).map((a) => (
          <span key={a} className="unit-badge" title={`${a}主管的預算`}>
            {a}主管
          </span>
        ))}
        {m.has_briefing ? <span className="unit-badge" title="同一場議程前半是邀請機關專案報告，後半才是預算審查">含專案報告</span> : null}
        {m.subsidiary ? <span className="unit-badge unit-subsidiary">附屬單位</span> : null}
        {m.qa_only ? <span className="unit-badge unit-qa">僅詢答</span> : null}
      </div>
      {m.stage === 'plenary' && m.name ? <p className="muted timeline-sub">{m.name}</p> : null}
      <p className="clamp-2" title={m.agenda}>
        {m.agenda}
      </p>
      {(m.funds ?? []).length > 0 ? (
        <p className="fund-line" title={(m.funds ?? []).join('、')}>
          基金：{(m.funds ?? []).slice(0, 6).join('、')}
          {(m.funds ?? []).length > 6 ? ` 等 ${m.funds.length} 檔` : ''}
        </p>
      ) : null}
      <small className="muted">
        {m.speaker_count > 0 ? `${m.speaker_count} 位委員登記發言` : '沒有登記發言名單'}
        {m.speakers.length > 0 ? `（${m.speakers.slice(0, 4).map((s) => s.name).join('、')}${m.speakers.length > 4 ? ' 等' : ''}）` : ''}
        {m.video_url ? (
          <>
            {' · '}
            <a href={m.video_url} target="_blank" rel="noopener noreferrer">
              IVOD 影片
              <ExternalLink aria-hidden="true" />
            </a>
          </>
        ) : null}
      </small>
    </li>
  );

  return (
    <section className="panel" aria-label="預算審查歷程" id="budget-timeline">
      <div className="sectionhead">
        <h2>預算審查歷程</h2>
        {/* 年度改由上方「預算審查流程」的年度 chips 控制：同一頁只留一組年度，避免兩組年度各說各話 */}
        <span className="muted">{data?.year ? `${data.year} 年度的審查會議` : '全部年度的審查會議'}</span>
      </div>
      {res.phase === 'loading' && !data ? <LoadingState label="讀取審查歷程…" /> : null}
      {res.phase === 'error' ? (
        <ErrorState title="無法取得審查歷程（/api/v1/budget/timeline）" error={res.error} onRetry={res.reload} />
      ) : null}
      {data && data.summary.total - briefingCount === 0 ? (
        <EmptyState message="這個年度還沒有會議紀錄" hint="立法院開放資料同步後會出現在這裡。" />
      ) : null}
      {data && data.summary.total > 0 ? (
        <>
          <p className="muted topic-note">
            {data.year} 年度中央政府總預算：共 {reviewTotal} 場審查會議
            {data.summary.first && data.summary.last ? `（${fullDate(data.summary.first)} ～ ${fullDate(data.summary.last)}）` : ''}，
            包含 {stages.map((s) => `${s.label} ${s.count} 場`).join('、')}；
            分屬 {committeeGroups.length} 個委員會。
            {briefingCount > 0
              ? `另有 ${briefingCount} 場「邀請機關專案報告／業務報告」（不是審查，未列在上面）：從上方流程帶那一行點進去看。`
              : ''}
          </p>
          {stage ? (
            <p className="wall-bulk">
              <button
                type="button"
                className="quiet"
                onClick={() => {
                  onStageChange('');
                  setLimit(20);
                }}
              >
                只看「{allStages.find((s) => s.id === stage)?.label ?? stage}」，按這裡看全部階段
              </button>
            </p>
          ) : null}
          {agencies.length > 0 ? (
            <div className="wall-filter-row" role="group" aria-label="審查單位（主管機關）">
              <span className="wall-filter-label">審查單位</span>
              <div className="law-facets">
                <button type="button" className="chip" aria-pressed={!agency} onClick={() => { setAgency(''); setLimit(20); }}>
                  全部
                </button>
                {agencies.slice(0, 18).map((a) => (
                  <button key={a.name} type="button" className="chip" aria-pressed={agency === a.name} onClick={() => { setAgency(a.name); setLimit(20); }} title={`${a.name}主管的預算`}>
                    {a.name} <span className="muted">{a.count}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="wall-filter-row" role="group" aria-label="分組方式">
            <span className="wall-filter-label">分組</span>
            <div className="law-facets">
              <button
                type="button"
                className="chip"
                aria-pressed={groupBy === 'committee'}
                onClick={() => {
                  setGroupBy('committee');
                  setLimit(20);
                }}
              >
                依委員會 <span className="muted">{committeeGroups.length} 個</span>
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={groupBy === 'date'}
                onClick={() => {
                  setGroupBy('date');
                  setLimit(20);
                }}
              >
                依時間
              </button>
            </div>
          </div>

          {groupBy === 'committee' ? (
            <>
              <p className="muted topic-note">依委員會分組，點一下展開該委員會的審查會議（組內照時間排）。</p>
              {committeeGroups.map((g) => (
                <details key={g.key} className="committee-group">
                  <summary>
                    <b>{g.label}</b>
                    <span className="muted">{g.items.length} 場</span>
                    <span className="muted">{g.range}</span>
                  </summary>
                  <ul className="meeting-list budget-timeline">{g.items.map(timelineItem)}</ul>
                </details>
              ))}
            </>
          ) : (
            <>
              {dateGroups.map((g) => (
                <div key={g.key}>
                  <h3 className="subhead">{g.label}</h3>
                  <ul className="meeting-list budget-timeline">{g.items.map(timelineItem)}</ul>
                </div>
              ))}
              {items.length > limit ? (
                <button type="button" className="more" onClick={() => setLimit((n) => n + 30)}>
                  顯示更多（還有 {items.length - limit} 場）
                </button>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

/** 議程涉及預算的委員會會議：登記發言最多的在職委員＋最近的會議 */
function BudgetMeetings({ refreshToken, onOpenId }: { refreshToken: number; onOpenId: (id: string) => void }) {
  const res = useApi<BudgetMeetingsResponse>(buildUrl('/budget/meetings', { limit: 8 }), { refreshToken });
  const [showAll, setShowAll] = useState(false);
  const data = res.data;
  return (
    <section className="panel" aria-label="預算會議發言">
      <h2>預算會議發言</h2>
      {res.phase === 'loading' && !data ? <LoadingState label="讀取會議…" /> : null}
      {res.phase === 'error' ? <ErrorState title="無法取得會議（/api/v1/budget/meetings）" error={res.error} onRetry={res.reload} /> : null}
      {data && data.total === 0 ? <EmptyState message="還沒有會議資料" hint="發言名單同步完成後會出現在這裡。" /> : null}
      {data && data.total > 0 ? (
        <>
          <p className="muted topic-note">
            本屆議程涉及預算的委員會會議 {data.total} 場（{data.with_speakers} 場有發言名單），在職委員登記發言場次：
          </p>
          <ol className="partner-list">
            {(showAll ? data.speakers : data.speakers.slice(0, 10)).map((s) => (
              <li key={s.legislator.id}>
                <button type="button" className="name-button" onClick={() => onOpenId(s.legislator.id)}>
                  {s.legislator.name}
                </button>
                <small style={{ color: partyStyle(s.legislator.party).color }}>{partyStyle(s.legislator.party).short}</small>
                <span className="partner-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((s.count / data.speakers[0].count) * 100)}%`, background: partyStyle(s.legislator.party).color }} />
                </span>
                <span className="partner-count">{s.count} 場</span>
              </li>
            ))}
          </ol>
          {data.speakers.length > 10 ? (
            <button type="button" className="more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? '收合' : `顯示前 ${data.speakers.length} 名`}
            </button>
          ) : null}
          <h3 className="subhead">最近有發言名單的預算會議</h3>
          <ul className="meeting-list">
            {data.items.map((m, i) => (
              <li key={`${m.date}-${m.name}-${i}`}>
                <b>
                  {m.date} · {shortCommittee(m.committee)}
                  {m.joint ? `（聯席：${m.joint}）` : ''}
                </b>
                <p className="clamp-2" title={m.content}>
                  {m.content}
                </p>
                <small className="muted">{m.speakers.length} 位委員登記發言</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** 立法院預算中心的評估報告 */
function BudgetReports({ refreshToken }: { refreshToken: number }) {
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(10);
  const res = useApi<BudgetReportsResponse>(buildUrl('/budget/reports', { type, limit }), { refreshToken });
  const data = res.data;
  return (
    <section className="panel" aria-label="預算中心評估報告">
      <div className="sectionhead">
        <h2>預算中心評估報告</h2>
        <div className="segmented" role="group" aria-label="報告類型">
          <button type="button" aria-pressed={!type} onClick={() => setType('')}>
            全部
          </button>
          {(data?.types ?? []).map((t) => (
            <button key={t.name} type="button" aria-pressed={type === t.name} onClick={() => setType(t.name)}>
              {t.name.replace('評估', '')} {t.count}
            </button>
          ))}
        </div>
      </div>
      {res.phase === 'loading' && !data ? <LoadingState label="讀取報告…" /> : null}
      {res.phase === 'error' ? <ErrorState title="無法取得報告（/api/v1/budget/reports）" error={res.error} onRetry={res.reload} /> : null}
      {data && data.items.length === 0 ? <EmptyState message="還沒有報告" hint="預算中心資料同步完成後會出現在這裡。" /> : null}
      {data && data.items.length > 0 ? (
        <>
          <ul className="news-list">
            {data.items.map((r) => (
              <li key={r.no}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer noopener">
                    {r.title}
                    <FileText aria-hidden="true" />
                  </a>
                ) : (
                  <span>{r.title}</span>
                )}
                <small>
                  {formatDay(r.completed)}　{r.author}　{r.type}
                </small>
              </li>
            ))}
          </ul>
          {data.items.length < data.total ? (
            <button type="button" className="more" onClick={() => setLimit((n) => Math.min(n + 20, 100))} disabled={limit >= 100}>
              顯示更多（{data.items.length} / {data.total}）
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
