import { useState, type CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { ActivityItem, ActivityResponse, NewsResponse, TopicsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Portrait } from '../components/Portrait';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { formatDateTime } from '../lib/format';
import { partyStyle, sortParties } from '../lib/parties';

export interface HomePageProps {
  refreshToken: number;
  onOpenId: (legislatorId: string) => void;
  onNavigate: (href: string) => void;
}

const shortDate = (value: string | undefined | null) => (value ? value.slice(5, 10).replace('-', '/') : '');

function ActivityCard({ item, onOpenId }: { item: ActivityItem; onOpenId: (id: string) => void }) {
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
        <time dateTime={item.activity_date}>{shortDate(item.activity_date)}</time>
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
export function HomePage({ refreshToken, onOpenId, onNavigate }: HomePageProps) {
  const [limit, setLimit] = useState(12);
  const activity = useApi<ActivityResponse>(buildUrl('/activity', { limit }), { refreshToken });
  const topics = useApi<TopicsResponse>(buildUrl('/topics', { days: 30, limit: 10 }), { refreshToken });
  const news = useApi<NewsResponse>(buildUrl('/news', { limit: 8 }), { refreshToken });

  return (
    <>
      <div className="page-head">
        <h1>最近動態</h1>
        <p className="muted">委員最新的臉書貼文、新聞與提案進度，依時間排列。</p>
      </div>

      <div className="home">
        <section className="panel" aria-label="委員動態">
          <h2>委員動態</h2>
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
                  <ActivityCard key={item.legislator.id} item={item} onOpenId={onOpenId} />
                ))}
              </ol>
              {activity.data.count >= limit && limit < 113 ? (
                <button type="button" className="more" onClick={() => setLimit(113)}>
                  顯示全部委員
                </button>
              ) : null}
            </>
          ) : null}
        </section>

        <div className="home-side">
          <section className="panel" aria-label="熱門議題">
            <h2>熱門議題</h2>
            {topics.data?.since ? <p className="muted topic-note">{topics.data.since.slice(5).replace('-', '/')} 以來有進度的委員提案，依涉及的法律分組；色條是主提案人黨籍</p> : null}
            {topics.phase === 'loading' && !topics.data ? <LoadingState label="讀取議題…" /> : null}
            {topics.phase === 'error' ? (
              <ErrorState title="無法取得議題（/api/v1/topics）" error={topics.error} onRetry={topics.reload} />
            ) : null}
            {topics.phase === 'empty' ? <EmptyState message="近 30 天沒有提案進度" hint="議案資料可能尚未同步。" /> : null}
            {topics.data && topics.data.items.length > 0 ? (
              <ol className="topic-list">
                {topics.data.items.map((topic) => {
                  const parties = sortParties(Object.keys(topic.parties));
                  return (
                    <li key={topic.law}>
                      <a
                        href={pathFor('bills', { law: topic.law })}
                        onClick={(event) => {
                          event.preventDefault();
                          onNavigate(pathFor('bills', { law: topic.law }));
                        }}
                      >
                        <span className="topic-name">{topic.law}</span>
                        <span className="topic-count">
                          {topic.count} 件{topic.passed ? `・三讀 ${topic.passed}` : ''}
                        </span>
                        <span
                          className="bar"
                          aria-label={`主提案黨籍：${parties.map((p) => `${partyStyle(p).short} ${topic.parties[p]}`).join('、')}`}
                        >
                          {parties.map((p) => (
                            <span key={p} style={{ flexGrow: topic.parties[p], background: partyStyle(p).color }} />
                          ))}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>

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
    </>
  );
}
