import { useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type {
  ActivityResponse,
  BillsResponse,
  BudgetReportsResponse,
  BudgetResponse,
  CommitteeActivityResponse,
  NewsResponse,
  RankingsResponse,
  RegionsResponse,
} from '../api/types';
import { ErrorState, LoadingState } from '../components/DataStates';
import { useApi, type ApiResource } from '../hooks/useApi';
import { pathFor, type Route } from '../hooks/useRoute';
import { billTitle } from '../lib/format';
import { partyStyle, sortParties } from '../lib/parties';

export interface DashboardPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  onNavigate: (href: string) => void;
}

const PASSED = new Set(['三讀', '審查完畢(三讀)', '照案通過']);
const KIND_LABEL = { post: '臉書', news: '新聞', bill: '提案' } as const;
const shortDate = (value: string | null | undefined) => (value ? value.slice(5, 10).replace('-', '/') : '');

/** 一張總覽卡：標題＋「看更多」連到對應頁面；四態沿用各頁的 LoadingState／ErrorState */
function Card<T>({
  title,
  href,
  onNavigate,
  resource,
  children,
  wide = false,
}: {
  wide?: boolean;
  title: string;
  href: string;
  onNavigate: (href: string) => void;
  resource: ApiResource<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className={wide ? 'panel dash-card wide' : 'panel dash-card'} aria-label={title}>
      <div className="sectionhead">
        <h2>{title}</h2>
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
      </div>
      {resource.phase === 'loading' && !resource.data ? <LoadingState label="讀取中…" /> : null}
      {resource.phase === 'error' ? <ErrorState title={`無法取得「${title}」`} error={resource.error} onRetry={resource.reload} /> : null}
      {resource.data ? children(resource.data) : null}
    </section>
  );
}

function Who({ id, name, party, onOpenId }: { id: string; name: string; party: string; onOpenId: (id: string) => void }) {
  return (
    <button type="button" className="name-button" style={{ color: partyStyle(party).color }} onClick={() => onOpenId(id)}>
      {name}
    </button>
  );
}

/**
 * 總覽：各區塊（動態、新聞、法案、三讀、預算、預算中心、委員會紀錄、排行榜）各取最新幾則，
 * 下方依縣市列出各區委員的最新動態。資料全部沿用各頁的端點，只多一個 /regions。
 */
