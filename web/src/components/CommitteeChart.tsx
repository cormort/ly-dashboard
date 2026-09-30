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

/** 一席＝一個小人，顏色是黨籍；圖形只定義一次，其餘用 <use> 引用 */
const PERSON_ID = 'committee-person';
function Person({ color }: { color: string }) {
  return (
    <svg className="person" viewBox="0 0 10 16" style={{ color }} aria-hidden="true">
      <use href={`#${PERSON_ID}`} />
    </svg>
  );
}

/**
 * 委員會席次與黨籍組成：每列一個委員會，每席一個依黨籍著色的小人。
 * 數字全部來自 /api/v1/committees（count、parties 由後端算好），前端不重新聚合委員名單。
 * ponytail: 內嵌 SVG 小人取代圖表函式庫，一種圖不需要 recharts。
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

  const legend = sortParties(new Set(items.flatMap((item) => Object.keys(item.parties ?? {}))));

  return shell(
    <>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <symbol id={PERSON_ID} viewBox="0 0 10 16">
          <circle cx="5" cy="3" r="2.7" fill="currentColor" />
          <path d="M1 16V10.5a4 4 0 0 1 8 0V16z" fill="currentColor" />
        </symbol>
      </svg>
      <p className="muted chart-scope">{sessionScopeLabel}・點委員會可篩選名錄</p>
      <ul className="people-legend" role="list" aria-label="圖例">
        {legend.map((p) => (
          <li key={p}>
            <Person color={partyStyle(p).color} />
            {partyStyle(p).short}
          </li>
        ))}
      </ul>
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
                <span className="people" aria-hidden="true">
                  {parties.flatMap((p) => Array.from({ length: item.parties[p] }, (_, i) => <Person key={`${p}-${i}`} color={partyStyle(p).color} />))}
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
