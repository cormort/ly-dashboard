import type { CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { CosponsorMatrixResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { partyStyle, sortParties } from '../lib/parties';
import { ErrorState, LoadingState } from './DataStates';

/** 跨黨連署矩陣：列＝主提案人黨籍、欄＝連署人黨籍，格子深淺依該列占比。 */
export function CosponsorMatrix({ refreshToken }: { refreshToken: number }) {
  const res = useApi<CosponsorMatrixResponse>(buildUrl('/cosponsors'), { refreshToken });
  if (res.phase === 'loading' && !res.data) return <LoadingState label="讀取連署資料…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得連署資料（/api/v1/cosponsors）" error={res.error} onRetry={res.reload} />;
  const matrix = res.data?.matrix ?? {};
  const leads = sortParties(Object.keys(matrix));
  if (leads.length === 0) return null;
  const cols = sortParties(new Set(leads.flatMap((p) => Object.keys(matrix[p]))));

  return (
    <section className="panel matrix" aria-label="跨黨連署">
      <h2>跨黨連署</h2>
      <p className="muted">各黨委員主提案時，連署人來自哪些政黨（本屆累計人次）。對角線以外就是跨黨合作。</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">主提案 ＼ 連署</th>
              {cols.map((c) => (
                <th key={c} scope="col" style={{ color: partyStyle(c).color }}>
                  {partyStyle(c).short}
                </th>
              ))}
              <th scope="col">跨黨占比</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => {
              const row = matrix[lead];
              const total = Object.values(row).reduce((a, b) => a + b, 0);
              const cross = total - (row[lead] ?? 0);
              return (
                <tr key={lead}>
                  <th scope="row" style={{ color: partyStyle(lead).color }}>
                    {partyStyle(lead).short}
                  </th>
                  {cols.map((c) => {
                    const n = row[c] ?? 0;
                    return (
                      <td key={c} style={{ '--share': total ? n / total : 0, '--party': partyStyle(c).color } as CSSProperties} className="heat">
                        {n || '—'}
                      </td>
                    );
                  })}
                  <td>{total ? `${Math.round((cross / total) * 100)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
