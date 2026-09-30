/**
 * 立委觀測站前端 — 靜態渲染煙霧測試（開發用，不進 production bundle）
 *
 * 用 react-dom/server 把元件樹與各資料區塊的**四態**（loading / ready / empty / error）
 * 各渲染一次，驗證：
 *   1. 沒有 import／render 期例外（lucide、三個頁面、整棵元件樹都載得起來）
 *   2. 初始載入時不會顯示任何委員資料
 *   3. ready 狀態真的把後端欄位畫出來（含圖表的文字替代）
 *   4. empty／error 狀態有明確文案，且**不會**補上任何示範資料
 *
 * 注意：server render 不執行 useEffect，所以畫面與真實 /api/v1 後端的整合
 * （實際上網抓資料後的行為）仍需瀏覽器 + 後端才能驗證。
 * 這裡用**測試替身** resource 物件直接把四態餵進元件。
 *
 * 執行：npx --yes tsx@4 scripts/render-smoke.ts
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../src/api/client';
import type { ApiResource } from '../src/hooks/useApi';
import type { ChangesResponse, CommitteesResponse, LegislatorsResponse, MetaResponse } from '../src/api/types';
import { AppShell } from '../src/components/AppShell';
import { ChangesPanel } from '../src/components/ChangesPanel';
import { CommitteeChart } from '../src/components/CommitteeChart';
import { Header } from '../src/components/Header';
import { LegislatorGrid } from '../src/components/LegislatorGrid';
import { SessionSelector } from '../src/components/SessionSelector';
import { Hemicycle, seatLayout } from '../src/components/Hemicycle';
import { HomePage } from '../src/pages/HomePage';
import { BillsPage } from '../src/pages/BillsPage';
import { SyncStatusBanner } from '../src/components/SyncStatusBanner';
import { RankingsPage, RankingBoardView } from '../src/pages/RankingsPage';
import { ComparePage } from '../src/pages/ComparePage';
import { BudgetPage } from '../src/pages/BudgetPage';
import { DashboardPage } from '../src/pages/DashboardPage';
import { BillStageBar } from '../src/components/BillStage';

/* ---------------------------- 瀏覽器 API 替身 ---------------------------- */
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  location: { pathname: '/', search: '?term=11&session=11-5' },
  scrollTo: () => undefined,
  dispatchEvent: () => true,
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  history: { pushState: () => undefined, replaceState: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

/* ------------------------------ 測試替身資料 ------------------------------ */
// 全部是明顯的測試替身字串（測試委員甲／測試政黨A），且此檔不在 vite 打包範圍內。

const META = {
  generated_at: '2026-09-30T09:20:00.000Z',
  fetched_at: '2026-09-30T08:59:55.000Z',
  stale: false,
  source: {
    name: '立法院開放資料',
    url: 'https://data.ly.gov.tw/',
    license: '政府資料開放授權條款第 1 版',
  },
};

const TERMS = [
  {
    no: 11,
    sessions: [
      { id: '11-1', seq: 1, label: '第 11 屆第 1 會期' },
      { id: '11-5', seq: 5, label: '第 11 屆第 5 會期' },
    ],
  },
];

const LEGISLATOR = {
  id: 'LY-00024',
  name: '測試委員甲',
  ename: 'TEST-A',
  party: '測試政黨A',
  caucus: '測試政黨A',
  area_name: '測試市第1選舉區',
  region: '測試市',
  sex: '男',
  onboard_date: '2024/02/01',
  contacts: [{ label: '國會研究室', tel: '02-2358-0000', fax: '', addr: '台北市中正區濟南路1段' }],
  social: [{ platform: 'facebook', name: '測試委員甲', url: 'https://www.facebook.com/test', latest_post_date: '2026-09-27', latest_post_summary: '測試摘要' }],
  photo_url: null,
  degree: null,
  experience: null,
  term: 11,
  sessions: ['11-1', '11-5'],
  committees: [{ id: '內政委員會', kind: 'standing' as const, is_convener: true }],
  is_convener: true,
  former: false,
  leave_date: '',
  leave_reason: '',
  bill_count: 3,
  news_count: 7,
  source_url: 'https://data.ly.gov.tw/odw/ID9Action.action',
};

const COMMITTEES: CommitteesResponse = {
  meta: { ...META, term: 11, session: '11-5' },
  count: 2,
  items: [
    { id: '內政委員會', kind: 'standing', count: 14, parties: { 測試政黨A: 9, 測試政黨B: 5 }, conveners: [{ id: 'LY-00024', name: '測試委員甲' }] },
    { id: '財政委員會', kind: 'standing', count: 13, parties: { 測試政黨A: 13 }, conveners: [] },
  ],
};

const LEGISLATORS: LegislatorsResponse = {
  meta: { ...META, term: 11, session: '11-5' },
  count: 1,
  total: 1,
  items: [LEGISLATOR],
};

const EMPTY_LEGISLATORS: LegislatorsResponse = {
  meta: { ...META, term: 11, session: '11-5' },
  count: 0,
  total: 0,
  items: [],
};

function resource<T>(phase: ApiResource<T>['phase'], data: T | null): ApiResource<T> {
  return {
    phase,
    data,
    error:
      phase === 'error' ? new ApiError('無法連線到 API 伺服器', { code: 'network_error' }) : null,
    reload: () => undefined,
  };
}

const ready = <T,>(data: T) => resource<T>('ready', data);
const empty = <T,>(data: T | null) => resource<T>('empty', data);
const errored = <T>() => resource<T>('error', null);
const idle = <T>() => resource<T>('loading', null);

/* -------------------------------- 檢查框架 -------------------------------- */
let failed = 0;
let passed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
    if (detail) console.error(detail.slice(0, 1200));
  }
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function expectAll(name: string, html: string, needles: string[]): void {
  const missing = needles.filter((needle) => !html.includes(needle));
  check(name, missing.length === 0, missing.length > 0 ? `缺少片段：${missing.join(' / ')}` : undefined);
}

