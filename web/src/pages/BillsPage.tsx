import { useEffect, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BillsResponse } from '../api/types';
import { BillStageBar } from '../components/BillStage';
import { PASSED_STATUSES } from '../lib/billStage';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { billTitle } from '../lib/format';
import { pathFor } from '../hooks/useRoute';
import { partyStyle, sortParties } from '../lib/parties';

export interface BillsPageProps {
  refreshToken: number;
  onOpenId: (legislatorId: string) => void;
}

interface BillFilters {
  q: string;
  law: string;
  status: string;
  session: string;
  from: string;
  to: string;
}

const readFilters = (): BillFilters => {
  const params = new URLSearchParams(window.location.search);
  const get = (key: string) => params.get(key) ?? '';
  return { q: get('q'), law: get('law'), status: get('status'), session: get('session'), from: get('from'), to: get('to') };
};

const PAGE = 30;

/**
 * 法案查詢：關鍵字（議案名稱或法律）、法律、狀態。條件寫在網址（可分享、首頁議題可直接連進來）。
 * 結果依最新進度日期排序，附提案人與黨籍。
 */
export function BillsPage({ refreshToken, onOpenId }: BillsPageProps) {
  const [filters, setFilters] = useState<BillFilters>(readFilters);
  const [page, setPage] = useState(0);

  // 上一頁／首頁議題連結進來時重新讀網址
  useEffect(() => {
    const onPop = () => setFilters(readFilters());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const change = (patch: Partial<BillFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setPage(0);
    window.history.replaceState(null, '', pathFor('bills', { ...next, q: next.q.trim() }));
  };

  const query = { q: filters.q.trim(), law: filters.law, status: filters.status, session: filters.session, from: filters.from, to: filters.to };
  const bills = useApi<BillsResponse>(buildUrl('/bills', { ...query, limit: PAGE, offset: page * PAGE }), { refreshToken });
  const data = bills.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const goto = (next: number) => {
    setPage(next);
    document.getElementById('bill-results')?.scrollIntoView({ block: 'start' });
  };

  return (
    <>
      <h1 className="sr-only">法案查詢</h1>

      <div className="filters bill-filters" role="group" aria-label="法案篩選條件">
        <SearchField
          value={filters.q}
          onChange={(q) => change({ q })}
          ariaLabel="搜尋法案名稱或法律"
          placeholder="搜尋法案名稱或法律，例如：國土計畫法"
        />
        <label>
          <span className="sr-only">會期</span>
          <select value={filters.session} onChange={(event) => change({ session: event.target.value })}>
            <option value="">第 {data?.term ?? ''} 屆全部會期</option>
            {(data?.sessions ?? []).map((s) => (
              <option key={s.seq} value={String(s.seq)}>
                第 {data?.term} 屆第 {s.seq} 會期（{s.count}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">議案狀態</span>
          <select value={filters.status} onChange={(event) => change({ status: event.target.value })}>
            <option value="">全部狀態</option>
            {(data?.statuses ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}（{s.count}）
              </option>
            ))}
            {filters.status && !data?.statuses.some((s) => s.name === filters.status) ? (
              <option value={filters.status}>{filters.status}</option>
            ) : null}
          </select>
        </label>
        <label className="date-range">
          <span>進度日期</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => change({ from: event.target.value })} aria-label="起日" />
          <span aria-hidden="true">–</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => change({ to: event.target.value })} aria-label="迄日" />
        </label>
        {filters.law ? (
          <button type="button" aria-pressed="true" onClick={() => change({ law: '' })} aria-label={`取消法律條件：${filters.law}`}>
            {filters.law}
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {filters.law && data ? <LawSummary law={filters.law} data={data} /> : null}

      {data && data.laws.length > 0 && !filters.law ? (
        <div className="law-facets" aria-label="符合結果中最常涉及的法律">
          {data.laws.map((law) => (
            <button key={law.name} type="button" className="chip" onClick={() => change({ law: law.name })}>
              {law.name} <span className="muted">{law.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <section className="panel" aria-label="法案列表" id="bill-results">
        <div className="sectionhead">
          <h2>符合的提案</h2>
          <div>
            {data ? <span className="muted">{data.total} 件</span> : null}
            {data && data.total > 0 ? (
              <a className="button" href={buildUrl('/bills', { ...query, format: 'csv' })} download="bills.csv">
                <Download aria-hidden="true" />
                下載 CSV
              </a>
            ) : null}
          </div>
        </div>
        {bills.phase === 'loading' && !data ? <LoadingState label="讀取法案…" /> : null}
        {bills.phase === 'error' ? <ErrorState title="無法取得法案（/api/v1/bills）" error={bills.error} onRetry={bills.reload} /> : null}
        {data && data.items.length === 0 ? (
          <EmptyState message="沒有符合的提案" hint="換個關鍵字，或清除狀態與法律條件。" />
        ) : null}
        {data && data.items.length > 0 ? (
          <>
            <ol className="bill-results">
              {data.items.map((bill) => (
                <li key={bill.id}>
                  <a href={bill.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={billTitle(bill.name)}>
                    {billTitle(bill.name)}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <p className="bill-meta">
                    <BillStageBar status={bill.status} />
                    <span className="status-tag">{bill.status}</span>
                    <span>{bill.latest_date}</span>
                    {bill.session ? (
                      <span>
                        第 {bill.term} 屆第 {bill.session} 會期
                      </span>
                    ) : null}
                    {bill.laws.map((law) => (
                      <button key={law} type="button" className="link-button" onClick={() => change({ law })}>
                        {law}
                      </button>
                    ))}
                  </p>
                  {bill.sponsors.length > 0 ? (
                    <p className="sponsors">
                      {bill.sponsors.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={s.is_lead ? 'sponsor lead' : 'sponsor'}
                          style={{ color: partyStyle(s.party).color }}
                          onClick={() => onOpenId(s.id)}
                          title={`${s.name}（${partyStyle(s.party).short}）${s.is_lead ? '・主提案' : ''}`}
                        >
                          {s.name}
                        </button>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {pages > 1 ? (
              <nav className="pager" aria-label="分頁">
                <button type="button" disabled={page === 0} onClick={() => goto(page - 1)}>
                  上一頁
                </button>
                <span className="muted">
                  第 {page + 1} / {pages} 頁
                </span>
                <button type="button" disabled={page + 1 >= pages} onClick={() => goto(page + 1)}>
                  下一頁
                </button>
              </nav>
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}

/** 單一法律的總覽：件數、三讀、期間、各黨主提案分布（依篩選後結果）。 */
function LawSummary({ law, data }: { law: string; data: BillsResponse }) {
  const passed = data.statuses.filter((s) => PASSED_STATUSES.has(s.name)).reduce((sum, s) => sum + s.count, 0);
  const parties = sortParties(Object.keys(data.parties));
  const latest = data.items[0]?.latest_date;
  return (
    <section className="panel law-summary" aria-label={`${law} 總覽`}>
      <h2>{law}</h2>
      <div className="stat-row">
        <div className="stat-tile">
          <b className="stat-value">{data.total}</b>
          <span className="stat-label">件委員提案</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{passed}</b>
          <span className="stat-label">件已三讀</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{data.first_date?.slice(0, 7).replace('-', '/') ?? '—'}</b>
          <span className="stat-label">最早進度（最新 {latest ?? '—'}）</span>
        </div>
      </div>
      <p className="muted">各黨主提案件數</p>
      <span className="bar" aria-hidden="true">
        {parties.map((p) => (
          <span key={p} style={{ flexGrow: data.parties[p], background: partyStyle(p).color }} />
        ))}
      </span>
      <ul className="party-counts" role="list">
        {parties.map((p) => (
          <li key={p}>
            <span className="swatch" style={{ background: partyStyle(p).color }} aria-hidden="true" />
            {partyStyle(p).short} {data.parties[p]}
          </li>
        ))}
      </ul>
    </section>
  );
}
