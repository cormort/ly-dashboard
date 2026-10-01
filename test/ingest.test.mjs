import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applyBills, applySocial, upsertNews, pruneLogs, getMeta, setMeta } from '../server/db.mjs';
import { buildDataset, normalizeBills, normalizeMeetings, normalizeSocial, newsName, rocDate, DataValidationError } from '../server/normalize.mjs';
import { CONFIG } from '../server/config.mjs';
import { runIngest, runBillsIngest, runBudgetIngest, runBudgetReportsIngest, runMeetingsIngest, budgetPageUrl, runNewsIngest, runSocialIngest, runAll } from '../server/ingest.mjs';
import { getHealth, listBills, listBudget, listBudgetMeetings, listBudgetReports, budgetState, listChanges, listLegislators, listNews, listSyncRuns } from '../server/queries.mjs';
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
    // 只計名錄（ID9／ID14）；其他來源（議案、發言名單、新聞…）不在本測試範圍
    if (!/ID(9|14)Action/.test(url)) throw new FetchError('非名錄來源不在本測試範圍', { attempts: 1 });
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
  assert.equal(urls.filter((u) => u.includes('%E7%AB%8B%E5%A7%94')).length, listLegislators(db, { session: 'all' }).items.filter((x) => !x.former).length, '只抓在職委員');
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
  // 113 位在職委員各有一個 facebook；吳思瑤另外由更正表補上 threads → 114 筆
  assert.equal(getHealth(db).db.social_accounts, 114);
  const wu = listLegislators(db, { q: '吳思瑤' }).items[0];
  const wuFacebook = wu.social.find((a) => a.platform === 'facebook');
  const wuThreads = wu.social.find((a) => a.platform === 'threads');
  assert.equal(wuFacebook.url, 'https://www.facebook.com/taipeineedyou', '臉書列保留（目前無法查看，但未刪除）');
  assert.equal(wuThreads.url, 'https://www.threads.com/@wusuyao541');
  assert.equal(wuThreads.source, 'override');

  const blocked = await runSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: '<!DOCTYPE html>login', status: 200, attempts: 1 }) });
  assert.equal(blocked.status, 'failed', '試算表被改回私人（回登入頁）要 fail closed');
  assert.equal(getHealth(db).db.social_accounts, 114, '失敗時保留舊資料');
});

/* ---------------- Review 修正的回歸測試（M1/M2/M3/M4/M5） ---------------- */

const fixtureText = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

test('M1: LY_SKIP_* 可跳過外部來源（測試與離線驗證用）', async () => {
  const db = seeded();
  const before = { ...CONFIG.skip };
  CONFIG.skip.bills = true;
  CONFIG.skip.social = true;
  CONFIG.skip.news = true;
  try {
    const result = await runAll(db, { logger: silent, fetchImpl: respondWith({ id9: fixture('id9.json'), id14: fixture('id14.json') }) });
    assert.equal(result.status, 'success', '名錄仍然要跑');
    assert.equal(result.bills.status, 'skipped');
    assert.equal(result.social.status, 'skipped');
    assert.equal(result.news.status, 'skipped');
    assert.equal(listBills(db, { limit: 5 }).total, 0, '跳過就不該有議案');
  } finally {
    Object.assign(CONFIG.skip, before);
  }
});

test('M2: 議案狀態變更會寫入 change_log', async () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [l.name, l.id]));
  const page = fixture('bills-page.json');

  const first = normalizeBills([page], idByName);
  const applied1 = applyBills(db, first, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  assert.equal(applied1.changes, 0, '第一次匯入沒有前一版可比對');
  assert.equal(listChanges(db, { limit: 5 }).count, 0);

  const target = page.bills.find((b) => b['議案狀態'] && b['議案狀態'] !== '三讀');
  const patched = { ...page, bills: page.bills.map((b) => (b['議案編號'] === target['議案編號'] ? { ...b, 議案狀態: '三讀' } : b)) };
  const applied2 = applyBills(db, normalizeBills([patched], idByName), { fetchedAt: '2026-09-30T10:00:00.000Z' });

  assert.equal(applied2.changes, 1, '恰好一筆狀態異動');
  const logged = listChanges(db, { limit: 5 });
  assert.equal(logged.items[0].entity, 'bill');
  assert.equal(logged.items[0].field, 'status');
  assert.equal(logged.items[0].new_value, '三讀');
  assert.equal(logged.items[0].entity_id, target['議案編號']);
});

