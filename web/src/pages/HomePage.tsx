import { useState, type CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import { PageTitle } from '../components/PageTitle';
import { TopicsPanel } from '../components/TopicsPanel';
import type { ActivityItem, ActivityResponse, NewsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Portrait } from '../components/Portrait';
import { useApi } from '../hooks/useApi';
import type { TrackedApi } from '../hooks/useTracked';
import { readPreference, writePreference } from '../lib/storage';
import { formatDateTime } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface HomePageProps {
  refreshToken: number;
  onOpenId: (legislatorId: string) => void;
  onNavigate: (href: string) => void;
  tracked: TrackedApi;
}

/**
 * 上次造訪的日期（YYYY-MM-DD）：讀出舊值後立刻寫入今天，之後比它新的動態標「新」。
 * ponytail: 以日為單位（動態日期本來就只有日），同一天內重複造訪不會再標新。
 */
function useLastVisit(): string | null {
  const [previous] = useState(() => {
    const value = readPreference('last-visit');
    writePreference('last-visit', new Date().toISOString().slice(0, 10));
    return value;
  });
  return previous;
}

const shortDate = (value: string | undefined | null) => (value ? value.slice(5, 10).replace('-', '/') : '');

function ActivityCard({ item, onOpenId, isNew }: { item: ActivityItem; onOpenId: (id: string) => void; isNew: boolean }) {
  const { legislator: l, post, news, bill } = item;
  const style = partyStyle(l.party);
  return (
    <li className="activity" style={{ '--party': style.color } as CSSProperties}>
      <div className="activity-who">
        <Portrait legislator={l} />
        <div>
          <button type="button" className="name-button" onClick={() => onOpenId(l.id)}>
            {l.name}
          </button>
          {l.is_convener ? <span className="convener-mark">召委</span> : null}
          <small>
            <span style={{ color: style.color }}>{style.short}</span>　{l.region}
          </small>
        </div>
        <time dateTime={item.activity_date}>
          {isNew ? <span className="new-mark">新</span> : null}
          {shortDate(item.activity_date)}
        </time>
      </div>
      <dl className="activity-lines">
        {post ? (
          <>
            <dt>臉書 {shortDate(post.date)}</dt>
            <dd>
              <a href={post.url} target="_blank" rel="noreferrer noopener">
                {post.summary || '最新貼文'}
              </a>
            </dd>
          </>
        ) : null}
        {news ? (
          <>
            <dt>新聞 {shortDate(news.published_at)}</dt>
            <dd>
              <a href={news.url} target="_blank" rel="noreferrer noopener">
                {news.title}
              </a>
              <small>{news.source}</small>
            </dd>
          </>
        ) : null}
        {bill ? (
          <>
            <dt>提案 {shortDate(bill.latest_date)}</dt>
            <dd>
              <a href={bill.url} target="_blank" rel="noreferrer noopener">
                {bill.laws[0] ?? bill.name}
              </a>
              <small>{bill.status}</small>
            </dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

/** 首頁：最近有動態的委員（貼文／新聞／提案），旁邊是近 30 天熱門議題與最新新聞。 */
export function HomePage({ refreshToken, onOpenId, onNavigate, tracked }: HomePageProps) {
  const [limit, setLimit] = useState(12);
  const [onlyTracked, setOnlyTracked] = useState(() => readPreference('home-tracked') === '1');
  const lastVisit = useLastVisit();
  const showTracked = onlyTracked && tracked.count > 0;
  const activity = useApi<ActivityResponse>(
    buildUrl('/activity', { limit: showTracked ? 113 : limit, ids: showTracked ? tracked.ids.join(',') : undefined }),
    { refreshToken },
  );
  const toggleTracked = (next: boolean) => {
    setOnlyTracked(next);
    writePreference('home-tracked', next ? '1' : '0');
  };
  const news = useApi<NewsResponse>(buildUrl('/news', { limit: 8 }), { refreshToken });

  return (
    <>
      <div className="page-head">
        <PageTitle title="最近動態">委員最新的臉書貼文、新聞與提案進度，依時間排列。</PageTitle>
      </div>

      <div className="home">
        <section className="panel" aria-label="委員動態">
          <div className="sectionhead">
            <h2>委員動態</h2>
            <div className="segmented" role="group" aria-label="動態範圍">
              <button type="button" aria-pressed={!showTracked} onClick={() => toggleTracked(false)}>
                全部
              </button>
              <button
                type="button"
                aria-pressed={showTracked}
                disabled={tracked.count === 0}
                onClick={() => toggleTracked(true)}
                title={tracked.count === 0 ? '在委員查詢頁按 ☆ 加入追蹤' : undefined}
              >
                追蹤中（{tracked.count}）
              </button>
            </div>
          </div>
          {activity.phase === 'loading' && !activity.data ? <LoadingState label="讀取委員動態…" /> : null}
          {activity.phase === 'error' ? (
            <ErrorState title="無法取得委員動態（/api/v1/activity）" error={activity.error} onRetry={activity.reload} />
          ) : null}
          {activity.phase === 'empty' ? (
            <EmptyState message="還沒有任何動態" hint="貼文、新聞與提案資料同步完成後會出現在這裡。" />
          ) : null}
          {activity.data && activity.data.items.length > 0 ? (
            <>
              <ol className="activity-list">
                {activity.data.items.map((item) => (
                  <ActivityCard
                    key={item.legislator.id}
                    item={item}
                    onOpenId={onOpenId}
                    isNew={lastVisit !== null && item.activity_date > lastVisit}
                  />
                ))}
              </ol>
              {!showTracked && activity.data.count >= limit && limit < 113 ? (
                <button type="button" className="more" onClick={() => setLimit(113)}>
                  顯示全部委員
                </button>
              ) : null}
            </>
          ) : null}
        </section>

        <div className="home-side">
          <section className="panel" aria-label="最新新聞">
            <h2>最新新聞</h2>
            {news.phase === 'loading' && !news.data ? <LoadingState label="讀取新聞…" /> : null}
            {news.phase === 'error' ? <ErrorState title="無法取得新聞（/api/v1/news）" error={news.error} onRetry={news.reload} /> : null}
            {news.phase === 'empty' ? <EmptyState message="還沒有新聞" hint="新聞同步完成後會出現在這裡。" /> : null}
            {news.data && news.data.items.length > 0 ? (
              <ul className="news-list">
                {news.data.items.map((item) => (
                  <li key={`${item.legislator_id}-${item.url}`}>
                    <a href={item.url} target="_blank" rel="noreferrer noopener">
                      {item.title}
                      <ExternalLink aria-hidden="true" />
                    </a>
                    <small>
                      <button type="button" className="name-button" onClick={() => onOpenId(item.legislator_id)}>
                        {item.legislator_name}
                      </button>
                      　{item.source}　{formatDateTime(item.published_at)}
                    </small>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>

      {/* 熱門議題：全寬（有區間／詞彙／檢視三組控制，需要橫向空間） */}
      <TopicsPanel refreshToken={refreshToken} onNavigate={onNavigate} />
    </>
  );
}
