import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { CommitteeActivityResponse, UpcomingMeetingsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { SearchField } from '../components/SearchField';
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
const readParam = (key: string) => new URLSearchParams(window.location.search).get(key) ?? '';

/**
 * 委員會：最新會議（議程、登記發言委員、附件與影片）、機關回覆（部會對委員質詢的書面答復）與會議紀錄（公報，含官員答詢全文），可依委員會篩選。
 */
/**
 * 會議預告：立法院議事轉播「會議預報」頁（`/api/v1/meetings/upcoming`）。
 *
 * 預告範圍天生很短：委員會的開會通知是逐週公布的，所以任何來源（g0v meets、IVOD）都只到「下週」。
 * 這裡把「為什麼只有兩天」直接寫在畫面上，免得被當成資料沒抓到。歷史會議仍在下面的「最新會議」。
 */
/**
 * 會議預告的篩選（純函式，render smoke 驗真值表）。
 *
 * `committee`＝委員會頁自己那一格；`q`＝空白分隔的關鍵字（我的機關以「全名 簡稱 …」連過來）。
 * 兩者都是「沒有就不篩」。只比對標題與議程 —— 我的機關那張卡片用的是同一條規則，
 * 所以「卡片寫 1 場」點進來的清單也必須是 1 場，不會變成整份 19 場。
 */
export function filterForecasts<T extends { committee: string; title: string; agenda: string }>(
  items: readonly T[],
  { committee = '', q = '' }: { committee?: string; q?: string } = {},
): T[] {
  const terms = String(q ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  return items.filter((m) => {
    if (committee && !(m.committee === committee || m.committee.includes(shortCommittee(committee)))) return false;
    if (!terms.length) return true;
    const text = `${m.title ?? ''} ${m.agenda ?? ''}`;
    return terms.some((t) => text.includes(t));
  });
}

function UpcomingMeetings({ refreshToken, committee, q }: { refreshToken: number; committee: string; q: string }) {
  const res = useApi<UpcomingMeetingsResponse>(buildUrl('/meetings/upcoming', { days: 10 }), { refreshToken });
  const data = res.data;
  if (res.phase === 'error') return null; // 預告不是主功能，掛掉不要擋整頁
  const items = filterForecasts(data?.items ?? [], { committee, q });
  const groups: { date: string; items: typeof items }[] = [];
  for (const m of items) {
    const last = groups.at(-1);
    if (last && last.date === m.date) last.items.push(m);
    else groups.push({ date: m.date, items: [m] });
  }
  return (
    <section className="panel forecast-panel" aria-label="會議預告">
      <div className="sectionhead">
        <h2>會議預告</h2>
        <span className="muted">
          {data
            ? `未來 ${data.days} 天・${items.length} 場${committee ? `（${shortCommittee(committee)}）` : q.trim() ? `（關鍵字：${q.trim()}）` : ''}`
            : ''}
        </span>
      </div>
      {res.phase === 'loading' && !data ? <LoadingState label="讀取會議預告…" /> : null}
      {data && data.total === 0 ? (
        <EmptyState message="目前沒有排定的會議" hint="委員會的開會通知多半在週五公布下週場次，公布後這裡就會出現。" />
      ) : null}
      {data && data.total > 0 ? (
        <>
          <p className="muted topic-note">
            來源是立法院議事轉播的「會議預報」。<b>預告範圍只有下週</b>——委員會開會通知逐週公布，不是資料少了。
          </p>
          {groups.map((g) => (
            <div key={g.date}>
              <h3 className="subhead">{slash(g.date)}</h3>
              <ul className="meeting-list budget-timeline">
                {g.items.map((m) => (
                  <li key={`${m.date}-${m.time}-${m.committee}-${m.title}`}>
                    <div className="timeline-head">
                      <time>{m.time || '時間未定'}</time>
                      <b>{m.committee}</b>
                      {m.place ? <span className="muted">{m.place}</span> : null}
                      {/* 狀態有時是一整句（「休息(12:35)，10月21日上午9:00繼續開會。」）→ 太長就不標 */}
                      {m.status && m.status.length <= 14 ? <span className="unit-badge">{m.status}</span> : null}
                      {m.materials_url ? (
                        <a href={m.materials_url} target="_blank" rel="noopener noreferrer">
                          會議相關資料
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                    <p className="clamp-2" title={m.title}>
                      {m.title}
                    </p>
                    {m.agenda ? (
                      <p className="clamp-2 muted" title={m.agenda}>
                        {m.agenda}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}

export function CommitteesPage({ refreshToken, onOpenId }: CommitteesPageProps) {
  const [committee, setCommittee] = useState(() => readParam('committee'));
  // q：空白分隔、任一符合（「我的機關」以機關全名＋簡稱連過來）
  const [q, setQ] = useState(() => readParam('q'));
  const [limit, setLimit] = useState(STEP);
  useEffect(() => {
    const onPop = () => {
      setCommittee(readParam('committee'));
      setQ(readParam('q'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const change = (next: { committee?: string; q?: string }) => {
    const c = next.committee ?? committee;
    const k = (next.q ?? q).trim();
    setCommittee(c);
    setQ(k);
    setLimit(STEP);
    window.history.replaceState(null, '', pathFor('committees', { committee: c, q: k }));
  };
  const choose = (name: string) => change({ committee: name });

  const res = useApi<CommitteeActivityResponse>(buildUrl('/committee-activity', { committee, q, limit }), { refreshToken });
  const data = res.data;
  const more = data && (data.meetings.total > limit || data.replies.total > limit || data.records.total > limit);

  return (
    <>
      <h1 className="sr-only">委員會</h1>

      <UpcomingMeetings refreshToken={refreshToken} committee={committee} q={q} />

      <div className="filters bill-filters" role="search">
        <SearchField value={q} onChange={(value) => change({ q: value })} ariaLabel="搜尋會議、機關回覆與會議紀錄" placeholder="搜尋機關或議題，例如：主計總處（空白分隔，任一符合）" />
        <ClearFiltersButton active={Boolean(q.trim() || committee)} onClick={() => change({ committee: '', q: '' })} />
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
