import { RefreshCw } from 'lucide-react';
import type { SourceInfo } from '../api/types';
import type { Route } from '../hooks/useRoute';
import { pathFor } from '../hooks/useRoute';
import { formatDateTime } from '../lib/format';
import { SearchField } from './SearchField';

export interface HeaderProps {
  route: Route;
  onNavigate: (href: string) => void;
  source: SourceInfo | null;
  /** 資料最後成功同步時間（meta.fetched_at） */
  fetchedAt: string | null;
  stale: boolean;
  /** 最近一次同步失敗 */
  failed: boolean;
  /** 同步紀錄面板是否展開 */
  syncOpen: boolean;
  onSyncToggle: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const NAV: { route: Route; label: string }[] = [
  { route: 'home', label: '最近動態' },
  { route: 'legislators', label: '委員查詢' },
  { route: 'bills', label: '法案查詢' },
];

/** 頁首：站名、三頁導覽、委員搜尋、資料狀態（有問題才用警示色）。 */
export function Header({
  route,
  onNavigate,
  source,
  fetchedAt,
  stale,
  failed,
  syncOpen,
  onSyncToggle,
  query,
  onQueryChange,
  onRefresh,
  refreshing,
}: HeaderProps) {
  const tone = failed ? 'error' : stale ? 'warning' : 'ok';
  const statusText = failed ? '同步失敗' : stale ? '可能非最新' : '資料截至';

  return (
    <header>
      <a
        className="brand"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          onNavigate('/');
        }}
      >
        <b>立委觀測站</b>
        <small>{source?.name ?? '立法院開放資料'}</small>
      </a>

      <nav aria-label="主要頁面">
        {NAV.map((item) => (
          <a
            key={item.route}
            href={pathFor(item.route)}
            aria-current={route === item.route ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(pathFor(item.route));
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <SearchField
        value={query}
        onChange={onQueryChange}
        ariaLabel="關鍵字搜尋立法委員"
        placeholder="搜尋委員姓名、選區、委員會"
      />

      <div className="header-status">
        <button
          type="button"
          className={`sync-pill ${tone}`}
          aria-expanded={syncOpen}
          aria-controls="sync-panel"
          onClick={onSyncToggle}
          title="同步狀態與紀錄"
        >
          <span className="dot" aria-hidden="true" />
          {statusText} {formatDateTime(fetchedAt, '尚無成功同步紀錄')}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshing ? '重新載入中…' : '重新載入'}
          title="重新載入"
        >
          <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
