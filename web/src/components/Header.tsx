import { Fragment } from 'react';
import { RefreshCw } from 'lucide-react';
import type { SourceInfo } from '../api/types';
import type { Route } from '../hooks/useRoute';
import { pathFor } from '../hooks/useRoute';
import { formatDateTime } from '../lib/format';
import { FontSizeControl } from './FontSizeControl';
import { InfoTip } from './InfoTip';
import { PAGE_HINTS } from '../lib/pageHints';
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
  /** 按下去觸發後端同步（同步完才會重新載入畫面資料） */
  onRefresh: () => void;
  refreshing: boolean;
  /** 同步進度／結果文字（如「同步中…（已完成 2 個來源）」）；無則不顯示 */
  syncMessage?: string | null;
  syncTone?: 'running' | 'ok' | 'error';
}

/**
 * 導覽兩層，順序依「機關首長要面對立法院」的關心程度：
 * 總覽 → 我的機關（選定機關後以它為中心）→ 議事（預算、委員會、法案＝對機關的直接影響）→ 委員（誰在問、誰在動）→ 新聞（首長與委員的輿情）→ 機關／基金（查詢工具）。
 * 每個主題的子頁也依首長與幕僚的使用頻率排，第一個就是點主題時的預設頁（例如「新聞」先開機關首長新聞）。
 * 縣市地圖與最近動態是看委員選區與活躍度用的，收進「委員」底下，不佔頂層。
 */
interface NavGroup {
  id: string;
  label: string;
  home: Route;
  routes: { route: Route; label: string }[];
}

const NAV: NavGroup[] = [
  { id: 'overview', label: '總覽', home: 'dashboard', routes: [{ route: 'dashboard', label: '總覽' }] },
  { id: 'my', label: '我的機關', home: 'my', routes: [{ route: 'my', label: '我的機關' }] },
  {
    id: 'agenda',
    label: '議事',
    home: 'budget',
    routes: [
      { route: 'budget', label: '預算審議' },
      { route: 'committees', label: '委員會' },
      { route: 'bills', label: '法案查詢' },
    ],
  },
  {
    id: 'members',
    label: '委員',
    home: 'legislators',
    routes: [
      { route: 'legislators', label: '委員查詢' },
      { route: 'home', label: '最近動態' },
      { route: 'rankings', label: '排行榜' },
      { route: 'compare', label: '委員比較' },
      { route: 'counties', label: '縣市' },
    ],
  },
  {
    id: 'news',
    label: '新聞',
    home: 'officials',
    routes: [
      { route: 'officials', label: '機關首長新聞' },
      { route: 'news', label: '委員新聞' },
    ],
  },
  {
    id: 'orgs',
    label: '機關／基金',
    home: 'agencies',
    routes: [
      { route: 'agencies', label: '機關' },
      { route: 'funds', label: '基金' },
      { route: 'foundations', label: '財團法人' },
      { route: 'administrative', label: '行政法人' },
    ],
  },
];

// /dgbas（主計總處專頁）不在任何頁籤上：它的內容已併入「我的機關」（預設機關），網址保留，高亮歸「我的機關」
const groupOf = (route: Route): NavGroup =>
  NAV.find((group) => group.routes.some((item) => item.route === (route === 'dgbas' ? 'my' : route))) ?? NAV[0];

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
  syncMessage = null,
  syncTone = 'running',
}: HeaderProps) {
  const tone = failed ? 'error' : stale ? 'warning' : 'ok';
  const statusText = failed ? '同步失敗' : stale ? '可能非最新' : '資料截至';
  // L6：同步面板是條件式 render，只有它存在時 aria-controls 才指得到東西
  const syncPanelExists = syncOpen || failed || stale;
  const activeGroup = groupOf(route);
  // 目前頁面的功能說明：掛在分頁導覽上（頁面本身不再有重複分頁名稱的標題列）
  const hint = PAGE_HINTS[route];
  const hasSubnav = activeGroup.routes.length > 1;

  return (
    <>
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
        {NAV.map((group) => {
          const active = activeGroup.id === group.id;
          return (
            <Fragment key={group.id}>
              <a
                href={pathFor(group.home)}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(pathFor(group.home));
                }}
              >
                {group.label}
              </a>
              {active && !hasSubnav && hint ? <InfoTip>{hint}</InfoTip> : null}
            </Fragment>
          );
        })}
      </nav>

      {/* 法案、預算、委員會頁有自己的搜尋框，兩個不同目標的搜尋框疊在一起會混淆 */}
      {route !== 'bills' && route !== 'budget' && route !== 'committees' ? (
        <SearchField
          value={query}
          onChange={onQueryChange}
          ariaLabel="關鍵字搜尋立法委員"
          placeholder="搜尋委員姓名、選區、委員會"
        />
      ) : null}

      <div className="header-status">
        <button
          type="button"
          className={`sync-pill ${tone}`}
          aria-expanded={syncPanelExists ? syncOpen : undefined}
          aria-controls={syncPanelExists ? 'sync-panel' : undefined}
          onClick={onSyncToggle}
          title="同步狀態與紀錄"
        >
          <span className="dot" aria-hidden="true" />
          {statusText} {formatDateTime(fetchedAt, '尚無成功同步紀錄')}
        </button>
        <FontSizeControl />
        <span className={`sync-progress ${syncTone}`} role="status" aria-live="polite">
          {syncMessage}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshing ? '同步更新中…' : '更新資料'}
          title="從立法院重新同步最新資料"
        >
          <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
        </div>
      </header>

      {/* 次級導覽：只在所屬主題有多個頁面時出現（兩層導覽的第二層） */}
      {hasSubnav ? (
        <div className="subnav-row">
          <nav className="subnav" aria-label={`${activeGroup.label}的頁面`}>
            {activeGroup.routes.map((item) => (
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
          {hint ? <InfoTip align="end">{hint}</InfoTip> : null}
        </div>
      ) : null}
    </>
  );
}