/* ----------------------------------- 跑 ----------------------------------- */

const { default: App } = await import('../src/App');

console.log('— 整頁初始狀態（尚未取得任何 API 資料）—');
const homeHtml = render(createElement(App));
expectAll('首頁：站名、三頁導覽、動態／議題／新聞骨架', homeHtml, [
  '立委觀測站',
  '關鍵字搜尋立法委員',
  '最近動態',
  '排行榜',
  '委員查詢',
  '法案查詢',
  'aria-current="page"',
  '讀取委員動態',
  '讀取議題',
  '讀取新聞',
]);
check('首頁初始不顯示任何委員', !homeHtml.includes('查看檔案'));
check('不含示範／假資料字串', !/甲黨|示範資料|林怡安|陳宏宇|乙黨/.test(homeHtml));

(window as unknown as { location: { pathname: string } }).location.pathname = '/legislators';
const legislatorsHtml = render(createElement(App));
expectAll('委員查詢頁：屆次、篩選、名錄、委員會、異動骨架', legislatorsHtml, [
  '屆次與會期',
  '篩選條件',
  '立法委員名錄',
  '讀取委員名錄',
  '委員會組成',
  '最近異動',
  '卡片',
  '列表',
]);
(window as unknown as { location: { pathname: string } }).location.pathname = '/';

console.log('\n— Header —');
const headerProps = {
  route: 'home' as const,
  onNavigate: () => undefined,
  source: META.source,
  fetchedAt: META.fetched_at,
  stale: false,
  failed: false,
  syncOpen: false,
  onSyncToggle: () => undefined,
  query: '',
  onQueryChange: () => undefined,
  onRefresh: () => undefined,
  refreshing: false,
};
expectAll('顯示資料來源與資料截至時間', render(createElement(Header, headerProps)), [
  '立法院開放資料',
  '資料截至 2026/09/30',
]);
// L6：同步面板是條件式 render，aria-controls 不能指向不存在的元素
expectNone('面板不存在時，aria-controls 不該指向空號', render(createElement(Header, headerProps)), ['aria-controls="sync-panel"']);
expectAll('stale 時明示「可能非最新」', render(createElement(Header, { ...headerProps, stale: true })), ['可能非最新', 'sync-pill warning']);
expectAll(
  '面板存在時（stale／失敗／展開）才給 aria-controls',
  render(createElement(Header, { ...headerProps, stale: true })),
  ['aria-controls="sync-panel"', 'aria-expanded="false"'],
);
expectAll('同步失敗時明示', render(createElement(Header, { ...headerProps, failed: true })), ['同步失敗', 'sync-pill error']);

