import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applyBills, applySocial, applyCommitteeRecords, applyCommitteeMeets, upsertNews, upsertArticles, pruneNews, pruneLogs, getMeta, setMeta, migrate } from '../server/db.mjs';
import { buildDataset, normalizeBills, normalizeCommitteeRecords, normalizeMeetings, normalizeSocial, newsName, rocDate, DataValidationError } from '../server/normalize.mjs';
import { CONFIG } from '../server/config.mjs';
import { entityFeedUrl, guardShrink, runIngest, runBillsIngest, runRecordsIngest, runBudgetIngest, runBudgetReportsIngest, runMeetingsIngest, budgetPageUrl, runNewsIngest, runOutletNews, runOutletPoll, retagOutletArticles, runNewsBackfill, backfillTargets, rangeFeedUrl, BACKFILL_CAP, runNewsFeedImport, runSocialIngest, runAll } from '../server/ingest.mjs';
import { entityNewsTerms, listFunds, getHealth, listBills, listBudget, listBudgetMeetings, listBudgetReports, budgetState, listChanges, listCounties, listLegislatorVotes, listRankings, compareLegislators, listRegions, listSplitTicket, listDemographics, listPopulationTrend, getTownMap, listLegislators, listNews, listNewsArticles, listSyncRuns } from '../server/queries.mjs';
import { FetchError } from '../server/fetch-ly.mjs';
import { feedDate, feedFileUrl, mergeFeedFile, parseFeedFile } from '../server/news-feed.mjs';
import { syncOnce, pollOutletsOnce } from '../server/index.mjs';

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
  const outletUrls = CONFIG.news.outlets.map((o) => o.url);
  assert.ok(
    urls.every((u) => u.includes('news.google.com') || outletUrls.includes(u) || u.startsWith(CONFIG.news.feedUrl)),
    'Google 新聞以外只抓設定的媒體 RSS 與收集檔',
  );
  assert.deepEqual(urls.filter((u) => outletUrls.includes(u)), outletUrls, '每家媒體 RSS 每輪只抓一次');
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
  // 113 位在職委員各有一個 facebook，扣掉更正表 deny 掉的陳永康（指向 KMT 粉專）→ 112 筆，
  // 再加上吳思瑤由更正表補的 threads → 113 筆。
  assert.equal(getHealth(db).db.social_accounts, 113);
  const wu = listLegislators(db, { q: '吳思瑤' }).items[0];
  const wuFacebook = wu.social.find((a) => a.platform === 'facebook');
  const wuThreads = wu.social.find((a) => a.platform === 'threads');
  assert.equal(wuFacebook.url, 'https://www.facebook.com/taipeineedyou', '臉書列保留（目前無法查看，但未刪除）');
  assert.equal(wuThreads.url, 'https://www.threads.com/@wusuyao541');
  assert.equal(wuThreads.source, 'override');

  const chen = listLegislators(db, { q: '陳永康' }).items[0];
  assert.deepEqual(chen.social, [], '陳永康的連結指向中國國民黨粉專，已被更正表 deny，寧可沒有也不要連到別人');

  const blocked = await runSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: '<!DOCTYPE html>login', status: 200, attempts: 1 }) });
  assert.equal(blocked.status, 'failed', '試算表被改回私人（回登入頁）要 fail closed');
  assert.equal(getHealth(db).db.social_accounts, 113, '失敗時保留舊資料');
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
  assert.equal(ok.accounts, 113, '112 位 facebook（113 扣掉 deny 的陳永康）+ 吳思瑤的 threads');
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

