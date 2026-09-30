import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, getMeta } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { runIngest, runBillsIngest, runNewsIngest, runSocialIngest, runAll } from '../server/ingest.mjs';
import { getHealth, listBills, listLegislators, listNews, listSyncRuns } from '../server/queries.mjs';
import { FetchError } from '../server/fetch-ly.mjs';
import { syncOnce } from '../server/index.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const silent = { log() {}, warn() {}, error() {} };

function seeded() {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  applyDataset(db, dataset, { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  return db;
}

const respondWith = (payloadByDataset) => async (url) => {
  const key = url.includes('ID9') ? 'id9' : 'id14';
  return {
    json: payloadByDataset[key],
    status: 200,
    headers: {},
    bytes: 100,
    sha256: `${key}-sha`,
    attempts: 1,
  };
};

test('A3: Concurrent syncs are single-flighted via syncOnce', async () => {
  const db = seeded();
  const unchanged = { id9: fixture('id9.json'), id14: fixture('id14.json') };
  let fetchCount = 0;
  
  // Wait artificially so both promises are created while the first is pending
  const fetchImpl = async (url) => {
    if (!url.includes('data.ly.gov.tw')) throw new FetchError('議案／新聞不在本測試範圍', { attempts: 1 });
    fetchCount++;
    await new Promise(r => setTimeout(r, 50));
    const key = url.includes('ID9') ? 'id9' : 'id14';
    return {
      json: unchanged[key],
      status: 200,
      headers: {},
      bytes: 100,
      sha256: `${key}-sha`,
      attempts: 1,
    };
  };

  const p1 = syncOnce(db, { logger: silent, fetchImpl, delayMs: 0 });
  const p2 = syncOnce(db, { logger: silent, fetchImpl, delayMs: 0 });
  
  const [res1, res2] = await Promise.all([p1, p2]);
  
  assert.equal(fetchCount, 2, 'Should only fetch 2 datasets total, not 4');
  assert.equal(res1, res2, 'Both promises should resolve to the identical result object');
});

test('抓取失敗（WAF 403 / 逾時）時：保留舊資料、記錄失敗、不得清空', async () => {
  const db = seeded();
  const before = listLegislators(db, {});
  const failing = async () => {
    throw new FetchError('HTTP 403', { status: 403, attempts: 3 });
  };

  const result = await runIngest(db, { logger: silent, fetchImpl: failing });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /403/);
  assert.equal(listLegislators(db, {}).total, before.total, '舊資料必須完整保留');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T09:00:00.000Z', 'last_success_at 不該被失敗的同步改寫');

  const runs = listSyncRuns(db, { limit: 5 });
  assert.equal(runs.count, 2, '兩個 dataset 都要留下失敗紀錄');
  assert.ok(runs.items.every((r) => r.status === 'failed'));
  assert.ok(runs.items.every((r) => r.http_status === 403));
  assert.equal(getHealth(db).db.legislators, 123);
});

test('驗證失敗（API 改版導致筆數暴跌）時：fail closed，不寫入半套資料', async () => {
  const db = seeded();
  const before = listLegislators(db, {});
  const truncated = {
    id9: { dataList: fixture('id9.json').dataList.slice(0, 3) },
    id14: fixture('id14.json'),
  };

  const result = await runIngest(db, { logger: silent, fetchImpl: respondWith(truncated) });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /驗證失敗/);
  assert.equal(listLegislators(db, {}).total, before.total);
  assert.equal(getHealth(db).db.committee_seats, 783);
});

test('內容未變更時：status=skipped，資料與異動紀錄都不動', async () => {
  const db = seeded();
  const unchanged = { id9: fixture('id9.json'), id14: fixture('id14.json') };

  const result = await runIngest(db, { logger: silent, fetchImpl: respondWith(unchanged) });

  // 註：這裡用假 sha256，最後一次「已套用」的 sha 與假 sha 不同，因此會重新套用但異動為 0。
  assert.ok(['skipped', 'success'].includes(result.status));
  assert.equal(result.changes, 0, '相同內容重新套用不該產生異動紀錄');
  assert.equal(listLegislators(db, {}).total, 113);
});

test('內容變更時：同步會產生異動紀錄並更新 last_success_at', async () => {
  const db = seeded();
  const id9 = fixture('id9.json');
  const id14 = fixture('id14.json');
  const patched = {
    id9,
    id14: {
      dataList: id14.dataList.map((r) =>
        r.name === '丁學忠' && r.term === '11' && r.sessionPeriod === '5' && r.committee === '內政委員會'
          ? { ...r, isCoChairman: 'Y' }
          : r,
      ),
    },
  };

  const result = await runIngest(db, { logger: silent, fetchImpl: respondWith(patched) });

  assert.equal(result.status, 'success');
  assert.equal(result.changes, 1);
  assert.notEqual(getMeta(db, 'last_success_at'), '2026-09-30T09:00:00.000Z');
  const roster = listLegislators(db, { convener: '1' });
  assert.equal(roster.total, 24, '新任召委應反映在名錄（23 + 1）');
});

