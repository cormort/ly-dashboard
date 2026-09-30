import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { NewsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatDateTime } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

/** 近期新聞：/api/v1/news（Google 新聞，標題含委員姓名者）。只列標題與連結，不轉載內文。 */
export function LegislatorNews({ legislatorId }: { legislatorId: string }) {
  const news = useApi<NewsResponse>(buildUrl('/news', { legislator: legislatorId, limit: 8 }));

  if (news.phase === 'loading' && !news.data) return <LoadingState label="讀取新聞…" />;
  if (news.phase === 'error') {
    return <ErrorState title="無法取得新聞（/api/v1/news）" error={news.error} onRetry={news.reload} />;
  }
  if (!news.data || news.data.total === 0) {
    return <EmptyState message="近期沒有新聞" hint="只收錄標題提到這位委員的報導；新聞資料可能尚未同步。" />;
  }

  return (
    <div className="bills">
      <p className="muted">
        近 180 天共 {news.data.total} 則 · 來源：{news.data.meta.news_source.name}（標題含姓名者）
      </p>
      <ol className="bill-list">
        {news.data.items.map((item) => (
          <li key={item.url}>
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {item.title}
              <ExternalLink aria-hidden="true" />
            </a>
            <small>
              {formatDateTime(item.published_at)} · {item.source}
            </small>
          </li>
        ))}
      </ol>
    </div>
  );
}
