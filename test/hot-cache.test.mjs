import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.mjs';
import { openDb, applyDataset, applyMeetingForecasts } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import {
  CACHE_SKIP_PATHS,
  FIXED_TARGETS,
  agenciesWithUpcoming,
  buildTargets,
  cacheClear,
  cacheGet,
  cacheKey,
  cacheSet,
  cacheStats,
  isCacheable,
  refreshHotCache,
} from '../server/hot-cache.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

function seeded() {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json')), { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  return db;
}

test('暫存金鑰：參數排序、空值丟掉（預熱與前端才會命中同一格）', () => {
  assert.equal(cacheKey('/api/v1/news', '?limit=8'), '/api/v1/news?limit=8');
  assert.equal(cacheKey('/api/v1/news', '?b=2&a=1'), '/api/v1/news?a=1&b=2');
  assert.equal(cacheKey('/api/v1/news', '?a=1&b='), '/api/v1/news?a=1', '空字串等於沒帶（buildUrl 就是這樣）');
  assert.equal(cacheKey('/api/v1/news', ''), '/api/v1/news');
  assert.equal(cacheKey('/api/v1/agency', '?name=%E8%B2%A1%E6%94%BF%E9%83%A8'), cacheKey('/api/v1/agency', '?name=財政部'), '編碼不同但內容相同要同一格');
});

test('哪些端點不快取：health（同步進度）、sync-sources（上次同步時間）、page-views', () => {
  assert.equal(isCacheable('/api/v1/agency', 'GET'), true);
  for (const path of CACHE_SKIP_PATHS) assert.equal(isCacheable(path, 'GET'), false, `${path} 不快取`);
  assert.equal(isCacheable('/api/v1/agency', 'POST'), false, '只快取 GET');
  assert.equal(isCacheable('/index.html', 'GET'), false, '靜態檔不走這層');
});

test('暫存：過期就重算、超過上限丟最舊的、統計看得出命中率', () => {
  cacheClear();
  cacheSet('k', 'v1', { now: 1_000 });
  assert.equal(cacheGet('k', { now: 1_500 }), 'v1');
  assert.equal(cacheGet('k', { now: 1_500 + 61_000 }), null, '超過 60 秒就過期');
  assert.equal(cacheStats().misses, 1);
  const before = cacheStats().hits;

  cacheClear();
  for (let i = 0; i < 405; i += 1) cacheSet(`k${i}`, `v${i}`);
  const filled = cacheStats();
  assert.equal(filled.keys, filled.limit, '上限 400');
  assert.equal(cacheGet('k0'), null, '最舊的被丟掉');
  assert.equal(cacheGet('k404'), 'v404', '最新的還在');
  assert.ok(cacheStats().hits > before, '命中數會累加（stats 是當下的快照，不能在取值前先讀）');
});

test('熱資料預熱：把熱門查詢的結果寫進同一格（之後請求直接命中）', async () => {
  cacheClear();
  const calls = [];
  const targets = [
    { label: '假的熱門項目', key: '/api/v1/fake?a=1', run: (db) => ({ ok: true, db: !!db }) },
    { label: '會爆的項目', key: '/api/v1/fake?a=2', run: () => { throw new Error('boom'); } },
  ];
  const result = await refreshHotCache({ fake: 'db' }, { logger: { log() {}, warn() {} }, targets });
  assert.equal(result.ok, 1);
  assert.equal(result.total, 2, '單一項失敗不影響其他項');
  assert.equal(cacheGet('/api/v1/fake?a=1'), JSON.stringify({ ok: true, db: true }));
  assert.equal(cacheGet('/api/v1/fake?a=2'), null);
  calls.push(1);
  assert.equal(calls.length, 1);
});

