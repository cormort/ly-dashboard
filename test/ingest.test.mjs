import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, upsertBudgetCommittees, getBudgetCommittees, applyBills, applySocial, applyCommitteeRecords, applyCommitteeMeets, upsertNews, upsertArticles, pruneNews, pruneLogs, getMeta, setMeta, migrate } from '../server/db.mjs';
import { buildDataset, normalizeBills, normalizeCommitteeRecords, normalizeMeetings, normalizeSocial, normalizeCouncilSocial, sameSocialPage, sheetDate, newsName, rocDate, DataValidationError } from '../server/normalize.mjs';
import { CONFIG } from '../server/config.mjs';
import { entityFeedUrl, guardShrink, runIngest, runBillsIngest, runRecordsIngest, runBudgetIngest, runBudgetReportsIngest, runMeetingsIngest, budgetPageUrl, runNewsIngest, runOutletNews, runOutletPoll, retagOutletArticles, runNewsBackfill, backfillTargets, rangeFeedUrl, BACKFILL_CAP, runNewsFeedImport, runCouncilNews, runCouncilSocialIngest, runSocialIngest, runBudgetCommittees, runAll } from '../server/ingest.mjs';
import { entityNewsTerms, listFunds, getHealth, listBills, listBudget, listBudgetMeetings, listBudgetReports, budgetState, budgetUnitState, mergeBudgetUnits, listChanges, listCounties, listLegislatorVotes, listRankings, compareLegislators, listRegions, listSplitTicket, listDemographics, listPopulationTrend, getTownMap, listLegislators, listNews, listNewsArticles, newsCsv, listCouncilActivity, currentCouncilors, socialFreshness, listSyncRuns } from '../server/queries.mjs';
import { FetchError } from '../server/fetch-ly.mjs';
import { csvRowsToFeedItems, feedDate, feedFileUrl, mergeFeedFile, parseFeedFile } from '../server/news-feed.mjs';
import { syncOnce, pollOutletsOnce, getInflightScope } from '../server/index.mjs';
import { scopeStages } from '../server/sync-scopes.mjs';

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
  // 預設統計範圍是「只算預算案本身」，要看全部 80 筆要明講 scope: 'all'
  assert.ok(listBudget(db, { limit: 200 }).total < 80, '預設只算預算案本身');
  // 預設是「一案一列」；這個測試要看議案紀錄筆數，明講 merge: 'none'
  const all = listBudget(db, { scope: 'all', merge: 'none', limit: 200 });
  assert.equal(all.total, 80);
  assert.deepEqual(all.categories.map((c) => c.count), [20, 20, 40]);
  assert.ok(all.items.some((b) => b.fiscal_year >= 113), '名稱含「115年度」要抽出年度');
  const p = all.progress;
  assert.equal(p.reviewed + p.in_review + p.pending + p.letter + p.returned, 80, '五級加起來要是全部');
  assert.equal(p.total, 80);
  assert.equal(p.awaiting, p.in_review + p.pending + p.returned, '尚未審竣＝審議中＋待審查＋退回');
});

test('預算查詢：類別、機關、狀態可組合，統計在各自條件前算', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const reports = listBudget(db, { scope: 'all', merge: 'none', category: '預(決) 算決議案、定期報告' });
  assert.equal(reports.total, 40);
  const top = reports.proposers[0].name;
  const byAgency = listBudget(db, { scope: 'all', merge: 'none', category: '預(決) 算決議案、定期報告', proposer: top });
  assert.ok(byAgency.items.every((b) => b.proposer === top));
  assert.ok(byAgency.proposers.length > 1, '選了機關，機關清單不該只剩一個');
  const pending = listBudget(db, { scope: 'all', merge: 'none', state: 'pending', limit: 200 });
  assert.ok(pending.items.every((b) => b.state === 'pending'));
  // 五級：舊版把「交付查照」這種函件也算成「已結案」，會讓人以為大部分都審完了
  assert.equal(budgetState('交付查照'), 'letter');
  assert.equal(budgetState('函復機關'), 'letter');
  assert.equal(budgetState('交付審查'), 'in_review');
  assert.equal(budgetState('排入院會'), 'pending');
  assert.equal(budgetState('審查完畢'), 'reviewed');
  assert.equal(budgetState('三讀'), 'reviewed');
  assert.equal(budgetState('審查完畢(逾審查期限)'), 'reviewed');
  assert.equal(budgetState('退回程序委員會'), 'returned');
  assert.equal(budgetState('從來沒見過的狀態'), 'pending', '認不得的狀態不可以謊稱審竣');
});

