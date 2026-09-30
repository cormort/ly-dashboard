import type { ReactNode } from 'react';
import type { ApiResource } from '../hooks/useApi';
import type { CommitteesResponse } from '../api/types';
import { partyStyle, sortParties } from '../lib/parties';
import { shortCommittee } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface CommitteeChartProps {
  committees: ApiResource<CommitteesResponse>;
  /** 目前會期顯示名稱，用於空狀態文案 */
  sessionScopeLabel: string;
  /** 目前篩選中的委員會 */
  selected?: string | null;
  /** 點委員會列＝以該委員會篩選名錄（再點一次取消） */
  onSelect?: (committee: string | null) => void;
}

/**
 * 委員會席次與黨籍組成：每列一個委員會，橫條依黨籍分段。
 * 數字全部來自 /api/v1/committees（count、parties 由後端算好），前端不重新聚合委員名單。
 * ponytail: 純 CSS 橫條取代圖表函式庫，一種圖不需要 recharts。
 */
export function CommitteeChart({ committees, sessionScopeLabel, selected = null, onSelect }: CommitteeChartProps) {
  const shell = (body: ReactNode) => (
    <section className="panel chart" aria-label="委員會席次">
      <h2>委員會組成</h2>
      {body}
    </section>
  );

  if (committees.phase === 'loading' && !committees.data) return shell(<LoadingState label="讀取委員會資料…" />);
  if (committees.phase === 'error') {
    return shell(
      <ErrorState
        title="無法取得委員會資料（/api/v1/committees）"
        error={committees.error}
        onRetry={committees.reload}
      />,
    );
  }

  const items = committees.data?.items ?? [];
  if (items.length === 0) {
    return shell(<EmptyState message="此會期尚無委員會資料" hint={`範圍：${sessionScopeLabel}。請切換會期或稍後再試。`} />);
  }

  const max = Math.max(...items.map((item) => item.count));

  return shell(
    <>
      <p className="muted chart-scope">{sessionScopeLabel}・點委員會可篩選名錄</p>
      <ul className="committee-bars" role="list">
        {items.map((item) => {
          const parties = sortParties(Object.keys(item.parties ?? {}));
          const breakdown = parties.map((p) => `${partyStyle(p).short} ${item.parties[p]}`).join('、');
          const active = selected === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect?.(active ? null : item.id)}
                aria-label={`${item.id} ${item.count} 席（${breakdown}）${item.conveners.length ? `，召委 ${item.conveners.map((c) => c.name).join('、')}` : ''}`}
              >
                <span className="committee-name">{shortCommittee(item.id)}</span>
                <span className="bar" style={{ width: `${(item.count / max) * 100}%` }} aria-hidden="true">
                  {parties.map((p) => (
                    <span key={p} style={{ flexGrow: item.parties[p], background: partyStyle(p).color }} />
                  ))}
                </span>
                <span className="committee-count">{item.count}</span>
                <span className="committee-conveners">
                  {item.conveners.length ? `召委 ${item.conveners.map((c) => c.name).join('、')}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>,
  );
}
