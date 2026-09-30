import { buildUrl } from '../api/client';
import type { CosponsorsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { partyStyle } from '../lib/parties';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

/** 最常一起列名提案的委員，以及跨黨合作比例（有他黨委員連署的議案占比）。 */
export function LegislatorCosponsors({ legislatorId, onOpenId }: { legislatorId: string; onOpenId: (id: string) => void }) {
  const res = useApi<CosponsorsResponse>(buildUrl('/cosponsors', { legislator: legislatorId, limit: 8 }));

  if (res.phase === 'loading' && !res.data) return <LoadingState label="讀取共同提案…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得共同提案（/api/v1/cosponsors）" error={res.error} onRetry={res.reload} />;
  if (!res.data || res.data.items.length === 0) return <EmptyState message="沒有共同提案紀錄" hint="議案資料可能尚未同步。" />;

  const { items, total_bills, cross_party_bills } = res.data;
  const top = items[0].count;
  const share = total_bills > 0 ? Math.round((cross_party_bills / total_bills) * 100) : 0;
  return (
    <div className="cosponsors">
      <p className="muted">
        {total_bills} 件提案中，{cross_party_bills} 件有他黨委員一起列名（{share}%）
      </p>
      <ol className="partner-list">
        {items.map((p) => (
          <li key={p.id}>
            <button type="button" className="name-button" onClick={() => onOpenId(p.id)}>
              {p.name}
            </button>
            <small style={{ color: partyStyle(p.party).color }}>{partyStyle(p.party).short}</small>
            <span className="partner-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((p.count / top) * 100)}%`, background: partyStyle(p.party).color }} />
            </span>
            <span className="partner-count">{p.count} 件</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