test('預算同步：失敗保留舊資料；筆數不足 fail closed', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  // 分布說有 5000 筆，實際只拿到 80 筆 → 驗證不過
  const short = async (url) =>
    url.includes('agg=') ? { json: { total: 5000, aggs: [{ buckets: [{ 會期: 5, count: 5000 }] }] }, attempts: 1 } : budgetOk(url);
  assert.equal((await runBudgetIngest(db, { logger: silent, fetchImpl: short })).status, 'failed');
  assert.equal(listBudget(db, { scope: 'all', merge: 'none' }).total, 80, '舊資料必須保留');
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
  // 收緊後的真資料守門：fixture 第一筆是「函送…附屬單位預算審查報告，請併…討論案」⇒ 不是預算案本身
  const report = all.items.find((b) => b.id === '303110233040000');
  assert.ok(report, 'fixture 應該有那一筆審查報告');
  assert.deepEqual(report.types, [], '名稱含「審查報告／請併」的不可以算成預算案');
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

test('sameSocialPage：同一個粉專的網址寫法不同算同一個，不同粉專不算', () => {
  assert.ok(sameSocialPage('https://www.facebook.com/kuanheng99/', 'https://facebook.com/kuanheng99'));
  assert.ok(sameSocialPage('HTTPS://WWW.FACEBOOK.COM/X/', 'http://m.facebook.com/x'));
  assert.ok(!sameSocialPage('https://www.facebook.com/a/', 'https://www.facebook.com/b/'));
  assert.ok(!sameSocialPage('', ''), '兩個空字串不算同一個頁面（否則空值會被當成有對應）');
  assert.ok(!sameSocialPage('https://www.facebook.com/a/', ''));
});

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

test('社群更正表：網址與整理表相同時保留貼文日期／摘要（不該清掉自己的資料）', () => {
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const csv = fixtureText('social.csv');
  const { accounts } = normalizeSocial(csv, idByName);

  // 整理表已經照更正表修好了：更正表的網址與整理表是同一個粉專（這裡只差結尾斜線）
  const target = accounts.find((a) => a.latest_post_date && a.legislator_id);
  const name = dataset.legislators.find((l) => l.id === target.legislator_id).name;
  const sameUrl = target.url.endsWith('/') ? target.url : `${target.url}/`;

  const result = normalizeSocial(csv, idByName, { overrides: [{ legislator: name, url: sameUrl }] });
  const kept = result.accounts.find((a) => a.legislator_id === target.legislator_id);
  assert.equal(kept.source, 'override', '來源仍標成 override（人工確認過的網址）');
  assert.equal(kept.latest_post_date, target.latest_post_date, '同一個粉專的貼文日期要留著');
  assert.equal(kept.latest_post_summary, target.latest_post_summary, '摘要也要留著');
  assert.ok(
    result.warnings.some((w) => w.includes('網址相同') && w.includes(name)),
    '要留下「網址相同、保留資料」的紀錄',
  );

  // 真的換了網址才清（上面那個測試顧到）；寫進資料庫後日期要在
  applySocial(db, result.accounts, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const stored = db.prepare('SELECT latest_post_date, latest_post_summary FROM social_accounts WHERE legislator_id = ?').get(target.legislator_id);
  assert.equal(stored.latest_post_date, target.latest_post_date);
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

test('真實更正表檔案：19 筆（含 1 筆 threads、1 筆 deny）、平台與網址格式一致、沒有重複', async () => {
  const file = JSON.parse(readFileSync(fileURLToPath(new URL('../server/social-overrides.json', import.meta.url)), 'utf8'));
  const db = seeded();
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const idByName = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const result = normalizeSocial(fixtureText('social.csv'), idByName, { overrides: file.overrides });

  assert.equal(file.overrides.length, 19, '2026-10-06 追加吳琪銘、王義川兩筆');
  assert.equal(result.overridesApplied.length, 19, '每一筆都要生效（含 deny 的移除）');
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
/** 基金機關的 OR 批次查詢（主計總處的查詢也有 OR，要排除） */
const isEntityBatch = (q) => q.includes(' OR ') && !q.startsWith('("主計總處" OR "主計長")');

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
    if (!isEntityBatch(q)) return rssResponse(rssOf([])); // 委員／首長查詢：沒有新聞
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
  assert.equal(queries.filter(isEntityBatch).length, result.entity.total, '每組一次查詢');
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
      if (!isEntityBatch(q)) return rssResponse(rssOf([]));
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
      if (!isEntityBatch(q)) return rssResponse(rssOf([]));
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
  assert.deepEqual(all.kind_counts, { all: 2, other: 1, legislator: 1, official: 0, entity: 0, dgbas: 0, local_accounting: 0, councilor: 0 });
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
  assert.ok(count('official:') > 20 && count('dgbas:') === 2 && count('entities:') > 50);
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

test('新聞 CSV：全部符合的都匯出（不分頁）、臺灣時間、類別與提到的人、不含摘要', () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const items = Array.from({ length: 35 }, (_, i) => ({ url: `https://cna.example/${i}`, title: `颱風第${i}報`, summary: '機密摘要', source: '中央社', published_at: `2026-09-${String(10 + (i % 18)).padStart(2, '0')}T16:30:00.000Z` }));
  items.push({ url: 'https://cna.example/t', title: '丁學忠質詢, "國防"預算', summary: '', source: '中央社', published_at: '2026-09-29T16:30:00.000Z' });
  upsertArticles(db, items, { origin: 'outlet', fetchedAt: 'x' });
  upsertNews(db, ting, [items.at(-1)], { fetchedAt: 'x' });

  const all = listNewsArticles(db, { scope: 'all', all: true });
  assert.equal(all.items.length, 36, 'all：不受每頁 100 筆上限影響');
  const rows = newsCsv(all.items, 'all').split('\r\n');
  assert.equal(rows[0], '發布時間,媒體,標題,類別,提到的委員／首長／議員,連結');
  assert.equal(rows.length, 37);
  const name = listLegislators(db, { q: '丁學忠' }).items[0].name;
  assert.equal(rows[1], `2026-09-30 00:30,中央社,"丁學忠質詢, ""國防""預算",委員,${name},https://cna.example/t`, '臺灣時間、逗號與引號要跳脫');
  assert.ok(rows.slice(2).every((r) => r.includes(',其他,')), '沒提到人的類別是「其他」');
  assert.ok(!rows.join('').includes('機密摘要'), '摘要不匯出');
  const filtered = listNewsArticles(db, { scope: 'all', kind: 'legislator', all: true }).items;
  assert.equal(newsCsv(filtered, 'all').split('\r\n').length, 2, '照篩選條件匯出');
  assert.equal(newsCsv(listNewsArticles(db, { all: true }).items, 'legislators').split('\r\n')[1].split(',').at(-3), '委員', '委員新聞頁的類別就是委員');
});

test('機關新聞：只列標題提到中央機關的（含委員新聞與「其他」類）、附上機關、可只看單一機關、匯出多一欄機關', () => {
  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const at = (d) => `2026-09-${d}T08:00:00.000Z`;
  const items = [
    { url: 'https://cna.example/1', title: '主計總處公布物價指數', source: '中央社', published_at: at(28) },
    { url: 'https://cna.example/2', title: '丁學忠要求交通部說明', source: '中央社', published_at: at(29) },
    { url: 'https://cna.example/3', title: '交通部與衛生福利部聯合記者會', source: '公視新聞', published_at: at(27) },
    { url: 'https://cna.example/4', title: '颱風明天登陸', source: '中央社', published_at: at(26) },
    { url: 'https://cna.example/5', title: '台電宣布電價調整', source: '中央社', published_at: at(25) }, // 國營事業＝基金，不是機關
  ];
  upsertArticles(db, items, { origin: 'outlet', fetchedAt: 'x' });
  upsertNews(db, ting, [items[1]], { fetchedAt: 'x' });

  const res = listNewsArticles(db, { scope: 'agencies' });
  assert.deepEqual(
    res.items.map((a) => [a.title, a.agencies]),
    [
      ['丁學忠要求交通部說明', ['交通部']],
      ['主計總處公布物價指數', ['行政院主計總處']],
      ['交通部與衛生福利部聯合記者會', ['交通部', '衛生福利部']],
    ],
    '簡稱對到全名；颱風、台電不算',
  );
  assert.equal(res.items[0].legislators[0].name, listLegislators(db, { q: '丁學忠' }).items[0].name, '提到的委員也列出');
  assert.deepEqual(res.people.slice(0, 1), [{ id: '交通部', name: '交通部', party: '機關', count: 2 }], '下拉選單依則數排序');
  assert.deepEqual(listNewsArticles(db, { scope: 'agencies', legislator: '衛生福利部' }).items.map((a) => a.title), ['交通部與衛生福利部聯合記者會']);
  assert.equal(listNewsArticles(db, { scope: 'agencies', q: '物價' }).total, 1);

  const rows = newsCsv(listNewsArticles(db, { scope: 'agencies', all: true }).items, 'agencies').split('\r\n');
  assert.equal(rows[0], '發布時間,媒體,標題,類別,提到的機關,提到的委員／首長／議員,連結');
  assert.ok(rows[3].includes(',機關,交通部、衛生福利部,'));
});

/* ---------------- 主計拆成主計總處／地方主計處 ---------------- */

test('主計：每日同步分兩次查（主計總處、地方主計處），都寫進主計主題；全部新聞分成兩類', async () => {
  const db = seeded();
  const queries = [];
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
    queries.push(q);
    if (q.startsWith('("主計總處" OR "主計長")')) return rssResponse(rssOf([{ title: '主計總處公布物價指數', url: 'https://g/c1', date: 'Tue, 29 Sep 2026 08:00:00 GMT' }]));
    if (q.startsWith('"主計處"')) {
      return rssResponse(
        rssOf([
          { title: '臺北市主計處公布市府預算', url: 'https://g/l1', date: 'Tue, 29 Sep 2026 09:00:00 GMT' },
          { title: '國防部主計局說明', url: 'https://g/x1', date: 'Tue, 29 Sep 2026 10:00:00 GMT' },
        ]),
      );
    }
    return rssResponse(rssOf([]));
  };
  const original = CONFIG.news.outlets;
  const feedUrl = CONFIG.news.feedUrl;
  Object.assign(CONFIG.news, { outlets: [], feedUrl: '' });
  try {
    await runNewsIngest(db, { logger: silent, fetchImpl, now: NEWS_NOW, delayMs: 0, entityBudgetMs: 0 });
  } finally {
    Object.assign(CONFIG.news, { outlets: original, feedUrl });
  }
  assert.deepEqual(
    queries.filter((q) => q.startsWith('("主計總處" OR "主計長")') || q.startsWith('"主計處"')).map((q) => q.replace(/ when:.*$/, '')),
    ['("主計總處" OR "主計長")', '"主計處"'],
    '主計查兩次',
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM topic_news WHERE topic = 'dgbas'").get().n, 3);
  const all = listNewsArticles(db, { scope: 'all' });
  assert.equal(all.kind_counts.dgbas, 1);
  assert.equal(all.kind_counts.local_accounting, 1);
  assert.deepEqual(listNewsArticles(db, { scope: 'all', kind: 'local_accounting' }).items.map((a) => a.title), ['臺北市主計處公布市府預算']);
  assert.ok(listNewsArticles(db, { scope: 'all', kind: 'other' }).items.some((a) => a.title === '國防部主計局說明'), '只說主計的不歸兩類');
  assert.ok(newsCsv(listNewsArticles(db, { scope: 'all', all: true }).items, 'all').includes(',地方主計,'));
});

test('回補：插入新的對象（主計拆成兩組）時，做到一半的那組從原本的月份接續，不重頭來', async () => {
  const db = seeded();
  const targets = backfillTargets(db);
  const entity = targets.find((t) => t.key.startsWith('entities:'));
  const before = targets.filter((t) => !t.key.startsWith('entities:') && !t.key.startsWith('dgbas:')).map((t) => t.key);
  // 模擬舊版進度：委員、首長、舊的 'dgbas' 都做完了，第一組基金機關做到第 4 個月
  const now = BACKFILL_NOW();
  const to = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to.getTime() - CONFIG.news.keepDays * 86_400_000);
  setMeta(db, 'news_backfill', JSON.stringify({ from: from.toISOString(), to: to.toISOString(), done: [...before, 'dgbas'], current: { key: entity.key, month: 4 } }));
  const asked = [];
  const result = await runNewsBackfill(db, { logger: silent, now: BACKFILL_NOW, delayMs: 0, fetchImpl: async (url) => (asked.push(rangeOf(url).query), rssResponse(rssOf([]))) });
  assert.equal(result.stopped, null);
  assert.equal(asked.filter((q) => q === '("主計總處" OR "主計長")').length, 6, '新的主計總處組完整補 6 個月');
  assert.equal(asked.filter((q) => q === '"主計處"').length, 6, '新的地方主計處組完整補 6 個月');
  assert.equal(asked.filter((q) => q === entity.q).length, 2, '基金機關那組只補剩下的 2 個月');
  assert.equal(result.completed, targets.length, '舊的 dgbas key 不算進完成數');
});

/* ---------------- 下載 CSV 的歷史新聞併進收集檔 ---------------- */

test('CSV → 收集檔：臺灣時間轉 UTC、依表頭找欄位、Google 轉址標 origin、壞列略過；匯入時照 origin 存', async () => {
  const rows = [
    ['發布時間', '媒體', '標題', '類別', '提到的機關', '提到的委員／首長', '連結'],
    ['2026-04-07 15:00', '自由時報', '丁學忠質詢國防預算', '委員', '', '丁學忠', 'https://news.google.com/rss/articles/abc'],
    ['2026-04-08 00:30', '中央社', '颱風明天登陸', '其他', '', '', 'https://cna.example/1'],
    ['不是時間', '中央社', '壞列', '', '', '', 'https://cna.example/bad'],
  ];
  const items = csvRowsToFeedItems(rows);
  assert.deepEqual(
    items.map((i) => [i.published_at, i.origin, feedDate(i.published_at)]),
    [
      ['2026-04-07T07:00:00.000Z', 'google', '2026-04-07'],
      ['2026-04-07T16:30:00.000Z', 'outlet', '2026-04-08'],
    ],
  );
  assert.throws(() => csvRowsToFeedItems([['標題', '連結']]), /缺少欄位/);
  assert.equal(parseFeedFile(mergeFeedFile('', items, 'T')).find((i) => i.origin === 'google').url, 'https://news.google.com/rss/articles/abc', 'origin 寫進收集檔');

  const db = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0].id;
  const feedUrl = CONFIG.news.feedUrl;
  CONFIG.news.feedUrl = 'https://raw.example/feed';
  const files = new Map();
  for (const i of items) files.set(feedDate(i.published_at), mergeFeedFile(files.get(feedDate(i.published_at)) ?? '', [i], 'T'));
  try {
    const now = () => new Date('2026-05-01T00:00:00.000Z');
    await runNewsFeedImport(db, {
      logger: silent,
      now,
      fetchImpl: async (url) => {
        const date = url.match(/(\d{4}-\d{2}-\d{2})\.ndjson$/)[1];
        if (files.has(date)) return { text: files.get(date), status: 200 };
        throw new FetchError('HTTP 404', { status: 404 });
      },
    });
  } finally {
    CONFIG.news.feedUrl = feedUrl;
  }
  assert.deepEqual(db.prepare('SELECT origin FROM articles ORDER BY url').all().map((r) => r.origin), ['outlet', 'google'], 'Google 來的照實標 google');
  assert.equal(listNews(db, { legislator: ting }).total, 1, '照標題規則分派到委員');
});

test('同一家多個分類 feed（中央社）：同一則出現在兩類只存一次、媒體名一樣；失敗的 log 標出是哪一類', async () => {
  const db = seeded();
  const warnings = [];
  const outlets = [
    { name: '中央社', feed: '政治', url: 'https://outlet.example/cna-politics' },
    { name: '中央社', feed: '地方', url: 'https://outlet.example/cna-local' },
    { name: '中央社', feed: '社會', url: 'https://outlet.example/cna-social' },
  ];
  const same = outletRss([{ title: '臺北市主計處公布市府預算', url: 'https://cna.example/9', date: 'Tue, 29 Sep 2026 08:00:00 GMT' }]);
  const fetchImpl = async (url) => {
    if (url.endsWith('social')) throw new FetchError('HTTP 404', { status: 404 });
    return rssResponse(same);
  };
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const result = await runOutletNews(db, { logger: { ...silent, warn: (m) => warnings.push(m) }, fetchImpl, now: NEWS_NOW, cutoff, outlets });
  assert.equal(result.stored, 1, '政治、地方都回同一則，網址相同只存一次');
  assert.deepEqual(db.prepare('SELECT source FROM articles').all().map((r) => r.source), ['中央社']);
  assert.ok(warnings.some((w) => w.includes('中央社（社會）')), `失敗的 log 要標出分類：${warnings}`);
  assert.ok(CONFIG.news.outlets.filter((o) => o.name === '中央社').length >= 4, '設定裡中央社有政治、產經證券、社會、地方');
});

/* ---------------- 議員近期動態 ---------------- */

test('議員名單：最新一屆當選人扣掉轉任立委／病逝／解職，加上遞補者', () => {
  const all = currentCouncilors();
  assert.ok(all.length > 350 && all.length < 380, `六都現任議員約 360 多位，實際 ${all.length}`);
  assert.ok(all.some((c) => c.id === '新北市|5|石一佑' && c.status.includes('遞補')), '遞補者有列');
  assert.ok(!all.some((c) => c.id === '新北市|5|黃俊哲'), '被遞補的原當選人不算現任');
  assert.equal(new Set(all.map((c) => c.id)).size, all.length, 'id 不重複');
});

test('議員近期動態：標題提到議員才列；兩字名、或與縣市長／立委／首長同名要有「議員」；別的職稱在前不算', () => {
  const db = seeded();
  const at = (d) => `2026-09-${d}T08:00:00.000Z`;
  upsertArticles(
    db,
    [
      { url: 'https://n/1', title: '秦慧珠質詢北市預算', source: '自由時報', published_at: at(29) },
      { url: 'https://n/2', title: '南投縣長許淑華推廣好茶', source: '聯合新聞網', published_at: at(28) }, // 縣長在前
      { url: 'https://n/3', title: '許淑華行銷南投', source: '聯合新聞網', published_at: at(27) }, // 與南投縣長同名、沒寫議員
      { url: 'https://n/4', title: '北市議員許淑華談台語', source: '中央社', published_at: at(26) },
      { url: 'https://n/5', title: '耿葳出席活動', source: '中央社', published_at: at(25) }, // 兩字名沒寫議員
      { url: 'https://n/6', title: '議員耿葳質詢', source: '中央社', published_at: at(24) },
      { url: 'https://n/7', title: '颱風明天登陸', source: '中央社', published_at: at(23) },
    ],
    { origin: 'outlet', fetchedAt: 'x' },
  );
  const all = listCouncilActivity(db, {});
  assert.deepEqual(
    all.items.map((i) => [i.title, i.councilors.map((c) => c.name)]),
    [
      ['秦慧珠質詢北市預算', ['秦慧珠']],
      ['北市議員許淑華談台語', ['許淑華']],
      ['議員耿葳質詢', ['耿葳']],
    ],
  );
  assert.equal(all.councilors.find((c) => c.name === '秦慧珠').count, 1, '名單附新聞則數');
  // 李柏毅同時是在職立委（同名）：沒寫「議員」不算
  upsertArticles(db, [{ url: 'https://n/8', title: '李柏毅質詢', source: '中央社', published_at: at(22) }], { origin: 'outlet', fetchedAt: 'y' });
  assert.ok(!listCouncilActivity(db, {}).items.some((i) => i.title === '李柏毅質詢'), '與立委同名要寫議員');
  assert.equal(all.councilors[0].count, 1, '依則數排序');
  assert.equal(listCouncilActivity(db, { county: '高雄市' }).total, 0, '縣市篩選');
  assert.equal(listCouncilActivity(db, { county: '台北市' }).total, 3, '臺／台都可以');
  assert.ok(listCouncilActivity(db, { county: '高雄市' }).councilors.every((c) => c.county === '高雄市'));
  assert.deepEqual(listCouncilActivity(db, { councilor: '臺北市|3|許淑華' }).items.map((i) => i.title), ['北市議員許淑華談台語']);
  assert.equal(listCouncilActivity(db, { q: '預算' }).total, 1);
});

/* ---------------- 議員 Google 新聞 ---------------- */

test('議員 Google 新聞：逐位查「"姓名" 縣市議員」；同名／兩字名要有議員或縣市簡稱；記在議員名下，近期動態同名也不誤標', async () => {
  const db = seeded();
  const queries = [];
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    queries.push(q);
    if (q.startsWith('"許淑華" 臺北市議員')) {
      return rssResponse(
        rssOf([
          { title: '北市許淑華質詢市府預算', url: 'https://g/s1', date: 'Tue, 29 Sep 2026 08:00:00 GMT' }, // 有縣市簡稱
          { title: '許淑華行銷南投好茶', url: 'https://g/s2', date: 'Tue, 29 Sep 2026 09:00:00 GMT' }, // 同名、沒線索：不收
        ]),
      );
    }
    if (q.startsWith('"秦慧珠" 臺北市議員')) return rssResponse(rssOf([{ title: '秦慧珠談交通', url: 'https://g/c1', date: 'Tue, 29 Sep 2026 10:00:00 GMT' }]));
    return rssResponse(rssOf([]));
  };
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const result = await runCouncilNews(db, { logger: silent, fetchImpl, now: NEWS_NOW, cutoff, budgetMs: 60_000 });
  assert.equal(result.processed, result.total, '全部議員都查到');
  assert.equal(queries.length, currentCouncilors().filter((c) => !c.name.includes('□')).length);
  assert.ok(queries.some((q) => q.startsWith('"秦慧珠" 臺北市議員 when:')));
  const topic = (name) => db.prepare("SELECT title FROM topic_news WHERE topic LIKE ? ORDER BY url").all(`councilor:%|${name}`).map((r) => r.title);
  assert.deepEqual(topic('許淑華'), ['北市許淑華質詢市府預算']);
  assert.deepEqual(topic('秦慧珠'), ['秦慧珠談交通']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE origin = 'google'").get().n, 2, '也進新聞庫');

  // 近期動態：「北市許淑華…」標題沒有「議員」，但查詢記在她名下，所以算她的
  const act = listCouncilActivity(db, { councilor: '臺北市|3|許淑華' });
  assert.deepEqual(act.items.map((i) => i.title), ['北市許淑華質詢市府預算']);
  assert.ok(!listNewsArticles(db, { scope: 'all' }).items.some((i) => 'councilorIds' in i), '內部欄位不外洩');
});

test('議員 Google 新聞：時間預算用完就停、下輪從停下的議員接續；預算 0＝不查', async () => {
  const db = seeded();
  const cutoff = new Date(NEWS_NOW().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const first = [];
  const slow = (list) => async (url) => {
    list.push(new URL(url).searchParams.get('q'));
    await new Promise((r) => setTimeout(r, 10));
    return rssResponse(rssOf([]));
  };
  const r1 = await runCouncilNews(db, { logger: silent, fetchImpl: slow(first), now: NEWS_NOW, cutoff, budgetMs: 35 });
  assert.ok(r1.partial && r1.processed >= 1 && r1.processed < r1.total);
  const second = [];
  await runCouncilNews(db, { logger: silent, fetchImpl: slow(second), now: NEWS_NOW, cutoff, budgetMs: 35 });
  assert.notEqual(second[0], first[0], '第二輪不是從頭開始');
  const none = await runCouncilNews(db, { logger: silent, fetchImpl: async () => assert.fail('不該查'), now: NEWS_NOW, cutoff, budgetMs: 0 });
  assert.equal(none.skipped, true);
});

test('回補：直轄市議員排在最後；已做完前面各組的進度，只會接著補議員；篩選同每日查詢', async () => {
  const db = seeded();
  const targets = backfillTargets(db);
  const firstCouncilor = targets.findIndex((t) => t.key.startsWith('councilor:'));
  assert.ok(firstCouncilor > 0 && targets.slice(firstCouncilor).every((t) => t.key.startsWith('councilor:')), '議員全部在最後');
  assert.equal(targets.length - firstCouncilor, currentCouncilors().filter((c) => !c.name.includes('□')).length);
  const xu = targets.find((t) => t.key === 'councilor:臺北市|3|許淑華');
  assert.equal(xu.q, '"許淑華" 臺北市議員');
  const xml = rssOf([
    { title: '北市許淑華質詢', url: 'https://g/1', date: 'Tue, 29 Sep 2026 08:00:00 GMT' },
    { title: '許淑華行銷南投', url: 'https://g/2', date: 'Tue, 29 Sep 2026 08:00:00 GMT' },
  ]);
  assert.deepEqual(xu.parse(xml).map((i) => i.title), ['北市許淑華質詢'], '同名要有縣市簡稱或議員');

  // 模擬：委員／首長／主計／基金機關都做完了（加議員之前的狀態）
  const now = BACKFILL_NOW();
  const to = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to.getTime() - CONFIG.news.keepDays * 86_400_000);
  setMeta(db, 'news_backfill', JSON.stringify({ from: from.toISOString(), to: to.toISOString(), done: targets.slice(0, firstCouncilor).map((t) => t.key), current: null }));
  const asked = [];
  const result = await runNewsBackfill(db, { logger: silent, now: BACKFILL_NOW, delayMs: 0, fetchImpl: async (url) => (asked.push(rangeOf(url).query), rssResponse(rssOf([]))) });
  assert.equal(result.stopped, null);
  assert.ok(asked.every((q) => q.endsWith('議員')), '只查議員');
  assert.equal(asked.length, (targets.length - firstCouncilor) * 6, '每位議員 6 個月');
});

test('全部新聞「議員」類別：Google 議員查詢與標題提到議員的都算；附上議員；CSV 類別寫議員', () => {
  const db = seeded();
  const at = (d) => `2026-09-${d}T08:00:00.000Z`;
  upsertArticles(
    db,
    [
      { url: 'https://n/1', title: '秦慧珠質詢北市預算', source: '自由時報', published_at: at(29) }, // 標題比對
      { url: 'https://g/2', title: '北市許淑華談台語', source: '民視', published_at: at(28) }, // 只有 Google 議員查詢記在她名下
      { url: 'https://n/3', title: '颱風明天登陸', source: '中央社', published_at: at(27) },
    ],
    { origin: 'outlet', fetchedAt: 'x' },
  );
  db.prepare("INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at, title_key) VALUES('councilor:臺北市|3|許淑華', 'https://g/2', '北市許淑華談台語', '民視', ?, 'x', '北市許淑華談台語')").run(at(28));
  const all = listNewsArticles(db, { scope: 'all' });
  assert.equal(all.kind_counts.councilor, 2);
  assert.equal(all.kind_counts.other, 1, '議員新聞不再算進「其他」');
  const councilor = listNewsArticles(db, { scope: 'all', kind: 'councilor' });
  assert.deepEqual(
    councilor.items.map((i) => [i.title, i.kinds, i.councilors.map((c) => `${c.county}${c.name}`)]),
    [
      ['秦慧珠質詢北市預算', ['councilor'], ['臺北市秦慧珠']],
      ['北市許淑華談台語', ['councilor'], ['臺北市許淑華']],
    ],
  );
  const rows = newsCsv(listNewsArticles(db, { scope: 'all', kind: 'councilor', all: true }).items, 'all').split('\r\n');
  assert.ok(rows[1].includes(',議員,臺北市議員秦慧珠,'), rows[1]);
  // 快取裡的資料沒有被改到：再查一次結果一樣
  assert.equal(listNewsArticles(db, { scope: 'all' }).kind_counts.councilor, 2);
});

/* ---------------- 社群整理表的新鮮度 ---------------- */

test('社群整理表新鮮度：標出資料截至哪天；超過天數算過期，/health 提醒、臉書榜附提醒', async () => {
  const db = seeded();
  assert.deepEqual(socialFreshness(db), { as_of: null, age_days: null, stale: false, stale_days: CONFIG.social.staleDays }, '沒資料不提醒');
  await runSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: socialCsv, status: 200, attempts: 1 }) });
  const asOf = socialFreshness(db).as_of;
  assert.match(asOf, /^\d{4}-\d{2}-\d{2}$/);
  // 臺灣時間的「今天」＝資料截至日的 2 天後 → 不過期；10 天後 → 過期
  const at = (days) => Date.parse(`${asOf}T12:00:00+08:00`) + days * 86_400_000;
  assert.deepEqual(socialFreshness(db, at(2)), { as_of: asOf, age_days: 2, stale: false, stale_days: CONFIG.social.staleDays });
  const old = socialFreshness(db, at(10));
  assert.equal(old.stale, true);
  assert.equal(old.age_days, 10);
  const health = getHealth(db, { now: at(10) });
  assert.deepEqual(health.social, old);
  assert.ok(health.warnings.some((w) => w.includes(`停在 ${asOf}`) && w.includes('10 天前')), `warnings：${health.warnings}`);
  assert.ok(!getHealth(db, { now: at(2) }).warnings.some((w) => w.includes('臉書整理表')), '沒過期不提醒');
  const board = listRankings(db, { type: 'facebook' }).boards.facebook;
  assert.equal(board.as_of, asOf);
  assert.ok(board.note.includes(`資料截至 ${asOf}`));
  assert.equal(typeof board.stale, 'boolean');
  assert.equal(board.stale_note === null, !board.stale, '過期才有提醒文字');
});

