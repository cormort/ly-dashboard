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
import { FacetChips } from '../src/components/FacetChips';
import { Header } from '../src/components/Header';
import { MyAgencyPage } from '../src/pages/MyAgencyPage';
import { InfoTip } from '../src/components/InfoTip';
import { PAGE_HINTS } from '../src/lib/pageHints';
import { FundsPage } from '../src/pages/FundsPage';
import { LegislatorGrid } from '../src/components/LegislatorGrid';
import { SessionSelector } from '../src/components/SessionSelector';
import { Hemicycle, seatLayout } from '../src/components/Hemicycle';
import { HomePage } from '../src/pages/HomePage';
import { BillsPage } from '../src/pages/BillsPage';
import { SyncStatusBanner } from '../src/components/SyncStatusBanner';
import { RankingsPage, RankingBoardView } from '../src/pages/RankingsPage';
import { TopicsPanel, tagTier } from '../src/components/TopicsPanel';
import { ComparePage } from '../src/pages/ComparePage';
import { BudgetPage } from '../src/pages/BudgetPage';
import { DashboardPage } from '../src/pages/DashboardPage';
import { CommitteesPage } from '../src/pages/CommitteesPage';
import { pathFor, routeOf, type Route } from '../src/hooks/useRoute';
import { BillStageBar } from '../src/components/BillStage';
import { CountiesPage } from '../src/pages/CountiesPage';
import { CouncilPage, marginText, upgradedNotes } from '../src/pages/CouncilPage';
import { NewsPage } from '../src/pages/NewsPage';
import { WallCard } from '../src/pages/SocialWallPage';
import { FacebookEmbed } from '../src/components/FacebookEmbed';
import { embedButtonLabel, shouldMountEmbed } from '../src/lib/embedPolicy';
import { ChoroplethMap } from '../src/components/ChoroplethMap';
import { bbox, countyViewBoxFor } from '../src/components/TownMap';
import { resolveCounty } from '../src/pages/CountiesPage';
import { colorAt } from '../src/lib/colorScales';
import { readFileSync } from 'node:fs';

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
const dashboardHtml = render(createElement(App));
expectAll('預設首頁是總覽', dashboardHtml, ['立委觀測站', '總覽', '各縣市最新動態', 'aria-current="page"']);

(window as unknown as { location: { pathname: string } }).location.pathname = '/activity';
const homeHtml = render(createElement(App));
// 導覽改成兩層後：上層只有 5 個主題，子頁面（榜行榜／法案查詢…）改放在對應主題的次級導覽
expectAll('最近動態（/activity）：站名、導覽、動態／議題／新聞骨架', homeHtml, [
  '立委觀測站',
  '關鍵字搜尋立法委員',
  '最近動態',
  '委員',
  '議事',
  '機關／基金',
  'aria-current="page"',
  '讀取委員動態',
  '讀取議題',
  '讀取新聞',
]);
// 只看最上層導覽（<nav aria-label="主要頁面">）；子頁面屬於第二層 subnav，在所屬主題的頁面上本來就會出現
const topNav = homeHtml.match(/<nav aria-label="主要頁面">([\s\S]*?)<\/nav>/)?.[1] ?? '';
expectNone('最上層導覽不該再把所有子頁面平鋪出來', topNav, ['排行榜', '法案查詢', '委員比較', '最近動態', '機關首長新聞']);
check('首頁初始不顯示任何委員', !homeHtml.includes('查看檔案'));
// 上層導覽順序（機關首長視角）：總覽 → 我的機關 → 議事 → 委員 → 議員 → 縣市地圖 → 新聞 → 機關／基金；
// 最近動態收進「委員」，首長新聞收進「新聞」，議員（2026-10-04 起）與縣市縣市地圖分析（2026-10-05 起）各自成一個頁籤
check(
  '上層導覽的順序是 總覽→我的機關→議事→委員→議員→縣市地圖→新聞→機關／基金',
  (() => {
    const nav = dashboardHtml.match(/<nav aria-label="主要頁面">([\s\S]*?)<\/nav>/)?.[1] ?? '';
    const labels = [...nav.matchAll(/>([^<>]+)<\/a>/g)].map((m) => m[1].trim()).filter(Boolean);
    return labels.join('→') === '總覽→我的機關→議事→委員→議員→縣市地圖→新聞→機關／基金';
  })(),
);
check('不含示範／假資料字串', !/甲黨|示範資料|林怡安|陳宏宇|乙黨/.test(homeHtml));
check('/funds、/agencies、/foundations、/administrative 各對應一頁', routeOf('/funds') === 'funds' && routeOf('/agencies') === 'agencies' && routeOf('/foundations') === 'foundations' && routeOf('/administrative') === 'administrative' && routeOf('/dgbas') === 'dgbas');
check('/activity 對應最近動態、舊網址 /dashboard 仍是總覽', routeOf('/activity') === 'home' && routeOf('/dashboard') === 'dashboard' && routeOf('/') === 'dashboard');

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