test('M4: 社群帳號數掉超過 20% 時 fail closed，保留舊資料', async () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  // 先塞 150 筆（模擬上一次成功的同步）
  applySocial(
    db,
    Array.from({ length: 150 }, (_, i) => ({
      legislator_id: `X${i}`,
      platform: 'facebook',
      page_name: `專頁 ${i}`,
      url: `https://www.facebook.com/page${i}`,
      latest_post_date: '2026-09-01',
      latest_post_summary: '',
    })),
    { fetchedAt: '2026-09-30T09:00:00.000Z' },
  );

  const csv = fixtureText('social.csv'); // 真實整理表，113 筆
  const result = await runSocialIngest(db, {
    logger: silent,
    fetchImpl: async () => ({ text: csv, status: 200, headers: {}, bytes: csv.length, sha256: 'x', attempts: 1 }),
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /掉到/);
  assert.equal(Number(getMeta(db, 'social_count')), 150, 'social_count 不該被失敗的同步改寫');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n), 150, '舊資料必須保留');

  // 正常情況（沒有前一版）則成功
  const fresh = openDb(':memory:');
  applyDataset(fresh, dataset, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const ok = await runSocialIngest(fresh, {
    logger: silent,
    fetchImpl: async () => ({ text: csv, status: 200, headers: {}, bytes: csv.length, sha256: 'x', attempts: 1 }),
  });
  assert.equal(ok.status, 'success');
  assert.equal(ok.accounts, 114, '113 位 facebook + 吳思瑤的 threads');
});

test('M5: 新聞同步有時間預算，用完標記 partial 而不是失敗', async () => {
  const db = seeded();
  let calls = 0;
  const result = await runNewsIngest(db, {
    logger: silent,
    delayMs: 0,
    budgetMs: 30,
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 12));
      return {
        text: '<rss version="2.0"><channel><item><title>丁學忠 立委 新聞 - 來源</title><link>https://news.example/a</link><pubDate>Wed, 30 Sep 2026 00:00:00 GMT</pubDate><source>來源</source></item></channel></rss>',
        status: 200,
        headers: {},
        bytes: 10,
        sha256: `s${calls}`,
        attempts: 1,
      };
    },
  });

  assert.equal(result.status, 'success', '時間用盡不是失敗');
  assert.equal(result.partial, true);
  assert.ok(result.processed >= 1 && result.processed < result.total, `只完成一部分（${result.processed}/${result.total}）`);
  assert.match(String(getMeta(db, 'news_status')), /^partial:/);
  const health = getHealth(db);
  assert.ok(health.warnings.some((w) => w.includes('新聞同步未跑完')), 'health 要提示未跑完');
});

test('M3: syncOnce(scope=roster) 只同步名錄', async () => {
  const db = seeded();
  const result = await syncOnce(db, {
    scope: 'roster',
    logger: silent,
    fetchImpl: respondWith({ id9: fixture('id9.json'), id14: fixture('id14.json') }),
  });
  assert.ok(result.stats, '回傳名錄統計');
  assert.equal(result.bills, undefined, '不該跑議案階段');
  assert.equal(listBills(db, { limit: 5 }).total, 0);
});

test('L8: 選了議案狀態後，下拉仍拿得到全部狀態選項', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [l.name, l.id]));
  applyBills(db, normalizeBills([fixture('bills-page.json')], idByName), { fetchedAt: '2026-09-30T09:00:00.000Z' });

  const all = listBills(db, { limit: 5 });
  assert.ok(all.statuses.length > 1, '未篩選時本來就該有多個狀態');
  const filtered = listBills(db, { status: all.statuses[0].name, limit: 5 });
  assert.equal(filtered.total, all.statuses[0].count, 'total 要反映狀態篩選');
  assert.equal(filtered.statuses.length, all.statuses.length, '統計不受 status 篩選影響（L8）');
});

test('正規化版本改變時，即使來源內容相同也要重寫（避免解析邏輯改了卻不生效）', async () => {
  const db = seeded();
  const fetchImpl = respondWith({ id9: fixture('id9.json'), id14: fixture('id14.json') });

  const first = await runIngest(db, { logger: silent, fetchImpl });
  assert.equal(first.status, 'success');

  const second = await runIngest(db, { logger: silent, fetchImpl });
  assert.equal(second.status, 'skipped', '同版本、同內容 → 略過');

  // 模擬「改了 normalize.mjs 之後升級版本」
  const { NORMALIZER_VERSION } = await import('../server/normalize.mjs');
  setMeta(db, 'applied_sha', `0:${getMeta(db, 'applied_sha').split(':').slice(1).join(':')}`);
  const third = await runIngest(db, { logger: silent, fetchImpl });
  assert.equal(third.status, 'success', '版本不同 → 必須重新套用');
  assert.equal(getMeta(db, 'applied_sha').startsWith(`${NORMALIZER_VERSION}:`), true);
});

