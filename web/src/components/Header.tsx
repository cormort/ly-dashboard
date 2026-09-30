import { Building2, ExternalLink, RefreshCw } from 'lucide-react';
import type { SourceInfo } from '../api/types';
import { formatDateTime, text } from '../lib/format';
import { SearchField } from './SearchField';

export interface HeaderProps {
  source: SourceInfo | null;
  /** 資料最後成功同步時間（meta.fetched_at） */
  fetchedAt: string | null;
  stale: boolean;
  /** 本回應產生時間（meta.generated_at） */
  generatedAt: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function Header({
  source,
  fetchedAt,
  stale,
  generatedAt,
  query,
  onQueryChange,
  onRefresh,
  refreshing,
}: HeaderProps) {
  return (
    <header>
      <div className="brand">
        <Building2 aria-hidden="true" />
        <div>
          <b>立委觀測站</b>
          <small>立法院開放資料 · 同源 API</small>
        </div>
      </div>

      <SearchField value={query} onChange={onQueryChange} ariaLabel="關鍵字搜尋立法委員" />

      <div className="header-meta">
        <span className="source-line">
          資料來源：
          {source ? (
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              {source.name}
              <ExternalLink aria-hidden="true" />
            </a>
          ) : (
            <span className="muted">載入中…</span>
          )}
        </span>
        <span className={stale ? 'source-line stale' : 'source-line'}>
          資料截至：{formatDateTime(fetchedAt, '尚無成功同步紀錄')}
          {stale ? '（可能非最新）' : ''}
        </span>
        <span className="source-line muted">
          畫面產生：{formatDateTime(generatedAt, '—')}
          {source ? ` · ${text(source.license)}` : ''}
        </span>
      </div>

      <button type="button" className="primary" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        {refreshing ? '重新載入中…' : '重新載入'}
      </button>
    </header>
  );
}