console.log('\n— SyncStatusBanner —');
expectAll(
  'loading 態',
  render(createElement(SyncStatusBanner, { health: idle(), refreshToken: 0 })),
  ['讀取同步狀態'],
);
expectAll(
  'error 態有重試按鈕',
  render(createElement(SyncStatusBanner, { health: errored(), refreshToken: 0 })),
  ['無法取得同步狀態', '重試', 'network_error'],
);
expectAll(
  'ready 態顯示同步時間與展開按鈕',
  render(
    createElement(SyncStatusBanner, {
      health: ready({
        meta: META,
        ok: true,
        db: { legislators: 113, memberships: 481, committee_seats: 402, changes: 37 },
        last_runs: [],
      }),
      refreshToken: 0,
    }),
  ),
  ['資料同步正常', '最後成功同步', '同步紀錄', 'aria-expanded="false"'],
);
expectAll(
  'stale 態必須明顯警示「可能非最新」',
  render(
    createElement(SyncStatusBanner, {
      health: ready({
        meta: { ...META, stale: true },
        ok: true,
        db: { legislators: 113, memberships: 481, committee_seats: 402, changes: 37 },
        last_runs: [],
      }),
      refreshToken: 0,
    }),
  ),
  ['資料可能非最新', '可能非最新', '超過 36 小時未成功同步'],
);
expectAll(
  '最近一次失敗時告警',
  render(
    createElement(SyncStatusBanner, {
      health: ready({
        meta: META,
        ok: false,
        db: { legislators: 0, memberships: 0, committee_seats: 0, changes: 0 },
        last_runs: [
          {
            id: 9,
            dataset: 'id9',
            status: 'failed' as const,
            started_at: META.fetched_at,
            finished_at: META.fetched_at,
            records: null,
            attempt: 2,
            http_status: 502,
            error: 'unsafe legacy renegotiation disabled',
            duration_ms: 1200,
            ua: null,
          },
        ],
      }),
      refreshToken: 0,
    }),
  ),
  ['最近一次同步失敗', 'ID14 委員會委員名單'.replace('14', '14') === '' ? '' : 'ID9 立法委員名錄'],
);

console.log('\n— SessionSelector —');
expectAll(
  'ready 態列出屆次與會期',
  render(
    createElement(SessionSelector, {
      meta: ready<MetaResponse>({
        meta: META,
        terms: TERMS,
        current: { term: 11, session: '11-5' },
        counts: { terms: 1, sessions: 2 },
      }),
      term: 11,
      session: '11-5',
      onTermChange: () => undefined,
      onSessionChange: () => undefined,
    }),
  ),
  ['第 11 屆', '第 11 屆第 5 會期', '全部會期', 'selected=""'],
);
expectAll(
  'current.session 為 null 時優雅處理',
  render(
    createElement(SessionSelector, {
      meta: ready<MetaResponse>({
        meta: META,
        terms: TERMS,
        current: { term: 11, session: null },
        counts: { terms: 1, sessions: 2 },
      }),
      term: 11,
      session: 'all',
      sessionUndetermined: true,
      onTermChange: () => undefined,
      onSessionChange: () => undefined,
    }),
  ),
  ['current.session', '全部會期'],
);
expectAll(
  '空屆次清單顯示空狀態',
  render(
    createElement(SessionSelector, {
      meta: empty<MetaResponse>({ meta: META, terms: [], current: { term: 11, session: null }, counts: { terms: 0, sessions: 0 } }),
      term: null,
      session: null,
      onTermChange: () => undefined,
      onSessionChange: () => undefined,
    }),
  ),
  ['後端尚無屆次資料'],
);