console.log('\n— 委員 › 粉專牆 —');
check(
  '/legislators/wall 對應粉專牆（不被 /legislators 吃掉）',
  routeOf('/legislators/wall') === 'socialwall' && routeOf('/legislators') === 'legislators' && pathFor('socialwall') === '/legislators/wall',
);
(window as unknown as { location: { pathname: string } }).location.pathname = '/legislators/wall';
const wallHtml = render(createElement(App));
expectAll('粉專牆頁：站名、子頁籤高亮、載入狀態', wallHtml, [
  '立委觀測站',
  '粉專牆',
  'aria-current="page"',
  '載入粉專牆',
]);
// 注意：頁面說明（ⓘ）本身就會出現「看貼文」「委員檔案」等字，所以只能用卡片專屬的標記來驗
check(
  '粉專牆：未取得資料前不編造任何一張卡（沒有卡片骨架、沒有嵌入框）',
  !wallHtml.includes('fb-embed') && !wallHtml.includes('粉專：') && !wallHtml.includes('堅持正向選舉'),
);
// 嵌入框是按需載入的：沒展開時不得出現 iframe，展開了才出現 Facebook 的 plugin URL
const wallItem = {
  id: '00014',
  name: '吳思瑤',
  party: '民主進步黨',
  region: '臺北市',
  area_name: '臺北市第1選舉區',
  photo_url: null,
  page_name: '吳思瑤',
  url: 'https://www.facebook.com/taipeineedyou',
  latest_post_date: '2026-09-27',
  latest_post_summary: '堅持正向選舉、不贊成選戰負面操作',
  source: 'sheet' as const,
};
const wallCardClosed = render(createElement(WallCard, { item: wallItem, onOpenId: () => undefined }));
expectAll('粉專牆卡片：黨籍短名、選區、粉專名稱、貼文日期與摘要', wallCardClosed, [
  '吳思瑤',
  '民進黨',
  '臺北市第1選舉區',
  '粉專：吳思瑤',
  'dateTime="2026-09-27"',
  '堅持正向選舉',
  'aria-expanded="false"',
  '委員檔案',
]);
// server render 不執行 useEffect，所以這裡看到的是「還沒捲進畫面」的狀態：
// 不得有 iframe，但要先把嵌入框的位置佔好（載入時瀑布流才不會跳）
expectNone('粉專牆卡片：還沒捲進畫面時不載入 Facebook 嵌入框（iframe 不出現，佔位不算）', wallCardClosed, ['<iframe', 'plugins/page.php']);
expectAll('粉專牆卡片：嵌入框先佔好位置，捲到才載入', wallCardClosed, ['fb-embed-slot', '捲到這裡就會載入 Facebook 貼文']);
// 自動載入的規則抽成純函式，直接驗真值表（不受 server render 不跑 effect 的限制）
check(
  '嵌入框載入規則：捲進畫面→載入；按過「收起」→不載入；手動按「看貼文」→載入',
  shouldMountEmbed({ collapsed: false, inView: true, forced: false }) === true &&
    shouldMountEmbed({ collapsed: false, inView: false, forced: false }) === false &&
    shouldMountEmbed({ collapsed: false, inView: false, forced: true }) === true &&
    shouldMountEmbed({ collapsed: true, inView: true, forced: false }) === false &&
    shouldMountEmbed({ collapsed: true, inView: true, forced: true }) === false,
);
check('嵌入框按鈕文字：掛上去＝可以收起、還沒掛＝看貼文', embedButtonLabel(true) === '收起貼文' && embedButtonLabel(false) === '看貼文');
// 嵌入框掛上去之後的內容（iframe 只在 mounted 時出現，所以直接驗元件）
expectAll('嵌入框：連到 Facebook 官方的粉專 plugin URL、lazy 載入', render(createElement(FacebookEmbed, { url: wallItem.url, name: wallItem.name })), [
  'fb-embed',
  'plugins/page.php',
  'taipeineedyou',
  'loading="lazy"',
]);
expectAll('粉專牆卡片：沒有貼文日期時明講，不會填上今天的日期', render(createElement(WallCard, { item: { ...wallItem, latest_post_date: null, latest_post_summary: '' } })), [
  '整理表還沒有這一位的貼文日期',
]);
(window as unknown as { location: { pathname: string } }).location.pathname = '/';