/* ---------------- 議員臉書整理表 ---------------- */

/** 用現任議員名單做一份「議員分頁」CSV（格式見 docs/social-sheet-spec.md） */
function councilSheet({ edit = (rows) => rows } = {}) {
  const rows = currentCouncilors().map((c) => {
    const no = Number(c.id.split('|')[1]);
    return [c.county, `第${no}選區`, c.name, c.party, c.facebook ?? `https://www.facebook.com/test.${no}`, c.status ?? '現任', '', ''];
  });
  const body = edit(rows).map((r) => r.map((x) => (/[",]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(','));
  return ['直轄市,選區,姓名,黨籍,Facebook 粉專網址,現任狀態,最新貼文日期,最新貼文主題摘要', ...body].join('\n');
}

test('議員臉書整理表：照規格解析；縣市＋姓名比對（同名用選區分辨、台→臺）；日期格式不對當空白', () => {
  const sheet = councilSheet({
    edit: (rows) =>
      rows.map((r) => {
        if (r[2] === '秦慧珠') return [...r.slice(0, 6), '2026-10-04', '關心北市交通'];
        if (r[2] === '許淑華') return ['台北市', r[1], r[2], r[3], r[4], r[5], '10月4日', '日期格式錯'];
        if (r[2] === '侯漢廷') return [...r.slice(0, 6), '2026/10/4', 'Google 試算表自動轉成的日期'];
        return r;
      }),
  });
  const { rows, warnings } = normalizeCouncilSocial(sheet, currentCouncilors());
  assert.equal(warnings.length, 0);
  const qin = rows.find((r) => r.councilor_id.endsWith('|秦慧珠'));
  assert.deepEqual([qin.latest_post_date, qin.latest_post_summary], ['2026-10-04', '關心北市交通']);
  const xu = rows.find((r) => r.councilor_id === '臺北市|3|許淑華');
  assert.ok(xu, '「台北市」也對得到');
  assert.equal(xu.latest_post_date, '', '日期格式不對當空白');
  assert.equal(rows.find((r) => r.councilor_id.endsWith('|侯漢廷')).latest_post_date, '2026-10-04', '2026/10/4 統一成 YYYY-MM-DD');
  // 原住民議員：中選會姓名含族語拼音，整理表只寫漢名也要對得到
  const indigenous = currentCouncilors().find((c) => /[A-Za-z]/.test(c.name));
  const han = indigenous.name.replace(/[^\u4e00-\u9fff].*$/, '');
  const onlyHan = normalizeCouncilSocial(councilSheet({ edit: (rs) => rs.map((r) => (r[2] === indigenous.name ? [r[0], r[1], han, ...r.slice(3)] : r)) }), currentCouncilors());
  assert.ok(onlyHan.rows.some((r) => r.councilor_id === indigenous.id), `${han} 要對到 ${indigenous.name}`);
  assert.throws(() => normalizeCouncilSocial('直轄市,姓名\n臺北市,某', currentCouncilors()), /缺少欄位：選區、Facebook 粉專網址/);
  assert.throws(() => normalizeCouncilSocial(councilSheet({ edit: (r) => r.slice(0, 150) }), currentCouncilors()), /筆數異常/);
  assert.throws(() => normalizeCouncilSocial(councilSheet({ edit: (r) => r.map((x, i) => (i < 60 ? [x[0], x[1], `不存在${i}`, ...x.slice(3)] : x)) }), currentCouncilors()), /對不到現任議員/);
});

test('議員臉書整理表同步：沒設網址就跳過；成功時覆寫並出現在議員近期動態；掉超過 20% 拒收保留舊資料', async () => {
  const db = seeded();
  const url = CONFIG.social.councilUrl;
  try {
    CONFIG.social.councilUrl = '';
    assert.equal((await runCouncilSocialIngest(db, { logger: silent, fetchImpl: async () => assert.fail('不該抓') })).status, 'skipped');

    CONFIG.social.councilUrl = 'https://sheet.example/council.csv';
    const sheet = councilSheet({
      edit: (rows) =>
        rows.map((r) => (r[2] === '秦慧珠' ? [...r.slice(0, 4), 'https://www.facebook.com/qin.new', r[5], '2026-10-04', '關心北市交通'] : r[2] === '侯漢廷' ? [...r.slice(0, 5), '轉任立委', '', ''] : r)),
    });
    const ok = await runCouncilSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: sheet, status: 200, attempts: 1 }) });
    assert.equal(ok.status, 'success');
    const act = listCouncilActivity(db, { county: '臺北市' });
    const qin = act.councilors.find((c) => c.name === '秦慧珠');
    assert.deepEqual([qin.facebook, qin.latest_post_date, qin.latest_post_summary], ['https://www.facebook.com/qin.new', '2026-10-04', '關心北市交通'], '整理表的網址與最新貼文優先');
    assert.ok(!act.councilors.some((c) => c.name === '侯漢廷'), '整理表標轉任立委的不列為現任');
    assert.equal(act.social.as_of, '2026-10-04');

    const before = db.prepare('SELECT COUNT(*) AS n FROM council_social').get().n;
    const truncated = councilSheet({ edit: (rows) => rows.slice(0, 210) });
    const bad = await runCouncilSocialIngest(db, { logger: silent, fetchImpl: async () => ({ text: truncated, status: 200, attempts: 1 }) });
    assert.equal(bad.status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM council_social').get().n, before, '保留舊資料');
    assert.equal(getHealth(db).council_social.as_of, '2026-10-04', '/health 也回報議員整理表的資料截至日');
  } finally {
    CONFIG.social.councilUrl = url;
  }
});

test('整理表日期：YYYY-MM-DD 為準，也接受 Google 試算表自動轉成的 2026/10/5；其他寫法當空白', () => {
  assert.equal(sheetDate('2026-10-05'), '2026-10-05');
  assert.equal(sheetDate('2026/10/5'), '2026-10-05');
  assert.equal(sheetDate(' 2026.1.9 '), '2026-01-09');
  for (const bad of ['10月5日', '2026/13/1', '2026/10', '', null, '昨天']) assert.equal(sheetDate(bad), '', String(bad));
});

/* ---------------- 同步範圍（下拉選單） ---------------- */

/** 只服務整理表兩個來源（社群／議員），其他一律視為「不該被呼叫」 */
const sheetOnlyFetch = (urls) => async (url) => {
  urls.push(url);
  const body = url === CONFIG.social.url ? socialCsv : url === CONFIG.social.councilUrl ? councilSheet() : null;
  if (body === null) throw new FetchError(`不該抓這個來源：${url}`, { status: 500, attempts: 1 });
  return { text: body, status: 200, headers: {}, bytes: body.length, sha256: 'x', attempts: 1 };
};

test('同步範圍：只重讀社群粉專時，其他階段一個都不跑', async () => {
  const db = seeded();
  const urls = [];
  const result = await runAll(db, { logger: silent, fetchImpl: sheetOnlyFetch(urls), stages: scopeStages('social') });

  assert.equal(result.social.status, 'success');
  assert.equal(result.council_social.status, 'success');
  assert.equal(result.news, undefined, '不該跑新聞（實測 763 秒）');
  assert.equal(result.bills, undefined);
  assert.equal(result.roster, undefined);
  const datasets = db.prepare('SELECT DISTINCT dataset FROM sync_runs').all().map((r) => r.dataset);
  assert.deepEqual(datasets.sort(), ['council_social', 'social'], 'sync_runs 只該有這兩個來源');
  assert.ok(
    urls.every((url) => url === CONFIG.social.url || url === CONFIG.social.councilUrl),
    `只該打整理表，實際打了：${urls.join('、')}`,
  );
});

test('同步範圍：syncOnce 收到 scope 就只跑那個範圍（不會偷跑全部）', async () => {
  const db = seeded();
  const urls = [];
  const result = await syncOnce(db, { scope: 'social', logger: silent, fetchImpl: sheetOnlyFetch(urls) });
  assert.equal(result.social.status, 'success');
  assert.equal(result.news, undefined);
  assert.equal(result.bills, undefined);
  assert.equal(getInflightScope(), null, '跑完要把 inflight 清掉');
});

test('同步範圍：runAll 收到不認識的階段要直接丟錯，不要靜默跳過', async () => {
  const db = seeded();
  await assert.rejects(
    () => runAll(db, { logger: silent, fetchImpl: async () => assert.fail('不該抓'), stages: ['sosial'] }),
    /未知的同步階段：sosial/,
  );
});

test('預算進度：分年度的件數統計（含沒有年度的）', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const all = listBudget(db, { merge: 'none', limit: 200 });
  // 每年都要有完整的進度統計
  for (const y of all.years) {
    assert.ok(y.progress, `${y.name} 要有 progress`);
    assert.equal(y.progress.total, y.count);
    assert.equal(
      y.progress.reviewed + y.progress.in_review + y.progress.pending + y.progress.letter + y.progress.returned,
      y.count,
      `${y.name} 的五級加總要等於件數`,
    );
  }
  // 年度遞減排序、unknown 最後
  const names = all.years.map((y) => y.name);
  assert.deepEqual(names, [...names].sort((a, b) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : Number(b) - Number(a))));
});

