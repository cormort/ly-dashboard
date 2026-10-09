/**
 * 立委觀測站前端 — 邏輯煙霧測試（開發用，不進 production bundle）
 *
 * 目的：在後端（127.0.0.1:8787）尚未啟動的情況下，仍能驗證
 *   1. URL 篩選狀態的解析／序列化（可分享、可上一頁的前提）
 *   2. 屆次／會期語意（B4 缺陷的架構性防線）
 *   3. api/client 的請求 URL 與錯誤對應（含 4xx/5xx、非 JSON、逾時）
 *   4. 顯示層格式化（不改變資料本身）
 *
 * 這裡的 fetch 替身只回傳**測試替身**資料（測試委員甲／測試政黨A），
 * 檔名與內容都不會被打包（vite 只打包 src/），可用
 * `grep -r "測試委員甲" web/dist` 確認。
 *
 * 執行：node scripts/smoke.ts   （或 npx --yes tsx scripts/smoke.ts）
 */
import assert from 'node:assert/strict';
import {
  ApiError,
  apiRequest,
  buildUrl,
  fetchChanges,
  fetchCommittees,
  fetchHealth,
  fetchLegislators,
  fetchMeta,
  fetchSyncRuns,
  legislatorParams,
  startSync,
} from '../src/api/client.ts';
import { legislatorDetailUrl } from '../src/lib/legislators.ts';
import { billStage } from '../src/lib/billStage.ts';
import { MOBILE_MAX_WIDTH, scrollBehaviorFor, shouldScrollToDirectory } from '../src/lib/scroll.ts';
import { toCsv } from '../src/lib/csv.ts';
import { DEFAULT_FONT_SCALE_INDEX, FONT_SCALES, loadFontScaleIndex } from '../src/lib/fontScale.ts';
import { latestSessionId, sessionLabelIndex, sessionScopeLabel } from '../src/lib/sessions.ts';
import {
  ALL_SESSIONS,
  parseFilters,
  resetForSessionChange,
  resetForTermChange,
  serializeFilters,
  filtersEqual,
} from '../src/lib/urlState.ts';
import {
  shortCommittee,
  datasetLabel,
  formatChangeValue,
  formatDateTime,
  formatDay,
  text,
} from '../src/lib/format.ts';

/* ------------------------- 測試替身：API 回應 ------------------------- */

const TERMS = [
  {
    no: 11,
    sessions: [
      { id: '11-1', seq: 1, label: '第 11 屆第 1 會期' },
      { id: '11-5', seq: 5, label: '第 11 屆第 5 會期' },
    ],
  },
];

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
  committees: [{ id: '內政委員會', kind: 'standing', is_convener: true }],
  is_convener: true,
  source_url: 'https://data.ly.gov.tw/odw/ID9Action.action',
};

const ROUTES: Record<string, unknown> = {
  '/api/v1/health': {
    meta: META,
    ok: true,
    db: { legislators: 113, memberships: 481, committee_seats: 402, changes: 37 },
    last_runs: [
      { dataset: 'id9', status: 'success', finished_at: '2026-09-30T08:59:55.000Z', records: 113, attempt: 1, error: null },
    ],
  },
  '/api/v1/meta': {
    meta: META,
    terms: TERMS,
    current: { term: 11, session: '11-5' },
    counts: { terms: 1, sessions: 5 },
  },
  '/api/v1/committees': {
    meta: { ...META, term: 11, session: '11-5' },
    count: 2,
    items: [
      { id: '內政委員會', kind: 'standing', count: 14, conveners: [{ id: 'LY-00024', name: '測試委員甲' }] },
      { id: '財政委員會', kind: 'standing', count: 13, conveners: [] },
    ],
  },
  '/api/v1/legislators': {
    meta: { ...META, term: 11, session: '11-5' },
    count: 1,
    total: 1,
    items: [LEGISLATOR],
  },
  '/api/v1/changes': {
    meta: META,
    count: 1,
    items: [
      {
        id: 12,
        at: '2026-09-30T08:59:55.000Z',
        entity: 'committee_seat',
        entity_id: '11-5|內政委員會|LY-00024',
        field: 'is_convener',
        old_value: '0',
        new_value: '1',
      },
    ],
  },
  '/api/v1/sync-runs': {
    meta: META,
    count: 1,
    items: [
      { id: 2, dataset: 'id9', status: 'success', started_at: null, finished_at: null, records: 113, attempt: 1, http_status: 200, error: null, duration_ms: 1840, ua: 'ly-dashboard/1.0' },
    ],
  },
};

