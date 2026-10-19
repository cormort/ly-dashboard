import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Building2,
  Gavel,
  Landmark,
  LayoutDashboard,
  Map as MapIcon,
  MessageCircle,
  Newspaper,
  RefreshCw,
  Search,
  Users,
  Vote,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SourceInfo, SyncScope } from '../api/types';
import type { Route } from '../hooks/useRoute';
import { pathFor } from '../hooks/useRoute';
import { formatDateTime, formatRelative } from '../lib/format';
import { FontSizeControl } from './FontSizeControl';
import { InfoTip } from './InfoTip';
import { Magnifier } from './Magnifier';
import { shouldOpenInCard } from '../lib/nav';
import { useCountiesEnabled } from '../lib/features';
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
  /** false＝伺服器不接受網頁觸發同步（區網分享模式），整組同步按鈕隱藏 */
  syncEnabled?: boolean;
  /** 這個入口不提供的頁（例如公開站收掉縣市地圖、議員）：連同頁籤一起藏起來 */
  hiddenRoutes?: Route[];
  query: string;
  onQueryChange: (value: string) => void;
  /** 按下去觸發後端同步（同步完才會重新載入畫面資料） */
  /** force=true 用在防呆擋下來之後使用者仍要重跑（見 useSync 的 blocked） */
  onRefresh: (force?: boolean) => void;
  refreshing: boolean;
  /** 同步進度／結果文字（如「同步中…（已完成 2 個來源）」）；無則不顯示 */
  syncMessage?: string | null;
  syncTone?: 'running' | 'ok' | 'error' | 'blocked';
  /**
   * 手機：第二層頁籤點下去改成開卡片（見 lib/nav.ts 與 PageCard）。
   * 沒給就維持原本的直接換頁（桌機、以及測試都是這條路）。
   */
  onOpenCard?: (route: Route) => void;
  /** 可選的同步範圍（/sync-sources）；只有一個或還沒載到時不顯示下拉 */
  syncScopes?: SyncScope[];
  /** 目前選的同步範圍 id（預設 'all'） */
  syncScope?: string;
  onSyncScopeChange?: (id: string) => void;
}

/** 下拉選項的文字：範圍名稱＋上次同步時間（選單裡就要看得到，不然會以為按了同步每頁都變新） */
export function scopeOptionLabel(scope: SyncScope): string {
  const when = scope.last_run_at ? formatRelative(scope.last_run_at) : '尚未同步';
  return `${scope.label}（${when}）`;
}

/** 這個範圍涵蓋哪些來源、各自上次同步時間（當工具提示用） */
export function scopeDetailText(scope: SyncScope): string {
  return scope.sources.map((source) => `${source.label}：${source.finished_at ? formatRelative(source.finished_at) : '尚未同步'}`).join('\n');
}

/** 下拉選單的說明內容：更新頻率（使用者最常問「為什麼按了沒變」）＋上次同步＋防呆的冷卻時間 */
export function scopeCadenceText(scope: SyncScope): string {
  const lines = [`更新頻率：${scope.cadence ?? '來源每日更新'}`];
  lines.push(`上次同步：${scope.last_run_at ? formatRelative(scope.last_run_at) : '尚未同步'}`);
  if (scope.cooldown_minutes) {
    lines.push(`${scope.cooldown_minutes} 分鐘內再按會被擋下（按了也不會有新資料），要重跑請按「仍要重跑」`);
  }
  return lines.join('\n');
}

/**
 * 導覽兩層，順序依「機關首長要面對立法院」的關心程度：
 * 總覽 → 我的機關（選定機關後以它為中心）→ 議事（預算、委員會、法案＝對機關的直接影響）→ 委員（誰在問、誰在動）→ 議員 → 社群（委員與議員的社群貼文）→ 縣市地圖 → 新聞（首長與委員的輿情）→ 機關／基金（查詢工具）。
 * 每個主題的子頁也依首長與幕僚的使用頻率排，第一個就是點主題時的預設頁（例如「新聞」先開機關首長新聞）。
 * 最近動態是看委員活躍度用的，收進「委員」底下，不佔頂層；六都議員與縣市地圖分析各自成一個頂層頁籤。
 * 「社群」是 2026-10-06 從「委員」（粉專牆）與「議員」（近期動態）搬上來的：貼文是社群資料，
 * 跟議事資料性質不同，且立委與議員的粉專本來就該放在一起看。標籤用「社群」而不是「臉書」，
 * 以後 Instagram／Threads／YouTube 進來不必再開新頁籤。
 */