test('真實更正表檔案：17 筆（含 1 筆 threads、1 筆 deny）、平台與網址格式一致、沒有重複', async () => {
  const file = JSON.parse(readFileSync(fileURLToPath(new URL('../server/social-overrides.json', import.meta.url)), 'utf8'));
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const result = normalizeSocial(fixtureText('social.csv'), idByName, { overrides: file.overrides });

  assert.equal(file.overrides.length, 17);
  assert.equal(result.overridesApplied.length, 17, '每一筆都要生效（含 deny 的移除）');
  assert.equal(file.overrides.filter((o) => o.platform === 'threads').length, 1);
  assert.equal(file.overrides.filter((o) => o.action === 'deny').length, 1);
  for (const o of file.overrides) {
    const platform = o.platform ?? 'facebook';
    assert.ok(platform === 'facebook' || platform === 'threads', `${o.legislator} 平台不合法`);
    if (platform === 'threads') assert.match(o.url, /^https:\/\/(www\.)?threads\.(com|net)\/@[\w.]+\/?$/, `${o.legislator} threads 網址格式`);
    else assert.match(o.url, /^https:\/\/(www\.|m\.)?facebook\.com\//, `${o.legislator} facebook 網址格式`);
    assert.ok(o.reason && o.verified_at, `${o.legislator} 缺 reason 或 verified_at`);
    assert.ok(['replace', 'add', 'deny'].includes(o.action ?? 'replace'), `${o.legislator} action 不合法`);
  }
  const keys = result.accounts.map((a) => `${a.legislator_id}|${a.platform}|${a.url}`);
  assert.equal(new Set(keys).size, keys.length, '不該有重複');

  // deny 的實際效果：整理表原本指到政黨粉專的那一列，產出的帳號清單裡不該再有它
  const denied = file.overrides.find((o) => o.action === 'deny');
  const deniedId = idByName.get(newsName(denied.legislator));
  assert.ok(deniedId, `${denied.legislator} 應該對得到委員`);
  assert.ok(!result.accounts.some((a) => a.legislator_id === deniedId), `${denied.legislator} 的錯誤連結必須被移除`);
  assert.ok(result.accounts.length < file.overrides.length + 100, '移除一列不該讓總數爆走');
});

test('社群更正表：action=deny 移除已知錯誤的網址（可逆、不動整理表）', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const csv = fixtureText('social.csv');
  const before = normalizeSocial(csv, idByName).accounts;
  const target = before.find((a) => a.legislator_id);
  const name = dataset.legislators.find((l) => l.id === target.legislator_id).name;

  const result = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: name, platform: 'facebook', action: 'deny', url: target.url, reason: '指向別的實體' }],
  });
  assert.equal(result.accounts.length, before.length - 1, 'deny 會少一列');
  assert.ok(!result.accounts.some((a) => a.legislator_id === target.legislator_id && a.platform === 'facebook'));
  assert.deepEqual(result.overridesApplied, [`${name}(facebook·移除)`]);
  assert.ok(result.warnings.some((w) => w.includes(target.url)), '要留下移除紀錄與被移除的網址');

  // deny 不需要 url（只是記錄），但不支援的 action 要 fail closed
  const noUrl = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: name, platform: 'facebook', action: 'deny', reason: '指向別的實體' }],
  });
  assert.equal(noUrl.accounts.length, before.length - 1);
  assert.throws(
    () => normalizeSocial(csv, idByName, { overrides: [{ legislator: name, action: 'remove', url: target.url }] }),
    DataValidationError,
    'action 打錯字要 fail closed，不能默默當成 replace',
  );

  // deny 套用到不存在的列 → 只警告，不崩潰
  const missing = dataset.legislators.find((l) => !before.some((a) => a.legislator_id === l.id));
  const none = normalizeSocial(csv, idByName, {
    overrides: [{ legislator: missing.name, platform: 'facebook', action: 'deny', reason: '沒有這一列' }],
  });
  assert.equal(none.accounts.length, before.length);
  assert.ok(none.warnings.some((w) => w.includes('已經沒有這一列')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 0, '這個測試不寫資料庫');
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

/* ---------------- 換屆（README 列為「沒有實際測過」） ---------------- */

function termShift(payload, from, to) {
  const rows = payload.dataList.map((row) => {
    const next = { ...row, term: String(to) };
    if (typeof next.committee === 'string') next.committee = next.committee.replaceAll(`第${from}屆`, `第${to}屆`);
    return next;
  });
  return { ...payload, dataList: rows };
}

test('換屆：第 12 屆名錄進來時，屆次／會期／席次要整組切過去，不能混到上一屆', () => {
  const id9v12 = termShift(fixture('id9.json'), 11, 12);
  // id14 是「第 4 屆至今」的完整名單，換屆時新屆次的列會一起出現；這裡把第 11 屆的列複製一份改成第 12 屆
  const id14Source = fixture('id14.json');
  const id14v12 = {
    ...id14Source,
    dataList: [...id14Source.dataList, ...id14Source.dataList.filter((r) => r.term === '11').map((r) => ({ ...r, term: '12' }))],
  };

  const dataset = buildDataset(id9v12, id14v12);
  assert.equal(dataset.term, 12, '屆次跟著 id9 的最大屆別走');
  assert.equal(dataset.stats.legislators, 123);
  assert.equal(dataset.stats.current_roster, 113);
  assert.equal(dataset.stats.seats, 783);
  assert.equal(dataset.stats.sessions, 5);
  assert.equal(dataset.currentSession, '12-5');
  assert.ok(dataset.sessions.every((s) => s.id.startsWith('12-')), `不該殘留上一屆會期：${dataset.sessions.map((s) => s.id)}`);
  assert.ok(dataset.sessions.every((s) => s.term === 12));
  assert.ok(dataset.seats.every((s) => s.session_id.startsWith('12-')));
  assert.ok(
    dataset.committees.every((c) => !c.id.includes('會期')),
    '委員會 id 仍不可含會期前綴（換屆後最容易復發的地方）',
  );

  // 寫進資料庫：舊屆次的資料必須整批換掉（這是「整批覆寫」的既定語意，README 已載明只保留當屆）
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json')), {
    fetchedAt: '2026-09-30T09:00:00.000Z',
    sourceUrl: 'https://data.ly.gov.tw/',
  });
  assert.equal(getMeta(db, 'term'), '11');
  assert.equal(listLegislators(db, {}).meta.session, '11-5');

  applyDataset(db, dataset, { fetchedAt: '2026-12-01T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  assert.equal(getMeta(db, 'term'), '12');
  assert.equal(getMeta(db, 'current_session'), '12-5');
  assert.equal(listLegislators(db, {}).total, 113, '預設查詢要看得到新屆次的名錄');
  assert.equal(listLegislators(db, {}).meta.session, '12-5');
  assert.equal(listLegislators(db, { session: '12-5' }).total, 113);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE '11-%'").get().n), 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM committee_seats WHERE session_id LIKE '11-%'").get().n), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM terms').get().n), 2, 'terms 表會同時保留第 11 與第 12 屆的標籤');

  // 換屆後帶著舊會期的舊連結（?session=11-5）會怎樣？resolveScope 會退回「該屆最新會期」，
  // 不是回空清單、也不會回上一屆的人；而且 meta.session 會明講是 12-5，前端照著顯示。
  // 這條行為以前沒有測試，換屆時最容易變成「連結默默指到別的資料」而沒人發現。
  const legacyLink = listLegislators(db, { session: '11-5' });
  assert.equal(legacyLink.meta.session, '12-5', '不存在的會期要退回該屆最新會期，並在 meta 講清楚');
  assert.equal(legacyLink.total, 113);
  assert.equal(legacyLink.meta.term, 12);
});

/* ---------------- 第三輪 review（2026-10-02）：整批覆寫前的相對筆數門檻 ---------------- */

test('B1: 名錄部分回應（席次掉一半）要 fail closed，不可以整批覆寫掉完整資料', async () => {
  const db = seeded(); // 先有一份完整資料
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM committee_seats').get().n);
  assert.equal(before, 783);
  // 正式路徑由 runIngest 在成功後記錄基準筆數；這裡的 seed 是直接 applyDataset，補上同一組基準
  setMeta(db, 'seats_count', String(before));
  setMeta(db, 'legislators_count', '123');

  // 模擬來源只回了一半：id9 有一半委員的 committee 欄位是空的
  const id9 = fixture('id9.json');
  let n = 0;
  const broken = {
    ...id9,
    dataList: id9.dataList.map((row) => {
      if (row.term !== '11' || n++ % 2 === 1) return row;
      return { ...row, committee: '' };
    }),
  };

  const result = await runIngest(db, {
    logger: silent,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
    fetchImpl: async (url) => ({
      json: url.includes('ID9') ? broken : fixture('id14.json'),
      status: 200,
      headers: {},
      bytes: 100,
      sha256: url.includes('ID9') ? 'broken-id9' : 'id14-sha',
      attempts: 1,
    }),
  });

  assert.equal(result.status, 'failed', '筆數腰斬不可以是 success');
  assert.match(result.error, /席次/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM committee_seats').get().n), before, '舊資料必須原封不動');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T09:00:00.000Z', '失敗不可改寫 last_success_at');
  assert.equal(getMeta(db, 'term'), '11');
  // 失敗要留下紀錄（前端橫幅靠 last_runs）
  const failed = db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'failed'").get().n;
  assert.ok(Number(failed) >= 1);

  // 真的合法縮減時，LY_ALLOW_SHRINK=1 是逃生門（CONFIG 是模組載入時讀的，這裡直接驗 guardShrink 的參數）
  assert.throws(() => guardShrink(db, 'seats', '委員會席次', 367), DataValidationError);
  guardShrink(db, 'seats', '委員會席次', 367, { minRatio: 0 });
  assert.throws(() => guardShrink(db, 'seats', '委員會席次', 400, { minRatio: 0.8 }), /席次筆數異常/);
});