test('A1: Unchanged data updates last_success_at to prevent stale dashboard', async () => {
  const db = seeded();
  const unchanged = { id9: fixture('id9.json'), id14: fixture('id14.json') };
  const fetchImpl = respondWith(unchanged);
  
  // First run sets the applied_sha
  await runIngest(db, { logger: silent, fetchImpl });
  
  const secondFetchedAt = new Date('2026-10-05T00:00:00.000Z');
  const result = await runIngest(db, { logger: silent, fetchImpl, now: () => secondFetchedAt });
  
  assert.equal(result.status, 'skipped');
  assert.equal(getMeta(db, 'last_success_at'), '2026-10-05T00:00:00.000Z');
});

const billsOk = async () => ({ json: fixture('bills-page.json'), status: 200, headers: {}, bytes: 1, sha256: 'x', attempts: 1 });

test('議案同步：成功時寫入議案並記錄 sync_runs', async () => {
  const db = seeded();
  const result = await runBillsIngest(db, { logger: silent, fetchImpl: billsOk });
  assert.equal(result.status, 'success');
  assert.equal(result.bills, 300);
  assert.equal(getHealth(db).db.bills, 300);
  assert.equal(listSyncRuns(db, { limit: 1 }).items[0].dataset, 'bills');
});

test('議案同步：抓取失敗時保留既有議案（與名錄各自 fail closed）', async () => {
  const db = seeded();
  await runBillsIngest(db, { logger: silent, fetchImpl: billsOk });
  const failing = async () => {
    throw new FetchError('read ECONNRESET', { attempts: 3 });
  };
  const result = await runBillsIngest(db, { logger: silent, fetchImpl: failing });
  assert.equal(result.status, 'failed');
  assert.equal(getHealth(db).db.bills, 300, '舊議案必須保留');
  assert.equal(listLegislators(db, {}).total, 113, '名錄不受議案失敗影響');
});

test('runAll：名錄失敗時不跑議案', async () => {
  const db = seeded();
  let billCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('govapi')) billCalls++;
    throw new FetchError('HTTP 403', { status: 403, attempts: 1 });
  };
  const result = await runAll(db, { logger: silent, fetchImpl });
  assert.equal(result.status, 'failed');
  assert.equal(billCalls, 0);
});

const newsXml = readFileSync(fileURLToPath(new URL('./fixtures/news-rss.xml', import.meta.url)), 'utf8');
const newsOk = async () => ({ text: newsXml, status: 200, headers: {}, bytes: 1, sha256: 'x', attempts: 1 });

test('新聞同步：只存標題含姓名的項目、可累積去重、在職委員才抓', async () => {
  const db = seeded();
  const urls = [];
  const fetchImpl = async (url) => (urls.push(url), newsOk());
  const now = () => new Date('2026-09-30T00:00:00.000Z');
  const first = await runNewsIngest(db, { logger: silent, fetchImpl, now, delayMs: 0 });
  assert.equal(first.status, 'success');
  assert.equal(urls.length, listLegislators(db, { session: 'all' }).items.filter((x) => !x.former).length, '只抓在職委員');
  assert.ok(urls.every((u) => u.includes('news.google.com')));
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const news = listNews(db, { legislator: ting, limit: 100 });
  assert.ok(news.total > 0 && news.items.every((n) => n.title.includes('丁學忠')));
  assert.ok(news.items.every((n, i, arr) => i === 0 || arr[i - 1].published_at >= n.published_at), '最新在前');
  // 同一份 RSS 再抓一次：不重複新增
  const second = await runNewsIngest(db, { logger: silent, fetchImpl, now, delayMs: 0 });
  assert.equal(second.added, 0);
  assert.equal(listNews(db, { legislator: ting }).total, news.total);
});

test('新聞同步：過半委員失敗才算 failed，且不清掉既有新聞', async () => {
  const db = seeded();
  const now = () => new Date('2026-09-30T00:00:00.000Z');
  await runNewsIngest(db, { logger: silent, fetchImpl: newsOk, now, delayMs: 0 });
  const before = getHealth(db).db.news;
  const failing = async () => {
    throw new FetchError('HTTP 503', { status: 503, attempts: 2 });
  };
  const result = await runNewsIngest(db, { logger: silent, fetchImpl: failing, now, delayMs: 0 });
  assert.equal(result.status, 'failed');
  assert.equal(getHealth(db).db.news, before);
});

const socialCsv = readFileSync(fileURLToPath(new URL('./fixtures/social.csv', import.meta.url)), 'utf8');

test('社群同步：成功時寫入並出現在委員資料；失敗時保留舊資料', async () => {
  const db = seeded();
  const ok = await runSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: socialCsv, status: 200, attempts: 1 }) });
  assert.equal(ok.status, 'success');
  assert.equal(getHealth(db).db.social_accounts, 113);
  const wu = listLegislators(db, { q: '吳思瑤' }).items[0];
  assert.equal(wu.social[0].platform, 'facebook');
  assert.equal(wu.social[0].url, 'https://www.facebook.com/taipeineedyou');

  const blocked = await runSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: '<!DOCTYPE html>login', status: 200, attempts: 1 }) });
  assert.equal(blocked.status, 'failed', '試算表被改回私人（回登入頁）要 fail closed');
  assert.equal(getHealth(db).db.social_accounts, 113);
});
