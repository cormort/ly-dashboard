import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.mjs';
import { openDb, applyDataset, recordEvents } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { eventsSince } from '../server/queries.mjs';
import { runBillsIngest } from '../server/ingest.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

function seeded() {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json')), { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  return db;
}

test('站內事件：同一件事只記一次（同步整批覆寫也不會每天重播）', () => {
  const db = seeded();
  const events = [
    { kind: 'meeting', ref: '2026-10-22|09:00|財政委員會|第2次會議', title: '10-22 09:00 財政委員會 第2次會議', url: '/committees' },
    { kind: 'bill', ref: 'B001', title: '礦業法修正草案', url: '/bills?id=B001' },
  ];
  assert.equal(recordEvents(db, events, { now: '2026-10-22T00:00:00.000Z' }), 2);
  assert.equal(recordEvents(db, events, { now: '2026-10-22T01:00:00.000Z' }), 0, '同樣的 kind+ref 不再記一次');
  // 同一件事但種類不同算兩件（會議 vs 法案剛好同 ref 不該互吃）
  assert.equal(recordEvents(db, [{ kind: 'budget', ref: 'B001', title: '預算案' }], { now: '2026-10-22T02:00:00.000Z' }), 1);
  // INSERT OR IGNORE 被忽略的那幾筆也會吃掉 autoincrement，所以 id 會跳號；latest 只保證「≥ 實際筆數」
  const all = eventsSince(db, {});
  assert.equal(all.items.length, 3);
  assert.ok(all.latest >= 3);
});

test('事件流：since 之後才算新事件、最新的在前、limit 生效、latest 一定是最新 id', () => {
  const db = seeded();
  recordEvents(db, [
    { kind: 'bill', ref: 'A1', title: '一' },
    { kind: 'bill', ref: 'A2', title: '二' },
    { kind: 'bill', ref: 'A3', title: '三' },
  ], { now: '2026-10-22T00:00:00.000Z' });
  const all = eventsSince(db, {});
  assert.deepEqual(all.items.map((e) => e.title), ['三', '二', '一'], '新的在前');
  assert.equal(all.latest, 3);

  const afterFirst = eventsSince(db, { since: 1 });
  assert.deepEqual(afterFirst.items.map((e) => e.title), ['三', '二'], 'since 之前的不再回');
  assert.equal(afterFirst.latest, 3, 'latest 不受 limit／since 影響，前端游標才推得對');

  assert.equal(all.total, 3, 'since 之後的總筆數');
  const capped = eventsSince(db, { limit: 1 });
  assert.equal(capped.items.length, 1);
  assert.equal(capped.total, 3, 'limit 只截 items，total 仍說實話（畫面才能寫「另有 2 筆」）');
  assert.equal(capped.latest, 3, '只回一筆，但游標仍是最新 —— 不會下次又重播');
  assert.equal(eventsSince(db, { since: 99 }).items.length, 0);
  assert.equal(eventsSince(db, { since: 'abc' }).since, 0, '亂傳的字串當成從頭開始');
});

test('事件流 API：不快取（跑馬燈不能遲 60 秒），格式固定', async () => {
  const db = seeded();
  recordEvents(db, [{ kind: 'meeting', ref: 'k1', title: '10-23 09:00 經濟委員會 第3次會議', url: '/committees' }]);
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/api/v1/events?since=0`);
    const body = await first.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'meeting');
    assert.equal(first.headers.get('x-hot-cache'), null, '事件流不進熱資料暫存');

    // 新事件進來，下一次輪詢（同一組參數）要馬上看到
    recordEvents(db, [{ kind: 'bill', ref: 'k2', title: '新提案' }]);
    const second = await fetch(`${base}/api/v1/events?since=${body.latest}`);
    const body2 = await second.json();
    assert.equal(body2.items.length, 1);
    assert.equal(body2.items[0].title, '新提案');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('同步新增很多筆時收成一筆摘要事件（跑馬燈不會連跳幾十筆）；資料沒變就不產生事件', async () => {
  const db = seeded();
  const silent = { log() {}, warn() {}, error() {} };
  const page = fixture('bills-page.json');
  const fetchImpl = async () => ({ json: page, status: 200, headers: {}, bytes: 1, sha256: 'x', attempts: 1 });
  // 第一次：整批 300 筆都是新的 → 收成一筆「新增 300 筆議案」，而不是 300 筆事件
  const first = await runBillsIngest(db, { logger: silent, fetchImpl });
  assert.equal(first.status, 'success');
  const afterFirst = eventsSince(db, { limit: 50 });
  assert.equal(afterFirst.items.length, 1, '300 筆收成一筆摘要');
  assert.equal(afterFirst.items[0].kind, 'bill-batch');
  assert.equal(afterFirst.items[0].title, '新增 300 筆議案');
  assert.equal(afterFirst.items[0].url, '/bills');

  // 第二次：資料沒變 → 一筆新事件都不該產生（不然每天同步都會跳一次）
  const second = await runBillsIngest(db, { logger: silent, fetchImpl });
  assert.equal(second.status, 'success');
  assert.equal(eventsSince(db, { since: afterFirst.latest }).items.length, 0, '沒新資料就沒有事件');
});

test('同步新增少量（≤5 筆）時逐筆記，使用者才能一條一條看', () => {
  const db = seeded();
  // 直接驗 recordEvents 的逐筆行為（ingest 的門檻在 recordAdded：> 5 才收成摘要）
  recordEvents(db, [{ kind: 'bill', ref: 'X1', title: '礦業法修正草案', url: '/bills?id=X1' }]);
  const evs = eventsSince(db, { limit: 10 });
  assert.equal(evs.items.length, 1);
  assert.equal(evs.items[0].kind, 'bill');
  assert.equal(evs.items[0].url, '/bills?id=X1');
});