test('B2: records 被截斷時要 fail closed，不可以靜默覆寫', async () => {
  const db = seeded();
  const full = fixture('gazette-agendas.json');
  const first = normalizeCommitteeRecords([full], CONFIG.records.category);
  assert.ok(first.length >= 3, `fixture 應該有多筆委員會紀錄（實際 ${first.length}）`);
  applyCommitteeRecords(db, first, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  setMeta(db, 'records_count', String(first.length));
  setMeta(db, 'term', '11');

  // 來源只回一筆（截斷、或上游分頁壞掉）：以前只有「非空」驗證，會直接 DELETE + INSERT 蓋掉完整資料
  const truncated = { ...full, gazetteagendas: full.gazetteagendas.slice(0, 1), total_page: 1 };
  const result = await runRecordsIngest(db, {
    logger: silent,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
    fetchImpl: async (url) => ({
      json: url.includes('gazette_agendas') ? truncated : { total_page: 1, meets: [] },
      status: 200,
      headers: {},
      bytes: 100,
      sha256: 'truncated',
      attempts: 1,
    }),
  });

  assert.equal(result.status, 'failed', '筆數腰斬不可以是 success');
  assert.match(result.error, /筆數異常/);
  assert.equal(
    Number(db.prepare('SELECT COUNT(*) AS n FROM committee_records').get().n),
    first.length,
    '舊資料必須保留',
  );
});

test('B5: 429 會多給幾次機會（上限 5 次），不再是到不了的死碼', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    () =>
      fetchJson('https://example.com/x', {
        retries: 3,
        once: async () => {
          calls += 1;
          return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
        },
        sleepMs: async (ms) => sleeps.push(ms),
      }),
    FetchError,
  );
  assert.equal(calls, 5, 'retries=3 但 429 要打到 5 次（D41 的意圖）');
  assert.equal(sleeps.length, 4);

  // 非 429 的 5xx 仍然只給 retries 次
  let calls5 = 0;
  await assert.rejects(
    () =>
      fetchJson('https://example.com/x', {
        retries: 3,
        once: async () => {
          calls5 += 1;
          return { status: 503, headers: {}, body: Buffer.from('') };
        },
        sleepMs: async () => {},
      }),
    FetchError,
  );
  assert.equal(calls5, 3);
});

test('B6: Retry-After 再長也只在 cap 之內等待（不讓一個標頭卡住整個同步階段）', async () => {
  const sleeps = [];
  await assert.rejects(
    () =>
      fetchJson('https://example.com/x', {
        retries: 2,
        retryAfterCapMs: 1000,
        once: async () => ({ status: 429, headers: { 'retry-after': '99999' }, body: Buffer.from('') }),
        sleepMs: async (ms) => sleeps.push(ms),
      }),
    FetchError,
  );
  // retries=2，但 429 給到 5 次上限 → 4 次等待，每次都夾在 1000ms
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000], 'Retry-After: 99999 要被夾到 1000ms');
});

test('B10: rocDate 不合法月日要回 null，不能產生 2024-13-45', () => {
  assert.equal(rocDate('1150930'), '2026-09-30');
  assert.equal(rocDate('113/13/45'), null);
  assert.equal(rocDate('113/02/31'), null);
  assert.equal(rocDate('113/00/10'), null);
  assert.equal(rocDate('113/12/31'), '2024-12-31');
  assert.equal(rocDate('abc'), null);});

/* ---------------- 基金／機關／行政法人新聞：專屬批次查詢（與機關首長新聞同樣新） ---------------- */

const rssOf = (items) =>
  `<rss version="2.0"><channel>${items
    .map((i) => `<item><title>${i.title} - ${i.source ?? '來源'}</title><link>${i.url}</link><pubDate>${i.date}</pubDate><source>${i.source ?? '來源'}</source></item>`)
    .join('')}</channel></rss>`;
const rssResponse = (xml) => ({ text: xml, status: 200, headers: {}, bytes: xml.length, sha256: 'x', attempts: 1 });
const NEWS_NOW = () => new Date('2026-09-30T00:00:00.000Z');

test('基金新聞：搜尋詞不重複、取最短簡稱、全部合併成 OR 批次', () => {
  const terms = entityNewsTerms();
  assert.equal(new Set(terms).size, terms.length, '搜尋詞不可重複');
  assert.ok(terms.includes('台電') && !terms.includes('台灣電力股份有限公司'), '有簡稱就用簡稱');
  const q = new URL(entityFeedUrl(['台電', '中油'])).searchParams.get('q');
  assert.match(q, /^\("台電" OR "中油"\) when:\d+d$/);
});

test('基金新聞：不依賴委員新聞，標題提到具名單位才收，並出現在基金頁', async () => {
  const db = seeded();
  const queries = [];
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    queries.push(q);
    if (!q.includes(' OR ')) return rssResponse(rssOf([])); // 委員／首長查詢：沒有新聞
    return rssResponse(
      rssOf([
        { title: '台電宣布電價調整', url: 'https://news.example/tpc', date: 'Tue, 29 Sep 2026 08:00:00 GMT' },
        { title: '今天天氣很好', url: 'https://news.example/weather', date: 'Tue, 29 Sep 2026 09:00:00 GMT' },
        { title: '泛稱的某基金成立', url: 'https://news.example/generic', date: 'Tue, 29 Sep 2026 10:00:00 GMT' },
      ]),
    );
  };
  const result = await runNewsIngest(db, { logger: silent, fetchImpl, now: NEWS_NOW, delayMs: 0 });
  assert.equal(result.status, 'success');
  assert.equal(result.entity.processed, result.entity.total);
  assert.equal(result.entity.added, 1, '77 組都回同一則，只算新增 1 列');
  assert.equal(queries.filter((q) => q.includes(' OR ')).length, result.entity.total, '每組一次查詢');
  assert.ok(result.entity.total >= 50 && result.entity.total < 200, `約 80 組，實際 ${result.entity.total}`);

  const stored = db.prepare("SELECT title FROM topic_news WHERE topic = 'entities'").all().map((r) => r.title);
  assert.deepEqual(stored, ['台電宣布電價調整'], '無關與泛稱基金的標題不收（同網址跨組只存一次）');
  const funds = listFunds(db, { type: 'fund', kind: 'news' });
  const row = funds.items.find((i) => i.url === 'https://news.example/tpc');
  assert.ok(row, '基金頁要看得到');
  assert.equal(row.legislator, null, '不掛委員');
  assert.ok(row.funds.includes('台灣電力股份有限公司'));
  // 再抓一次：不重複新增
  const again = await runNewsIngest(db, { logger: silent, fetchImpl, now: NEWS_NOW, delayMs: 0 });
  assert.equal(again.entity.added, 0);
});

