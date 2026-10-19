import { useEffect, useState } from 'react';
import { buildUrl } from '../api/client';
import type { RollcallItem, RollcallsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { formatDay } from '../lib/format';

export interface VotesPageProps {
  refreshToken: number;
  onOpenId?: (id: string) => void;
}

const STEP = 20;
const readParam = (key: string) => new URLSearchParams(window.location.search).get(key) ?? '';

/** 一組名單（贊成／反對／棄權）：預設收起，點開才列姓名（一場表決可能上百人） */
function VoterList({ label, voters, tone }: { label: string; voters: RollcallItem['supporters']; tone: string }) {
  if (voters.length === 0) return null;
  return (
    <details className="vote-names">
      <summary>
        <span className={`vote-dot vote-dot-${tone}`} aria-hidden="true" />
        {label} <strong>{voters.length}</strong> 人
      </summary>
      <p className="muted">
        {voters.map((v) => v.name).join('、')}
      </p>
    </details>
  );
}

/**
 * 院會表決（議事 › 院會表決）：立法院開放資料 ID370，一場表決一列。
 *
 * 顯示順序由後端決定（日期 → 時間，新到舊）。官方的 agree／against／abstain 是**人數欄位**，
 * 與名單長度可能不同（實測有落差），所以兩者都顯示、不互相取代。
 *
 * 用 `?legislator=王鴻薇` 進來時只列他參與過的場次，並標出他每一場投什麼
 * （委員頁之後要接這個入口，見 DECISIONS D296）。
 */
export function VotesPage({ refreshToken }: VotesPageProps) {
  const [q, setQ] = useState(() => readParam('q'));
  const [legislator, setLegislator] = useState(() => readParam('legislator'));
  const [limit, setLimit] = useState(STEP);
  useEffect(() => {
    const onPop = () => {
      setQ(readParam('q'));
      setLegislator(readParam('legislator'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const change = (next: { q?: string; legislator?: string }) => {
    const nextQ = (next.q ?? q).trim();
    const nextLegislator = next.legislator ?? legislator;
    setQ(nextQ);
    setLegislator(nextLegislator);
    setLimit(STEP);
    window.history.replaceState(null, '', pathFor('votes', { q: nextQ, legislator: nextLegislator }));
  };

  const res = useApi<RollcallsResponse>(buildUrl('/votes', { q, legislator, limit }), { refreshToken });
  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入院會表決…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得院會表決（/api/v1/votes）" error={res.error} onRetry={res.reload} />;
  const data = res.data;
  if (!data) return <EmptyState message="沒有表決資料" />;

  return (
    <>
      <h1 className="sr-only">院會表決</h1>
      <section className="panel" aria-label="院會表決">
        <div className="sectionhead">
          <h2>院會表決</h2>
          <span className="muted">{data.total} 場</span>
        </div>
        <p className="muted">
          立法院開放資料 ID370（{data.meta.votes_fetched_at ? `同步於 ${formatDay(data.meta.votes_fetched_at.slice(0, 10))}` : '尚未同步'}）。一場表決一列，
          名單用立法院的委員編號對到本屆委員；第 10 屆已卸任的委員只顯示姓名、不對應個人頁。
          官方給的贊成／反對／棄權「人數」與名單長度可能不一致（實測有落差），兩個都照原樣顯示。
        </p>

        <SearchField
          value={q}
          onChange={(value) => change({ q: value })}
          ariaLabel="搜尋表決議題或會議名稱"
          placeholder="搜尋表決議題，例如：議事日程、覆議、預算"
        />

        {legislator ? (
          <p className="wall-bulk">
            <button type="button" className="quiet" onClick={() => change({ legislator: '' })}>
              只看 {legislator} 的表決，按這裡清除
            </button>
          </p>
        ) : null}

        {data.items.length === 0 ? (
          <EmptyState message="沒有符合條件的表決" hint="換個關鍵字，或清除委員條件。" />
        ) : (
          <ul className="vote-list" role="list">
            {data.items.map((vote) => (
              <li key={vote.id} className="vote-card">
                <div className="vote-head">
                  <time dateTime={vote.date}>
                    {formatDay(vote.date)} {vote.time}
                  </time>
                  <span className="muted">
                    {vote.session ? `${vote.session} 會期` : ''}
                    {vote.session_times ? `第 ${vote.session_times} 次會議` : ''}
                    {vote.vote_type ? ` · ${vote.vote_type}` : ''}
                  </span>
                  {vote.mine !== undefined ? (
                    <span className={`vote-mine vote-dot-${vote.mine === '贊成' ? 'agree' : vote.mine === '反對' ? 'against' : 'abstain'}`}>
                      {vote.mine ?? '未投票'}
                    </span>
                  ) : null}
                </div>
                <p className="vote-issue">{vote.issue}</p>
                <div className="vote-tally" role="group" aria-label="表決結果">
                  <span>
                    贊成 <strong>{vote.agree ?? vote.counts['贊成']}</strong>
                  </span>
                  <span>
                    反對 <strong>{vote.against ?? vote.counts['反對']}</strong>
                  </span>
                  <span>
                    棄權 <strong>{vote.abstain ?? vote.counts['棄權']}</strong>
                  </span>
                  <span className="muted">出席 {vote.present ?? '—'}</span>
                </div>
                <VoterList label="贊成" voters={vote.supporters} tone="agree" />
                <VoterList label="反對" voters={vote.opposers} tone="against" />
                <VoterList label="棄權" voters={vote.abstainers} tone="abstain" />
              </li>
            ))}
          </ul>
        )}

        {data.total > data.items.length ? (
          <p className="wall-bulk">
            <button type="button" onClick={() => setLimit(limit + STEP)}>
              載入更多（已顯示 {data.items.length} / {data.total}）
            </button>
          </p>
        ) : null}
        {res.phase === 'loading' ? <p className="muted">更新中…</p> : null}
      </section>
    </>
  );
}