test('M2: 社群帳號首次匯入不產生異動紀錄，之後的增減才記', () => {
  const db = seeded();
  const csv = fixtureText('social.csv');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const accounts = normalizeSocial(csv, idByName).accounts;

  applySocial(db, accounts, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  assert.equal(listChanges(db, { limit: 5 }).count, 0, '第一次匯入不是異動');

  const trimmed = accounts.slice(0, accounts.length - 3);
  const result = applySocial(db, trimmed, { fetchedAt: '2026-09-30T10:00:00.000Z' });
  assert.equal(result.removed, 3);
  assert.equal(result.added, 0);
  const logged = listChanges(db, { limit: 10 });
  assert.equal(logged.count, 3);
  assert.ok(logged.items.every((i) => i.entity === 'social_account' && i.new_value === null));
});

/* ---------------- 預算審議 ---------------- */

// 先回會期分布（agg），再回該會期的分頁；替身把 80 筆都放在第 5 會期
const budgetOk = async (url) =>
  url.includes('agg=')
    ? { json: { total: 80, aggs: [{ buckets: [{ 會期: 5, count: 80 }] }] }, attempts: 1 }
    : { json: fixture('budget-page.json'), status: 200, headers: {}, bytes: 1, sha256: 'x', attempts: 1 };

test('預算同步：三種類別一次抓、寫入、抽出預算年度', async () => {
  const db = seeded();
  const url = decodeURIComponent(budgetPageUrl(11, 1));
  for (const c of CONFIG.budget.categories) assert.ok(url.includes(`議案類別=${c}`.replace(/ /g, '+')) || url.includes(`議案類別=${c}`), c);
  const result = await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  assert.equal(result.status, 'success');
  assert.equal(result.items, 80);
  const all = listBudget(db, { limit: 200 });
  assert.equal(all.total, 80);
  assert.deepEqual(all.categories.map((c) => c.count), [20, 20, 40]);
  assert.ok(all.items.some((b) => b.fiscal_year >= 113), '名稱含「115年度」要抽出年度');
  assert.equal(all.states.pending + all.states.done + all.states.returned, 80);
});

test('預算查詢：類別、機關、狀態可組合，統計在各自條件前算', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const reports = listBudget(db, { category: '預(決) 算決議案、定期報告' });
  assert.equal(reports.total, 40);
  const top = reports.proposers[0].name;
  const byAgency = listBudget(db, { category: '預(決) 算決議案、定期報告', proposer: top });
  assert.ok(byAgency.items.every((b) => b.proposer === top));
  assert.ok(byAgency.proposers.length > 1, '選了機關，機關清單不該只剩一個');
  const pending = listBudget(db, { state: 'pending', limit: 200 });
  assert.ok(pending.items.every((b) => b.state === 'pending'));
  assert.equal(budgetState('交付查照'), 'done');
  assert.equal(budgetState('交付審查'), 'pending');
  assert.equal(budgetState('退回程序委員會'), 'returned');
});

test('預算同步：失敗保留舊資料；筆數不足 fail closed', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  // 分布說有 5000 筆，實際只拿到 80 筆 → 驗證不過
  const short = async (url) =>
    url.includes('agg=') ? { json: { total: 5000, aggs: [{ buckets: [{ 會期: 5, count: 5000 }] }] }, attempts: 1 } : budgetOk(url);
  assert.equal((await runBudgetIngest(db, { logger: silent, fetchImpl: short })).status, 'failed');
  assert.equal(listBudget(db, {}).total, 80, '舊資料必須保留');
});

