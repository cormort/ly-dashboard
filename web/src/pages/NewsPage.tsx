import { useEffect, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { AgencyHomeResponse, LegislatorsResponse, NewsArticlesResponse, NewsKind } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { DEFAULT_AGENCY, MY_AGENCY_KEY } from './MyAgencyPage';
import { readPreference } from '../lib/storage';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { RouteLink } from '../components/RouteLink';
import { formatDateTime } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface NewsPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  /** officials＝機關首長新聞（server/officials.json）、agencies＝機關新聞（標題提到中央機關）、all＝全部新聞（四類合併、不限期間），預設看委員新聞 */
  scope?: 'legislators' | 'officials' | 'agencies' | 'all';
  /** 站內導覽（點議員名字到議員近期動態）；沒給就整頁跳轉 */
  onNavigate?: (href: string) => void;
}

const PAGE = 30;

interface Filters {
  q: string;
  source: string;
  legislator: string;
  /** 只有全部新聞用：類別（空＝全部） */
  kind: string;
}

const readFilters = (): Filters => {
  const p = new URLSearchParams(window.location.search);
  return { q: p.get('q') ?? '', source: p.get('source') ?? '', legislator: p.get('legislator') ?? '', kind: p.get('kind') ?? '' };
};

/** 全部新聞的類別切換；「其他」＝媒體 RSS 抓到、但沒提到任何委員／首長／機關的新聞 */
const KINDS: { key: NewsKind | 'all' | 'other'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'legislator', label: '委員' },
  { key: 'official', label: '首長' },
  { key: 'entity', label: '機關／基金' },
  { key: 'dgbas', label: '主計總處' },
  { key: 'local_accounting', label: '地方主計' },
  { key: 'councilor', label: '議員' },
  { key: 'other', label: '其他' },
];
/** 每則新聞旁的類別標示：委員與首長已經列出人名，只標沒有人名的兩類 */
const KIND_TAG: Partial<Record<NewsKind, string>> = { entity: '機關／基金', dgbas: '主計總處', local_accounting: '地方主計' };

