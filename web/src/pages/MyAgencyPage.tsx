import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { AgencyHomeResponse, AgencyItem, FundKind } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { RouteLink } from '../components/RouteLink';
import { formatDay, shortCommittee } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { readPreference, writePreference } from '../lib/storage';
import { AGENCY_REPORT_CATEGORY } from './BudgetPage';

export interface MyAgencyPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  onNavigate: (href: string) => void;
}

/** 選定的機關存在這個瀏覽器（總覽頂端的「我的機關」摘要也讀它） */
export const MY_AGENCY_KEY = 'my-agency';
/** 沒選過時預設載入的機關 */
export const DEFAULT_AGENCY = '行政院主計總處';

/** 網址 ?agency= 優先（可分享），其次是上次選的（存在這個瀏覽器），都沒有就用預設機關 */
const initialAgency = (): string => new URLSearchParams(window.location.search).get('agency') || readPreference(MY_AGENCY_KEY) || DEFAULT_AGENCY;

/** 網址 ?watch=（「誰在關注」哪一位的明細，可分享、上一頁也回得去）；沒帶就沒有明細 */
const initialWatch = (): string => new URLSearchParams(window.location.search).get('watch') || '';

/** 「誰在關注」的件數連到這裡：同一頁的明細卡片，記在網址上（換機關時要一起帶） */
export const watchUrl = (agency: string, id: string) => pathFor('my', { agency, watch: id });

/** 一個區塊：標題＋件數＋「看更多」；沒資料時明說，不留空白 */
function Block({ title, total, href, onNavigate, note, children }: { title: string; total: number; href?: string; onNavigate: (href: string) => void; note?: string; children: ReactNode }) {
  return (
    <section className="panel dash-card" aria-label={title}>
      <div className="sectionhead">
        <h2>
          {title} <span className="muted">{total.toLocaleString()}</span>
        </h2>
        {href && total > 0 ? (
          <a
            className="more-link"
            href={href}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(href);
            }}
          >
            看更多 <ArrowRight aria-hidden="true" />
          </a>
        ) : null}
      </div>
      {note ? <p className="muted">{note}</p> : null}
      {total === 0 ? <p className="muted">目前沒有相關資料</p> : children}
    </section>
  );
}