export function DashboardPage({ refreshToken, onOpenId, onNavigate }: DashboardPageProps) {
  const opts = { refreshToken };
  // 各縣市預設不展開，而且展開才渲染（25 張卡片的 DOM 不進首次繪製）
  const [regionsOpen, setRegionsOpen] = useState(false);
  // 每張卡只取 3 則：總覽的任務是「指出重點並導向」，不是把所有清單攤開
  const activity = useApi<ActivityResponse>(buildUrl('/activity', { limit: 4 }), opts);
  const news = useApi<NewsResponse>(buildUrl('/news', { limit: 8 }), opts);
  const bills = useApi<BillsResponse>(buildUrl('/bills', { limit: 3 }), opts);
  const passed = useApi<BillsResponse>(buildUrl('/bills', { status: '三讀', limit: 3 }), opts);
  const budget = useApi<BudgetResponse>(buildUrl('/budget', { limit: 3 }), opts);
  const reports = useApi<BudgetReportsResponse>(buildUrl('/budget/reports', { limit: 3 }), opts);
  const rankings = useApi<RankingsResponse>(buildUrl('/rankings', { type: 'all', days: 30, limit: 3 }), opts);
  const committees = useApi<CommitteeActivityResponse>(buildUrl('/committee-activity', { limit: 3 }), opts);
  const regions = useApi<RegionsResponse>(buildUrl('/regions', { per: 2 }), opts);

  const link = (route: Route, params?: Record<string, string>) => pathFor(route, params);
  const passedCount = bills.data?.statuses.filter((s) => PASSED.has(s.name)).reduce((sum, s) => sum + s.count, 0);
  const tiles: { label: string; value: number | undefined; href: string }[] = [
    { label: '在職委員', value: regions.data?.items.reduce((sum, r) => sum + r.legislators.length, 0), href: link('legislators') },
    { label: '本屆委員提案', value: bills.data?.total, href: link('bills') },
    { label: '已三讀', value: passedCount, href: link('bills', { status: '三讀' }) },
    { label: '預算審議中', value: budget.data?.states.pending, href: link('budget', { category: 'all', state: 'pending' }) },
  ];

  return (
    <>
      <div className="page-head">
        <h1>總覽</h1>
        <p className="page-lead">
          本屆立法院的四個關鍵數字，接著是最新動態、法案、預算與委員會的重點摘要。
          每個區塊右上角都能進入完整頁面；各縣市動態收在頁面最下方（預設收合）。
        </p>
      </div>

      <div className="stat-row">
        {tiles.map((t) => (
          <a
            key={t.label}
            className="stat-tile"
            href={t.href}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(t.href);
            }}
          >
            <b className="stat-value">{t.value === undefined ? '—' : t.value.toLocaleString()}</b>
            <span className="stat-label">{t.label}</span>
          </a>
        ))}
      </div>

      <div className="dash-grid">
        <Card title="最新動態" href={link('home')} onNavigate={onNavigate} resource={activity} wide>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((a) => {
                const latest = [
                  a.post && { label: '臉書', date: a.post.date, text: a.post.summary || '最新貼文', url: a.post.url },
                  a.news && { label: '新聞', date: a.news.published_at.slice(0, 10), text: a.news.title, url: a.news.url },
                  a.bill && { label: '提案', date: a.bill.latest_date, text: a.bill.laws[0] ?? a.bill.name, url: a.bill.url },
                ]
                  .filter((x): x is { label: string; date: string; text: string; url: string } => Boolean(x))
                  .sort((x, y) => y.date.localeCompare(x.date))[0];
                return (
                  <li key={a.legislator.id}>
                    <Who {...a.legislator} onOpenId={onOpenId} />
                    {latest ? (
                      <a href={latest.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                        <span className="kind">{latest.label}</span>
                        {latest.text}
                      </a>
                    ) : null}
                    <time>{shortDate(a.activity_date)}</time>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="最新新聞" href={link('news')} onNavigate={onNavigate} resource={news}>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((n) => (
                <li key={`${n.legislator_id}-${n.url}`}>
                  <Who id={n.legislator_id} name={n.legislator_name} party={n.legislator_party} onOpenId={onOpenId} />
                  <a href={n.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    {n.title}
                  </a>
                  <time>{shortDate(n.published_at)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="新聞來源" href={link('news')} onNavigate={onNavigate} resource={news}>
          {(data) => {
            const max = Math.max(1, ...data.sources.map((s) => s.count));
            return (
              <>
                <p className="muted">近 180 天 {data.source_total} 家媒體；長條為報導則數，顏色為提到的委員黨籍比例</p>
                <ul className="source-bars">
                  {data.sources.map((s) => {
                    const total = Object.values(s.parties).reduce((a, b) => a + b, 0) || 1;
                    return (
                      <li key={s.name}>
                        <span className="source-name">{s.name}</span>
                        <span className="source-bar" style={{ width: `${(s.count / max) * 100}%` }} title={sortParties(Object.keys(s.parties)).map((p) => `${partyStyle(p).short} ${s.parties[p]}`).join('、')}>
                          {sortParties(Object.keys(s.parties)).map((p) => (
                            <span key={p} style={{ flexGrow: s.parties[p] / total, background: partyStyle(p).color }} />
                          ))}
                        </span>
                        <span className="source-count">{s.count}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            );
          }}
        </Card>

        <Card title="法案最新進度" href={link('bills')} onNavigate={onNavigate} resource={bills}>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((b) => (
                <li key={b.id}>
                  <span className="status-tag">{b.status}</span>
                  <a href={b.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    {billTitle(b.name)}
                  </a>
                  <time>{shortDate(b.latest_date)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="最新三讀" href={link('bills', { status: '三讀' })} onNavigate={onNavigate} resource={passed}>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((b) => (
                <li key={b.id}>
                  {b.sponsors[0] ? <Who {...b.sponsors[0]} onOpenId={onOpenId} /> : <span className="muted">黨團</span>}
                  <a href={b.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    {billTitle(b.name)}
                  </a>
                  <time>{shortDate(b.latest_date)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="預算審議最新進度" href={link('budget', { category: 'all' })} onNavigate={onNavigate} resource={budget}>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((b) => (
                <li key={b.id}>
                  <span className="status-tag">{b.proposer}</span>
                  <a href={b.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    {b.name}
                  </a>
                  <time>{shortDate(b.latest_date)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="預算中心報告" href={link('budget', { category: 'all' })} onNavigate={onNavigate} resource={reports}>
          {(data) => (
            <ul className="dash-list">
              {data.items.map((r) => (
                <li key={r.no}>
                  <span className="kind">{r.type.replace('評估', '')}</span>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                      {r.title}
                    </a>
                  ) : (
                    <span className="clamp-2">{r.title}</span>
                  )}
                  <time>{r.completed?.slice(0, 7).replace('-', '/')}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="委員會會議紀錄" href={link('committees')} onNavigate={onNavigate} resource={committees}>
          {(data) => (
            <ul className="dash-list">
              {data.records.items.map((r) => (
                <li key={r.id}>
                  <span className="kind">{r.committees[0]?.replace(/委員會$/, '') ?? '會議'}</span>
                  <a href={r.html_url ?? r.gazette_url ?? '#'} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    {r.title}
                  </a>
                  <time>{shortDate(r.date)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="排行榜（近 30 天）" href={link('rankings')} onNavigate={onNavigate} resource={rankings} wide>
          {(data) => (
            <div className="dash-boards">
              {Object.values(data.boards).map((board) =>
                board ? (
                  <div key={board.type}>
                    <h3>{board.title}</h3>
                    <ol>
                      {board.items.map((item) => (
                        <li key={item.legislator.id}>
                          <Who {...item.legislator} onOpenId={onOpenId} />
                          <span className="muted">{item.value_display}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </Card>
      </div>

      <details
        className="panel regions-details"
        open={regionsOpen}
        onToggle={(event) => setRegionsOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          <span className="regions-title">各縣市最新動態</span>
          <span className="muted">
            {regions.data ? `${regions.data.count} 個選區` : '讀取中…'}・{regionsOpen ? '點此收合' : '點此展開'}
          </span>
        </summary>
        {regions.phase === 'loading' && !regions.data ? <LoadingState label="讀取各縣市…" /> : null}
        {regions.phase === 'error' ? <ErrorState title="無法取得各縣市（/api/v1/regions）" error={regions.error} onRetry={regions.reload} /> : null}
        {/* 收合時完全不渲染 25 張卡片：DOM 少 25 個 panel／25 個 h3，首次繪製也更快 */}
        {regionsOpen && regions.data ? (
          <div className="region-grid">
            {regions.data.items.map((r) => (
              <article key={r.region} className="panel region-card">
                <div className="sectionhead">
                  <h3>
                    <a
                      href={link('legislators', { region: r.region })}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(link('legislators', { region: r.region }));
                      }}
                    >
                      {r.region}
                    </a>
                  </h3>
                  <span className="muted">
                    {r.legislators.length} 位{r.news_7d ? `・近 7 天新聞 ${r.news_7d}` : ''}
                  </span>
                </div>
                <p className="region-people">
                  {r.legislators.map((l) => (
                    <span key={l.id} className="region-person" style={{ '--party': partyStyle(l.party).color } as CSSProperties}>
                      <Who {...l} onOpenId={onOpenId} />
                    </span>
                  ))}
                </p>
                {r.latest.length ? (
                  <ul className="dash-list">
                    {r.latest.map((x) => (
                      <li key={`${x.kind}-${x.legislator.id}-${x.url}`}>
                        <span className="kind">{KIND_LABEL[x.kind]}</span>
                        <a href={x.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                          <b>{x.legislator.name}</b>　{x.text}
                          <ExternalLink aria-hidden="true" />
                        </a>
                        <time>{shortDate(x.date)}</time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">暫無動態</p>
                )}
              </article>
            ))}
          </div>
        ) : null}
      </details>
    </>
  );
}