test('基金新聞：批次失敗只記警告不影響整體；預算用盡會接續上次的組別', async () => {
  const db = seeded();
  const first = [];
  await runNewsIngest(db, {
    logger: silent,
    delayMs: 0,
    entityBudgetMs: 25,
    now: NEWS_NOW,
    fetchImpl: async (url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('q'));
      if (!q.includes(' OR ')) return rssResponse(rssOf([]));
      first.push(q);
      await new Promise((r) => setTimeout(r, 10));
      return rssResponse(rssOf([]));
    },
  });
  assert.ok(first.length >= 1 && first.length < entityNewsTerms().length / CONFIG.news.entityBatch, '只跑一部分');
  assert.ok(Number(getMeta(db, 'news_entity_cursor')) >= 1, '記下接續位置');

  const second = [];
  const result = await runNewsIngest(db, {
    logger: silent,
    delayMs: 0,
    entityBudgetMs: 25,
    now: NEWS_NOW,
    fetchImpl: async (url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('q'));
      if (!q.includes(' OR ')) return rssResponse(rssOf([]));
      second.push(q);
      if (second.length === 1) throw new FetchError('HTTP 503', { status: 503, attempts: 2 }); // 第一組失敗
      await new Promise((r) => setTimeout(r, 10));
      return rssResponse(rssOf([]));
    },
  });
  assert.notEqual(second[0], first[0], '第二輪不是又從頭開始');
  assert.equal(result.status, 'success', '基金新聞批次失敗不拖垮新聞同步');
  assert.equal(result.entity.failures, 1);
  assert.match(String(db.prepare("SELECT error FROM sync_runs WHERE dataset = 'news' ORDER BY id DESC LIMIT 1").get().error), /基金／機關新聞/);
});


/* ---------------- 媒體官方 RSS（中央社／自由／聯合／公視） ---------------- */

/** 媒體自己的 RSS：沒有 <source>、標題沒有「 - 來源」尾綴，標題常包在 CDATA 裡 */
const outletRss = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>政治</title>${items
    .map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.url}</link><pubDate>${i.date}</pubDate></item>`)
    .join('')}</channel></rss>`;
const OUTLETS = [
  { name: '中央社', url: 'https://outlet.example/cna' },
  { name: '自由時報', url: 'https://outlet.example/ltn' },
];

test('媒體 RSS：每家抓一次，依標題分派到委員／首長／主計／基金機關，來源記媒體名', async () => {
  const db = seeded();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/cna')) {
      return rssResponse(
        outletRss([
          { title: '丁學忠質詢國防預算', url: 'https://cna.example/1', date: 'Tue, 29 Sep 2026 08:00:00 GMT' },
          { title: '卓榮泰赴立法院施政報告', url: 'https://cna.example/2', date: 'Tue, 29 Sep 2026 09:00:00 GMT' },
          { title: '主計總處公布物價指數', url: 'https://cna.example/3', date: 'Tue, 29 Sep 2026 10:00:00 GMT' },
          { title: '台電宣布電價調整', url: 'https://cna.example/4', date: 'Tue, 29 Sep 2026 11:00:00 GMT' },
          { title: '今天天氣很好', url: 'https://cna.example/5', date: 'Tue, 29 Sep 2026 12:00:00 GMT' },
          // 兩個字的委員名：沒有「立委／委員」不收（「黃捷運」這種會誤判），有才收
          { title: '黃捷運站周邊交通管制', url: 'https://cna.example/6', date: 'Tue, 29 Sep 2026 13:00:00 GMT' },
          { title: '立委黃捷提案修法', url: 'https://cna.example/7', date: 'Tue, 29 Sep 2026 14:00:00 GMT' },
          // 超過保存期限的不收
          { title: '丁學忠舊聞', url: 'https://cna.example/old', date: 'Tue, 01 Jan 2025 08:00:00 GMT' },
        ]),
      );
    }
    return rssResponse(outletRss([]));
  };
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const result = await runOutletNews(db, { logger: silent, fetchImpl, now: NEWS_NOW, cutoff, outlets: OUTLETS });
  assert.deepEqual(calls, OUTLETS.map((o) => o.url), '每家抓一次');
  assert.equal(result.failures, 0);

  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const news = listNews(db, { legislator: ting }).items;
  assert.deepEqual(news.map((n) => [n.title, n.source]), [['丁學忠質詢國防預算', '中央社']], '來源記媒體名、過期的不收');
  const huang = listLegislators(db, { q: '黃捷' }).items[0].id;
  assert.deepEqual(listNews(db, { legislator: huang }).items.map((n) => n.title), ['立委黃捷提案修法'], '兩字名需標題含立委／委員');
  const topic = (t) => db.prepare('SELECT title FROM topic_news WHERE topic = ? ORDER BY url').all(t).map((r) => r.title);
  assert.deepEqual(topic('official:卓榮泰'), ['卓榮泰赴立法院施政報告']);
  assert.deepEqual(topic('dgbas'), ['主計總處公布物價指數']);
  assert.deepEqual(topic('entities'), ['主計總處公布物價指數', '台電宣布電價調整'], '主計總處本身也在機關清單裡（與 Google 那一路相同）；天氣、委員新聞不收');
});

test('媒體 RSS：一家失敗只記警告；同一則報導 Google 與媒體各抓到一次只存一則', async () => {
  const db = seeded();
  const warnings = [];
  const logger = { ...silent, warn: (m) => warnings.push(m) };
  const fetchImpl = async (url) => {
    if (url.endsWith('/ltn')) throw new FetchError('HTTP 403', { status: 403, attempts: 2 });
    if (url.endsWith('/cna')) return rssResponse(outletRss([{ title: '丁學忠 質詢國防預算', url: 'https://cna.example/1', date: 'Tue, 29 Sep 2026 08:00:00 GMT' }]));
    // Google 新聞：同一則報導，網址是 news.google.com 的轉址，標題帶「 - 中央社」尾綴
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
    if (q.includes('丁學忠')) return rssResponse(rssOf([{ title: '丁學忠質詢國防預算', source: '中央社 CNA', url: 'https://news.google.com/rss/articles/abc', date: 'Tue, 29 Sep 2026 08:05:00 GMT' }]));
    return rssResponse(rssOf([]));
  };
  const original = CONFIG.news.outlets;
  CONFIG.news.outlets = OUTLETS;
  try {
    const result = await runNewsIngest(db, { logger, fetchImpl, now: NEWS_NOW, delayMs: 0, entityBudgetMs: 0 });
    assert.equal(result.status, 'success', '媒體 RSS 失敗不影響新聞同步成敗');
    assert.equal(result.outlet.failures, 1);
    assert.ok(warnings.some((w) => w.includes('自由時報')), '失敗要記警告');
    assert.match(String(db.prepare("SELECT error FROM sync_runs WHERE dataset = 'news' ORDER BY id DESC LIMIT 1").get().error), /媒體 RSS 1\/2 家/);
  } finally {
    CONFIG.news.outlets = original;
  }
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  assert.equal(listNews(db, { legislator: ting }).total, 1, '標題相同（忽略空白）就是同一則，不重複計入排行');
});