test('預算進度：分年度呈現（group_by=year）每組都有統計與前幾筆', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const grouped = listBudget(db, { merge: 'none', limit: 5, groupBy: 'year', perGroup: 3 });
  assert.equal(grouped.group_by, 'year');
  assert.equal(grouped.per_group, 3);
  assert.ok(grouped.groups.length > 0, '要有分組');
  const sum = grouped.groups.reduce((n, g) => n + g.total, 0);
  assert.equal(sum, grouped.total, '各組件數加起來要是總件數');
  for (const g of grouped.groups) {
    assert.ok(g.items.length <= 3, '每組最多只列 perGroup 筆（其餘用年度條件再查）');
    assert.equal(g.progress.total, g.total);
  }
  // 不分年度時不給 groups（前端才不會誤用）
  assert.deepEqual(listBudget(db, { merge: 'none', limit: 5 }).groups, []);
});

test('預算進度：年度不明的案子可以單獨查（不要被藏起來）', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const unknown = listBudget(db, { merge: 'none', year: 'unknown', limit: 200 });
  assert.ok(unknown.items.every((b) => b.fiscal_year === null || b.fiscal_year === undefined), '年度不明＝上游沒給年度');
  const all = listBudget(db, { merge: 'none', limit: 200 });
  assert.equal(unknown.total, all.years.find((y) => y.name === 'unknown')?.count ?? 0);
});