console.log('\n— Hemicycle —');
check('seatLayout 產生精確席次數', [1, 8, 113, 120].every((n) => seatLayout(n).length === n));
const B = { ...LEGISLATOR, id: 'LY-B', name: '測試委員乙', party: '測試政黨B', is_convener: false };
const hemiHtml = render(
  createElement(Hemicycle, {
    roster: [LEGISLATOR, B],
    matching: new Set(['LY-B']),
    party: '測試政黨B',
    onPartyToggle: () => undefined,
    onOpen: () => undefined,
  }),
);
expectAll('席次圖：文字替代、亮起數、圖例按鈕狀態、召委外框', hemiHtml, [
  '議場席次圖：共 2 席，符合條件 1 席',
  '測試政黨A 0／1 席',
  '測試政黨B 1／1 席',
  'aria-label="依黨籍篩選"',
  'aria-pressed="true"',
  '<title>測試委員乙',
]);
check('不符合的席次變淡', hemiHtml.includes('var(--seat-off)'));
check('無篩選時全部亮起', !render(
  createElement(Hemicycle, { roster: [LEGISLATOR, B], matching: null, party: null, onPartyToggle: () => undefined, onOpen: () => undefined }),
).includes('var(--seat-off)'));

console.log('\n— CommitteeChart —');
const chartHtml = render(
  createElement(CommitteeChart, { committees: ready(COMMITTEES), sessionScopeLabel: '第 11 屆第 5 會期' }),
);
expectAll('ready 態：每個委員會的席次、黨籍組成、召委都有文字', chartHtml, [
  '委員會組成',
  '內政委員會 14 席',
  '財政委員會 13 席',
  '召委 測試委員甲',
  'aria-pressed="false"',
]);
check('小人數＝席次總和（14＋13）', (chartHtml.match(/class="person"/g) ?? []).length - 2 === 27, '圖例另有 2 個');

expectAll(
  'empty 態顯示「此會期尚無委員會資料」',
  render(
    createElement(CommitteeChart, {
      committees: empty<CommitteesResponse>({ meta: META, count: 0, items: [] }),
      sessionScopeLabel: '第 11 屆第 1 會期',
    }),
  ),
  ['此會期尚無委員會資料', '第 11 屆第 1 會期'],
);
expectAll(
  'error 態有重試與錯誤代碼',
  render(createElement(CommitteeChart, { committees: errored<CommitteesResponse>(), sessionScopeLabel: 'x' })),
  ['無法取得委員會資料', '重試'],
);
expectAll(
  'loading 態',
  render(createElement(CommitteeChart, { committees: idle<CommitteesResponse>(), sessionScopeLabel: 'x' })),
  ['讀取委員會資料'],
);

console.log('\n— LegislatorGrid —');
const gridHtml = render(
  createElement(LegislatorGrid, {
    legislators: ready(LEGISLATORS),
    isTracked: () => true,
    onToggleTrack: () => undefined,
    onOpen: () => undefined,
    sessionScopeLabel: '第 11 屆第 5 會期',
    hasFilters: false,
    mode: 'cards',
    onModeChange: () => undefined,
    onDownload: () => undefined,
  }),
);
expectAll('ready 態卡片欄位齊全', gridHtml, [
  '測試委員甲',
  '測試政黨A',
  '內政<span class="convener-badge">召委</span>',
  '測試市第1選舉區',
  '召委',
  '提案 3',
  '新聞 7',
  'aria-label="取消追蹤 測試委員甲"',
  'aria-pressed="true"',
  '查看檔案',
]);
check('未追蹤時 aria-label 為加入追蹤', render(
  createElement(LegislatorGrid, {
    legislators: ready(LEGISLATORS),
    isTracked: () => false,
    onToggleTrack: () => undefined,
    onOpen: () => undefined,
    sessionScopeLabel: 'x',
    hasFilters: false,
    mode: 'cards',
    onModeChange: () => undefined,
    onDownload: () => undefined,
  }),
).includes('aria-label="追蹤 測試委員甲"'));
expectAll(
  'empty 態（無篩選）說「此會期尚無資料」且不塞假委員',
  render(
    createElement(LegislatorGrid, {
      legislators: empty(EMPTY_LEGISLATORS),
      isTracked: () => false,
      onToggleTrack: () => undefined,
      onOpen: () => undefined,
      sessionScopeLabel: '第 11 屆第 5 會期',
      hasFilters: false,
      mode: 'cards',
      onModeChange: () => undefined,
    onDownload: () => undefined,
    }),
  ),
  ['此會期尚無資料', '第 11 屆第 5 會期'],
);
expectAll(
  'empty 態（有篩選）說「沒有符合條件的委員」',
  render(
    createElement(LegislatorGrid, {
      legislators: empty(EMPTY_LEGISLATORS),
      isTracked: () => false,
      onToggleTrack: () => undefined,
      onOpen: () => undefined,
      sessionScopeLabel: '第 11 屆第 5 會期',
      hasFilters: true,
      mode: 'cards',
      onModeChange: () => undefined,
    onDownload: () => undefined,
    }),
  ),
  ['沒有符合條件的委員', '清除條件'],
);
expectAll(
  'error 態有重試',
  render(
    createElement(LegislatorGrid, {
      legislators: errored<LegislatorsResponse>(),
      isTracked: () => false,
      onToggleTrack: () => undefined,
      onOpen: () => undefined,
      sessionScopeLabel: 'x',
      hasFilters: false,
      mode: 'cards',
      onModeChange: () => undefined,
    onDownload: () => undefined,
    }),
  ),
  ['無法取得委員名錄', '重試'],
);
expectAll(
  'loading 態',
  render(
    createElement(LegislatorGrid, {
      legislators: idle<LegislatorsResponse>(),
      isTracked: () => false,
      onToggleTrack: () => undefined,
      onOpen: () => undefined,
      sessionScopeLabel: 'x',
      hasFilters: false,
      mode: 'cards',
      onModeChange: () => undefined,
    onDownload: () => undefined,
    }),
  ),
  ['讀取委員名錄'],
);