test('媒體 RSS：公視是 Atom，也要抓得到（回歸：整家被當成「不是 RSS」丟掉）', async () => {
  const db = seeded();
  // 公視 newsfeed.xml 的實際形狀：<feed>／<entry>／自閉合的 link／<updated>，沒有 <pubDate>
  const atomRss = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-TW">
  <id>https://news.pts.org.tw/xml/newsfeed.xml</id>
  <link href="https://news.pts.org.tw/xml/newsfeed.xml" rel="self"></link>
  <title><![CDATA[公視新聞網]]></title>
  <updated>2026-09-30T08:00:00+08:00</updated>
${items
  .map(
    (i) => `  <entry>
    <title><![CDATA[${i.title}]]></title>
    <link rel="alternate" href="${i.url}" />
    <id>${i.url}</id>
    <updated>${i.date}</updated>
  </entry>`,
  )
  .join('\n')}
</feed>`;
  const outlets = [{ name: '公視新聞', url: 'https://outlet.example/pts' }];
  const fetchImpl = async () =>
    rssResponse(
      atomRss([
        { title: '丁學忠質詢國防預算', url: 'https://news.pts.org.tw/article/1', date: '2026-09-29T16:00:00+08:00' },
        { title: '卓榮泰赴立法院施政報告', url: 'https://news.pts.org.tw/article/2', date: '2026-09-29T17:00:00+08:00' },
        { title: '今天天氣很好', url: 'https://news.pts.org.tw/article/3', date: '2026-09-29T18:00:00+08:00' },
      ]),
    );
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const result = await runOutletNews(db, { logger: silent, fetchImpl, now: NEWS_NOW, cutoff, outlets });
  assert.equal(result.failures, 0, 'Atom 不可以被當成「不是 RSS」而整家失敗');
  assert.equal(result.items, 3, '三個 <entry> 都要解析出來');
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  assert.deepEqual(listNews(db, { legislator: ting }).items.map((n) => [n.title, n.source, n.published_at]), [
    ['丁學忠質詢國防預算', '公視新聞', '2026-09-29T08:00:00.000Z'],
  ]);
  assert.deepEqual(
    db.prepare("SELECT title FROM topic_news WHERE topic = 'official:卓榮泰'").all().map((r) => r.title),
    ['卓榮泰赴立法院施政報告'],
  );
});

/* ---------------- 原始新聞庫（全部新聞）：全存、重新分派、每小時輪詢 ---------------- */

const outletRssWithSummary = (items) =>
  `<rss version="2.0"><channel>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.url}</link><pubDate>${i.date}</pubDate><description><![CDATA[<p>${i.summary ?? ''}</p>]]></description></item>`)
    .join('')}</channel></rss>`;

test('原始新聞庫：媒體 RSS 每一則都存（含沒提到任何人的）、帶摘要；Google 結果也存但不存摘要', async () => {
  const db = seeded();
  const fetchImpl = async (url) => {
    if (url.endsWith('/cna')) {
      return rssResponse(
        outletRssWithSummary([
          { title: '丁學忠質詢國防預算', url: 'https://cna.example/1', date: 'Tue, 29 Sep 2026 08:00:00 GMT', summary: '立法院今天審查' },
          { title: '颱風明天登陸', url: 'https://cna.example/2', date: 'Tue, 29 Sep 2026 09:00:00 GMT', summary: '氣象署發布海上警報' },
        ]),
      );
    }
    if (url.endsWith('/ltn')) return rssResponse(outletRss([]));
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
    if (q.includes('丁學忠')) return rssResponse(rssOf([{ title: '丁學忠出席記者會', source: '民視', url: 'https://news.google.com/rss/articles/g1', date: 'Tue, 29 Sep 2026 10:00:00 GMT' }]));
    return rssResponse(rssOf([]));
  };
  const original = CONFIG.news.outlets;
  CONFIG.news.outlets = OUTLETS;
  try {
    const result = await runNewsIngest(db, { logger: silent, fetchImpl, now: NEWS_NOW, delayMs: 0, entityBudgetMs: 0 });
    assert.equal(result.outlet.stored, 2, '兩則都進新聞庫，包含颱風那則');
  } finally {
    CONFIG.news.outlets = original;
  }
  const rows = db.prepare('SELECT url, title, summary, origin FROM articles ORDER BY url').all();
  assert.deepEqual(
    rows.map((r) => [r.url, r.origin, r.summary]),
    [
      ['https://cna.example/1', 'outlet', '立法院今天審查'],
      ['https://cna.example/2', 'outlet', '氣象署發布海上警報'],
      ['https://news.google.com/rss/articles/g1', 'google', null],
    ],
  );
  assert.ok(getMeta(db, 'news_outlets_fetched_at'), '記下媒體 RSS 的抓取時間');
  // 過期刪除也要刪到新聞庫
  upsertArticles(db, [{ url: 'https://old.example/1', title: '舊聞', source: 'x', published_at: '2025-01-01T00:00:00.000Z' }], { origin: 'outlet', fetchedAt: 'x' });
  pruneNews(db, { keepDays: CONFIG.news.keepDays, now: NEWS_NOW() });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE url = 'https://old.example/1'").get().n, 0);
});

test('重新分派：新聞庫裡的舊媒體新聞，換了名單之後也會標到人；重跑不重複', () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  // 模擬「抓的時候還沒分派到」的狀態：只在新聞庫裡、news 沒有
  upsertArticles(db, [{ url: 'https://cna.example/9', title: '丁學忠談預算', source: '中央社', published_at: '2026-09-29T08:00:00.000Z' }], { origin: 'outlet', fetchedAt: 'x' });
  upsertArticles(db, [{ url: 'https://news.google.com/rss/articles/g9', title: '丁學忠另一則', source: '民視', published_at: '2026-09-29T08:00:00.000Z' }], { origin: 'google', fetchedAt: 'x' });
  assert.equal(listNews(db, { legislator: ting }).total, 0);
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const first = retagOutletArticles(db, { cutoff, now: NEWS_NOW });
  assert.equal(first.items, 1, '只重新分派媒體 RSS 的（Google 那一路本來就是依對象查的）');
  assert.deepEqual(listNews(db, { legislator: ting }).items.map((n) => n.title), ['丁學忠談預算']);
  assert.equal(retagOutletArticles(db, { cutoff, now: NEWS_NOW }).added, 0, '重跑不重複新增');
});