test('預算中心報告與委員會發言：寫入、預算會議篩選、發言排行只列在職委員', async () => {
  const db = seeded();
  const fetchImpl = async (url) => ({ json: fixture(url.includes('BudgetCenter') ? 'budget-reports.json' : 'id223.json'), attempts: 1 });
  const reports = await runBudgetReportsIngest(db, { logger: silent, fetchImpl });
  assert.equal(reports.status, 'success');
  assert.equal(reports.records, 6, '兩種類型回同一份替身，編號去重後 6 份');
  const listed = listBudgetReports(db, {});
  assert.ok(listed.items.every((r, i, a) => i === 0 || a[i - 1].completed >= r.completed), '新到舊');

  const meetings = await runMeetingsIngest(db, { logger: silent, fetchImpl });
  assert.equal(meetings.status, 'success');
  assert.equal(meetings.records, 16);
  const budget = listBudgetMeetings(db, { limit: 100 });
  assert.equal(budget.total, 8, '只列議程含「預算」的會議');
  assert.ok(budget.items.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date)), '民國日期轉 ISO');
  assert.ok(budget.speakers.length > 0 && budget.speakers.every((s, i, a) => i === 0 || a[i - 1].count >= s.count));
  assert.ok(budget.speakers[0].count <= 8);
});

test('預算中心／發言名單：格式不符 fail closed，保留舊資料', async () => {
  const db = seeded();
  const ok = async (url) => ({ json: fixture(url.includes('BudgetCenter') ? 'budget-reports.json' : 'id223.json'), attempts: 1 });
  await runBudgetReportsIngest(db, { logger: silent, fetchImpl: ok });
  await runMeetingsIngest(db, { logger: silent, fetchImpl: ok });
  const broken = async () => ({ json: { unexpected: true }, attempts: 1 });
  assert.equal((await runBudgetReportsIngest(db, { logger: silent, fetchImpl: broken })).status, 'failed');
  assert.equal((await runMeetingsIngest(db, { logger: silent, fetchImpl: broken })).status, 'failed');
  assert.equal(listBudgetReports(db, {}).total, 6);
  assert.equal(listBudgetMeetings(db, {}).total, 8);
  assert.equal(rocDate('113/03/07'), '2024-03-07');
  assert.equal(rocDate('1150930'), '2026-09-30');
  assert.equal(rocDate('bad'), null);
  const { meetings } = normalizeMeetings({ dataList: [{ smeetingDate: '113/03/07', legislatorNameList: '伍麗華Saidhai Tahovecahe' }] }, new Map([['伍麗華Saidhai‧Tahovecahe', 'X']]));
  assert.equal(meetings[0].speakers[0].id, 'X', '族語名分隔符號不同也要對得到');
});

test('預算查詢：依預算類型篩選，類型件數在類型條件前算', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const all = listBudget(db, { limit: 200 });
  assert.ok(all.types.general > 0);
  const special = listBudget(db, { type: 'special', limit: 200 });
  assert.equal(special.total, all.types.special);
  assert.ok(special.items.every((b) => b.types.includes('special')));
  assert.deepEqual(special.types, all.types, '選了類型，各類型件數不變');
  assert.equal(listBudget(db, { type: 'bogus' }).total, all.total, '未知類型視為未指定');
});

/* ---------------- 429：g0v API 的節流（實測 budget／records 整批失敗） ---------------- */

import { isRetryableStatus, parseRetryAfter, fetchJson } from '../server/fetch-ly.mjs';

test('429／5xx 可重試，其他 4xx 不可（403 是 WAF 拒絕，重試沒意義）', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true, `HTTP ${status} 應可重試`);
  for (const status of [400, 401, 403, 404, 410, 422]) assert.equal(isRetryableStatus(status), false, `HTTP ${status} 不該重試`);
});

test('Retry-After 支援秒數與 HTTP 日期', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed > 3000 && parsed <= 5000, `日期格式應換算成毫秒（得到 ${parsed}）`);
});

test('429 會重試到成功，且不會重試 403', async () => {
  const calls = [];
  const fakeOnce = async () => {
    calls.push(calls.length + 1);
    if (calls.length < 3) return { status: 429, body: Buffer.from(''), headers: { 'retry-after': '0' } };
    return { status: 200, body: Buffer.from('{"dataList":[]}'), headers: {} };
  };
  const result = await fetchJson('https://ly.govapi.tw/v2/bills?page=1', { once: fakeOnce, retries: 5 });
  assert.equal(result.status, 200, '第三次應該成功');
  assert.equal(result.attempts, 3);
});

test('非 200 且不可重試（403）只打一次就失敗', async () => {
  let calls = 0;
  const forbidden = async () => {
    calls += 1;
    return { status: 403, body: Buffer.from('forbidden'), headers: {} };
  };
  await assert.rejects(
    () => fetchJson('https://data.ly.gov.tw/odw/ID9Action.action', { once: forbidden, retries: 5 }),
    (error) => error.status === 403 && error.retryable === false,
  );
  assert.equal(calls, 1, 'WAF 403 重試沒有意義，只該打一次');
});