test('預算統計範圍：預設只算預算案本身；含報告類要自己切，且不影響類別導覽數', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const bills = listBudget(db, { merge: 'none', limit: 200 });
  assert.equal(bills.scope, 'bills', '預設只算預算案本身');
  const BILL = ['中央政府總預算案', '法人預(決)算案'];
  assert.ok(bills.items.every((b) => BILL.includes(b.category)), '預設清單只列議案本身');
  assert.ok(bills.items.every((b) => !b.types.includes('bogus')));
  const all = listBudget(db, { scope: 'all', merge: 'none', limit: 200 });
  assert.equal(all.scope, 'all');
  assert.equal(all.total, 80);
  assert.ok(all.total > bills.total, '含報告類一定比只算預算案多');
  // 決議案／定期報告（報告類）在含報告的範圍才會出現
  assert.ok(all.items.some((b) => !BILL.includes(b.category)));
  assert.ok(bills.items.every((b) => all.items.some((a) => a.id === b.id)));
  // 類別件數是導覽用的，不受範圍影響（否則使用者會找不到那 10,801 筆報告）
  assert.deepEqual(all.categories, bills.categories);
  assert.equal(all.scope_totals.all, 80, '含報告類在同樣篩選下有 80 筆紀錄');
  assert.equal(all.scope_totals.bills, bills.total);
  assert.ok(all.scope_note && bills.scope_note, '兩種範圍都要有說明');
  // 統計也跟著範圍走：含報告的「尚未審竣」不會比較少
  assert.ok(all.progress.awaiting >= bills.progress.awaiting);
});