test('HTTP：第二次打同一支 API 直接命中暫存（x-hot-cache: hit），health 永遠不命中', async () => {
  const db = seeded();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    cacheClear();
    const first = await fetch(`${base}/api/v1/legislators?session=all`);
    const firstBody = await first.text();
    assert.equal(first.headers.get('x-hot-cache'), null, '第一次是算出來的');
    const second = await fetch(`${base}/api/v1/legislators?session=all`);
    assert.equal(second.headers.get('x-hot-cache'), 'hit');
    assert.equal(await second.text(), firstBody, '命中的內容要跟算出來的一模一樣');

    // 參數順序不同但內容相同 → 同一格
    const reordered = await fetch(`${base}/api/v1/legislators?session=all&x=`);
    assert.equal(reordered.headers.get('x-hot-cache'), 'hit', '空參數不影響金鑰');

    // 狀態不是 200 的回應不能進暫存（例：不認得的端點）
    const missing = await fetch(`${base}/api/v1/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await fetch(`${base}/api/v1/nope`)).headers.get('x-hot-cache'), null);

    // health 帶同步狀態，快取會讓進度條停住
    await fetch(`${base}/api/v1/health`);
    assert.equal((await fetch(`${base}/api/v1/health`)).headers.get('x-hot-cache'), null);

    // 清了之後要重新算（同步寫入資料後就是走這條路）
    cacheClear();
    assert.equal((await fetch(`${base}/api/v1/legislators?session=all`)).headers.get('x-hot-cache'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP：熱門項目（主計總處）預熱後第一個使用者就命中', async () => {
  const db = seeded();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    cacheClear();
    await refreshHotCache(db, { logger: { log() {}, warn() {} } });
    const hit = await fetch(`${base}/api/v1/agency?name=${encodeURIComponent('行政院主計總處')}`);
    assert.equal(hit.headers.get('x-hot-cache'), 'hit', '主計總處那一頁啟動時就要是溫的');
    const body = await hit.json();
    assert.equal(body.agency?.name, '行政院主計總處');
    assert.ok(body.kinds && body.upcoming, '內容要是完整的那一份（不是空殼）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('有預計會議的機關：用與「我的機關」同一組比對詞挑出來（簡稱也算），照最早場次排', () => {
  const db = seeded();
  applyMeetingForecasts(
    db,
    [
      { date: '2026-10-21', time: '09:00', committee: '財政委員會', title: '財政委員會第2次會議', agenda: '邀請財政部部長報告' },
      { date: '2026-10-22', time: '09:00', committee: '經濟委員會', title: '經濟委員會第3次會議', agenda: '邀請央行總裁報告' },
      { date: '2026-10-22', time: '14:00', committee: '司法及法制委員會', title: '司法及法制委員會第1次會議', agenda: '審查法務部組織法' },
      { date: '2026-10-19', time: '09:00', committee: '內政委員會', title: '過去的場次', agenda: '邀請內政部部長' },
    ],
    { fetchedAt: '2026-10-20T00:00:00.000Z' },
  );
  const found = agenciesWithUpcoming(db, { days: 10, today: '2026-10-20' });
  const names = found.map((a) => a.name);
  assert.ok(names.includes('財政部'), '全名比對');
  assert.ok(names.includes('中央銀行'), '議程寫「央行總裁」，簡稱也要算進來');
  assert.ok(names.includes('法務部'));
  assert.equal(names.includes('內政部'), false, '過去的場次不算');
  assert.equal(found[0].name, '財政部', '最早那場排最前面');
  const capped = agenciesWithUpcoming(db, { days: 10, today: '2026-10-20', cap: 1 });
  assert.equal(capped.length, 1, '上限生效');
});

test('預熱清單會把「有預計會議的機關」一起排進去，第一個使用者就命中', async () => {
  const db = seeded();
  applyMeetingForecasts(
    db,
    [{ date: '2026-10-21', time: '09:00', committee: '財政委員會', title: '財政委員會第2次會議', agenda: '邀請財政部部長報告' }],
    { fetchedAt: '2026-10-20T00:00:00.000Z' },
  );
  const targets = buildTargets(db, { today: '2026-10-20' });
  assert.ok(targets.length > FIXED_TARGETS.length, '固定名單之外還要有動態的');
  assert.ok(targets.some((t) => t.label.startsWith('財政部（有預計會議 1 場）')));

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    cacheClear();
    await refreshHotCache(db, { logger: { log() {}, warn() {} }, targets });
    const hit = await fetch(`${base}/api/v1/agency?name=${encodeURIComponent('財政部')}`);
    assert.equal(hit.headers.get('x-hot-cache'), 'hit', '下週要備詢的機關，第一個人打開就是溫的');
    const body = await hit.json();
    assert.equal(body.agency.name, '財政部');
    assert.ok(body.meetings.total >= 0, '內容要完整');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