/* ---------------- 社群更正表（人工確認過的粉專覆蓋整理表） ---------------- */

test('社群更正表：覆蓋整理表的錯誤網址，並清掉屬於舊網址的貼文摘要', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const csv = fixtureText('social.csv');
  const { accounts } = normalizeSocial(csv, idByName);

  // 先找一位在整理表裡有資料的委員，模擬「整理表貼錯網址」
  const target = accounts.find((a) => a.latest_post_date && a.legislator_id);
  const name = dataset.legislators.find((l) => l.id === target.legislator_id).name;
  const wrongUrl = target.url;

  const overrides = [{ legislator: name, url: 'https://www.facebook.com/correct-page/', page_name: `${name} 粉專` }];
  const result = normalizeSocial(csv, idByName, { overrides });

  assert.deepEqual(result.overridesApplied, [`${name}(facebook)`]);
  const fixed = result.accounts.find((a) => a.legislator_id === target.legislator_id);
  assert.equal(fixed.url, 'https://www.facebook.com/correct-page/');
  assert.equal(fixed.source, 'override');
  assert.equal(fixed.latest_post_date, '', '舊網址的貼文摘要必須清掉，否則會顯示別人粉專的貼文');
  assert.equal(fixed.latest_post_summary, '');
  assert.ok(result.warnings.some((w) => w.includes(wrongUrl)), '要留下覆蓋紀錄');

  // 沒有被覆蓋的維持 sheet
  assert.ok(result.accounts.every((a) => a.source === 'override' || a.source === 'sheet'));
  assert.equal(result.accounts.length, accounts.length, '覆蓋不應該改變帳號總數');

  // 寫進資料庫後 source 也要留著
  applySocial(db, result.accounts, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const stored = db.prepare('SELECT url, source FROM social_accounts WHERE legislator_id = ?').get(target.legislator_id);
  assert.equal(stored.source, 'override');
  assert.equal(stored.url, 'https://www.facebook.com/correct-page/');
});

test('社群更正表：補上整理表沒有的委員；非 facebook 網址要 fail closed', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const csv = fixtureText('social.csv');
  const before = normalizeSocial(csv, idByName).accounts;
  const missingName = dataset.legislators.find((l) => !before.some((a) => a.legislator_id === l.id)).name;

  const added = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: missingName, url: 'https://www.facebook.com/added-page/', page_name: missingName }],
  });
  assert.equal(added.accounts.length, before.length + 1, '整理表沒有的委員要用更正表補上');
  assert.ok(added.warnings.some((w) => w.includes('補上')));

  assert.throws(
    () => normalizeSocial(csv, idByName, { overrides: [{ legislator: missingName, url: 'https://example.com/x' }] }),
    DataValidationError,
  );
});

test('社群更正表：支援 threads（整理表沒有這個平台，只能由更正表補）', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const csv = fixtureText('social.csv');
  const before = normalizeSocial(csv, idByName).accounts;
  const target = dataset.legislators.find((l) => before.some((a) => a.legislator_id === l.id));

  const result = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: target.name, platform: 'threads', action: 'add', url: 'https://www.threads.com/@someone' }],
  });
  assert.deepEqual(result.overridesApplied, [`${target.name}(threads)`]);
  const added = result.accounts.filter((a) => a.legislator_id === target.id);
  assert.equal(added.length, 2, '臉書列保留、Threads 另外新增一列');
  assert.deepEqual(added.map((a) => a.platform).sort(), ['facebook', 'threads']);
  assert.equal(added.find((a) => a.platform === 'threads').source, 'override');

  // 同一平台的 add 不該重複插入
  const again = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: target.name, platform: 'facebook', action: 'add', url: 'https://www.facebook.com/dup/' }],
  });
  assert.equal(again.accounts.filter((a) => a.legislator_id === target.id && a.platform === 'facebook').length, 1);

  // 平台與網址格式要對得上
  assert.throws(
    () => normalizeSocial(csv, idByName, { overrides: [{ legislator: target.name, platform: 'threads', url: 'https://www.facebook.com/x/' }] }),
    DataValidationError,
    'threads 平台不接受 facebook 網址',
  );
  assert.throws(
    () => normalizeSocial(csv, idByName, { overrides: [{ legislator: target.name, platform: 'twitter', url: 'https://x.com/x' }] }),
    DataValidationError,
    '不支援的平台要 fail closed',
  );

  // 寫進資料庫：一位委員可以有兩個平台
  const stored = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: target.name, platform: 'threads', action: 'add', url: 'https://www.threads.com/@someone' }],
  });
  applySocial(db, stored.accounts, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM social_accounts WHERE legislator_id = ?').get(target.id).n), 2);
});