/** 新聞：所有委員的新聞合併成一份（同一篇只列一次），可依關鍵字與媒體篩選，並看各媒體的報導量。 */
export function NewsPage({ refreshToken, onOpenId, scope = 'legislators', onNavigate = (href) => window.location.assign(href) }: NewsPageProps) {
  const officials = scope === 'officials';
  const everything = scope === 'all';
  const agencies = scope === 'agencies';
  const route = officials ? 'officials' : agencies ? 'agencynews' : everything ? 'allnews' : 'news';
  // 首長與機關的下拉選單來自新聞 API 的 people；委員來自名冊
  const listFromApi = officials || agencies;
  const who = officials ? '首長' : agencies ? '機關' : '委員';
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [draft, setDraft] = useState(filters.q);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const onPop = () => {
      const next = readFilters();
      setFilters(next);
      setDraft(next.q);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const change = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setPage(0);
    window.history.replaceState(null, '', pathFor(route, { ...next }));
  };

  // 新聞要掃全表（實測最慢約 0.3 秒，但同步中／機器忙碌時會拖長）→ 給比較寬的逾時
  const res = useApi<NewsArticlesResponse>(buildUrl('/news/articles', { ...filters, scope, limit: PAGE, offset: page * PAGE }), { refreshToken, timeoutMs: 30_000 });
  const roster = useApi<LegislatorsResponse>(buildUrl('/legislators', { session: 'all' }), { refreshToken });
  // 首長／機關下拉：「我的機關」排第一個（首長頁排它的首長，機關頁排它自己；其餘維持依則數排序）
  const myAgency = useApi<AgencyHomeResponse>(listFromApi ? buildUrl('/agency', { name: readPreference(MY_AGENCY_KEY) || DEFAULT_AGENCY }) : null, { refreshToken });
  const mine = myAgency.data?.agency;
  const headNames = new Set(officials ? (mine?.heads ?? []).map((h) => h.name) : mine ? [mine.name] : []);
  const people = listFromApi
    ? (res.data?.people ?? []).map((p) => ({ id: p.id, name: p.name, count: p.count })).sort((a, b) => Number(headNames.has(b.name)) - Number(headNames.has(a.name)))
    : (roster.data?.items ?? []).filter((l) => !l.former).map((l) => ({ id: l.id, name: l.name, count: l.news_count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
  const picked = people.find((l) => l.id === filters.legislator);
  const data = res.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const max = Math.max(1, ...(data?.sources ?? []).map((s) => s.count));
  const goto = (p: number) => {
    setPage(p);
    document.getElementById('news-results')?.scrollIntoView({ block: 'start' });
  };

  return (
    <>
      <h1 className="sr-only">{officials ? '機關首長新聞' : agencies ? '機關新聞' : everything ? '全部新聞' : '新聞'}</h1>

      <form
        className="filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          change({ q: draft.trim() });
        }}
      >
        {/* 全部新聞以關鍵字為主，不提供依人篩選（委員與首長上百人混在一起反而難找） */}
        {everything ? null : (
        <select value={filters.legislator} aria-label={`依${who}分析`} onChange={(event) => change({ legislator: event.target.value, source: '' })}>
          <option value="">全部{who}</option>
          {people.map((l) => (
            <option key={l.id} value={l.id}>
              {headNames.has(l.name) ? '★ ' : ''}{l.name} {l.count}
            </option>
          ))}
        </select>
        )}
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={everything ? '搜尋標題關鍵字（空白分隔＝全部符合）' : '搜尋標題關鍵字'}
          aria-label="搜尋新聞標題"
        />
        <button type="submit">搜尋</button>
        {filters.q ? (
          <button type="button" aria-pressed="true" aria-label={`取消關鍵字：${filters.q}`} onClick={() => (setDraft(''), change({ q: '' }))}>
            {filters.q}
            <X aria-hidden="true" />
          </button>
        ) : null}
        {filters.source ? (
          <button type="button" aria-pressed="true" aria-label={`取消媒體：${filters.source}`} onClick={() => change({ source: '' })}>
            {filters.source}
            <X aria-hidden="true" />
          </button>
        ) : null}
      </form>

      {everything && data?.kind_counts ? (
        <div className="segmented" role="group" aria-label="新聞類別">
          {KINDS.map(({ key, label }) => {
            const value = key === 'all' ? '' : key;
            return (
              <button key={key} type="button" aria-pressed={filters.kind === value} onClick={() => change({ kind: value, source: '' })}>
                {label} {data.kind_counts?.[key].toLocaleString()}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* 報導清單是主角（每天看輿情）；媒體分布是分析，放右欄 */}
      <div className="home">
      <section className="panel" aria-label="新聞列表" id="news-results">
        <div className="sectionhead">
          <h2>報導</h2>
          <div>
            {data ? (
              <span className="muted">
                {data.total.toLocaleString()} 則
                {everything && data.first_date && data.last_date ? `・資料涵蓋 ${data.first_date.slice(0, 10)} 至 ${data.last_date.slice(0, 10)}` : ''}
              </span>
            ) : null}
            {/* 下載的是目前篩選條件下「全部符合」的新聞，不只這一頁 */}
            {data && data.total > 0 ? (
              <a className="button" href={buildUrl('/news/articles', { ...filters, scope, format: 'csv' })} download={`news-${scope}.csv`}>
                <Download aria-hidden="true" />
                下載 CSV
              </a>
            ) : null}
          </div>
        </div>
        {res.phase === 'loading' && !data ? <LoadingState label="讀取中…" /> : null}
        {res.phase === 'error' ? <ErrorState title="無法取得新聞（/api/v1/news/articles）" error={res.error} onRetry={res.reload} /> : null}
        {data && data.items.length === 0 ? <EmptyState message="沒有符合的新聞" hint="換個關鍵字，或清除媒體條件。" /> : null}
        {data && data.items.length > 0 ? (
          <>
            <ol className="bill-results">
              {data.items.map((a) => (
                <li key={a.url}>
                  <a href={a.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={a.title}>
                    {a.title}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <p className="bill-meta">
                    <span>{formatDateTime(a.published_at)}</span>
                    {agencies ? null : (a.kinds ?? []).map((k) => (KIND_TAG[k] ? <span key={k} className="muted">{KIND_TAG[k]}</span> : null))}
                    {/* 機關新聞：提到的機關，點了只看那個機關 */}
                    {(a.agencies ?? []).map((name) => (
                      <button key={name} type="button" className="link-button" aria-pressed={filters.legislator === name} onClick={() => change({ legislator: name, source: '' })}>
                        {name}
                      </button>
                    ))}
                    <button type="button" className="link-button" onClick={() => change({ source: a.source })}>
                      {a.source}
                    </button>
                    {/* 提到的議員：點了到議員近期動態，只看這位議員 */}
                    {(a.councilors ?? []).map((c) => (
                      <RouteLink key={c.id} href={pathFor('councilactivity', { councilor: c.id })} onNavigate={onNavigate} className="name-button" title={`${c.county}${c.district}議員`} style={{ color: partyStyle(c.party).color }}>
                        {c.county.slice(0, 2)}
                        {c.name}
                      </RouteLink>
                    ))}
                    {a.legislators.map((l) =>
                      l.kind === 'official' ? (
                        <span key={l.id} className="muted" title={l.party}>
                          {l.name}
                        </span>
                      ) : (
                      <button
                        key={l.id}
                        type="button"
                        className="name-button"
                        style={officials ? undefined : { color: partyStyle(l.party).color }}
                        title={officials ? l.party : undefined}
                        onClick={() => (officials ? change({ legislator: l.id }) : onOpenId(l.id))}
                      >
                        {l.name}
                      </button>
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ol>
            {pages > 1 ? (
              <nav className="pager" aria-label="分頁">
                <button type="button" disabled={page === 0} onClick={() => goto(page - 1)}>
                  上一頁
                </button>
                <span className="muted">
                  第 {page + 1} / {pages} 頁
                </span>
                <button type="button" disabled={page + 1 >= pages} onClick={() => goto(page + 1)}>
                  下一頁
                </button>
              </nav>
            ) : null}
          </>
        ) : null}
      </section>
      {data ? (
        <section className="panel" aria-label="媒體分布">
          <div className="sectionhead">
            <h2>{picked ? `${picked.name}的媒體分布` : '媒體分布'}</h2>
            <span className="muted">共 {data.source_total} 家，點媒體可篩選</span>
          </div>
          <ul className="source-bars">
            {data.sources.slice(0, 15).map((s) => (
              <li key={s.name}>
                <button type="button" className="link-button source-name" aria-pressed={filters.source === s.name} onClick={() => change({ source: filters.source === s.name ? '' : s.name })}>
                  {s.name}
                </button>
                <span className="source-bar mono" style={{ width: `${(s.count / max) * 100}%` }} />
                <span className="source-count">{s.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      </div>
    </>
  );
}