function ItemList({ items, tag }: { items: AgencyItem[]; tag?: (item: AgencyItem) => string | undefined }) {
  return (
    <ul className="dash-list">
      {items.map((i) => (
        <li key={`${i.kind}-${i.url}`}>
          {tag?.(i) ? <span className="status-tag">{tag(i)}</span> : null}
          <a href={i.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
            {i.title}
          </a>
          <time>{formatDay(i.date)}</time>
        </li>
      ))}
    </ul>
  );
}

/** 「誰在關注」明細的分組順序（與機關頁的來源一致；空的來源不顯示） */
const WATCHER_GROUPS: { kind: FundKind; label: string }[] = [
  { kind: 'news', label: '新聞' },
  { kind: 'post', label: '臉書貼文' },
  { kind: 'bill', label: '委員提案' },
  { kind: 'budget', label: '預算審議' },
  { kind: 'report', label: '預算中心報告' },
];

/**
 * 「誰在關注」的明細：那個「N 次」是由哪些資料組成。依來源分組，**每一筆都連回原始資料**
 * （新聞／貼文／議案／報告是各自的來源網址）；會議本身沒有自己的網址，連到委員會頁的同一場會議
 * （那裡的議程、登記發言與紀錄就是來源）。件數以清單上的數字為準，分組加總必須等於它。
 */
export function WatcherDetail({
  watcher,
  onClose,
  onNavigate,
}: {
  watcher: NonNullable<AgencyHomeResponse['watcher']>;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const groups = WATCHER_GROUPS.map((g) => ({ ...g, block: watcher.kinds[g.kind] })).filter((g) => g.block.total > 0);
  return (
    <section className="panel dash-card wide watcher-detail" aria-label={`${watcher.name} 的關注明細`}>
      <div className="sectionhead">
        <h2>
          <span style={{ color: partyStyle(watcher.party).color }}>{watcher.name}</span> 的 {watcher.count.toLocaleString()} 次
        </h2>
        <button type="button" className="link-button" onClick={onClose}>
          收起來
        </button>
      </div>
      <p className="muted">依來源分組，點標題連到原始資料。</p>
      {groups.map((g) => (
        <section key={g.kind} aria-label={g.label}>
          <h3>
            {g.label} <span className="muted">{g.block.total.toLocaleString()}</span>
          </h3>
          <ul className="dash-list">
            {g.block.items.map((i) => (
              <li key={`${i.kind}-${i.url}`}>
                {i.status ? <span className="status-tag">{i.status}</span> : null}
                <a href={i.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                  {i.title}
                </a>
                <time>{formatDay(i.date)}</time>
              </li>
            ))}
          </ul>
          {g.block.total > g.block.items.length ? <p className="muted">只列最新 {g.block.items.length} 筆（共 {g.block.total} 筆）。</p> : null}
        </section>
      ))}
      {watcher.meetings.total > 0 ? (
        <section aria-label="會議發言">
          <h3>
            會議發言 <span className="muted">{watcher.meetings.total.toLocaleString()}</span>
          </h3>
          <ul className="dash-list">
            {watcher.meetings.items.map((m) => {
              const href = pathFor('committees', { q: m.name });
              return (
                <li key={`${m.date}-${m.name}`}>
                  <span className="kind">{m.committees[0] ? shortCommittee(m.committees[0]) : '會議'}</span>
                  <a
                    href={href}
                    className="clamp-2"
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(href);
                    }}
                  >
                    {m.name}
                  </a>
                  <time>{formatDay(m.date)}</time>
                </li>
              );
            })}
          </ul>
          {watcher.meetings.total > watcher.meetings.items.length ? <p className="muted">只列最新 {watcher.meetings.items.length} 筆（共 {watcher.meetings.total} 筆）。</p> : null}
        </section>
      ) : null}
    </section>
  );
}

/**
 * 我的機關：選定一個機關（記在這個瀏覽器），頁面以它為中心，依首長最需要的順序：
 * 近期會議與書面回覆 → 預算與法案 → 誰在關注 → 新聞。資料來自 /api/v1/agency。
 */
export function MyAgencyPage({ refreshToken, onOpenId, onNavigate }: MyAgencyPageProps) {
  const [agency, setAgency] = useState(initialAgency);
  const [watch, setWatch] = useState(initialWatch);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const onPop = () => {
      setAgency(initialAgency());
      setWatch(initialWatch());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const res = useApi<AgencyHomeResponse>(buildUrl('/agency', { name: agency, watch }), { refreshToken });
  const data = res.data;
  const names = new Set(data?.agencies.map((a) => a.name));

  const choose = (name: string) => {
    setAgency(name);
    setWatch('');
    setDraft('');
    writePreference(MY_AGENCY_KEY, name);
    window.history.replaceState(null, '', pathFor('my', { agency: name }));
  };

  /** 「誰在關注」的件數：點開看那 N 次是哪些資料（同一位再點一次＝收起來） */
  const toggleWatch = (id: string) => {
    const next = watch === id ? '' : id;
    setWatch(next);
    window.history.replaceState(null, '', pathFor('my', { agency, watch: next }));
  };
  const selector = (
    <div className="agency-picker">
      <label>
        <span className="muted">{agency ? '更換機關' : '選擇機關'}</span>
        <input
          type="search"
          list="agency-options"
          value={draft}
          placeholder="輸入機關名稱，例如 財政部"
          onChange={(event) => {
            setDraft(event.target.value);
            if (names.has(event.target.value)) choose(event.target.value);
          }}
        />
      </label>
      <datalist id="agency-options">
        {data?.agencies.map((a) => (
          <option key={a.name} value={a.name} />
        ))}
      </datalist>
    </div>
  );

  if (!agency || (data && !data.agency)) {
    const quick = data?.agencies.filter((a) => a.heads.length > 0) ?? [];
    return (
      <>
        <h1 className="sr-only">我的機關</h1>
        {agency && data && !data.agency ? <p className="muted">找不到「{agency}」，請從清單選擇。</p> : null}
        {selector}
        {res.phase === 'loading' && !data ? <LoadingState label="讀取機關清單…" /> : null}
        {res.phase === 'error' ? <ErrorState title="無法取得機關清單（/api/v1/agency）" error={res.error} onRetry={res.reload} /> : null}
        {quick.length > 0 ? (
          <section className="panel" aria-label="常用機關">
            <div className="sectionhead">
              <h2>有首長新聞追蹤的機關</h2>
            </div>
            <div className="law-facets">
              {quick.map((a) => (
                <button key={a.name} type="button" className="chip" onClick={() => choose(a.name)}>
                  {a.name}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </>
    );
  }

  const link = (kind: FundKind) => pathFor('agencies', { fund: agency, kind });
  // 議程、回覆的「看更多」到委員會頁，用同一組比對詞（全名＋簡稱）搜尋，件數才會一致
  const committeesLink = pathFor('committees', { q: data?.agency?.terms.join(' ') });
  return (
    <>
      <div className="page-head my-head">
        <h1>{agency}</h1>
        {data?.agency?.heads.length ? (
          <p className="page-lead">
            {data.agency.heads.map((h, i) => (
              <span key={h.name}>
                {i > 0 ? '、' : ''}
                {h.title}{' '}
                <a
                  href={pathFor('officials', { legislator: h.name })}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(pathFor('officials', { legislator: h.name }));
                  }}
                >
                  {h.name}
                </a>
              </span>
            ))}
          </p>
        ) : null}
        <div className="agency-picker-row">
          {selector}
          {agency !== DEFAULT_AGENCY ? (
            <button type="button" onClick={() => choose(DEFAULT_AGENCY)}>
              回到{DEFAULT_AGENCY}
            </button>
          ) : null}
        </div>
      </div>

      <p className="muted cross-link">
        {agency === DEFAULT_AGENCY ? (
          <>
            <RouteLink href={pathFor('dgbas')} onNavigate={onNavigate}>
              主計總處專頁
            </RouteLink>
            另含「地方主計處」「僅提及主計」等較寬鬆的比對。
          </>
        ) : null}
        議程與回覆的「看更多」到委員會頁（已帶入本機關名稱搜尋），其餘到「機關」頁看完整清單；想跨機關瀏覽、看哪些機關最常被提到，請到
        <RouteLink href={pathFor('agencies')} onNavigate={onNavigate}>
          機關頁
        </RouteLink>
        。
      </p>

      {res.phase === 'loading' && !data ? <LoadingState label={`讀取「${agency}」…`} /> : null}
      {res.phase === 'error' ? <ErrorState title="無法取得機關資料（/api/v1/agency）" error={res.error} onRetry={res.reload} /> : null}

      {data?.agency && data.kinds && data.meetings && data.replies && data.official_news && data.watchers ? (
        <>
          <div className="stat-row">
            {[
              { label: '近期議程提到', value: data.meetings.total, id: 'my-meetings' },
              { label: '新聞', value: data.kinds.news.total + data.official_news.total, id: 'my-news' },
              { label: '預算審議', value: data.kinds.budget.total, id: 'my-budget' },
              { label: '機關檢送報告', value: data.kinds.submitted.total, id: 'my-budget' },
              { label: '法案', value: data.kinds.bill.total, id: 'my-budget' },
            ].map((t) => (
              <a key={t.label} className="stat-tile" href={`#${t.id}`}>
                <b className="stat-value">{t.value.toLocaleString()}</b>
                <span className="stat-label">{t.label}</span>
              </a>
            ))}
          </div>

          <section className="dash-section" aria-labelledby="my-meetings">
            <div className="dash-section-head">
              <h2 id="my-meetings">會議與備詢</h2>
              <p className="muted">已開過的委員會議程提到本機關者；尚無未來行事曆資料</p>
            </div>
            <div className="dash-grid">
              <Block title="近期議程" total={data.meetings.total} href={committeesLink} onNavigate={onNavigate}>
                <ul className="dash-list">
                  {data.meetings.items.map((m) => (
                    <li key={`${m.date}-${m.name}`}>
                      <span className="kind">{m.committees[0] ? shortCommittee(m.committees[0]) : '會議'}</span>
                      <span className="clamp-2">
                        {m.name}
                        {m.speakers.length ? <span className="muted">　發言：{m.speakers.slice(0, 4).map((s) => s.name).join('、')}{m.speakers.length > 4 ? '…' : ''}</span> : null}
                      </span>
                      <time>{formatDay(m.date)}</time>
                    </li>
                  ))}
                </ul>
              </Block>
              <Block title="書面回覆" total={data.replies.total} href={committeesLink} onNavigate={onNavigate} note="部會對委員質詢的書面答復">
                <ul className="dash-list">
                  {data.replies.items.map((r) => (
                    <li key={r.url}>
                      <a href={r.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                        {r.title}
                      </a>
                      <time>{formatDay(r.date)}</time>
                    </li>
                  ))}
                </ul>
              </Block>
            </div>
          </section>

          <section className="dash-section" aria-labelledby="my-watchers">
            <div className="dash-section-head">
              <h2 id="my-watchers">誰在關注</h2>
              <p className="muted">新聞、臉書、提案掛名，加上提到本機關的會議中登記發言的委員；點件數看是哪些資料</p>
            </div>
            <section className="panel dash-card wide" aria-label="關注本機關的委員">
              {data.watchers.length === 0 ? (
                <p className="muted">目前沒有相關資料</p>
              ) : (
                <ol className="watchers">
                  {data.watchers.map((w) => (
                    <li key={w.id}>
                      <button type="button" className="name-button" style={{ color: partyStyle(w.party).color }} onClick={() => onOpenId(w.id)}>
                        {w.name}
                      </button>
                      <a
                        href={watchUrl(agency, w.id)}
                        className="link-button count-button"
                        aria-expanded={watch === w.id}
                        title={`看 ${w.name} 的 ${w.count} 次是哪些資料`}
                        onClick={(event) => {
                          event.preventDefault();
                          toggleWatch(w.id);
                        }}
                      >
                        {w.count} 次
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            {data.watcher ? <WatcherDetail watcher={data.watcher} onClose={() => toggleWatch(data.watcher!.id)} onNavigate={onNavigate} /> : null}
          </section>

          <section className="dash-section" aria-labelledby="my-news">
            <div className="dash-section-head">
              <h2 id="my-news">新聞</h2>
              <p className="muted">首長與機關的近期報導</p>
            </div>
            <div className="dash-grid">
              <Block title="首長新聞" total={data.official_news.total} href={data.agency.heads[0] ? pathFor('officials', { legislator: data.agency.heads[0].name }) : undefined} onNavigate={onNavigate}>
                <ItemList items={data.official_news.items} tag={(i) => i.head} />
              </Block>
              <Block title="機關新聞" total={data.kinds.news.total} href={link('news')} onNavigate={onNavigate}>
                <ItemList items={data.kinds.news.items} tag={(i) => i.source || undefined} />
              </Block>
            </div>
          </section>

          <section className="dash-section" aria-labelledby="my-budget">
            <div className="dash-section-head">
              <h2 id="my-budget">預算與法案</h2>
              <p className="muted">提案單位或標題提到本機關者</p>
            </div>
            <div className="dash-grid">
              <Block title="預算審議" total={data.kinds.budget.total} href={link('budget')} onNavigate={onNavigate}>
                <ItemList items={data.kinds.budget.items} tag={(i) => i.status} />
              </Block>
              <Block
                title="機關檢送報告"
                total={data.kinds.submitted.total}
                href={pathFor('budget', { category: AGENCY_REPORT_CATEGORY, proposer: data.agency.name, scope: 'all' })}
                onNavigate={onNavigate}
                note="本機關自己函送立法院的書面報告（依預算決議檢送、定期報告）；看更多開的是預算頁同一類別再加上本機關"
              >
                <ItemList items={data.kinds.submitted.items} tag={(i) => i.status} />
              </Block>
              <Block title="預算中心報告" total={data.kinds.report.total} href={link('report')} onNavigate={onNavigate}>
                <ItemList items={data.kinds.report.items} tag={(i) => i.source?.replace('評估', '')} />
              </Block>
              <Block title="法案" total={data.kinds.bill.total} href={link('bill')} onNavigate={onNavigate}>
                <ItemList items={data.kinds.bill.items} tag={(i) => (i.attend_only ? `列席${i.status ? ` · ${i.status}` : ''}` : i.status)} />
              </Block>
            </div>
          </section>
        </>
      ) : null}
      {res.phase === 'empty' ? <EmptyState message="目前沒有資料" hint="同步完成後再試。" /> : null}
    </>
  );
}