test('媒體 RSS 每小時輪詢：只抓媒體、記下時間；完整同步進行中或停用新聞時跳過', async () => {
  const db = seeded();
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), rssResponse(outletRssWithSummary([{ title: '颱風明天登陸', url: 'https://cna.example/2', date: 'Tue, 29 Sep 2026 09:00:00 GMT' }])));
  const original = CONFIG.news.outlets;
  const feedUrl = CONFIG.news.feedUrl;
  CONFIG.news.outlets = OUTLETS;
  CONFIG.news.feedUrl = ''; // 收集檔另有測試
  try {
    const result = await runOutletPoll(db, { logger: silent, fetchImpl, now: NEWS_NOW });
    assert.deepEqual(calls, OUTLETS.map((o) => o.url), '不打 Google');
    assert.equal(result.stored, 1, '兩家回同一則，網址相同只存一次');
    assert.equal(getMeta(db, 'news_outlets_fetched_at'), NEWS_NOW().toISOString());

    const skip = CONFIG.skip.news;
    CONFIG.skip.news = true;
    try {
      assert.equal((await pollOutletsOnce(db, { logger: silent, fetchImpl })).status, 'skipped', 'LY_SKIP_NEWS 時不輪詢');
    } finally {
      CONFIG.skip.news = skip;
    }
  } finally {
    CONFIG.news.outlets = original;
    CONFIG.news.feedUrl = feedUrl;
  }
});

test('全部新聞：搜得到沒提到任何人的新聞、關鍵字也比對摘要（但不回傳摘要）、可依類別篩選', async () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const at = '2026-09-29T08:00:00.000Z';
  upsertArticles(
    db,
    [
      { url: 'https://cna.example/1', title: '丁學忠質詢國防預算', summary: '', source: '中央社', published_at: at },
      { url: 'https://cna.example/2', title: '颱風明天登陸', summary: '氣象署發布海上警報，預算追加防災', source: '中央社', published_at: '2026-09-28T08:00:00.000Z' },
    ],
    { origin: 'outlet', fetchedAt: 'x' },
  );
  upsertNews(db, ting, [{ url: 'https://cna.example/1', title: '丁學忠質詢國防預算', source: '中央社', published_at: at }], { fetchedAt: 'x' });

  const all = listNewsArticles(db, { scope: 'all' });
  assert.equal(all.total, 2, '颱風那則沒提到任何人也在');
  assert.deepEqual(all.kind_counts, { all: 2, other: 1, legislator: 1, official: 0, entity: 0, dgbas: 0 });
  assert.ok(all.items.every((a) => !('summary' in a) && !('text' in a)), '摘要只拿來搜尋，不回傳');

  const budget = listNewsArticles(db, { scope: 'all', q: '預算' });
  assert.deepEqual(budget.items.map((a) => a.title), ['丁學忠質詢國防預算', '颱風明天登陸'], '「預算」在颱風那則的摘要裡');
  assert.deepEqual(listNewsArticles(db, { scope: 'all', kind: 'legislator' }).items.map((a) => [a.title, a.kinds]), [['丁學忠質詢國防預算', ['legislator']]]);
  assert.deepEqual(listNewsArticles(db, { scope: 'all', kind: 'other' }).items.map((a) => a.title), ['颱風明天登陸']);
  assert.equal(listNewsArticles(db, { scope: 'all', kind: '亂打' }).total, 2, '未知類別當成全部');

  // 快取：寫入新資料後要看得到
  upsertArticles(db, [{ url: 'https://ltn.example/3', title: '股市大漲', source: '自由時報', published_at: '2026-09-30T08:00:00.000Z' }], { origin: 'outlet', fetchedAt: 'y' });
  assert.equal(listNewsArticles(db, { scope: 'all' }).items[0].title, '股市大漲', '資料變了快取要失效');
});

test('舊資料庫遷移：news／topic_news 補 title_key 並回填，同標題去重照常', () => {
  const db = openDb(':memory:');
  // 做出「舊版」的表：沒有 title_key
  db.exec('DROP INDEX idx_news_title_key; DROP INDEX idx_topic_news_title_key; ALTER TABLE news DROP COLUMN title_key; ALTER TABLE topic_news DROP COLUMN title_key;');
  db.prepare("INSERT INTO news(legislator_id, url, title, source, published_at, fetched_at) VALUES('L1', 'https://a/1', '標題 一', 's', '2026-09-01T00:00:00Z', 'x')").run();
  migrate(db);
  assert.equal(db.prepare('SELECT title_key FROM news').get().title_key, '標題一', '回填去掉空白的標題');
  assert.equal(upsertNews(db, 'L1', [{ url: 'https://b/2', title: '標題一', source: 's', published_at: '2026-09-01T00:00:00Z' }], { fetchedAt: 'y' }), 0, '回填後同標題去重照常');
  migrate(db); // 重跑不出錯
});

/* ---------------- 近半年新聞回補（scripts/backfill-news.mjs） ---------------- */

const BACKFILL_NOW = () => new Date('2026-10-03T12:00:00.000Z');
/** 解析回補 URL 的查詢字與日期區間 */
const rangeOf = (url) => {
  const q = new URL(url).searchParams.get('q');
  const [, query, after, before] = /^(.*) after:(\S+) before:(\S+)$/.exec(q);
  return { query, after, before };
};

test('回補：日期區間查詢的網址、對象清單涵蓋委員／首長／主計／基金機關', () => {
  const { query, after, before } = rangeOf(rangeFeedUrl('"丁學忠" 立委', new Date('2026-04-06T00:00:00Z'), new Date('2026-05-06T00:00:00Z')));
  assert.deepEqual([query, after, before], ['"丁學忠" 立委', '2026-04-06', '2026-05-06']);
  const db = seeded();
  const targets = backfillTargets(db);
  const count = (prefix) => targets.filter((t) => t.key.startsWith(prefix)).length;
  assert.equal(count('legislator:'), listLegislators(db, { session: 'all' }).items.filter((x) => !x.former).length);
  assert.ok(count('official:') > 20 && count('dgbas') === 1 && count('entities:') > 50);
  assert.equal(new Set(targets.map((t) => t.key)).size, targets.length, 'key 不可重複（接續靠它）');
});