console.log('\n— 我的機關 —');
check('/my 對應我的機關頁', routeOf('/my') === 'my' && routeOf('/my?agency=%E8%B2%A1%E6%94%BF%E9%83%A8') === 'my');
const myAgencyHtml = render(createElement(MyAgencyPage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined }));
// 沒選過機關時預設載入行政院主計總處（不再有「尚未選機關」狀態）；有輸入清單可更換，已是預設就不顯示「回到」按鈕
expectAll('我的機關：預設載入行政院主計總處', myAgencyHtml, ['<h1>行政院主計總處</h1>', '讀取「行政院主計總處」', '更換機關', 'list="agency-options"', 'id="agency-options"', '主計總處專頁']);
expectNone('我的機關：已是預設機關時沒有「取消選擇」或「回到」按鈕', myAgencyHtml, ['取消選擇', '回到行政院主計總處']);
// 我的機關的分區依首長與幕僚使用頻率：會議與備詢 → 誰在關注 → 新聞 → 預算與法案（只有資料到了才會渲染，這裡驗原始碼順序）
check(
  '我的機關：分區順序是 會議與備詢→誰在關注→新聞→預算與法案，統計卡是可跳到分區的連結',
  (() => {
    const src = readFileSync(new URL('../src/pages/MyAgencyPage.tsx', import.meta.url), 'utf8');
    const order = ['my-meetings', 'my-watchers', 'my-news', 'my-budget'].map((id) => src.indexOf(`aria-labelledby="${id}"`));
    return order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])) && src.includes('className="stat-tile" href={`#${t.id}`}');
  })(),
);
// 「機關」頁與「我的機關」互相連結
expectAll('我的機關連到機關頁', myAgencyHtml, ['href="/agencies"', '機關頁']);
{
  const win = window as unknown as { location: { pathname: string; search: string } };
  const saved = win.location.search;
  const fundsProps = { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined };
  win.location.search = '?fund=%E8%B2%A1%E6%94%BF%E9%83%A8'; // 財政部
  const agencyWithFund = render(createElement(FundsPage, { ...fundsProps, type: 'agency' }));
  expectAll('機關頁選了某機關：出現「在我的機關查看」連結', agencyWithFund, ['在「我的機關」查看財政部', 'href="/my?agency=%E8%B2%A1%E6%94%BF%E9%83%A8"']);
  expectNone('基金頁不顯示（只有機關才有「我的機關」）', render(createElement(FundsPage, { ...fundsProps, type: 'fund' })), ['在「我的機關」查看']);
  expectNone('沒有 onNavigate 就不顯示', render(createElement(FundsPage, { refreshToken: 0, onOpenId: () => undefined, type: 'agency' })), ['在「我的機關」查看']);
  win.location.search = '';
  expectNone('機關頁沒選機關：不顯示', render(createElement(FundsPage, { ...fundsProps, type: 'agency' })), ['在「我的機關」查看']);
  win.location.search = saved;
}

