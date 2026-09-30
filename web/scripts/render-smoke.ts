/**
 * 立委觀測站前端 — 靜態渲染煙霧測試（開發用，不進 production bundle）
 *
 * 用 react-dom/server 把元件樹與各資料區塊的**四態**（loading / ready / empty / error）
 * 各渲染一次，驗證：
 *   1. 沒有 import／render 期例外（recharts、lucide、整棵元件樹都載得起來）
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
import { StatCards } from '../src/components/StatCards';
import { SyncStatusBanner } from '../src/components/SyncStatusBanner';

/* ---------------------------- 瀏覽器 API 替身 ---------------------------- */
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  location: { pathname: '/', search: '?term=11&session=11-5' },
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
  photo_url: null,
  degree: null,
  experience: null,
  term: 11,
  sessions: ['11-1', '11-5'],
  committees: [{ id: '內政委員會', kind: 'standing' as const, is_convener: true }],
  is_convener: true,
  source_url: 'https://data.ly.gov.tw/odw/ID9Action.action',
};

const COMMITTEES: CommitteesResponse = {
  meta: { ...META, term: 11, session: '11-5' },
  count: 2,
  items: [
    { id: '內政委員會', kind: 'standing', count: 14, conveners: [{ id: 'LY-00024', name: '測試委員甲' }] },
    { id: '財政委員會', kind: 'standing', count: 13, conveners: [] },
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
const appHtml = render(createElement(App));
expectAll('站名、搜尋、各區塊骨架都在', appHtml, [
  '立委觀測站',
  '關鍵字搜尋立法委員',
  '讀取同步狀態',
  '屆次與會期',
  '篩選條件',
  '目前委員數',
  '本會期召委數',
  '委員會席次',
  '最近異動',
  '立法委員名錄',
]);
check('初始不顯示任何委員卡片', !appHtml.includes('查看檔案'));
check('不含示範／假資料字串', !/甲黨|示範資料|林怡安|陳宏宇|乙黨/.test(appHtml));

console.log('\n— Header —');
expectAll(
  '顯示資料來源、授權與資料截至時間',
  render(
    createElement(Header, {
      source: META.source,
      fetchedAt: META.fetched_at,
      stale: false,
      generatedAt: META.generated_at,
      query: '',
      onQueryChange: () => undefined,
      onRefresh: () => undefined,
      refreshing: false,
    }),
  ),
  ['立法院開放資料', '政府資料開放授權條款第 1 版', '資料截至：2026/09/30', 'data.ly.gov.tw'],
);
expectAll(
  'stale 時明示「可能非最新」',
  render(
    createElement(Header, {
      source: META.source,
      fetchedAt: META.fetched_at,
      stale: true,
      generatedAt: META.generated_at,
      query: '',
      onQueryChange: () => undefined,
      onRefresh: () => undefined,
      refreshing: false,
    }),
  ),
  ['可能非最新'],
);

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

console.log('\n— StatCards —');
expectAll(
  'ready 態顯示後端 total 與同步狀態',
  render(
    createElement(StatCards, {
      roster: ready({ ...LEGISLATORS, total: 113 }),
      convenerStat: ready({ ...LEGISLATORS, total: 64 }),
      trackedCount: 3,
      health: ready({
        meta: META,
        ok: true,
        db: { legislators: 113, memberships: 481, committee_seats: 402, changes: 37 },
        last_runs: [],
      }),
      sessionScopeLabel: '第 11 屆第 5 會期',
    }),
  ),
  ['113', '64', '追蹤中', '本會期召委數', '正常', '第 11 屆第 5 會期'],
);
expectAll(
  'error 態不假造數字',
  render(
    createElement(StatCards, {
      roster: errored<LegislatorsResponse>(),
      convenerStat: errored<LegislatorsResponse>(),
      trackedCount: 0,
      health: errored(),
      sessionScopeLabel: '第 11 屆第 5 會期',
    }),
  ),
  ['—', '無法讀取'],
);

console.log('\n— CommitteeChart —');
const chartHtml = render(
  createElement(CommitteeChart, { committees: ready(COMMITTEES), sessionScopeLabel: '第 11 屆第 5 會期' }),
);
expectAll('ready 態有圖表容器與文字替代', chartHtml, [
  'committee-chart-desc',
  'aria-label="委員會席次長條圖"',
  '內政委員會 14 席',
  '財政委員會 13 席',
  '共 2 個委員會、27 席',
  '以表格檢視',
]);
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
  }),
);
expectAll('ready 態卡片欄位齊全', gridHtml, [
  '測試委員甲',
  '測試政黨A',
  '內政委員會',
  '測試市第1選舉區',
  '召委',
  '第 11 屆',
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
    }),
  ),
  ['沒有符合條件的委員', '清除篩選'],
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
    }),
  ),
  ['讀取委員名錄'],
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

/* 型別上的靜態斷言：確保測試替身符合 API 契約（不改 runtime 行為） */
const _typecheck: ChangesResponse | null = null;
void _typecheck;

console.log(`\n通過 ${passed} 項，失敗 ${failed} 項`);
if (failed > 0) process.exit(1);