test('回補：每月一段；滿約 100 則才細切成週；寫入委員新聞與新聞庫；完成後不再重跑', async () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const calls = [];
  const fetchImpl = async (url) => {
    const r = rangeOf(url);
    calls.push(r);
    if (!r.query.includes('丁學忠')) return rssResponse(rssOf([]));
    // 2026-08 那個月新聞很多（≥ CAP），要細切；細切後每週各回 1 則
    const many = r.after >= '2026-08-01' && r.after < '2026-08-08' && r.before > '2026-08-30';
    if (many) {
      return rssResponse(rssOf(Array.from({ length: BACKFILL_CAP }, (_, i) => ({ title: `丁學忠八月第${i}則`, url: `https://g/aug-${i}`, date: 'Mon, 10 Aug 2026 08:00:00 GMT' }))));
    }
    return rssResponse(rssOf([{ title: `丁學忠 ${r.after} 那段`, url: `https://g/${r.after}`, date: new Date(`${r.after}T08:00:00Z`).toUTCString() }]));
  };
  const result = await runNewsBackfill(db, { logger: silent, fetchImpl, now: BACKFILL_NOW, delayMs: 0 });
  assert.equal(result.stopped, null);
  assert.equal(result.completed, result.targets);
  const tingCalls = calls.filter((c) => c.query.includes('丁學忠'));
  const monthly = tingCalls.filter((c) => (Date.parse(c.before) - Date.parse(c.after)) / 86_400_000 >= 28);
  assert.equal(monthly.length, 6, '180 天切成 6 段月份');
  assert.ok(tingCalls.some((c) => (Date.parse(c.before) - Date.parse(c.after)) / 86_400_000 === 7), '滿 CAP 的那個月細切成週');
  const titles = listNews(db, { legislator: ting, limit: 100 }).items.map((n) => n.title);
  assert.ok(titles.length >= 6 + 4 && !titles.some((t) => t.startsWith('丁學忠八月第')), `細切後收週的結果，不收被截斷的那批（實際 ${titles.length} 則）`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE origin = 'google'").get().n, titles.length, '也存進原始新聞庫');
  assert.ok(getMeta(db, 'news_backfill_done_at'));

  const again = await runNewsBackfill(db, { logger: silent, fetchImpl: async () => assert.fail('完成後不該再打'), now: BACKFILL_NOW, delayMs: 0 });
  assert.equal(again.requests, 0);
  assert.equal((await runNewsBackfill(db, { logger: silent, fetchImpl, now: BACKFILL_NOW, delayMs: 0, reset: true })).completed, result.targets, '--reset 從頭再來');
});

test('回補：連續失敗（被限流）就停下並記住進度；下次從同一個對象、同一個月接續', async () => {
  const db = seeded();
  const targets = backfillTargets(db);
  let n = 0;
  // 前 10 次正常（第 1 位委員 6 個月＋第 2 位的前 4 個月），之後一律 429
  const flaky = async () => {
    n += 1;
    if (n > 10) throw new FetchError('HTTP 429', { status: 429, attempts: 3 });
    return rssResponse(rssOf([]));
  };
  const first = await runNewsBackfill(db, { logger: silent, fetchImpl: flaky, now: BACKFILL_NOW, delayMs: 0, maxFailures: 3 });
  assert.equal(first.stopped, 'failures');
  assert.equal(first.completed, 1);
  const saved = JSON.parse(getMeta(db, 'news_backfill'));
  assert.deepEqual(saved.done, [targets[0].key]);
  assert.deepEqual(saved.current, { key: targets[1].key, month: 4 }, '停在第 2 位的第 5 個月');
  assert.equal(getMeta(db, 'news_backfill_done_at'), null, '沒做完不能記完成');

  const resumed = [];
  const ok = async (url) => (resumed.push(rangeOf(url)), rssResponse(rssOf([])));
  const second = await runNewsBackfill(db, { logger: silent, fetchImpl: ok, now: () => new Date('2026-10-05T00:00:00Z'), delayMs: 0 });
  assert.equal(second.stopped, null);
  assert.equal(resumed[0].query, targets[1].q, '從第 2 位接續，不是從頭');
  assert.equal(resumed[0].after, new Date(Date.parse(saved.from) + 4 * 30 * 86_400_000).toISOString().slice(0, 10), '從第 5 個月開始，起點沿用第一次的（不因為今天換了而位移）');
  assert.equal(resumed.filter((r) => r.query === targets[1].q).length, 2, '第 2 位只補剩下的 2 個月');
  assert.equal(second.completed, targets.length);
});

test('回補：時間預算用完就停下（不算失敗）', async () => {
  const db = seeded();
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 15));
    return rssResponse(rssOf([]));
  };
  const result = await runNewsBackfill(db, { logger: silent, fetchImpl: slow, now: BACKFILL_NOW, delayMs: 0, budgetMs: 40 });
  assert.equal(result.stopped, 'budget');
  assert.ok(result.requests >= 1 && result.failures === 0);
  assert.ok(JSON.parse(getMeta(db, 'news_backfill')).current, '記住做到哪');
});

/* ---------------- GitHub Actions 收集的媒體 RSS（news-data 分支） ---------------- */

test('收集檔格式：依臺灣時間分日、同網址合併（保留第一次收集時間與舊摘要）、排序穩定、壞行略過', () => {
  assert.equal(feedDate('2026-10-02T17:30:00.000Z'), '2026-10-03', '臺灣時間凌晨 1:30 算 10/3');
  assert.equal(feedFileUrl('https://raw.example/repo/news-data/', '2026-10-03'), 'https://raw.example/repo/news-data/news/2026-10-03.ndjson');
  const a = { url: 'https://cna.example/1', title: '颱風', summary: '海上警報', source: '中央社', published_at: '2026-10-03T01:00:00.000Z' };
  const b = { url: 'https://ltn.example/2', title: '股市', summary: '', source: '自由時報', published_at: '2026-10-03T00:30:00.000Z' };
  const first = mergeFeedFile('', [a, b], 'T1');
  assert.deepEqual(parseFeedFile(first).map((i) => i.url), [b.url, a.url], '依發布時間排序');
  const second = mergeFeedFile(first, [{ ...a, title: '颱風更新', summary: '' }], 'T2');
  const merged = parseFeedFile(second).find((i) => i.url === a.url);
  assert.deepEqual([merged.title, merged.summary, merged.collected_at], ['颱風更新', '海上警報', 'T1']);
  assert.equal(mergeFeedFile(second, [{ ...a, title: '颱風更新', summary: '' }], 'T3'), second, '內容沒變就一字不差（git 不會多 commit）');
  assert.equal(parseFeedFile(`${second}{壞掉的行\n`).length, 2);
});

