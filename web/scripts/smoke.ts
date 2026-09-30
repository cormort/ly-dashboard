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
} from '../src/api/client.ts';
import { deriveParties } from '../src/lib/legislators.ts';
import { latestSessionId, sessionLabelIndex, sessionScopeLabel } from '../src/lib/sessions.ts';
import {
  ALL_SESSIONS,
  parseFilters,
  resetForTermChange,
  serializeFilters,
  filtersEqual,
} from '../src/lib/urlState.ts';
import {
  committeeAxisLabel,
  datasetLabel,
  formatChangeValue,
  formatDateTime,
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

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
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

  console.log('— 名錄列舉 —');
  await check('deriveParties 去重、忽略空值', () => {
    const parties = deriveParties([
      { ...LEGISLATOR, id: 'a', party: '測試政黨B' },
      { ...LEGISLATOR, id: 'b', party: '測試政黨A' },
      { ...LEGISLATOR, id: 'c', party: null },
      { ...LEGISLATOR, id: 'd', party: '   ' },
    ]);
    assert.deepEqual(parties, ['測試政黨A', '測試政黨B']);
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
  await check('委員會名稱只在座標軸縮短，原始 id 不變', () => {
    assert.equal(committeeAxisLabel('內政委員會'), '內政');
    assert.equal(committeeAxisLabel('經費稽核委員會'), '經費稽核');
  });
  await check('布林語意欄位轉中文、null 轉（無）', () => {
    assert.equal(formatChangeValue('is_convener', '1'), '是');
    assert.equal(formatChangeValue('is_convener', '0'), '否');
    assert.equal(formatChangeValue('party', null), '（無）');
    assert.equal(formatChangeValue('party', '中國國民黨'), '中國國民黨');
  });
  await check('時間欄位 null 不會顯示 Invalid Date', () => {
    assert.equal(formatDateTime(null), '尚無紀錄');
    assert.equal(formatDateTime('not-a-date'), '尚無紀錄');
    assert.match(formatDateTime('2026-09-30T08:59:55.000Z'), /2026/);
  });
  await check('資料集代號有中文標示', () => {
    assert.equal(datasetLabel('id9'), 'ID9 立法委員名錄');
    assert.equal(datasetLabel('unknown'), 'unknown');
  });

  console.log(`\n全部通過：${passed} 項`);
}

await main();
