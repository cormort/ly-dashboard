import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { BillsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { billTitle } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

/** 委員提案：主題（最常涉及的法律）＋最近 10 筆。資料來自 /api/v1/bills，前端不重算。 */
export function LegislatorBills({ legislatorId }: { legislatorId: string }) {
  const bills = useApi<BillsResponse>(buildUrl('/bills', { legislator: legislatorId, limit: 10 }));

  if (bills.phase === 'loading' && !bills.data) return <LoadingState label="讀取提案…" />;
  if (bills.phase === 'error') {
    return <ErrorState title="無法取得提案（/api/v1/bills）" error={bills.error} onRetry={bills.reload} />;
  }
  if (!bills.data || bills.data.total === 0) {
    return <EmptyState message="本屆尚無提案紀錄" hint="議案資料可能尚未同步。" />;
  }

  const { laws, items, total, meta } = bills.data;
  return (
    <div className="bills">
      <p className="muted">
        本屆共 {total} 件提案（含共同提案）· 來源：{meta.bills_source.name}
      </p>
      {laws.length > 0 ? (
        <ul className="chip-list" role="list" aria-label="最常涉及的法律">
          {laws.map((law) => (
            <li key={law.name}>
              <span className="chip">
                {law.name} {law.count}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="bill-list">
        {items.map((bill) => (
          <li key={bill.id}>
            <a href={bill.url} target="_blank" rel="noreferrer noopener">
              {billTitle(bill.name)}
              <ExternalLink aria-hidden="true" />
            </a>
            <small>
              {bill.latest_date} · {bill.status}
              {bill.is_lead ? ' · 主提案' : ''}
            </small>
          </li>
        ))}
      </ol>
    </div>
  );
}