test('匯入收集檔：第一次讀滿保存期限、之後只讀上次以來的天數；404 不算失敗；寫進新聞庫並分派', async () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const feedUrl = CONFIG.news.feedUrl;
  CONFIG.news.feedUrl = 'https://raw.example/feed';
  const day = '2026-09-29';
  const file = mergeFeedFile(
    '',
    [
      { url: 'https://cna.example/1', title: '丁學忠質詢國防預算', summary: '立法院', source: '中央社', published_at: `${day}T02:00:00.000Z` },
      { url: 'https://pts.example/2', title: '颱風明天登陸', summary: '', source: '公視新聞', published_at: `${day}T03:00:00.000Z` },
    ],
    '2026-09-29T04:00:00.000Z',
  );
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === feedFileUrl(CONFIG.news.feedUrl, day)) return { text: file, status: 200 };
    throw new FetchError('HTTP 404', { status: 404, attempts: 1 });
  };
  try {
    const first = await runNewsFeedImport(db, { logger: silent, fetchImpl, now: NEWS_NOW });
    assert.equal(asked.length, CONFIG.news.keepDays, '第一次讀滿保存期限');
    assert.deepEqual([first.files, first.stored, first.failures, first.latest_collected_at], [1, 2, 0, '2026-09-29T04:00:00.000Z']);
    assert.deepEqual(listNews(db, { legislator: ting }).items.map((n) => n.title), ['丁學忠質詢國防預算'], '照規則分派');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE origin = 'outlet'").get().n, 2, '沒提到人的也進新聞庫');

    asked.length = 0;
    const later = () => new Date(NEWS_NOW().getTime() + 5 * 86_400_000);
    const second = await runNewsFeedImport(db, { logger: silent, fetchImpl, now: later });
    assert.equal(asked.length, 6, '隔 5 天：讀 5＋1 天');
    assert.equal(second.stored, 0, '已匯入的不重複');
  } finally {
    CONFIG.news.feedUrl = feedUrl;
  }
});

test('匯入收集檔：讀失敗不推進進度（下次多讀）；收集端停了會寫進新聞同步備註；feedUrl 空字串就不匯入', async () => {
  const db = seeded();
  const feedUrl = CONFIG.news.feedUrl;
  CONFIG.news.feedUrl = 'https://raw.example/feed';
  try {
    const broken = await runNewsFeedImport(db, { logger: silent, now: NEWS_NOW, fetchImpl: async () => { throw new FetchError('HTTP 500', { status: 500, attempts: 2 }); } });
    assert.equal(broken.failures, CONFIG.news.keepDays);
    assert.equal(getMeta(db, 'news_feed_imported_at'), null, '失敗時不推進');

    // 收集端最後一次收集是 10 小時前 → 新聞同步備註要提醒
    setMeta(db, 'news_feed_latest_collected_at', new Date(NEWS_NOW().getTime() - 10 * 3_600_000).toISOString());
    const outlets = CONFIG.news.outlets;
    CONFIG.news.outlets = [];
    try {
      await runNewsIngest(db, { logger: silent, now: NEWS_NOW, delayMs: 0, entityBudgetMs: 0, fetchImpl: async (url) => (url.startsWith(CONFIG.news.feedUrl) ? Promise.reject(new FetchError('HTTP 404', { status: 404 })) : rssResponse(rssOf([]))) });
    } finally {
      CONFIG.news.outlets = outlets;
    }
    assert.match(String(db.prepare("SELECT error FROM sync_runs WHERE dataset = 'news' ORDER BY id DESC LIMIT 1").get().error), /收集端.*10 小時前/);

    CONFIG.news.feedUrl = '';
    assert.equal((await runNewsFeedImport(db, { logger: silent, now: NEWS_NOW, fetchImpl: async () => assert.fail('不該打') })).skipped, true);
  } finally {
    CONFIG.news.feedUrl = feedUrl;
  }
});

test('fetchJson：額外 header 只送給原本的網域，轉址到別的網域時不帶（不外洩 token）', async () => {
  const seen = [];
  const once = async (url, { headers }) => {
    seen.push([new URL(url).host, headers.authorization ?? null]);
    if (url.startsWith('https://raw.example/')) return { status: 302, body: Buffer.from(''), headers: { location: 'https://cdn.example/file' } };
    return { status: 200, body: Buffer.from('ok'), headers: {} };
  };
  const { text } = await fetchJson('https://raw.example/news/a.ndjson', { text: true, retries: 1, once, headers: { authorization: 'Bearer secret' } });
  assert.equal(text, 'ok');
  assert.deepEqual(seen, [['raw.example', 'Bearer secret'], ['cdn.example', null]]);
});

test('匯入收集檔：設了 LY_GITHUB_TOKEN 就帶 Authorization（私人 repo 才讀得到）；沒設時讀不到要提示 token', async () => {
  const db = seeded();
  const { feedUrl, feedToken } = CONFIG.news;
  CONFIG.news.feedUrl = 'https://raw.example/feed';
  const auth = [];
  const fetchImpl = async (url, options) => {
    auth.push(options.headers?.authorization ?? null);
    throw new FetchError('HTTP 404', { status: 404 });
  };
  try {
    CONFIG.news.feedToken = 'ghp_test';
    await runNewsFeedImport(db, { logger: silent, fetchImpl, now: NEWS_NOW });
    assert.ok(auth.length > 0 && auth.every((a) => a === 'Bearer ghp_test'));
    CONFIG.news.feedToken = '';
    auth.length = 0;
    await runNewsFeedImport(db, { logger: silent, fetchImpl, now: NEWS_NOW });
    assert.ok(auth.every((a) => a === null), '沒設 token 就不帶');
    const outlets = CONFIG.news.outlets;
    CONFIG.news.outlets = [];
    try {
      await runNewsIngest(db, { logger: silent, now: NEWS_NOW, delayMs: 0, entityBudgetMs: 0, fetchImpl: async (url) => (url.startsWith(CONFIG.news.feedUrl) ? fetchImpl(url, {}) : rssResponse(rssOf([]))) });
    } finally {
      CONFIG.news.outlets = outlets;
    }
    assert.match(String(db.prepare("SELECT error FROM sync_runs WHERE dataset = 'news' ORDER BY id DESC LIMIT 1").get().error), /LY_GITHUB_TOKEN/);
  } finally {
    Object.assign(CONFIG.news, { feedUrl, feedToken });
  }
});