console.log('\n— FacetChips —');
const facets = Array.from({ length: 30 }, (_, i) => ({ name: `單位${i + 1}`, count: 100 - i }));
const facetHtml = render(createElement(FacetChips, { items: facets, label: '最常出現的機關', onPick: () => undefined }));
expectAll('預設只顯示前 12 個，其餘收在「更多 18」', facetHtml, ['單位1 ', '單位12 ', '更多 18', 'aria-expanded="false"']);
expectNone('收合時不顯示第 13 個之後', facetHtml, ['單位13 ', '單位30 ']);
expectNone('標籤不多於上限時不出現「更多」', render(createElement(FacetChips, { items: facets.slice(0, 10), label: 'x', onPick: () => undefined })), ['更多', 'facet-toggle']);
expectNone('沒有項目時整塊不畫', render(createElement(FacetChips, { items: [], label: 'x', onPick: () => undefined })), ['law-facets']);

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
// 主計總處移出「機關／基金」頁籤；它的網址仍在，高亮歸「我的機關」
const orgsHeader = render(createElement(Header, { ...headerProps, route: 'funds' as const }));
expectNone('機關／基金的頁籤不再有行政院主計總處', orgsHeader, ['行政院主計總處']);
expectAll('機關／基金的頁籤仍有基金、機關、財團法人、行政法人', orgsHeader, ['基金', '機關', '財團法人', '行政法人']);
check(
  '/dgbas 仍可開啟，導覽高亮「我的機關」',
  routeOf('/dgbas') === 'dgbas' && /aria-current="page"[^>]*>我的機關</.test(render(createElement(Header, { ...headerProps, route: 'dgbas' as const }))),
);