test('一案一列：同一個預算案的多筆議案紀錄要合成一列（實測 115 年度總預算案 24 筆）', () => {
  // 彙總狀態：全部函件→函件處理；需要審查的全部審完→已審竣；否則取最進行中的
  assert.equal(budgetUnitState({ letter: 3 }), 'letter');
  assert.equal(budgetUnitState({ reviewed: 9, letter: 5 }), 'reviewed', '需要審查的都審完就算已審竣（函件不影響）');
  assert.equal(budgetUnitState({ reviewed: 9, in_review: 13, pending: 2 }), 'in_review');
  assert.equal(budgetUnitState({ reviewed: 3, pending: 2 }), 'pending');
  assert.equal(budgetUnitState({ reviewed: 3, returned: 1 }), 'returned');
  // 合併：代表紀錄取最有進展的、日期取最新的、筆數與各狀態都留著
  const rows = [
    { id: 'a1', category: '中央政府總預算案', name: '同一個案子', status: '交付審查', proposer: '行政院', fiscal_year: 115, session: 5, latest_date: '2026-04-21', url: 'u1', types: [] },
    { id: 'a2', category: '中央政府總預算案', name: '同一個案子', status: '審查完畢', proposer: '行政院', fiscal_year: 115, session: 5, latest_date: '2026-07-29', url: 'u2', types: [] },
    { id: 'a3', category: '中央政府總預算案', name: '同一個案子', status: '排入院會', proposer: '行政院', fiscal_year: 115, session: 4, latest_date: '2025-10-01', url: 'u3', types: [] },
    { id: 'b1', category: '中央政府總預算案', name: '另一個案子', status: '交付查照', proposer: '行政院', fiscal_year: 115, session: 5, latest_date: '2026-01-01', url: 'u4', types: [] },
  ];
  const merged = mergeBudgetUnits(rows);
  assert.equal(merged.length, 2, '兩個案名 → 兩列');
  const one = merged.find((u) => u.name === '同一個案子');
  assert.equal(one.records, 3);
  assert.deepEqual(one.states, { in_review: 1, reviewed: 1, pending: 1 });
  assert.equal(one.state, 'in_review', '還沒全部審完 → 審議中（不可以只看代表紀錄就說已審竣）');
  assert.equal(one.latest_date, '2026-07-29', '日期取最新');
  assert.equal(one.id, 'a2', '代表紀錄取最有進展的（審查完畢）');
});