const seen: string[] = [];
/** 偶發失敗的替身計數器（測自動重試用） */
let flakyGets = 0;
let flakyPosts = 0;
const seenMethods: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    seenMethods.push(init?.method ?? 'GET');
    const { pathname } = new URL(url, 'http://stub.local');

    if (pathname === '/api/v1/boom') {
      return new Response(JSON.stringify({ error: { code: 'bad_request', message: '參數不正確' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (pathname === '/api/v1/not-json') {
      return new Response('<html>not json</html>', { status: 200 });
    }
    if (pathname === '/api/v1/never') {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (pathname === '/api/v1/flaky') {
      flakyGets += 1;
      // 模擬「偶發連不上／逾時」：第一次失敗，第二次成功
      if (flakyGets < 2) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: true, attempt: flakyGets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (pathname === '/api/v1/flaky-post') {
      flakyPosts += 1;
      throw new TypeError('Failed to fetch');
    }
    if (pathname === '/api/v1/sync') {
      return new Response(
        JSON.stringify({ accepted: true, started: true, scope: 'all', inflight_scope: 'all', message: '同步已在背景執行' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const body = ROUTES[pathname];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error: unknown) => {
      console.error(`FAIL  ${name}`);
      throw error;
    });
}

async function main(): Promise<void> {
  stubFetch();

  console.log('— URL 篩選狀態 —');
  await check('parse → serialize 來回一致（含 convener=1）', () => {
    const search = '?term=11&session=11-5&q=%E7%89%9B&party=%E4%B8%AD%E5%9C%8B%E5%9C%8B%E6%B0%91%E9%BB%A8&committee=%E5%85%A7%E6%94%BF%E5%A7%94%E5%93%A1%E6%9C%83&convener=1';
    const parsed = parseFilters(search);
    assert.equal(parsed.term, 11);
    assert.equal(parsed.session, '11-5');
    assert.equal(parsed.q, '牛');
    assert.equal(parsed.convener, true);
    assert.equal(serializeFilters(parsed), search);
  });
  await check('region（選區）可寫入並還原 URL', () => {
    const search = '?term=11&session=11-5&region=%E9%9B%B2%E6%9E%97%E7%B8%A3';
    const parsed = parseFilters(search);
    assert.equal(parsed.region, '雲林縣');
    assert.equal(serializeFilters(parsed), search);
    assert.equal(legislatorParams({ region: '  ' }).region, undefined);
    assert.equal(legislatorParams({ region: '雲林縣' }).region, '雲林縣');
  });
  await check('未指定的條件不會出現在 query string', () => {
    assert.equal(serializeFilters(parseFilters('')), '');
    assert.equal(parseFilters('').term, null);
    assert.equal(parseFilters('').convener, false);
  });
  await check('非數字屆次／未知參數被忽略，不會產生壞請求', () => {
    const parsed = parseFilters('?term=abc&session=&q=%20%20&evil=1');
    assert.equal(parsed.term, null);
    assert.equal(parsed.session, null);
    assert.equal(parsed.q, '');
    assert.equal(serializeFilters(parsed), '');
  });
  await check('切換屆次會清掉只對舊屆有意義的條件', () => {
    const before = parseFilters('?term=10&session=10-2&q=%E7%8E%8B&party=P&committee=C&convener=1');
    const after = resetForTermChange(before, 11, '11-5');
    assert.equal(after.term, 11);
    assert.equal(after.session, '11-5');
    assert.equal(after.party, null);
    assert.equal(after.committee, null);
    assert.equal(after.q, '王');
    assert.equal(after.convener, true);
    assert.equal(filtersEqual(after, before), false);
  });
  await check('H2：切換會期要清掉可能不存在於新會期的委員會條件', () => {
    // 修憲委員會只在第 3、5 會期存在；把它帶到第 4 會期會變成「篩選列顯示全部委員會卻 0 筆」
    const before = parseFilters('?term=11&session=11-5&committee=%E4%BF%AE%E6%86%B2%E5%A7%94%E5%93%A1%E6%9C%83&region=%E9%9B%B2%E6%9E%97%E7%B8%A3&q=%E7%8E%8B&convener=1&tracked=1');
    const after = resetForSessionChange(before, '11-4');
    assert.equal(after.session, '11-4');
    assert.equal(after.committee, null, '委員會條件必須清掉');
    assert.equal(after.region, '雲林縣', '選區各會期都存在，保留');
    assert.equal(after.party, before.party);
    assert.equal(after.q, '王');
    assert.equal(after.convener, true);
    assert.equal(after.tracked, true);
    assert.equal(after.term, 11);
  });

  console.log('— 屆次／會期語意（B4 防線）—');
  await check('latestSessionId 取 seq 最大的會期，且只在自己那一屆裡挑', () => {
    assert.equal(latestSessionId(TERMS[0]), '11-5');
    assert.equal(latestSessionId(undefined), null);
    assert.equal(latestSessionId({ no: 11, sessions: [] }), null);
  });
  await check('sessionScopeLabel 涵蓋 all／未指定／查不到標籤三種情況', () => {
    assert.equal(sessionScopeLabel(TERMS, 11, '11-5'), '第 11 屆第 5 會期');
    assert.equal(sessionScopeLabel(TERMS, 11, ALL_SESSIONS), '第 11 屆 全部會期');
    assert.equal(sessionScopeLabel(TERMS, 11, null), '第 11 屆 全部會期');
    assert.equal(sessionScopeLabel(TERMS, null, null), '未指定屆次');
    assert.equal(sessionScopeLabel(TERMS, 11, '99-9'), '第 11 屆（99-9）');
  });
  await check('sessionLabelIndex 只用 /meta 的標籤，不猜測', () => {
    const index = sessionLabelIndex(TERMS);
    assert.equal(index.get('11-1'), '第 11 屆第 1 會期');
    assert.equal(index.get('99-9'), undefined);
  });

  console.log('— 單一委員檔案的查詢網址 —');
  await check('H1：查單一委員一定要帶 session=all（否則離職委員永遠查不到）', () => {
    const url = legislatorDetailUrl('00084');
    assert.ok(url.includes('id=00084'), url);
    assert.ok(url.includes(`session=${ALL_SESSIONS}`), url);
    assert.ok(url.startsWith('/api/v1/legislators'), url);
  });

  console.log('— api/client —');
  await check('health 解析成功並保留 meta 欄位', async () => {
    const health = await fetchHealth();
    assert.equal(health.ok, true);
    assert.equal(health.db.legislators, 113);
    assert.equal(health.meta.stale, false);
    assert.equal(health.meta.source.license, '政府資料開放授權條款第 1 版');
  });
  await check('legislators 請求帶上屆次／會期／召委／上限', async () => {
    seen.length = 0;
    const result = await fetchLegislators({ term: 11, session: '11-5', convener: true, limit: 500 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.id, 'LY-00024');
    assert.equal(
      seen[0],
      '/api/v1/legislators?term=11&session=11-5&convener=1&limit=500',
      `實際請求：${seen[0]}`,
    );
  });
  await check('空字串／false 不會變成無效 query 參數', () => {
    const params = legislatorParams({ term: 11, q: '   ', party: '', convener: false });
    assert.equal(params.q, undefined);
    assert.equal(params.party, undefined);
    assert.equal(params.convener, undefined);
    assert.equal(buildUrl('/legislators', params), '/api/v1/legislators?term=11');
  });
  await check('committees 的 id 是乾淨名稱（無屆期前綴）', async () => {
    const result = await fetchCommittees({ term: 11, session: '11-5' });
    assert.equal(result.count, 2);
    for (const item of result.items) {
      assert.match(item.id, /委員會$/);
      assert.equal(/第\d+屆/.test(item.id), false, `委員會名稱含屆期前綴：${item.id}`);
      assert.equal(Number.isInteger(item.count) && item.count > 0, true);
    }
  });
  await check('changes 的 old/new value 與 entity_id 原樣呈現', async () => {
    const result = await fetchChanges({ limit: 50 });
    assert.equal(result.items[0]?.entity_id, '11-5|內政委員會|LY-00024');
    assert.equal(result.items[0]?.old_value, '0');
    assert.equal(result.items[0]?.new_value, '1');
  });
  await check('sync-runs 走 /api/v1/sync-runs（不是 /health 的 last_runs）', async () => {
    seen.length = 0;
    await fetchSyncRuns(50);
    assert.equal(seen[0], '/api/v1/sync-runs?limit=50');
  });
  await check('startSync 以 POST 打 /api/v1/sync，且其他請求維持 GET', async () => {
    seen.length = 0;
    seenMethods.length = 0;
    const result = await startSync();
    assert.equal(seen[0], '/api/v1/sync');
    assert.equal(seenMethods[0], 'POST');
    assert.equal(result.accepted, true);
    seenMethods.length = 0;
    await fetchSyncRuns(1);
    assert.equal(seenMethods[0], 'GET');
  });
  await check('字體倍率：沒有儲存值時回標準 100%，且倍率遞增', () => {
    assert.equal(FONT_SCALES[DEFAULT_FONT_SCALE_INDEX], 1);
    assert.equal(loadFontScaleIndex(), DEFAULT_FONT_SCALE_INDEX);
    assert.ok(FONT_SCALES.every((value, i) => i === 0 || value > FONT_SCALES[i - 1]));
  });
  await check('meta 的 current.session 可為 null 而不炸', async () => {
    const result = await fetchMeta();
    assert.equal(result.current.term, 11);
    assert.ok(result.current.session === null || typeof result.current.session === 'string');
  });
  await check('4xx 轉成 ApiError 並保留後端 error.code', async () => {
    await assert.rejects(
      () => apiRequest('/api/v1/boom'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'bad_request');
        assert.equal(error.status, 400);
        assert.match(error.message, /參數不正確/);
        return true;
      },
    );
    await assert.rejects(
      () => apiRequest('/api/v1/unknown'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'not_found');
        assert.equal(error.status, 404);
        assert.match(error.message, /no route/);
        return true;
      },
    );
  });
  await check('回應不是 JSON 時給出明確錯誤', async () => {
    await assert.rejects(
      () => apiRequest('/api/v1/not-json'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'bad_json');
        return true;
      },
    );
  });
  await check('連不上時會自動重試一次（第二次成功就當沒事，使用者看不到錯誤）', async () => {
    flakyGets = 0;
    const seenBefore = seen.length;
    const data = await apiRequest<{ ok: boolean; attempt: number }>('/api/v1/flaky');
    assert.equal(data.ok, true);
    assert.equal(flakyGets, 2, '第一次失敗、第二次才成功');
    assert.equal(seen.length - seenBefore, 2, '確實打了兩次');
  });
  await check('retries: 0 時不重試（要自己處理失敗的呼叫端用）', async () => {
    flakyGets = 0;
    await assert.rejects(
      () => apiRequest('/api/v1/flaky', { retries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'network_error');
        return true;
      },
    );
    assert.equal(flakyGets, 1, '只打一次');
  });
  await check('POST（手動同步）預設不重試，免得重複觸發', async () => {
    flakyPosts = 0;
    await assert.rejects(
      () => apiRequest('/api/v1/flaky-post', { method: 'POST' }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'network_error');
        return true;
      },
    );
    assert.equal(flakyPosts, 1, 'POST 只打一次');
  });
  await check('逾時會被中止並標示為 timeout（不是無聲卡住）', async () => {
    await assert.rejects(
      () => apiRequest('/api/v1/never', { timeoutMs: 60 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'timeout');
        return true;
      },
    );
  });
  await check('外部 AbortSignal 可取消請求', async () => {
    const controller = new AbortController();
    const promise = apiRequest('/api/v1/never', { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.isAbort, true);
      return true;
    });
  });
  await check('連線失敗（fetch 直接 reject）也是 ApiError', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchHealth(),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.code, 'network_error');
          return true;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  console.log('— 顯示層格式化（不改資料）—');
  await check('委員姓名／照片等可為 null 的欄位有「未提供」替代', () => {
    assert.equal(text(null), '未提供');
    assert.equal(text('  '), '未提供');
    assert.equal(text('牛', '未提供'), '牛');
  });
  await check('委員會短名只影響顯示，原始 id 不變（L9 共用一個 helper）', () => {
    assert.equal(shortCommittee('內政委員會'), '內政');
    assert.equal(shortCommittee('經費稽核委員會'), '經費稽核');
    assert.equal(shortCommittee('委員會'), '委員會', '整串只有「委員會」時不要變成空字串');
    assert.equal(shortCommittee(''), '');
  });
  await check('布林語意欄位轉中文、null 轉（無）', () => {
    assert.equal(formatChangeValue('is_convener', '1'), '是');
    assert.equal(formatChangeValue('is_convener', '0'), '否');
    assert.equal(formatChangeValue('party', null), '（無）');
    assert.equal(formatChangeValue('party', '中國國民黨'), '中國國民黨');
  });
  await check('日期顯示：今年的不寫年份、不同年才補；null／壞值有替代文字', () => {
    assert.equal(formatDateTime(null), '尚無紀錄');
    assert.equal(formatDateTime('not-a-date'), '尚無紀錄');
    // 「今天」注入固定日期，測試才不會因為跨年而失效
    const now = new Date('2026-10-08T12:00:00+08:00');
    const stamp = new Date('2026-09-30T08:59:55.000Z');
    const hhmm = `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
    const mmdd = `${String(stamp.getMonth() + 1).padStart(2, '0')}/${String(stamp.getDate()).padStart(2, '0')}`;
    assert.equal(formatDateTime('2026-09-30T08:59:55.000Z', '尚無紀錄', now), `${mmdd} ${hhmm}`, '今年：只有月日與時間、沒有年份');
    assert.match(formatDateTime('2025-12-31T08:00:00.000Z', '尚無紀錄', now), /^2025\//, '不同年：補上年份');
    assert.equal(formatDay('2026-09-27', '—', now), '09/27');
    assert.equal(formatDay('2024/02/01', '—', now), '2024/02/01');
    assert.equal(formatDay(null, '—', now), '—');
    assert.equal(formatDay('不是日期', '未提供', now), '未提供');
  });
  await check('資料集代號有中文標示', () => {
    assert.equal(datasetLabel('id9'), 'ID9 立法委員名錄');
    assert.equal(datasetLabel('unknown'), 'unknown');
  });

  await check('議案狀態對應立法流程階段；未知狀態不畫', () => {
    assert.deepEqual(billStage('交付審查'), { index: 1, stopped: false });
    assert.equal(billStage('三讀')?.index, 4);
    assert.equal(billStage('審查完畢(三讀)')?.index, 4);
    assert.equal(billStage('撤案')?.stopped, true);
    assert.equal(billStage('交付查照'), null);
  });
  await check('CSV：逗號、引號、換行要跳脫', () => {
    assert.equal(toCsv([['a,b', 'say "hi"', 'x\ny', null, 3]]), '"a,b","say ""hi""","x\ny",,3');
  });

  await check('點圖例之後要不要把名錄捲到眼前：只有手機，而且只有「選」的時候', () => {
    // 390×844 實測：圖例在 y=616–697、名錄第一張卡在 y=780 以下，而手機可視高度只剩 650–700px
    // —— 點下去真正變的是看不到的清單，所以要捲（見 lib/scroll.ts）。
    assert.equal(shouldScrollToDirectory({ selected: true, viewportWidth: 390 }), true);
    assert.equal(shouldScrollToDirectory({ selected: true, viewportWidth: MOBILE_MAX_WIDTH }), true, '760 是界線本身，算手機');
    assert.equal(shouldScrollToDirectory({ selected: true, viewportWidth: 761 }), false, '桌機／平板圖與清單同一個視野，捲動只會干擾');
    assert.equal(shouldScrollToDirectory({ selected: false, viewportWidth: 390 }), false, '取消篩選時不捲（使用者正在圖上比較數字）');
    assert.equal(shouldScrollToDirectory({ selected: true, viewportWidth: 0 }), false, '量不到寬度（SSR）就不要捲');
  });

  await check('減少動態效果時仍然要捲，只是不播動畫', () => {
    assert.equal(scrollBehaviorFor(false), 'smooth');
    assert.equal(scrollBehaviorFor(true), 'auto', '捲動是功能不是裝飾，不取消');
  });

  console.log(`\n全部通過：${passed} 項`);
}

await main();