// 子頁也依首長與幕僚的使用頻率排，主題的預設頁就是第一個子頁
check(
  '子頁順序：議事 預算→委員會→法案、新聞 首長→機關→委員→全部、機關／基金 機關在前，議員自成一個頁籤（總覽→近期動態），縣市地圖獨立成「縣市地圖」',
  (() => {
    const subOf = (route: Route) => {
      const sub = render(createElement(Header, { ...headerProps, route })).match(/<nav class="subnav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
      return [...sub.matchAll(/>([^<>]+)<\/a>/g)].map((m) => m[1].trim()).join('→');
    };
    const top = render(createElement(Header, { ...headerProps, route: 'dashboard' as const })).match(/<nav aria-label="主要頁面">([\s\S]*?)<\/nav>/)?.[1] ?? '';
    return (
      subOf('budget') === '預算審議→委員會→法案查詢' &&
      subOf('officials') === '機關首長新聞→機關新聞→委員新聞→全部新聞' &&
      subOf('agencies') === '機關→基金→財團法人→行政法人' &&
      subOf('legislators') === '委員查詢→粉專牆→最近動態→排行榜→委員比較' &&
      // 議員自成一個頁籤，子頁是總覽（選舉結果）與近期動態（新聞＋臉書）；委員的次級導覽不該再出現「議員」
      subOf('council') === '總覽→近期動態' &&
      subOf('councilactivity') === '總覽→近期動態' &&
      !subOf('legislators').includes('議員') &&
      // 縣市地圖是單頁主題：沒有次級導覽
      subOf('counties') === '' &&
      ['href="/budget"', 'href="/officials"', 'href="/agencies"', 'href="/council"', 'href="/counties"'].every((h) => top.includes(h))
    );
  })(),
);

// 功能說明掛在分頁導覽上：單頁主題（總覽）在頂層導覽、有子頁的主題在次級導覽那一列右端
console.log('\n— 導覽列上的說明提示 —');
const hintOf = (html: string, where: 'top' | 'sub') => {
  const m = where === 'top' ? html.match(/<nav aria-label="主要頁面">([\s\S]*?)<\/nav>/) : html.match(/<div class="subnav-row">([\s\S]*)$/);
  return m?.[1] ?? '';
};
const dashHeader = render(createElement(Header, { ...headerProps, route: 'dashboard' as const }));
expectAll('總覽（單頁主題）：說明在頂層導覽，預設不展開', hintOf(dashHeader, 'top'), ['role="tooltip"', PAGE_HINTS.dashboard!.slice(0, 12), 'class="info-tip"']);
expectNone('總覽：沒有次級導覽那一列', dashHeader, ['subnav-row']);
const billsHeader = render(createElement(Header, { ...headerProps, route: 'bills' as const }));
expectAll('法案查詢（有子頁的主題）：說明在次級導覽那一列右端', hintOf(billsHeader, 'sub'), ['role="tooltip"', '本屆委員提案', 'info-wrap end']);
expectNone('法案查詢：頂層導覽裡沒有說明（不重複）', hintOf(billsHeader, 'top'), ['role="tooltip"']);
expectNone('委員查詢沒有說明條目：不顯示 ⓘ', render(createElement(Header, { ...headerProps, route: 'legislators' as const })), ['role="tooltip"', 'info-button']);
expectNone('/dgbas 不顯示說明（它不在任何分頁上）', render(createElement(Header, { ...headerProps, route: 'dgbas' as const })), ['role="tooltip"']);
check('說明條目只對應存在的頁面，且不含 legislators／dgbas', (() => {
  const keys = Object.keys(PAGE_HINTS);
  return keys.length >= 14 && !keys.includes('legislators') && !keys.includes('dgbas') && keys.every((k) => (PAGE_HINTS as Record<string, string>)[k].length > 10);
})());
const tipHtml = render(createElement(InfoTip, null, '說明文字'));
expectAll('InfoTip：提示文字在 DOM 裡但預設不展開', tipHtml, ['aria-label="這個頁面的說明"', 'aria-expanded="false"', 'role="tooltip"', '說明文字', 'class="info-tip"']);
check('InfoTip：aria-describedby 指向提示（讀螢幕程式讀得到）', (() => {
  const id = tipHtml.match(/aria-describedby="([^"]+)"/)?.[1];
  return Boolean(id) && tipHtml.includes(`id="${id}"`);
})());
expectAll('顯示資料來源與資料截至時間', render(createElement(Header, headerProps)), [
  '立法院開放資料',
  '資料截至 2026/09/30',
]);
// L6：同步面板是條件式 render，aria-controls 不能指向不存在的元素
expectNone('面板不存在時，aria-controls 不該指向空號', render(createElement(Header, headerProps)), ['aria-controls="sync-panel"']);
expectAll('同步中：按鈕停用並顯示進度', render(createElement(Header, { ...headerProps, refreshing: true, syncMessage: '同步中…（已完成 2 個來源）' })), [
  '同步中…（已完成 2 個來源）',
  'aria-label="同步更新中…"',
  'disabled',
]);
expectAll('頁首有字體大小調整（縮小／放大／目前百分比）', render(createElement(Header, headerProps)), [
  'font-size-control',
  'aria-label="縮小字體"',
  'aria-label="放大字體"',
  '100%',
]);
expectAll('閒置時按鈕是「更新資料」', render(createElement(Header, headerProps)), ['aria-label="更新資料"']);
expectAll('同步失敗訊息帶 error 樣式', render(createElement(Header, { ...headerProps, syncMessage: '1 個資料來源同步失敗，保留舊資料', syncTone: 'error' })), [
  'sync-progress error',
  '1 個資料來源同步失敗',
]);
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
{
  const DetailComponent = (await import('../src/components/LegislatorDetail')).LegislatorDetail;
  const withFreshness = (stale: boolean) =>
    render(
      createElement(DetailComponent, {
        legislator: LEGISLATOR,
        onClose: () => undefined,
        tracked: false,
        onToggleTrack: () => undefined,
        source: META.source,
        sessionLabel: (id: string) => id,
        onOpenId: () => undefined,
        onCompare: () => undefined,
        socialFreshness: { as_of: '2026-09-27', age_days: stale ? 12 : 1, stale, stale_days: 7 },
      }),
    );
  const fresh = withFreshness(false);
  const old = withFreshness(true);
  check('詳情側欄：最新貼文旁標整理表資料截至哪天', fresh.includes('整理表資料截至 2026-09-27') && !fresh.includes('沒更新'));
  check('詳情側欄：整理表過期時提醒、引導看嵌入貼文', old.includes('整理表已 12 天沒更新') && old.includes('看貼文'));
}
check('詳情側欄：臉書帳號旁有「看貼文」（官方嵌入框點了才載入，預設不載入）', detailHtml.includes('看貼文') && !detailHtml.includes('facebook.com/plugins/page.php'));
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
expectAll('比較頁：未選委員時提示怎麼選，不先畫比較表', render(createElement(ComparePage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined })), [
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

expectAll('委員會頁：loading 態有標題與讀取提示', render(createElement(CommitteesPage, { refreshToken: 0, onOpenId: () => undefined })), ['委員會', '讀取委員會動態']);
check('/committees 對應委員會頁', routeOf('/committees') === 'committees');
// 委員會頁有自己的關鍵字搜尋（我的機關以機關全名＋簡稱連過來），頁首就不再放委員搜尋，免得兩個搜尋框混淆
{
  const win = window as unknown as { location: { search: string } };
  const saved = win.location.search;
  win.location.search = '?q=' + encodeURIComponent('行政院主計總處 主計總處');
  expectAll('委員會頁：網址帶 q 時搜尋框帶入關鍵字', render(createElement(CommitteesPage, { refreshToken: 0, onOpenId: () => undefined })), [
    'aria-label="搜尋會議、機關回覆與會議紀錄"',
    'value="行政院主計總處 主計總處"',
  ]);
  win.location.search = saved;
}
expectNone('委員會頁：頁首不放委員搜尋', render(createElement(Header, { ...headerProps, route: 'committees' as const })), ['關鍵字搜尋立法委員']);

const dashboardLoading = render(createElement(DashboardPage, { refreshToken: 0, onOpenId: () => undefined, onNavigate: () => undefined }));
expectAll('總覽：loading 態有統計列、焦點卡與各區塊骨架', dashboardLoading, [
  '總覽',
  '首長新聞（近 7 天）',
  'href="/officials"',
  '最新動態',
  '最新三讀',
  '預算審議最新進度',
  '預算中心報告',
  '委員會會議紀錄',
  '各縣市最新動態',
  'href="/bills?status=%E4%B8%89%E8%AE%80"',
]);
// 總覽依首長關心的順序：我的機關摘要 → 議事 → 新聞 → 委員；並有「機關首長新聞」卡
check(
  '總覽：最上方是我的機關摘要（預設主計總處），分區順序是 議事→新聞→委員',
  (() => {
    const heads = [...dashboardLoading.matchAll(/<h2 id="dash-(\w+)">/g)].map((m) => m[1]).join('→');
    const strip = dashboardLoading.indexOf('aria-label="我的機關"');
    return (
      heads === 'agenda→news→members' &&
      dashboardLoading.includes('aria-label="機關首長新聞"') &&
      strip > 0 &&
      strip < dashboardLoading.indexOf('id="dash-agenda"') &&
      dashboardLoading.includes('行政院主計總處') &&
      dashboardLoading.includes('前往我的機關')
    );
  })(),
);
check(
  '總覽：議事區的卡片順序是 預算審議→預算中心報告→委員會→法案→三讀',
  (() => {
    const agenda = dashboardLoading.split('id="dash-news"')[0];
    const order = ['預算審議最新進度', '預算中心報告', '委員會會議紀錄', '法案最新進度', '最新三讀'].map((t) => agenda.indexOf(`aria-label="${t}"`));
    return order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]));
  })(),
);
// 頁面不再有重複分頁名稱的標題列與介紹段落：標題只留給讀螢幕程式，說明改掛在導覽列（見 Header 的測試）
expectAll('總覽：標題只給讀螢幕程式', dashboardLoading, ['<h1 class="sr-only">總覽</h1>']);
expectNone('總覽：沒有標題列、介紹段落或頁內提示', dashboardLoading, ['class="page-head"', 'class="page-lead"', 'role="tooltip"']);
// 各縣市改成預設收合的 disclosure：25 張卡片不再一次攤開
check(
  '總覽：各縣市動態是預設收合的 <details>',
  dashboardLoading.includes('regions-details') && !/<details[^>]*regions-details[^>]*\sopen/.test(dashboardLoading),
);