test('真實更正表檔案：16 筆（含 1 筆 threads）、平台與網址格式一致、沒有重複', async () => {
  const file = JSON.parse(readFileSync(fileURLToPath(new URL('../server/social-overrides.json', import.meta.url)), 'utf8'));
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const result = normalizeSocial(fixtureText('social.csv'), idByName, { overrides: file.overrides });

  assert.equal(file.overrides.length, 16);
  assert.equal(result.overridesApplied.length, 16, '每一筆都要對到委員');
  assert.equal(file.overrides.filter((o) => o.platform === 'threads').length, 1);
  for (const o of file.overrides) {
    const platform = o.platform ?? 'facebook';
    assert.ok(platform === 'facebook' || platform === 'threads', `${o.legislator} 平台不合法`);
    if (platform === 'threads') assert.match(o.url, /^https:\/\/(www\.)?threads\.(com|net)\/@[\w.]+\/?$/, `${o.legislator} threads 網址格式`);
    else assert.match(o.url, /^https:\/\/(www\.|m\.)?facebook\.com\//, `${o.legislator} facebook 網址格式`);
    assert.ok(o.reason && o.verified_at, `${o.legislator} 缺 reason 或 verified_at`);
  }
  const keys = result.accounts.map((a) => `${a.legislator_id}|${a.platform}|${a.url}`);
  assert.equal(new Set(keys).size, keys.length, '不該有重複');
});

/* ---------------- 紀錄保留上限（前端顯示的同步紀錄／異動紀錄） ---------------- */

test('紀錄保留：同步紀錄與異動紀錄只留最近 N 筆，其餘刪除', () => {
  const db = seeded();
  const insert = db.prepare(
    `INSERT INTO sync_runs(dataset, status, started_at, finished_at, records, attempt, http_status, duration_ms, ua, error)
     VALUES(?, 'success', ?, ?, 1, 1, 200, 10, 'ua', ?)`,
  );
  for (let i = 0; i < 250; i += 1) insert.run('id9', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:01.000Z', `run-${i}`);
  const change = db.prepare("INSERT INTO change_log(at, entity, entity_id, field, old_value, new_value) VALUES('2026-09-30T00:00:00.000Z','legislator',?,'party','A','B')");
  for (let i = 0; i < 600; i += 1) change.run(`id-${i}`);

  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n), 250);
  const removed = pruneLogs(db, { syncRuns: 200, changeLog: 500 });

  assert.equal(removed.sync_runs, 50, '250 → 200，刪 50');
  assert.equal(removed.change_log, 100, '600 → 500，刪 100');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n), 200);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM change_log').get().n), 500);

  // 留下來的必須是「最新的」：最新那筆的 error 字串還在
  const newest = db.prepare('SELECT error FROM sync_runs ORDER BY id DESC LIMIT 1').get().error;
  assert.equal(newest, 'run-249');
  const oldest = db.prepare('SELECT error FROM sync_runs ORDER BY id ASC LIMIT 1').get().error;
  assert.equal(oldest, 'run-50', '最舊的被刪掉，不是新的');

  // 0 = 不刪
  assert.deepEqual(pruneLogs(db, { syncRuns: 0, changeLog: 0 }), { sync_runs: 0, change_log: 0 });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n), 200);
});

test('紀錄保留：預設不刪（要落地），health 回報目前筆數與上限', () => {
  const db = seeded();
  const health = getHealth(db);
  assert.ok(Number.isFinite(health.db.sync_runs));
  assert.equal(health.retention.change_log.current, health.db.changes);
  // 預設 0 = 不刪任何紀錄；使用者確認要落地
  assert.equal(CONFIG.retention.syncRuns, 0);
  assert.equal(CONFIG.retention.changeLog, 0);
  assert.equal(health.retention.sync_runs.kept, 0);
  // 真的跑一次 pruneLogs 也不該刪東西
  const insert = db.prepare("INSERT INTO sync_runs(dataset, status, started_at) VALUES('id9','success','2026-09-30T00:00:00.000Z')");
  for (let i = 0; i < 5; i += 1) insert.run();
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n);
  assert.deepEqual(pruneLogs(db, CONFIG.retention), { sync_runs: 0, change_log: 0 });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n), before, '預設不該刪掉任何紀錄');
});