const listHtml = render(
  createElement(LegislatorGrid, {
    legislators: ready(LEGISLATORS),
    isTracked: () => false,
    onToggleTrack: () => undefined,
    onOpen: () => undefined,
    sessionScopeLabel: 'x',
    hasFilters: false,
    mode: 'list',
    onModeChange: () => undefined,
    onDownload: () => undefined,
  }),
);
expectAll('列表模式：可排序表頭、欄位與召委標記', listHtml, [
  '<table class="roster">',
  'aria-sort="ascending"',
  '提案',
  '最新貼文',
  '測試委員甲',
  '09/27',
  '內政・召',
]);
check('列表模式不出現卡片', !listHtml.includes('查看檔案'));

console.log('\n— 首頁與法案查詢（自行抓資料，僅驗 loading 態）—');
expectAll(
  '首頁 loading 態',
  render(createElement(HomePage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined, tracked: { ids: [], set: new Set(), count: 0, isTracked: () => false, toggle: () => undefined } })),
  ['委員動態', '熱門議題', '最新新聞', '讀取委員動態'],
);
expectAll(
  '法案查詢 loading 態',
  render(createElement(BillsPage, { refreshToken: 0, onOpenId: () => undefined })),
  ['法案查詢', '搜尋法案名稱或法律', '全部狀態', '讀取法案'],
);

console.log('\n— AppShell 側欄（詳情）—');
const detailHtml = render(
  createElement(
    (await import('../src/components/LegislatorDetail')).LegislatorDetail,
    {
      legislator: LEGISLATOR,
      onClose: () => undefined,
      tracked: false,
      onToggleTrack: () => undefined,
      source: META.source,
      sessionLabel: (id: string) => `label:${id}`,
    },
  ),
);
expectAll('詳情側欄有 dialog 語意、學經歷、會期與來源連結', detailHtml, [
  'role="dialog"',
  'aria-modal="true"',
  'aria-label="關閉委員檔案"',
  '學歷',
  '經歷',
  '未提供',
  'label:11-1',
  'label:11-5',
  'LY-00024',
  '社群',
  '臉書：測試委員甲',
  'https://www.facebook.com/test',
  '最新貼文 2026-09-27：測試摘要',
  '最近提案',
  '讀取提案',
  '近期新聞',
  '讀取新聞',
  '就職日期',
  '2024/02/01',
  '國會研究室',
  'href="tel:0223580000"',
  'data.ly.gov.tw/odw/ID9Action.action',
  '政府資料開放授權條款第 1 版',
]);

console.log('\n— ChangesPanel（自行抓資料，僅驗 loading 態）—');
expectAll(
  'loading 態',
  render(createElement(ChangesPanel, { refreshToken: 0 })),
  ['最近異動', '讀取異動紀錄'],
);