test('一案一列：查詢預設合併，merge=none 才逐筆列', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const merged = listBudget(db, { scope: 'all', limit: 200 });
  assert.equal(merged.merge, 'name', '預設一案一列');
  const records = listBudget(db, { scope: 'all', merge: 'none', limit: 200 });
  assert.equal(records.merge, null);
  assert.equal(merged.total + 0 <= records.total, true, '合併後不會比逐筆多');
  assert.ok(merged.items.every((b) => b.records >= 1 && b.record_states));
  assert.equal(merged.records_total, records.total, '切到每筆議案時的件數＝records_total');
  assert.equal(records.merged_total, merged.total, '切到每筆議案時，「一案一列」那顆鈕還是要顯示合併後的件數');
  assert.equal(merged.merged_total, merged.total, '全部條件下，合併後件數＝merged_total');
  // 合併後每一列的狀態都要跟 record_states 一致（不會出現整列說已審竣、但裡面還有交付審查）
  for (const b of merged.items) {
    if (b.state === 'reviewed') assert.ok(!b.record_states.in_review && !b.record_states.pending && !b.record_states.returned, '說已審竣就不能還有未審完的紀錄');
  }
});

test('委員會同步：只做議案本身、做過不重打、失敗不動舊值', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const billCats = new Set(CONFIG.budget.billCategories);
  const billRows = db.prepare('SELECT id, category FROM budget_bills').all().filter((r) => billCats.has(r.category));
  const reportRows = db.prepare('SELECT id, category FROM budget_bills').all().filter((r) => !billCats.has(r.category));
  assert.ok(billRows.length > 0 && reportRows.length > 0, 'fixture 要有議案本身與報告類');

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes(reportRows[0].id)) throw new Error('報告類不該被查');
    return { json: { data: { 議案狀態: '交付審查', '會議代碼:str': '第11屆第5會期第7次會議', 議案流程: [{ 狀態: '排入院會 (交交通委員會)' }] } } };
  };
  const first = await runBudgetCommittees(db, { logger: silent, fetchImpl });
  assert.equal(first.status, 'success');
  assert.equal(first.checked, billRows.length, '只查議案本身那幾類');
  assert.equal(first.records, billRows.length, '每一筆都抓到委員會');
  assert.equal(calls.length, billRows.length);
  assert.ok(!calls.some((u) => reportRows.some((r) => u.includes(r.id))), '報告類不查（10,801 筆太多且委員會意義不大）');
  const map = getBudgetCommittees(db);
  assert.deepEqual(map.get(billRows[0].id).committees, ['交通委員會']);

  // 剛抓過 → 不再重打（refreshHours 預設 30 天）
  const again = await runBudgetCommittees(db, { logger: silent, fetchImpl });
  assert.equal(again.checked, 0, '抓過的不重打');
  assert.equal(calls.length, billRows.length);

  // 失敗時不要蓋掉舊值、也不要留下半筆
  const failing = async () => {
    throw new Error('boom');
  };
  const stale = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  for (const row of billRows) upsertBudgetCommittees(db, { id: row.id, committees: ['內政委員會'], status: '交付審查', meeting: 'x', fetchedAt: stale });
  const failed = await runBudgetCommittees(db, { logger: silent, fetchImpl: failing });
  assert.equal(failed.failed, billRows.length);
  assert.deepEqual(getBudgetCommittees(db).get(billRows[0].id).committees, ['內政委員會'], '失敗要保留舊值');
});