/* ------------------------------ 熱門議題（本次強化） ------------------------------ */

console.log('\n— 熱門議題 —');
expectAll(
  'loading 態有標題與三組控制（區間／詞彙／檢視）',
  render(createElement(TopicsPanel, { refreshToken: 0, onNavigate: () => undefined })),
  ['熱門議題', '本屆', '90 天', '30 天', '7 天', '法律名稱', '議案類別', '委員會', '長條', '標籤', '讀取議題'],
);
check('三段字級的規則固定（前 1/3 大、中 1/3 中、其餘小）', (() => {
  const tiers = Array.from({ length: 9 }, (_, i) => tagTier(i, 9));
  return tiers.join(',') === 'lg,lg,lg,md,md,md,sm,sm,sm';
})());

/* ---------------------- 縣市／新聞（新增頁面，先前 0 覆蓋） ---------------------- */

console.log('\n— 縣市與新聞 —');
expectAll(
  '縣市頁：loading 態有讀取提示（不先畫任何縣市資料）',
  render(createElement(CountiesPage, { refreshToken: 0, onOpenId: () => undefined })),
  ['載入縣市資料'],
);
expectAll(
  '新聞頁：loading 態有讀取提示（不先畫任何新聞）',
  render(createElement(NewsPage, { refreshToken: 0, onOpenId: () => undefined })),
  ['讀取中'],
);
check('/counties 對應縣市頁', routeOf('/counties') === 'counties');
expectAll('議員頁：loading 態有讀取提示（不先畫任何議員資料）', render(createElement(CouncilPage, { refreshToken: 0 })), ['載入議員選舉資料']);
check('/council 對應議員頁', routeOf('/council') === 'council');
check('/council/activity 對應議員近期動態（不被 /council 吃掉）', routeOf('/council/activity') === 'councilactivity');
check(
  '議員頁：落選頭差距——一般情形印「差 N 票」，保障名額造成負差距時改講「多 N 票」，不印負號',
  marginText({ first_loser: { name: '甲', party: '無黨籍', votes: 9000, pct: 10, margin: 1234 } }) === '｜落選頭 甲（9,000 票，差 1,234 票）' &&
    marginText({ first_loser: { name: '林竹旺', party: '無黨籍', votes: 8000, pct: 9, margin: -534 } }) === '｜落選頭 林竹旺（8,000 票，比婦女保障名額當選人多 534 票）' &&
    marginText({ first_loser: { name: '乙', party: '無黨籍', votes: 1, pct: 1, margin: null } }) === '｜落選頭 乙（1 票，差 — 票）' &&
    marginText({ first_loser: null }) === '',
);
check(
  '議員頁：升格前那一屆要講清楚是哪一個議會（桃園 2009 是桃園縣議會，不是桃園市議會）',
  (() => {
    const terms = [
      { year: 2022, label: '第3屆', body: '桃園市議會' },
      { year: 2009, label: '桃園縣第17屆', body: '桃園縣議會' },
    ];
    const notes = upgradedNotes('桃園市', terms);
    return (
      notes.length === 1 &&
      notes[0] === '2009 年投票時還沒有桃園市議會，那一屆是桃園縣議會（桃園縣第17屆）。' &&
      // 六都裡只有桃園有升格前的資料；其他縣市不可冒出這個提示
      upgradedNotes('新北市', [{ year: 2010, label: '第1屆', body: '新北市議會' }]).length === 0
    );
  })(),
);
check('/news 對應新聞頁', routeOf('/news') === 'news');
check('/news/agencies 對應機關新聞頁（不被 /news 吃掉）', routeOf('/news/agencies') === 'agencynews');
check('/news/all 對應全部新聞頁（不被 /news 吃掉）', routeOf('/news/all') === 'allnews' && pathFor('allnews', { q: '預算' }) === '/news/all?q=%E9%A0%90%E7%AE%97');
check('/officials 對應機關首長新聞頁', routeOf('/officials') === 'officials');