/* ------------------------------ 排行榜（新功能） ------------------------------ */

/** 反向檢查：這些字串**不該**出現（用來確認空狀態不會偷塞假資料） */
function expectNone(name: string, html: string, needles: string[]): void {
  const present = needles.filter((needle) => html.includes(needle));
  check(name, present.length === 0, present.length > 0 ? `不該出現：${present.join(' / ')}` : undefined);
}

const RANKING_BOARD = {
  type: 'news' as const,
  title: '新聞曝光排行',
  note: '近 30 天標題含委員姓名的報導數（測試）',
  unit: '則',
  items: [
    {
      rank: 1,
      intensity: 1,
      value: 87,
      value_display: '87 則',
      legislator: { id: 'LY-00001', name: '測試委員甲', party: '測試政黨A', area_name: '測試選區', region: '測試縣', photo_url: '' },
      detail: { label: '測試媒體', text: '測試標題一', url: 'https://example.com/1' },
    },
    {
      rank: 2,
      intensity: 0.5,
      value: 43,
      value_display: '43 則',
      legislator: { id: 'LY-00002', name: '測試委員乙', party: '測試政黨B', area_name: '測試選區二', region: '測試市', photo_url: '' },
      detail: { label: '測試媒體二', text: '測試標題二', url: 'https://example.com/2' },
    },
  ],
};

console.log('\n— RankingBoardView —');
expectAll('ready 態畫出名次、姓名、數值與長條', render(createElement(RankingBoardView, { board: RANKING_BOARD, onOpenId: () => undefined })), [
  '新聞曝光排行',
  '測試委員甲',
  '測試委員乙',
  '87 則',
  '43 則',
  '第 1 名',
  '第 2 名',
  'width:100%',
  'width:50%',
  'https://example.com/1',
  'rel="noreferrer noopener"',
]);
expectNone('empty 態不塞任何委員，只給空狀態', render(createElement(RankingBoardView, { board: { ...RANKING_BOARD, items: [] }, onOpenId: () => undefined })), [
  '測試委員甲',
  '測試委員乙',
]);

console.log('\n— RankingsPage（自行抓資料，僅驗 loading 態）—');
expectAll('loading 態', render(createElement(RankingsPage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined })), [
  '排行榜',
  '近 7 天',
  '近 30 天',
  '近 90 天',
  '載入排行榜',
]);
expectNone('loading 態不該先畫出任何委員', render(createElement(RankingsPage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined })), [
  '測試委員甲',
]);

console.log('\n— 委員比較與立法流程 —');
expectAll('比較頁：未選委員時提示怎麼選，不先畫比較表', render(createElement(ComparePage, { refreshToken: 0, onOpenId: () => undefined })), [
  '委員比較',
  '還沒選委員',
  '選擇委員…',
]);
expectAll('流程條：交付審查走到第 2 步', render(createElement(BillStageBar, { status: '交付審查' })), [
  'aria-label="立法進度：委員會審查（2/5）"',
  'class="done"',
  'class="current"',
]);
expectAll('流程條：撤案標為中止', render(createElement(BillStageBar, { status: '撤案' })), ['stage-bar stopped', '已中止：撤案']);
check('流程條：未知狀態不畫', render(createElement(BillStageBar, { status: '交付查照' })) === '');

expectAll('預算頁：loading 態有類別、篩選與三個區塊骨架', render(createElement(BudgetPage, { refreshToken: 0, onOpenId: () => undefined })), [
  '預算審議',
  '讀取預算審議',
  '預算會議發言',
  '預算中心評估報告',
  'aria-label="審議狀態"',
]);

expectAll('總覽：loading 態有統計列、七張卡與各縣市區塊', render(createElement(DashboardPage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined })), [
  '總覽',
  '在職委員',
  '委員動態',
  '最新三讀',
  '預算審議最新進度',
  '預算中心報告',
  '各縣市最新動態',
  'href="/bills?status=%E4%B8%89%E8%AE%80"',
]);

/* 型別上的靜態斷言：確保測試替身符合 API 契約（不改 runtime 行為） */
const _typecheck: ChangesResponse | null = null;
void _typecheck;

console.log(`\n通過 ${passed} 項，失敗 ${failed} 項`);
if (failed > 0) process.exit(1);