test('預算查詢：每一列帶委員會；一案一列時取成員紀錄的聯集', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const rows = db.prepare('SELECT id, name, category FROM budget_bills').all();
  upsertBudgetCommittees(db, { id: rows[0].id, committees: ['內政委員會'], status: '交付審查', meeting: null, fetchedAt: new Date().toISOString() });
  upsertBudgetCommittees(db, { id: rows[1].id, committees: ['交通委員會'], status: '交付審查', meeting: null, fetchedAt: new Date().toISOString() });
  const items = listBudget(db, { merge: 'none', limit: 200 }).items;
  assert.deepEqual(items.find((i) => i.id === rows[0].id).committees, ['內政委員會']);
  const merged = listBudget(db, { merge: 'name', limit: 200 }).items;
  // 沒有同名紀錄的案子：委員會要跟著那一筆
  const one = merged.find((i) => i.records === 1 && i.id === rows[0].id);
  if (one) assert.deepEqual(one.committees, ['內政委員會']);
  // 合併的案子：把成員紀錄的委員會聯集起來（順序照紀錄順序、去重）
  const sameName = rows.filter((r) => r.name === rows[0].name).map((r) => r.id);
  if (sameName.length > 1) {
    const unit = merged.find((i) => i.name === rows[0].name);
    for (const id of sameName) {
      const c = db.prepare('SELECT committees FROM budget_committees WHERE id = ?').get(id);
      if (c) for (const name of JSON.parse(c.committees)) assert.ok(unit.committees.includes(name), `${name} 應該在聯集裡`);
    }
  }
});

test('預算清單：勘誤表這類附件預設排除、要看得到筆數、可以切回來', async () => {
  const db = seeded();
  await runBudgetIngest(db, { logger: silent, fetchImpl: budgetOk });
  const insert = (id, category, name, status) =>
    db
      .prepare('INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url) VALUES(?, 11, 5, ?, ?, ?, ?, 115, ?, ?)')
      .run(id, category, name, status, '行政院', '2026-05-12', `https://example/${id}`);
  // 實際案例（2026-10-06）：115 年度總預算案的兩筆單位預算勘誤表，狀態「交付處理」→ 會被算成「審議中」
  insert('errata1', '中央政府總預算案', '函送「中華民國115年度中央政府總預算案內政部暨所屬單位預算勘誤表」，請查照案。', '交付處理');
  insert('errata2', '預(決) 算決議案、定期報告', '函送該部114年10月至12月「因公派員出國計畫考察費用執行情形勘誤表」，請查照案。', '交付處理');

  const without = listBudget(db, { merge: 'none', limit: 200 });
  assert.equal(without.attachment_count, 1, '議案類別裡的勘誤表要被排除並計數（報告類那筆不在預設範圍內）');
  assert.ok(!without.items.some((i) => i.id === 'errata1'), '勘誤表不列出來');
  assert.equal(listBudget(db, { merge: 'none', limit: 200, q: '勘誤' }).total, 0, '排除後連搜尋都找不到');
  const withIt = listBudget(db, { merge: 'none', limit: 200, includeAttachments: true });
  assert.equal(withIt.total, without.total + 1, '切回來要多那一筆');
  assert.equal(withIt.attachment_count, 1, 'containing 模式下筆數照報，只是改成「已包含」');
  assert.equal(withIt.include_attachments, true);
  assert.ok(withIt.items.some((i) => i.id === 'errata1'));
  // 統計也不能把那筆算進去（「審議中」會多 1）
  assert.equal(withIt.progress.in_review, without.progress.in_review + 1);
  // 報告類的勘誤表在 scope=all 也要排除
  const allScope = listBudget(db, { scope: 'all', merge: 'none', limit: 200 });
  assert.equal(allScope.attachment_count, 2);
  // 一般的預算案不受影響
  assert.ok(listBudget(db, { merge: 'none', limit: 200, q: '中央政府總預算' }).total > 0);
});
