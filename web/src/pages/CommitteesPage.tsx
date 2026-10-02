import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { CommitteeActivityResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { shortCommittee } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface CommitteesPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
}

const STEP = 20;
const SPEAKERS_SHOWN = 8;
const ATTACHMENTS_SHOWN = 5;
const slash = (d: string | null | undefined) => (d ? d.replaceAll('-', '/') : '');
const readCommittee = () => new URLSearchParams(window.location.search).get('committee') ?? '';

/**
 * 委員會：最新會議（議程、登記發言委員、附件與影片）、機關回覆（部會對委員質詢的書面答復）與會議紀錄（公報，含官員答詢全文），可依委員會篩選。
 */
export function CommitteesPage({ refreshToken, onOpenId }: CommitteesPageProps) {
  const [committee, setCommittee] = useState(readCommittee);
  const [limit, setLimit] = useState(STEP);
  useEffect(() => {
    const onPop = () => setCommittee(readCommittee());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const choose = (name: string) => {
    setCommittee(name);
    setLimit(STEP);
    window.history.replaceState(null, '', pathFor('committees', { committee: name }));
  };

  const res = useApi<CommitteeActivityResponse>(buildUrl('/committee-activity', { committee, limit }), { refreshToken });
  const data = res.data;
  const more = data && (data.meetings.total > limit || data.replies.total > limit || data.records.total > limit);

  return (
    <>
      <div className="page-head">
        <h1>委員會</h1>
        <p className="muted">各委員會的最新會議、機關回覆（部會對委員質詢的書面答復）與公報會議紀錄（含部會首長答詢全文）。</p>
      </div>

      {data ? (
        <dl className="period-list" aria-label="資料期間">
          <dt>資料期間</dt>
          {data.meetings.period ? (
            <dd>
              <b>會議</b> {slash(data.meetings.period.from)}–{slash(data.meetings.period.to)}
            </dd>
          ) : null}
          {data.replies.period ? (
            <dd>
              <b>機關回覆</b> {slash(data.replies.period.from)}–{slash(data.replies.period.to)}
            </dd>
          ) : null}
          {data.records.period ? (
            <dd>
              <b>會議紀錄</b> {slash(data.records.period.from)}–{slash(data.records.period.to)}
            </dd>
          ) : null}
        </dl>
      ) : null}

      {data ? (
        <div className="law-facets" role="group" aria-label="委員會">
          <button type="button" className="chip" aria-pressed={!committee} onClick={() => choose('')}>
            全部
          </button>
          {data.committees.map((c) => (
            <button key={c.name} type="button" className="chip" aria-pressed={committee === c.name} onClick={() => choose(c.name)}>
              {shortCommittee(c.name)} <span className="muted">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {res.phase === 'loading' && !data ? <LoadingState label="讀取委員會動態…" /> : null}
      {res.phase === 'error' ? <ErrorState title="無法取得委員會動態（/api/v1/committee-activity）" error={res.error} onRetry={res.reload} /> : null}

      {data ? (
        <div className="committee-layout">
          <section className="panel" aria-label="最新會議">
            <div className="sectionhead">
              <h2>最新會議</h2>
              <span className="muted">{data.meetings.total.toLocaleString()} 場</span>
            </div>
            {data.meetings.items.length === 0 ? <EmptyState message="沒有會議資料" /> : null}
            <ol className="bill-results">
              {data.meetings.items.map((m, i) => (
                <li key={`${m.date}-${m.name}-${i}`}>
                  <p className="bill-title">{m.name}</p>
                  <p className="clamp-2 muted">{m.content}</p>
                  <p className="bill-meta">
                    <span>{slash(m.date)}</span>
                    {m.committees.map((c) => (
                      <button key={c} type="button" className="link-button" onClick={() => choose(c)}>
                        {c}
                      </button>
                    ))}
                  </p>
                  {m.attachments.length || m.video_url ? (
                    <p className="bill-meta">
                      <span className="fund-kind">附件</span>
                      {m.attachments.slice(0, ATTACHMENTS_SHOWN).map((a) => (
                        <a key={a.url} href={a.url} target="_blank" rel="noreferrer noopener">
                          {a.title || '附件'}
                        </a>
                      ))}
                      {m.attachments.length > ATTACHMENTS_SHOWN ? <span className="muted">等 {m.attachments.length} 份</span> : null}
                      {m.video_url ? (
                        <a href={m.video_url} target="_blank" rel="noreferrer noopener">
                          會議影片 <ExternalLink aria-hidden="true" />
                        </a>
                      ) : null}
                    </p>
                  ) : null}
                  {m.speakers.length ? (
                    <p className="bill-meta">
                      <span className="fund-kind">發言</span>
                      {m.speakers.slice(0, SPEAKERS_SHOWN).map((s, j) =>
                        s.id ? (
                          <button key={`${s.id}-${j}`} type="button" className="name-button" style={{ color: partyStyle(s.party).color }} onClick={() => onOpenId(s.id!)}>
                            {s.name}
                          </button>
                        ) : (
                          <span key={`${s.name}-${j}`}>{s.name}</span>
                        ),
                      )}
                      {m.speakers.length > SPEAKERS_SHOWN ? <span className="muted">等 {m.speakers.length} 位</span> : null}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          <section className="panel" aria-label="機關回覆">
            <div className="sectionhead">
              <h2>機關回覆</h2>
              <span className="muted">{data.replies.total.toLocaleString()} 份</span>
            </div>
            <p className="muted topic-note">部會對委員質詢的書面答復與補充資料（PDF）</p>
            {data.replies.items.length === 0 ? <EmptyState message="沒有機關回覆" /> : null}
            <ol className="bill-results">
              {data.replies.items.map((r) => (
                <li key={r.url}>
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={r.meeting}>
                    {r.title}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <p className="bill-meta">
                    <span>{slash(r.date)}</span>
                    {r.legislators.map((l) => (
                      <button key={l.id} type="button" className="name-button" style={{ color: partyStyle(l.party).color }} onClick={() => onOpenId(l.id)}>
                        {l.name}
                      </button>
                    ))}
                    {r.committees.map((c) => (
                      <button key={c} type="button" className="link-button" onClick={() => choose(c)}>
                        {c}
                      </button>
                    ))}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel" aria-label="會議紀錄">
            <div className="sectionhead">
              <h2>會議紀錄</h2>
              <span className="muted">{data.records.total.toLocaleString()} 筆</span>
            </div>
            {data.records.items.length === 0 ? <EmptyState message="沒有會議紀錄" hint="公報刊登通常比開會晚數週。" /> : null}
            <ol className="bill-results">
              {data.records.items.map((r) => (
                <li key={r.id}>
                  <p className="clamp-3" title={r.title}>
                    {r.title}
                  </p>
                  <p className="bill-meta">
                    <span>{slash(r.date)}</span>
                    {r.html_url ? (
                      <a href={r.html_url} target="_blank" rel="noreferrer noopener">
                        紀錄全文 <ExternalLink aria-hidden="true" />
                      </a>
                    ) : null}
                    {r.pdf_url ? (
                      <a href={r.pdf_url} target="_blank" rel="noreferrer noopener">
                        公報 PDF <ExternalLink aria-hidden="true" />
                      </a>
                    ) : null}
                    {r.gazette_url ? (
                      <a href={r.gazette_url} target="_blank" rel="noreferrer noopener">
                        公報網 <ExternalLink aria-hidden="true" />
                      </a>
                    ) : null}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}

      {more ? (
        <nav className="pager" aria-label="載入更多">
          <button type="button" disabled={res.phase === 'loading'} onClick={() => setLimit(limit + STEP)}>
            顯示更多
          </button>
        </nav>
      ) : null}
    </>
  );
}