/* 面量圖的邊界值：values 可能是空的、可能混到 undefined（Map 取值沒有鍵時），
   這時 Math.min(...[]) 會是 Infinity、Math.max 會是 -Infinity，色階算出來是 NaN。
   NaN 進到 CSS fill 會被瀏覽器忽略 → 整張圖沒有顏色，而且不會有任何錯誤訊息。 */
console.log('\n— 面量圖邊界 —');
const MAP_ITEMS = [
  { county: '甲縣', path: 'M0 0 L1 1 Z' },
  { county: '乙縣', path: 'M2 2 L3 3 Z' },
];
const mapFormat = (v: number | null) => (v === null ? '—' : String(v));
const renderMap = (values: Map<string, number | null>) =>
  render(createElement(ChoroplethMap, { items: MAP_ITEMS, values, scale: 'YlOrRd' as const, title: '測試面量圖', format: mapFormat }));

for (const [label, values] of [
  ['全部有值', new Map<string, number | null>([['甲縣', 1], ['乙縣', 2]])],
  ['全部 null', new Map<string, number | null>([['甲縣', null], ['乙縣', null]])],
  ['空 map', new Map<string, number | null>()],
  ['含 undefined', new Map<string, number | null>([['甲縣', 1], ['乙縣', undefined as unknown as number]])],
  ['只有 undefined', new Map<string, number | null>([['甲縣', undefined as unknown as number]])],
  ['單一值', new Map<string, number | null>([['甲縣', 5]])],
  ['發散色階＋全 null', new Map<string, number | null>([['甲縣', null]])],
]) {
  const html = renderMap(values);
  check(`面量圖（${label}）不可產生 NaN／Infinity`, !/NaN|Infinity/.test(html));
}
check(
  '面量圖：null 的區塊用「無資料」底色，不硬套色階',
  renderMap(new Map<string, number | null>([['甲縣', null], ['乙縣', 2]])).includes('var(--seat-off)'),
);

