import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BudgetItem, BudgetMeetingsResponse, BudgetReportsResponse, BudgetResponse, BudgetState, BudgetType } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { InfoTip } from '../components/InfoTip';
import { YearProgressList, budgetProgressText, budgetRecordsText, hasReviewableItems, yearLabel } from '../components/BudgetProgress';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { shortCommittee } from '../lib/format';
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
export const progressDateText = (value: string | null | undefined): string => (value ? value : '尚無進度日期');

const DEFAULT_CATEGORY = '中央政府總預算案';
const ALL = 'all';
const PAGE = 30;
/** 分年度呈現時，每個年度先列幾筆（其餘用「看這一年全部」再查） */
const GROUP_PREVIEW = 4;

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
export function BudgetPage({ refreshToken, onOpenId }: BudgetPageProps) {
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

      {data && data.years.length > 1 ? (
        <section className="panel year-panel" aria-label="各年度審議進度">
          <div className="sectionhead">
            <h2>各年度審議進度</h2>
            <InfoTip align="inline-end" label="審議狀態的定義">
              {STATE_HINT}
            </InfoTip>
          </div>
          <p className="muted year-summary">
            {budgetProgressText(filters.year ? data.years.find((y) => y.name === filters.year)?.progress : data.progress)}
          </p>
          <YearProgressList
            years={data.years}
            active={filters.year}
            progress={data.progress}
            onPick={(year) => change({ year, state: filters.state })}
          />
        </section>
      ) : null}

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
      </div>

      {data ? (
        <p className="muted scope-note">
          {data.scope_note}
          {/* 勘誤表這種附件不是預算案本身（實測 9 筆被算成「審議中」）→ 預設排除，但要看得到 */}
          {data.attachment_count > 0 || data.include_attachments ? (
            <>
              {data.include_attachments
                ? `・已包含 ${data.attachment_count} 筆勘誤表等附件`
                : `・已排除 ${data.attachment_count} 筆勘誤表等附件`}
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
                  {r.completed?.slice(0, 7).replace('-', '/')}　{r.author}　{r.type}
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
