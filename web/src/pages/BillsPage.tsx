import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BillsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { billTitle } from '../lib/format';
import { pathFor } from '../hooks/useRoute';
import { partyStyle } from '../lib/parties';

export interface BillsPageProps {
  refreshToken: number;
  onOpenId: (legislatorId: string) => void;
}

interface BillFilters {
  q: string;
  law: string;
  status: string;
}

const readFilters = (): BillFilters => {
  const params = new URLSearchParams(window.location.search);
  return { q: params.get('q') ?? '', law: params.get('law') ?? '', status: params.get('status') ?? '' };
};

const PAGE = 30;

/**
 * 法案查詢：關鍵字（議案名稱或法律）、法律、狀態。條件寫在網址（可分享、首頁議題可直接連進來）。
 * 結果依最新進度日期排序，附提案人與黨籍。
 */
export function BillsPage({ refreshToken, onOpenId }: BillsPageProps) {
  const [filters, setFilters] = useState<BillFilters>(readFilters);
  const [limit, setLimit] = useState(PAGE);

  // 上一頁／首頁議題連結進來時重新讀網址
  useEffect(() => {
    const onPop = () => setFilters(readFilters());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const change = (patch: Partial<BillFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setLimit(PAGE);
    window.history.replaceState(null, '', pathFor('bills', { q: next.q.trim(), law: next.law, status: next.status }));
  };

  const bills = useApi<BillsResponse>(
    buildUrl('/bills', { q: filters.q.trim(), law: filters.law, status: filters.status, limit }),
    { refreshToken },
  );
  const data = bills.data;

  return (
    <>
      <div className="page-head">
        <h1>法案查詢</h1>
        <p className="muted">本屆委員提案{data?.meta.bills_source ? `，資料來源：${data.meta.bills_source.name}` : ''}</p>
      </div>

      <div className="filters bill-filters" role="group" aria-label="法案篩選條件">
        <SearchField
          value={filters.q}
          onChange={(q) => change({ q })}
          ariaLabel="搜尋法案名稱或法律"
          placeholder="搜尋法案名稱或法律，例如：國土計畫法"
        />
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
        {filters.law ? (
          <button type="button" aria-pressed="true" onClick={() => change({ law: '' })} aria-label={`取消法律條件：${filters.law}`}>
            {filters.law}
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {data && data.laws.length > 0 && !filters.law ? (
        <div className="law-facets" aria-label="符合結果中最常涉及的法律">
          {data.laws.map((law) => (
            <button key={law.name} type="button" className="chip" onClick={() => change({ law: law.name })}>
              {law.name} <span className="muted">{law.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <section className="panel" aria-label="法案列表">
        <div className="sectionhead">
          <h2>符合的提案</h2>
          {data ? <span className="muted">{data.total} 件</span> : null}
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
                  <a href={bill.url} target="_blank" rel="noreferrer noopener" className="bill-title">
                    {billTitle(bill.name)}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <p className="bill-meta">
                    <span className="status-tag">{bill.status}</span>
                    <span>{bill.latest_date}</span>
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
            {data.count < data.total && limit < 200 ? (
              <button type="button" className="more" onClick={() => setLimit((n) => Math.min(n + PAGE * 2, 200))}>
                顯示更多（已顯示 {data.count} / {data.total}）
              </button>
            ) : null}
            {data.count < data.total && limit >= 200 ? <p className="muted">最多顯示 200 件，請加上條件縮小範圍。</p> : null}
          </>
        ) : null}
      </section>
    </>
  );
}