/* ------------------- 縣市頁／鄉鎮地圖的邊界（第三輪複審抓到） ------------------- */

console.log('\n— 縣市縮放與參數解析 —');

// C1：縣市縮放框要用「縣市輪廓」，不是該縣市所有鄉鎮的 bbox。
// 旗津區（東沙／南沙）、頭城鎮（釣魚台）、烈嶼鄉、中正區的離島多邊形會把鄉鎮 bbox 撐到畫布外，
// 高雄市／宜蘭縣／基隆市／金門縣會縮成一個小點（實測放大 3–8 倍）。用真實資料當回歸測試。
const townMapData = JSON.parse(readFileSync(new URL('../../server/town-map.json', import.meta.url), 'utf8'));
const countyStatsData = JSON.parse(readFileSync(new URL('../../server/county-stats.json', import.meta.url), 'utf8'));
// 元件收到的是 API 形狀（items），不是資料檔的原始形狀（counties）
const countiesAsApi = { items: countyStatsData.counties };
const boxWidth = (box: string | undefined) => (box ? Number(box.split(' ')[2]) : NaN);
for (const name of ['高雄市', '宜蘭縣', '基隆市', '金門縣']) {
  // 測的是元件真正用的那個函式（不是自己重算一次），否則測不到「用輪廓還是用鄉鎮」的選擇
  const actual = countyViewBoxFor(countiesAsApi, name);
  const towns = bbox(townMapData.towns.filter((t: { county: string }) => t.county === name).map((t: { path: string }) => t.path));
  check(
    `縣市縮放（${name}）：要用縣市輪廓，不可被離島鄉鎮撐壞`,
    Number.isFinite(boxWidth(actual)) && boxWidth(actual) < 400 && boxWidth(towns) > boxWidth(actual) * 2,
    `元件用 ${boxWidth(actual)}、離島鄉鎮框 ${boxWidth(towns)}`,
  );
}
check('縣市縮放：找不到該縣市時回 undefined（不是無效的 Infinity viewBox）', countyViewBoxFor(countiesAsApi, '不存在的縣市') === undefined);
check('bbox([]) 不可回 Infinity（那是無效的 viewBox）', bbox([]) === undefined);
check('bbox(沒有座標的字串) 回 undefined', bbox(['not a path']) === undefined);
check('bbox(單一路徑) 回四段數字', /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(bbox(['M10 20 L30 40 Z']) ?? ''));

// C2：?county= 查不到要回 null，讓畫面顯示「找不到縣市」，不要靜默用第一筆
const sampleCounties = [{ county: '基隆市' }, { county: '臺北市' }];
check('resolveCounty：查得到就回該筆', resolveCounty(sampleCounties, '臺北市')?.county === '臺北市');
check('resolveCounty：原住民的 region 不是縣市名 → null', resolveCounty(sampleCounties, '山地原住民') === null);
check('resolveCounty：空字串／null → null', resolveCounty(sampleCounties, '') === null && resolveCounty(sampleCounties, null) === null);

// C4：?scale= 是任意字串，未知色階不可以丟例外（會讓整頁被 ErrorBoundary 蓋掉）
let scaleThrew = false;
let fallbackColor = '';
try {
  fallbackColor = colorAt('Nope' as never, 0.5);
} catch {
  scaleThrew = true;
}
check('colorAt：未知色階落回預設，不丟例外', !scaleThrew && /^rgb\(/.test(fallbackColor), fallbackColor);
check('colorAt：NaN 的 t 也回合法顏色', /^rgb\(/.test(colorAt('Blues', NaN)));

/* 型別上的靜態斷言：確保測試替身符合 API 契約（不改 runtime 行為） */
const _typecheck: ChangesResponse | null = null;
void _typecheck;

console.log(`\n通過 ${passed} 項，失敗 ${failed} 項`);
if (failed > 0) process.exit(1);