interface NavGroup {
  id: string;
  label: string;
  /**
   * 手機版頁籤列的小圖示（桌機不顯示，見 styles.css 的 .nav-icon）。
   * 2026-10-11：手機把主導覽改成「圖示＋文字、選取用底線」的頁籤列（使用者給的參考畫面），
   * 一行 9 個純文字標籤太難掃讀，加了圖示後每一格一眼可辨。
   */
  icon: LucideIcon;
  home: Route;
  routes: { route: Route; label: string }[];
  /**
   * 插在次級導覽最前面的捷徑（2026-10-07）。它指向**別的**主題的頁面，
   * 所以用一條分隔線跟這個主題自己的頁籤隔開，避免看起來像同一組。
   * 這裡允許重複：同一個頁面可以在兩個主題下都出現（例：新聞底下也放「我的機關」）。
   */
  lead?: { route: Route; label: string };
}

const NAV: NavGroup[] = [
  { id: 'overview', label: '總覽', icon: LayoutDashboard, home: 'dashboard', routes: [{ route: 'dashboard', label: '總覽' }] },
  { id: 'my', label: '我的機關', icon: Building2, home: 'my', routes: [{ route: 'my', label: '我的機關' }] },
  {
    id: 'agenda',
    label: '議事',
    icon: Gavel,
    home: 'budget',
    routes: [
      { route: 'budget', label: '預算審議' },
      { route: 'committees', label: '委員會' },
      { route: 'bills', label: '法案查詢' },
      { route: 'votes', label: '院會表決' },
      { route: 'resolutions', label: '附帶決議' },
    ],
  },
  {
    id: 'members',
    label: '委員',
    icon: Users,
    home: 'legislators',
    routes: [
      { route: 'legislators', label: '委員查詢' },
      { route: 'home', label: '最近動態' },
      { route: 'rankings', label: '排行榜' },
      { route: 'compare', label: '委員比較' },
    ],
  },
  {
    id: 'council',
    label: '議員',
    icon: Vote,
    home: 'council',
    routes: [{ route: 'council', label: '議員' }],
  },
  {
    id: 'facebook',
    label: '社群',
    icon: MessageCircle,
    home: 'socialwall',
    routes: [
      { route: 'socialwall', label: '委員粉專牆' },
      { route: 'councilactivity', label: '議員近期動態' },
    ],
  },
  { id: 'map', label: '縣市地圖', icon: MapIcon, home: 'counties', routes: [{ route: 'counties', label: '縣市地圖' }] },
  {
    id: 'news',
    label: '新聞',
    icon: Newspaper,
    home: 'officials',
    // 看新聞時最常回頭查的就是自己機關，所以在最前面放一個捷徑（用分隔線隔開，見 NavGroup.lead）
    lead: { route: 'my', label: '我的機關' },
    routes: [
      { route: 'officials', label: '機關首長新聞' },
      { route: 'agencynews', label: '機關新聞' },
      { route: 'news', label: '委員新聞' },
      { route: 'allnews', label: '全部新聞' },
    ],
  },
  {
    id: 'orgs',
    label: '機關／基金',
    icon: Landmark,
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
const groupOf = (route: Route, groups: NavGroup[] = NAV): NavGroup =>
  groups.find((group) => group.routes.some((item) => item.route === (route === 'dgbas' ? 'my' : route))) ?? groups[0];

/** 頁面自己有搜尋框的路由（法案、預算、委員會、各新聞頁、議員近期動態） */
const OWN_SEARCH = new Set<Route>(['bills', 'budget', 'committees', 'news', 'agencynews', 'allnews', 'officials', 'councilactivity']);

/**
 * 依「這個入口不提供的頁」過濾導覽：某組的頁全被藏起來，整組就不顯示。
 */
export function navGroupsFor(hiddenRoutes: Route[] = []): NavGroup[] {
  const hidden = new Set(hiddenRoutes);
  return NAV.map((group) => ({ ...group, routes: group.routes.filter((item) => !hidden.has(item.route)) }))
    .filter((group) => group.routes.length > 0);
}

/**
 * 這個路由在頁籤上的名字（卡片標題要用）。找不到就退回所屬主題的名稱，
 * 再找不到回 null（呼叫端自己決定要不要開卡片）。
 */
export function navLabelOf(route: Route): string | null {
  for (const group of NAV) {
    const item = group.routes.find((entry) => entry.route === route);
    if (item) return item.label;
    if (group.lead?.route === route) return group.lead.label;
  }
  return null;
}

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
  syncEnabled = true,
  hiddenRoutes = [],
  query,
  onQueryChange,
  onRefresh,
  refreshing,
  syncMessage = null,
  syncTone = 'running',
  onOpenCard,
  syncScopes = [],
  syncScope = 'all',
  onSyncScopeChange,
}: HeaderProps) {
  // 手機的搜尋框：收成圖示，點開才顯示輸入框（桌機由 CSS 讓它一直顯示，這裡的狀態不影響）
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 展開後直接聚焦，不然使用者還要再點一次輸入框
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // 手機的頁籤列一次只看得到 5 格半：換頁後把選取的那一格捲進視線（例如 /funds 在第 9 格）。
  // 只在真的溢出時才動（桌機不會溢出，等於 no-op），並且用 block:'nearest' 避免連整頁也跟著捲。
  const navRef = useRef<HTMLElement>(null);
  const navScrolled = useRef(false);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth + 1) return;
    const current = nav.querySelector<HTMLElement>("a[aria-current='page']");
    if (!current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // 第一次（剛進站／剛載入）直接就定位：不然一進站就看到頁籤列自己滑一段，很像壞掉；
    // 之後換頁才用平滑捲動，讓「被移到中間的是我剛點的那一格」看得出來。
    const behavior = navScrolled.current && !reduced ? 'smooth' : 'auto';
    navScrolled.current = true;
    current.scrollIntoView({ inline: 'center', block: 'nearest', behavior });
  }, [route]);

  // 目前選的同步範圍（說明與提示都要用同一份）
  const currentScope = syncScopes.find((scope) => scope.id === syncScope) ?? syncScopes[0] ?? null;
  const tone = failed ? 'error' : stale ? 'warning' : 'ok';
  const statusText = failed ? '同步失敗' : stale ? '可能非最新' : '資料截至';
  // L6：同步面板是條件式 render，只有它存在時 aria-controls 才指得到東西
  const syncPanelExists = syncOpen || failed || stale;
  // 這台有沒有提供縣市地圖：伺服器 LY_HIDE_COUNTIES=1 時為 false（App 用同一份 /health 值提供 Context），
  // 跟 hiddenRoutes 是同一個來源的兩條路徑（hiddenRoutes 也擋直接開網址）。
  const countiesEnabled = useCountiesEnabled();
  const navGroups = navGroupsFor(hiddenRoutes).filter((group) => countiesEnabled || group.id !== 'map');
  const activeGroup = groupOf(route, navGroups);
  const hasSubnav = activeGroup.routes.length > 1;
  // 先取出成 const：TS 的屬性縮窄不會進到 onClick 的閉包裡
  const subnavLead = activeGroup.lead;

  /**
   * 第二層頁籤的點擊行為：手機開卡片、其餘直接換頁。
   * `typeof window` 的守衛是為了非瀏覽器環境（render smoke 只做靜態渲染、不會點）。
   */
  const subnavClick = (target: Route) => (event: React.MouseEvent) => {
    event.preventDefault();
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    if (onOpenCard && shouldOpenInCard({ viewportWidth: width })) onOpenCard(target);
    else onNavigate(pathFor(target));
  };

  return (
    <>
      <header className={searchOpen ? 'search-open' : undefined}>
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

      <nav aria-label="主要頁面" ref={navRef}>
        {navGroups.map((group) => {
          const active = activeGroup.id === group.id;
          const Icon = group.icon;
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
                {/* 圖示只在手機顯示（桌機那條導覽的高度與寬度都算得很緊，見 styles.css） */}
                <span className="nav-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={1.8} />
                </span>
                <span className="nav-label">{group.label}</span>
              </a>
            </Fragment>
          );
        })}
      </nav>

      <Magnifier />
      {/* 有自己搜尋框的頁面不放頁首搜尋：兩個不同目標的搜尋框疊在一起會混淆 */}
      {!OWN_SEARCH.has(route) ? (
        <>
          {/* 手機：搜尋框收成一顆圖示（點開才出現輸入框），頁首因此少一列、也不會一進站
              就被鍵盤擋掉半個畫面。桌機這顆按鈕用 CSS 關掉（display: none），
              搜尋框直接顯示——桌機行為完全不變。 */}
          <button
            type="button"
            className="icon-button search-toggle"
            aria-expanded={searchOpen}
            aria-controls="header-search"
            title={searchOpen ? '收起搜尋' : '搜尋委員'}
            onClick={() => setSearchOpen((open) => !open)}
          >
            {searchOpen ? <X aria-hidden="true" /> : <Search aria-hidden="true" />}
            <span className="sr-only">{searchOpen ? '收起搜尋' : '搜尋委員姓名、選區、委員會'}</span>
          </button>
          <SearchField
            id="header-search"
            inputRef={searchInputRef}
            value={query}
            onChange={onQueryChange}
            ariaLabel="關鍵字搜尋立法委員"
            placeholder="搜尋委員姓名、選區、委員會"
          />
        </>
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
          {statusText}{' '}
          {/* 手機只顯示相對時間（「1 天前」），否則整串日期會把頁首擠成三行；
              桌機維持完整的日期時間（同一個資訊，兩種寬度各用適合的寫法） */}
          <span className="date-long">{formatDateTime(fetchedAt, '尚無成功同步紀錄')}</span>
          <span className="date-short">{formatRelative(fetchedAt, '尚無成功同步紀錄')}</span>
        </button>
        <FontSizeControl />
        <span className={`sync-progress ${syncTone}`} role="status" aria-live="polite">
          {syncMessage}
          {syncTone === 'blocked' ? (
            // 防呆擋下來時講清楚原因，但要留一條路：使用者真的要重跑就按這裡
            <button type="button" className="link-button" onClick={() => onRefresh(true)}>
              仍要重跑
            </button>
          ) : null}
        </span>
        {syncEnabled && syncScopes.length > 1 ? (
          <label className="sync-scope">
            <span className="sr-only">同步範圍</span>
            {/* 點一下（或滑過）就看得到這個範圍的更新頻率——「為什麼按了沒變」的答案在這裡 */}
            {currentScope ? (
              <InfoTip align="inline-end" label={`「${currentScope.label}」的更新頻率與上次同步`}>
                <b>{currentScope.label}</b>
                {scopeCadenceText(currentScope)
                  .split('\n')
                  .map((line) => (
                    <span key={line} className="info-line">
                      {line}
                    </span>
                  ))}
              </InfoTip>
            ) : null}
            <select
              value={syncScope}
              onChange={(event) => onSyncScopeChange?.(event.target.value)}
              disabled={refreshing}
              title={`選擇這次要同步哪些來源（按右邊的箭頭才會開始）\n${scopeDetailText(syncScopes.find((scope) => scope.id === syncScope) ?? syncScopes[0])}`}
            >
              {syncScopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scopeOptionLabel(scope)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {syncEnabled ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => onRefresh()}
          disabled={refreshing}
          aria-label={refreshing ? '同步更新中…' : '更新資料'}
          title="從立法院重新同步最新資料"
        >
          <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
        ) : null}
        </div>
      </header>

      {/* 次級導覽：只在所屬主題有多個頁面時出現（兩層導覽的第二層） */}
      {hasSubnav ? (
        <div className="subnav-row">
          <nav className="subnav" aria-label={`${activeGroup.label}的頁面`}>
            {subnavLead ? (
              <>
                <a href={pathFor(subnavLead.route)} onClick={subnavClick(subnavLead.route)}>
                  {subnavLead.label}
                </a>
                {/* 這條線左邊是「別的」主題的頁面，右邊才是「新聞」自己的頁籤 */}
                <span className="subnav-divider" aria-hidden="true" />
              </>
            ) : null}
            {activeGroup.routes.map((item) => (
              <a
                key={item.route}
                href={pathFor(item.route)}
                aria-current={route === item.route ? 'page' : undefined}
                onClick={subnavClick(item.route)}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
