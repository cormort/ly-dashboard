import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BudgetMeetingsResponse, BudgetReportsResponse, BudgetResponse, BudgetState, BudgetType } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { shortCommittee } from '../lib/format';
import { partyStyle } from '../lib/parties';

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
const STATE_LABEL: Record<BudgetState, string> = { pending: '審議中', done: '已結案', returned: '退回' };
const TYPE_LABEL: Record<BudgetType, string> = { general: '總預算', subsidiary: '附屬單位預算', special: '特別預算' };
const DEFAULT_CATEGORY = '中央政府總預算案';
const ALL = 'all';
const PAGE = 30;

interface Filters {
  category: string;
  type: string;
  q: string;
  year: string;
  proposer: string;
  state: string;
}

const readFilters = (): Filters => {
  const p = new URLSearchParams(window.location.search);
  const get = (k: string) => p.get(k) ?? '';
  return { category: get('category') || DEFAULT_CATEGORY, type: get('type'), q: get('q'), year: get('year'), proposer: get('proposer'), state: get('state') };
};

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

  const change = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    // 換類別時，年度與機關條件多半不再適用
    if (patch.category !== undefined && patch.category !== filters.category) Object.assign(next, { year: '', proposer: '' });
    setFilters(next);
    setPage(0);
    window.history.replaceState(null, '', pathFor('budget', { ...next, q: next.q.trim(), category: next.category === DEFAULT_CATEGORY ? '' : next.category }));
  };

  const query = {
    category: filters.category === ALL ? '' : filters.category,
    type: filters.type,
    q: filters.q.trim(),
    year: filters.year,
    proposer: filters.proposer,
    state: filters.state,
  };
  const budget = useApi<BudgetResponse>(buildUrl('/budget', { ...query, limit: PAGE, offset: page * PAGE }), { refreshToken });
  const data = budget.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const allCount = data?.categories.reduce((sum, c) => sum + c.count, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>預算審議</h1>
        <p className="muted">本屆總預算、法人預算與預算決議報告的審議進度，以及預算會議上發言的委員。</p>
      </div>

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

      <div className="filters bill-filters" role="group" aria-label="預算篩選條件">
        <SearchField value={filters.q} onChange={(q) => change({ q })} ariaLabel="搜尋名稱或提案單位" placeholder="搜尋名稱或機關，例如：國防部、特別預算" />
        <label>
          <span className="sr-only">預算年度</span>
          <select value={filters.year} onChange={(event) => change({ year: event.target.value })}>
            <option value="">全部年度</option>
            {(data?.years ?? []).map((y) => (
              <option key={y.name} value={y.name}>
                {y.name} 年度（{y.count}）
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="審議狀態">
          <button type="button" aria-pressed={!filters.state} onClick={() => change({ state: '' })}>
            全部
          </button>
          {(Object.keys(STATE_LABEL) as BudgetState[]).map((s) => (
            <button key={s} type="button" aria-pressed={filters.state === s} onClick={() => change({ state: s })}>
              {STATE_LABEL[s]} {data ? data.states[s] : ''}
            </button>
          ))}
        </div>
        {filters.proposer ? (
          <button type="button" aria-pressed="true" onClick={() => change({ proposer: '' })} aria-label={`取消機關條件：${filters.proposer}`}>
            {filters.proposer}
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

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
          {data && data.items.length > 0 ? (
            <>
              <ol className="bill-results">
                {data.items.map((item) => (
                  <li key={item.id}>
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
                      <span className="status-tag">{item.status}</span>
                      <span>{item.latest_date}</span>
                      <button type="button" className="link-button" onClick={() => change({ proposer: item.proposer })}>
                        {item.proposer}
                      </button>
                      {filters.category === ALL ? <span>{CATEGORY_LABEL[item.category] ?? item.category}</span> : null}
                    </p>
                  </li>
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
      </div>

      <div className="home">
        <BudgetMeetings refreshToken={refreshToken} onOpenId={onOpenId} />
        <BudgetReports refreshToken={refreshToken} />
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
