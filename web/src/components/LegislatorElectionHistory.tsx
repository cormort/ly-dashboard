import { buildUrl } from '../api/client';
import type { LegislatorVotesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { partyStyle } from '../lib/parties';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

const num = (n: number) => n.toLocaleString('zh-TW');
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

/** 委員側欄：歷次參選立委（含補選）的得票、與對手差距、與上次相比；完整表格在縣市頁「立委得票」 */
export function LegislatorElectionHistory({ legislatorId, region }: { legislatorId: string; region: string | null }) {
  const res = useApi<LegislatorVotesResponse>(buildUrl('/legislator-votes', { id: legislatorId }));
  if (res.phase === 'loading' && !res.data) return <LoadingState label="讀取得票紀錄…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得得票紀錄（/api/v1/legislator-votes）" error={res.error} onRetry={res.reload} />;
  const history = res.data?.items[0]?.history ?? [];
  if (!history.length) return <EmptyState message="沒有區域或原住民立委的參選紀錄" hint="2012 年起的大選與補選；不分區委員沒有個人得票。" />;

  return (
    <div className="election-history">
      <ol>
        {[...history].reverse().map((h) => (
          <li key={`${h.year}-${h.district}`}>
            <div>
              <b>{h.year}</b> {h.district}
              {h.by_election ? <small className="pill">補選</small> : null}
              <span className={h.elected ? 'election-won' : 'muted'}> {h.elected ? '當選' : '落選'}</span>
            </div>
            <div className="election-numbers">
              {num(h.votes)} 票（{h.pct.toFixed(2)}%）・{partyStyle(h.party).short}
              {h.change !== null ? <span className="muted">・較上次 {signed(h.change)}</span> : null}
            </div>
            {h.rival && h.margin !== null ? (
              <div className="muted">
                {h.margin >= 0 ? '領先' : '落後'} {h.rival.name}（{partyStyle(h.rival.party).short}）{num(Math.abs(h.margin))} 票、
                {Math.abs(h.margin_pct ?? 0).toFixed(2)} 個百分點
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <a className="muted" href={pathFor('counties', { tab: 'legislators', county: region ?? undefined })}>
        在縣市頁看完整得票表 →
      </a>
    </div>
  );
}
