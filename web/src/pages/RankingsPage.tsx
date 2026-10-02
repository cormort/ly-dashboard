import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { ExternalLink, Trophy } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { RankingBoard, RankingItem, RankingsResponse } from '../api/types';
import { CosponsorMatrix } from '../components/CosponsorMatrix';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { formatDateTime } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface RankingsPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  onNavigate: (href: string) => void;
}

const WINDOWS = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;
const RANK_LIMIT = 10;

type Days = (typeof WINDOWS)[number];

/** 把 ?days= 讀進初始狀態（可分享、重整後一致） */
function initialDays(): Days {
  const raw = Number(new URLSearchParams(window.location.search).get('days'));
  return (WINDOWS as readonly number[]).includes(raw) ? (raw as Days) : DEFAULT_DAYS;
}

function RankingRow({ item, onOpenId }: { item: RankingItem; onOpenId: (id: string) => void }) {
  const style = partyStyle(item.legislator.party);
  return (
    <li className="ranking-row">
      <span className="ranking-rank" aria-label={`第 ${item.rank} 名`}>
        {item.rank}
      </span>

      <div className="ranking-who">
        <button type="button" className="name-button" onClick={() => onOpenId(item.legislator.id)}>
          {item.legislator.name}
        </button>
        <span className="party-tag" style={{ '--party': style.color } as CSSProperties}>
          {style.short}
        </span>
        <small>{item.legislator.region}</small>
      </div>

      <span className="ranking-value">{item.value_display}</span>

      <div
        className="ranking-bar"
        role="img"
        aria-label={`相對第一名的 ${Math.round(item.intensity * 100)}%`}
      >
        <div className="ranking-fill" style={{ width: `${Math.max(4, Math.round(item.intensity * 100))}%` }} />
      </div>

      <div className="ranking-meta">
        {item.detail.label ? <span>{item.detail.label}</span> : null}
        {item.detail.text ? <span> · {item.detail.text}</span> : null}
        {item.detail.url ? (
          <a className="ranking-link" href={item.detail.url} target="_blank" rel="noreferrer noopener">
            開啟來源 <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** 單一排行榜卡片（匯出以便 render 測試直接餵資料驗證） */
export function RankingBoardView({ board, onOpenId }: { board: RankingBoard; onOpenId: (id: string) => void }) {
  return (
    <section className="panel ranking-board" aria-label={board.title}>
      <div className="ranking-head">
        <div>
          <h2 className="ranking-title">
            <Trophy size={16} aria-hidden="true" /> {board.title}
          </h2>
          <p className="ranking-note">{board.note}</p>
        </div>
        <span className="pill">前 {board.items.length} 名</span>
      </div>

      {board.items.length === 0 ? (
        <EmptyState message="尚無資料" hint="這個排行榜需要對應的資料集，請先執行同步。" />
      ) : (
        <ol className="ranking-list">
          {board.items.map((item) => (
            <RankingRow key={`${board.type}-${item.legislator.id}`} item={item} onOpenId={onOpenId} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * 排行榜：新聞曝光、臉書發文、法案提案。
 * 數值與排序一律由後端 `/api/v1/rankings` 決定（含長條的 intensity），前端不做二次統計。
 */
export function RankingsPage({ refreshToken, onOpenId }: RankingsPageProps) {
  const [days, setDays] = useState<Days>(initialDays);
  const rankings = useApi<RankingsResponse>(
    buildUrl('/rankings', { type: 'all', days, limit: RANK_LIMIT }),
    { refreshToken },
  );

  // 區間寫回 URL（replace：切換區間不該塞滿上一頁）
  const changeDays = useCallback((next: Days) => {
    setDays(next);
    const params = new URLSearchParams(window.location.search);
    params.set('days', String(next));
    window.history.replaceState(null, '', `/rankings?${params.toString()}`);
  }, []);

  const boards = useMemo(() => Object.values(rankings.data?.boards ?? {}), [rankings.data]);

  const totals = useMemo(() => {
    if (!rankings.data) return null;
    const news = rankings.data.boards.news;
    const bills = rankings.data.boards.bills;
    const facebook = rankings.data.boards.facebook;
    return {
      newsItems: news ? news.items.reduce((sum, item) => sum + item.value, 0) : 0,
      newsNames: news?.items.length ?? 0,
      billItems: bills ? bills.items.reduce((sum, item) => sum + item.value, 0) : 0,
      freshest: facebook?.items[0]?.value_display ?? '—',
    };
  }, [rankings.data]);

  return (
    <>
      <div className="page-head">
        <h1 className="sr-only">排行榜</h1>
        <div className="segmented" role="group" aria-label="統計區間">
          {WINDOWS.map((window) => (
            <button key={window} type="button" aria-pressed={days === window} onClick={() => changeDays(window)}>
              近 {window} 天
            </button>
          ))}
        </div>
      </div>

      {rankings.phase === 'loading' && !rankings.data ? <LoadingState label="載入排行榜…" /> : null}
      {rankings.phase === 'error' && !rankings.data ? (
        <ErrorState title="無法取得排行榜（/api/v1/rankings）" error={rankings.error} onRetry={rankings.reload} />
      ) : null}

      {rankings.data ? (
        <>
          {totals ? (
            <div className="stat-row">
              <div className="stat-tile">
                <b className="stat-value">{totals.newsItems}</b>
                <span className="stat-label">前 {totals.newsNames} 名的新聞則數（近 {rankings.data.days} 天）</span>
              </div>
              <div className="stat-tile">
                <b className="stat-value">{totals.billItems}</b>
                <span className="stat-label">前 {rankings.data.boards.bills?.items.length ?? 0} 名的提案件數（本屆）</span>
              </div>
              <div className="stat-tile">
                <b className="stat-value">{totals.freshest}</b>
                <span className="stat-label">臉書最新發文（{rankings.data.boards.facebook?.items[0]?.legislator.name ?? '—'}）</span>
              </div>
            </div>
          ) : null}

          <div className="board-grid">
            {boards.map((board) => (
              <RankingBoardView key={board.type} board={board} onOpenId={onOpenId} />
            ))}
          </div>

          <CosponsorMatrix refreshToken={refreshToken} />

          <p className="muted">
            資料截至 {formatDateTime(rankings.data.meta.fetched_at, '尚未同步')}
            {rankings.data.meta.news_fetched_at ? ` · 新聞：${formatDateTime(rankings.data.meta.news_fetched_at)}` : ''}
            {rankings.data.meta.bills_fetched_at ? ` · 議案：${formatDateTime(rankings.data.meta.bills_fetched_at)}` : ''}
          </p>
        </>
      ) : null}
    </>
  );
}
