import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, applyDataset, applyBills, applySocial, applyCommitteeMeets, upsertNews, saveSnapshot, recordSyncRun, getMeta, migrate } from '../server/db.mjs';
import { buildDataset, normalizeBills, normalizeSocial, newsName } from '../server/normalize.mjs';
import { billsCsv, compareLegislators, csvRow, makeTagger, listCommitteeActivity, listCosponsors, listFunds, listRegions, getHealth, getMetaPayload, listActivity, listBills, listTopics, listNews, listNewsArticles, listChanges, listCommittees, listLegislators, listRankings, listSyncRuns, listCounties, listDemographics, getTownMap, monthsSince, listLegislatorVotes, listSplitTicket, listRecalls } from '../server/queries.mjs';
import { regionOf } from '../server/normalize.mjs';
import { authorizeSync } from '../server/index.mjs';
import { runNewsIngest } from '../server/ingest.mjs';
import { FetchError } from '../server/fetch-ly.mjs';
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const silent = { log() {}, warn() {}, error() {} };
/** seeded() 已經寫入完整名冊，這裡只是讓「需要委員」的測試讀起來清楚 */
const seededWithRoster = () => seeded();
/** 讀 server/ 底下的資料檔（路徑相對於 test/fixtures） */
const dataFile = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, new URL('./fixtures/', import.meta.url))), 'utf8'));

function seeded() {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'), { sourceUrl: 'https://data.ly.gov.tw/' });
  const fetchedAt = '2026-09-30T09:00:00.000Z';
  applyDataset(db, dataset, { fetchedAt, sourceUrl: 'https://data.ly.gov.tw/' });
  saveSnapshot(db, 'id9', { fetchedAt, sha256: 'a'.repeat(64), bytes: 1234, json: fixture('id9.json') });
  saveSnapshot(db, 'id9', { fetchedAt, sha256: 'a'.repeat(64), bytes: 1234, json: fixture('id9.json') }); // 重複不該再寫
  recordSyncRun(db, {
    dataset: 'id9',
    status: 'success',
    started_at: fetchedAt,
    finished_at: fetchedAt,
    records: dataset.stats.legislators,
    attempt: 1,
    http_status: 200,
    duration_ms: 1234,
    ua: 'ly-dashboard/1.0 (test)',
    error: null,
  });
  return { db, dataset };
}

test('寫入後：預設查詢是本會期 113 人，且委員會已正規化', () => {
  const { db } = seeded();
  const current = listLegislators(db, {});
  assert.equal(current.total, 113);
  assert.equal(current.meta.term, 11);
  assert.equal(current.meta.session, '11-5');
  assert.ok(current.items.every((x) => x.committees.every((c) => !c.id.includes('會期'))));

  const all = listLegislators(db, { session: 'all' });
  assert.equal(all.total, 123, '全屆次檢視才看得到 123 位追蹤對象（含 2 位無會期紀錄者）');

  // 立法院固定 113 席：每個會期名錄都應該是 113 人，但「組成人員」會因辭職／遞補而不同。
  for (const sessionId of ['11-1', '11-2', '11-3', '11-4', '11-5']) {
    assert.equal(listLegislators(db, { session: sessionId }).total, 113, `${sessionId} 應為 113 人`);
  }

  const s1 = listLegislators(db, { session: '11-1' });
  const s5 = listLegislators(db, { session: '11-5' });
  const names = (x) => x.items.map((i) => i.name);
  assert.ok(names(s1).includes('黃國昌'), '第 1 會期應包含後來辭職的黃國昌');
  assert.ok(!names(s5).includes('黃國昌'), '第 5 會期不該再出現已辭職者');
  assert.ok(names(s5).includes('劉書彬'), '第 5 會期應包含遞補者');
  assert.equal(s1.items.find((i) => i.name === '黃國昌').former, true, '離職者要標記為 former');
});

test('篩選：黨籍、委員會、只看召委、關鍵字', () => {
  const { db } = seeded();
  const kmt = listLegislators(db, { party: '中國國民黨' });
  assert.ok(kmt.total > 40 && kmt.total < 60);
  assert.ok(kmt.items.every((x) => x.party === '中國國民黨'));

  const interior = listLegislators(db, { committee: '內政委員會' });
  assert.ok(interior.total >= 10);
  assert.ok(interior.items.every((x) => x.committees.some((c) => c.id === '內政委員會')));

  const conveners = listLegislators(db, { convener: '1' });
  assert.equal(conveners.total, 23, '本會期召委 23 人（去重）');

  const search = listLegislators(db, { q: '雲林' });
  assert.ok(search.total >= 1);
  assert.ok(search.items.every((x) => `${x.name}${x.area_name}${x.party}`.includes('雲林') || x.area_name.includes('雲林')));
});

test('委員會端點：本會期 11 個委員會，且只包含本會期真實存在的', () => {
  const { db } = seeded();
  const committees = listCommittees(db, {});
  assert.equal(committees.count, 11);
  assert.equal(committees.meta.session, '11-5');
  for (const c of committees.items) {
    assert.ok(c.count > 0);
    assert.ok(!c.id.includes('會期'));
  }
  const interior = committees.items.find((c) => c.id === '內政委員會');
  assert.ok(interior.conveners.length >= 1);

  const session1 = listCommittees(db, { session: '11-1' });
  assert.equal(session1.count, 10, '第 1 會期只有 10 個委員會（修憲委員會尚未成立）');
});

test('health / meta / changes / sync-runs 端點形狀正確', () => {
  const { db } = seeded();
  // 固定時鐘：資料是用固定時間戳寫入的，若拿「執行當下」判斷 stale，過了 36 小時這個測試就會自己變紅。
  const now = Date.parse('2026-09-30T10:00:00.000Z');
  const health = getHealth(db, { now });
  assert.equal(health.db.legislators, 123);
  assert.equal(health.db.committee_seats, 783);
  assert.equal(health.db.snapshots, 1, '相同 sha256 的快照不重複寫入');
  assert.equal(health.last_runs[0].records, 123);
  assert.equal(health.meta.stale, false);
  assert.equal(health.ok, true);

  // 同一份資料，時鐘往後推 37 小時 → 必須標記 stale 且 ok=false（原本沒有任何測試覆蓋這條路）
  const later = getHealth(db, { now: now + 37 * 3600 * 1000 });
  assert.equal(later.meta.stale, true, '超過 LY_STALE_HOURS 要標記 stale');
  assert.equal(later.ok, false, 'stale 時 /health 的 ok 應為 false');

  // db 欄位是固定清單產生（CR-9），不該因為沒有資料而少欄位
  assert.deepEqual(
    Object.keys(health.db),
    ['legislators', 'memberships', 'committee_seats', 'sessions', 'committees', 'changes', 'snapshots', 'sync_runs', 'bills', 'budget_bills', 'budget_reports', 'committee_meetings', 'news', 'social_accounts'],
  );

  const meta = getMetaPayload(db);
  assert.equal(meta.terms.length, 1);
  assert.equal(meta.terms[0].no, 11);
  assert.equal(meta.terms[0].sessions.length, 5);
  assert.deepEqual(meta.current, { term: 11, session: '11-5' });

  const changes = listChanges(db, { limit: 10 });
  assert.equal(changes.count, 0, '第一次寫入沒有前一份資料可比對，異動應為 0');

  const runs = listSyncRuns(db, { limit: 5 });
  assert.equal(runs.count, 1);
  assert.equal(runs.items[0].dataset, 'id9');
});

test('change_log：召委異動會被記錄（模擬真實改版）', () => {
  const db = openDb(':memory:');
  const id9 = fixture('id9.json');
  const id14 = fixture('id14.json');
  const fetchedAt = '2026-09-30T09:00:00.000Z';
  applyDataset(db, buildDataset(id9, id14), { fetchedAt });

  // 模擬：某位現任委員在 id14 中被標記為召委
  const target = id9.dataList.find((r) => r.name === '丁學忠');
  const patched = {
    dataList: id14.dataList.map((r) =>
      r.name === '丁學忠' && r.term === '11' && r.sessionPeriod === '5' && r.committee === '內政委員會'
        ? { ...r, isCoChairman: 'Y' }
        : r,
    ),
  };
  const after = buildDataset(id9, patched);
  const { changes } = applyDataset(db, after, { fetchedAt: '2026-09-30T10:00:00.000Z' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'is_convener');
  assert.equal(changes[0].old_value, '0');
  assert.equal(changes[0].new_value, '1');

  const logged = listChanges(db, { limit: 10 });
  assert.equal(logged.count, 1);
  assert.equal(logged.items[0].new_value, '1');
  assert.equal(logged.items[0].entity_id, '11-5|內政委員會|00001', '席次以穩定 id（立院 lgno）標識');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T10:00:00.000Z');
  assert.equal(target.name, '丁學忠');
});

test('A4: getHealth().last_runs items have the same fields as listSyncRuns', () => {
  const { db } = seeded();
  const health = getHealth(db);
  assert.ok(health.last_runs.length > 0);
  const expectedKeys = ['id', 'dataset', 'status', 'started_at', 'finished_at', 'records', 'attempt', 'http_status', 'duration_ms', 'ua', 'error'].sort();
  for (const run of health.last_runs) {
    assert.deepEqual(Object.keys(run).sort(), expectedKeys);
  }
});

test('CR-7：POST /api/v1/sync 的授權（設了 token 就一定要帶對；沒設 token 只限 loopback）', () => {
  // 沒設 token + 綁 loopback → 放行（本機維運的預設情境）
  assert.equal(authorizeSync({}, { host: '127.0.0.1', token: '' }), null);
  assert.equal(authorizeSync({}, { host: 'localhost', token: '' }), null);
  assert.equal(authorizeSync({}, { host: '::1', token: '' }), null);

  // 沒設 token + 綁對外 → 停用（不是警告，是直接不給用）
  const disabled = authorizeSync({}, { host: '0.0.0.0', token: '' });
  assert.equal(disabled?.status, 403);
  assert.equal(disabled?.code, 'sync_disabled');

  // 設了 token → 對外也開放，但一定要帶對
  assert.equal(authorizeSync({ 'x-sync-token': 's3cret' }, { host: '0.0.0.0', token: 's3cret' }), null);
  assert.equal(authorizeSync({}, { host: '0.0.0.0', token: 's3cret' })?.status, 401);
  assert.equal(authorizeSync({ 'x-sync-token': 'wrong' }, { host: '0.0.0.0', token: 's3cret' })?.status, 401);
  assert.equal(authorizeSync({ 'x-sync-token': 's3cre' }, { host: '127.0.0.1', token: 's3cret' })?.status, 401, '前綴不算通過');
  // header 可能是陣列（Node 對重複標頭的行為）→ 不可以崩潰
  assert.equal(authorizeSync({ 'x-sync-token': ['a', 'b'] }, { host: '127.0.0.1', token: 's3cret' })?.status, 401);
});

test('A5: Paging parameters are correctly clamped at trust boundary', () => {
  const { db } = seeded();
  const leg = listLegislators(db, { offset: -5 });
  const leg0 = listLegislators(db, { offset: 0 });
  assert.deepEqual(leg.items[0], leg0.items[0]);
  assert.ok(leg.count <= leg.total);
  
  const ch = listChanges(db, { limit: -1 });
  assert.ok(ch.count <= 1000);
});

test('寫入是交易：中途失敗不會留下半套資料', () => {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  applyDataset(db, dataset, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const before = listLegislators(db, {}).total;

  const broken = structuredClone(dataset);
  broken.seats[0].legislator_id = null; // 觸發 NOT NULL / FK 失敗
  assert.throws(() => applyDataset(db, broken, { fetchedAt: '2026-09-30T11:00:00.000Z' }));
  assert.equal(listLegislators(db, {}).total, before, '失敗後仍應是舊資料');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T09:00:00.000Z');
});

test('選區篩選：region 為縣市層級，且可精確篩選', () => {
  const { db } = seeded();
  const all = listLegislators(db, {});
  assert.ok(all.items.every((x) => x.region && !x.region.includes('選舉區')));
  const yunlin = listLegislators(db, { region: '雲林縣' });
  assert.equal(yunlin.total, 2);
  assert.ok(yunlin.items.every((x) => x.area_name.startsWith('雲林縣')));
  assert.equal(listLegislators(db, { region: '不存在的縣' }).total, 0);
});

test('個人資料：聯絡方式與就職日期', () => {
  const { db } = seeded();
  const ting = listLegislators(db, { q: '丁學忠' }).items[0];
  assert.equal(ting.onboard_date, '2024/02/01');
  assert.equal(ting.contacts[0].label, '國會研究室');
  assert.equal(ting.contacts[0].tel, '02-2358-8156');
});

test('遷移：舊資料庫補上 contacts 欄位並清掉 applied_sha 以便重新套用', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE legislators (id TEXT PRIMARY KEY, name TEXT NOT NULL);
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
           INSERT INTO meta VALUES ('applied_sha', 'old');`);
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(legislators)').all().map((c) => c.name);
  assert.ok(cols.includes('contacts'));
  assert.equal(getMeta(db, 'applied_sha'), null);
  migrate(db); // 第二次不該出錯
});

test('議案端點：依委員篩選、最新在前、主題（法律）統計', () => {
  const { db, dataset } = seeded();
  applyBills(db, normalizeBills([fixture('bills-page.json')], new Map(dataset.legislators.map((l) => [l.name, l.id]))), { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const liao = dataset.legislators.find((l) => l.name === '廖偉翔').id;
  const res = listBills(db, { legislator: liao, limit: 10 });
  assert.equal(res.total, 51);
  assert.equal(res.count, 10);
  assert.equal(res.items.filter((b) => b.is_lead).length <= 10, true);
  assert.ok(res.items.every((b, i, arr) => i === 0 || arr[i - 1].latest_date >= b.latest_date), '最新在前');
  assert.ok(res.laws.length > 0 && res.laws.every((l, i, arr) => i === 0 || arr[i - 1].count >= l.count));
  assert.equal(res.meta.bills_fetched_at, '2026-09-30T09:00:00.000Z');
  assert.equal(listBills(db, { legislator: 'nobody' }).total, 0);
  assert.equal(listBills(db, {}).total, 300);
});

test('名錄表格欄位：提案數／新聞數；委員會含黨籍組成且加總等於席次', () => {
  const { db } = seeded();
  const items = listLegislators(db, {}).items;
  assert.ok(items.every((x) => Number.isInteger(x.bill_count) && Number.isInteger(x.news_count)));
  for (const c of listCommittees(db, {}).items) {
    assert.equal(Object.values(c.parties).reduce((a, b) => a + b, 0), c.count, c.id);
  }
});

function withActivity() {
  const { db, dataset } = seeded();
  const idByName = new Map(dataset.legislators.map((l) => [l.name, l.id]));
  applyBills(db, normalizeBills([fixture('bills-page.json')], idByName), { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const serving = new Map(dataset.legislators.filter((l) => !l.leave_flag).map((l) => [newsName(l.name), l.id]));
  const csv = readFileSync(fileURLToPath(new URL('./fixtures/social.csv', import.meta.url)), 'utf8');
  applySocial(db, normalizeSocial(csv, serving).accounts, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  upsertNews(db, idByName.get('丁學忠'), [{ title: '丁學忠質詢', source: '測試報', url: 'https://example.com/1', published_at: '2026-09-29T08:00:00.000Z' }], { fetchedAt: '2026-09-30T09:00:00.000Z' });
  return { db, idByName };
}

test('議案查詢：關鍵字、法律、狀態可組合，並附提案人與黨籍', () => {
  const { db } = withActivity();
  const all = listBills(db, { limit: 5 });
  assert.equal(all.total, 300);
  assert.ok(all.statuses.length > 0 && all.laws.length > 0);
  const food = listBills(db, { q: '食品安全' });
  assert.ok(food.total > 0 && food.items.every((b) => b.name.includes('食品安全') || b.laws.some((l) => l.includes('食品安全'))));
  const law = all.laws[0].name;
  assert.equal(listBills(db, { law }).total, all.laws[0].count, '法律精確篩選件數＝主題統計件數');
  const passed = listBills(db, { status: '三讀' });
  assert.ok(passed.items.every((b) => b.status === '三讀'));
  const withSponsors = listBills(db, { limit: 20 }).items.find((b) => b.sponsors.length);
  assert.ok(withSponsors.sponsors[0].name && withSponsors.sponsors[0].party);
  assert.deepEqual(listBills(db, { offset: 295, limit: 10 }).count, 5);
});

test('熱門議題：以最新議案日期為基準、依件數排序、黨籍分布加總等於件數', () => {
  const { db } = withActivity();
  const topics = listTopics(db, { days: 30, limit: 10 });
  assert.ok(topics.window?.to, '要有資料截止日');
  assert.equal(topics.vocab, 'law');
  assert.ok(topics.items.length > 0);
  assert.ok(topics.items.every((t, i, arr) => i === 0 || arr[i - 1].count >= t.count), '件數要遞減');
  for (const t of topics.items) {
    assert.ok(t.name, '要有詞彙名稱');
    assert.equal(Object.values(t.parties).reduce((a, b) => a + b, 0), t.count, `${t.name} 的黨籍分布總和要等於件數`);
    assert.equal(typeof topics.comparable, 'boolean');
    if (topics.comparable) assert.equal(t.delta, t.count - t.previous_count, '可比較時 delta 要等於本期減前期');
    else assert.equal(t.delta, 0, '不可比較（本屆累計／前期早於資料起點）時 delta 必須是 0，不能報錯誤的增減');
    assert.ok(typeof t.recent_count === 'number');
  }
});

test('熱門議題：本屆累計比區間大、詞彙可切換、增減與近 7 天都算得出來', () => {
  const db = seededFull();
  const all = listTopics(db, { days: 'all', limit: 20, vocab: 'law' });
  const recent = listTopics(db, { days: 7, limit: 20, vocab: 'law' });
  assert.ok(all.distinct >= recent.distinct, '本屆累計的詞彙數不該少於 7 天');
  assert.ok(all.items[0].count >= (recent.items[0]?.count ?? 0), '本屆累計的件數不該少於 7 天');
  assert.equal(all.window.days, 0);
  assert.equal(all.items[0].previous_count, 0, '本屆累計不跟前一期比較');

  for (const vocab of ['law', 'category', 'committee']) {
    const res = listTopics(db, { days: 'all', limit: 20, vocab });
    assert.equal(res.vocab, vocab);
    assert.ok(res.vocabularies.some((v) => v.id === vocab && v.label && v.unit), '要回傳詞彙清單與單位');
    for (const item of res.items) {
      assert.ok(item.count > 0);
      assert.ok(item.latest_date >= (res.window.from ?? ''));
      assert.ok(item.recent_count <= item.count, '近 7 天不可能多於期間總數（本屆累計時）');
    }
  }

  const unknown = listTopics(db, { days: 30, vocab: '不存在的詞彙' });
  assert.equal(unknown.vocab, 'law', '未知詞彙要退回預設而不是壞掉');
});

test('最近動態：取貼文／新聞／議案中最新者排序，只列在職委員', () => {
  const { db, idByName } = withActivity();
  const res = listActivity(db, { limit: 20 });
  assert.equal(res.count, 20);
  assert.ok(res.items.every((x, i, arr) => i === 0 || arr[i - 1].activity_date >= x.activity_date));
  const ting = listActivity(db, { limit: 113 }).items.find((x) => x.legislator.id === idByName.get('丁學忠'));
  assert.equal(ting.news.title, '丁學忠質詢');
  assert.ok(ting.post?.summary);
  assert.equal(listNews(db, {}).items[0].legislator_name, '丁學忠');
  const tingRow = listLegislators(db, { session: 'all' }).items.find((x) => x.id === idByName.get('丁學忠'));
  assert.ok(tingRow.top_source && tingRow.top_source.count <= tingRow.news_count, '名冊附每人報導最多的媒體');
  assert.ok(compareLegislators(db, { ids: tingRow.id }).items[0].top_sources.length > 0, '比較頁附前 5 家媒體');
  const articles = listNewsArticles(db, { limit: 100 });
  assert.equal(new Set(articles.items.map((a) => a.url)).size, articles.items.length, '同一篇只列一次');
  const outlet = articles.sources[0].name;
  assert.ok(listNewsArticles(db, { source: outlet }).items.every((a) => a.source === outlet), '依媒體篩選');
  assert.equal(listNewsArticles(db, { source: outlet }).sources[0].name, outlet, '媒體統計不受媒體條件影響');
  assert.equal(listNewsArticles(db, { q: '丁學忠' }).items.every((a) => a.title.includes('丁學忠')), true, '關鍵字比對標題');
  db.prepare("INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES('official:卓榮泰', 'https://example.com/o1', '卓榮泰談物價', 'UDN', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z')").run();
  const officialNews = listNewsArticles(db, { scope: 'officials' });
  assert.equal(officialNews.total, 1);
  assert.equal(officialNews.items[0].legislators[0].name, '卓榮泰', '首長新聞列出被提到的首長');
  assert.equal(officialNews.people.find((p) => p.id === '卓榮泰').count, 1, '首長名單附則數');
  assert.equal(listNewsArticles(db, { scope: 'officials', legislator: '劉世芳' }).total, 0);
  // 近 7 天則數（總覽統計卡）：以現在時間起算、同一篇只算一次；8 天前的不算
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const before = listNewsArticles(db, { scope: 'officials' }).recent_7d; // 上面固定日期的那則落不落在近 7 天，取決於跑測試的日子
  const official = db.prepare('INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES(?, ?, ?, ?, ?, ?)');
  official.run('official:卓榮泰', 'https://example.com/o2', '卓榮泰與劉世芳視察', 'UDN', ago(1), ago(0));
  official.run('official:劉世芳', 'https://example.com/o2', '卓榮泰與劉世芳視察', 'UDN', ago(1), ago(0));
  official.run('official:卓榮泰', 'https://example.com/o3', '卓榮泰上週行程', 'UDN', ago(8), ago(0));
  assert.equal(listNewsArticles(db, { scope: 'officials' }).recent_7d, before + 1, '兩位首長同一篇只算一則，8 天前不算');
  const { sources, source_total: sourceTotal } = listNews(db, {});
  assert.ok(sources.length > 0 && sources.length <= Math.min(12, sourceTotal), '新聞來源最多 12 家');
  assert.ok(sources.every((s, i, a) => i === 0 || a[i - 1].count >= s.count), '依則數排序');
  assert.ok(sources.every((s) => Object.values(s.parties).reduce((x, y) => x + y, 0) >= s.count), '黨籍人次不少於則數');
});

test('依 id 取單一委員（首頁／法案頁開檔案用）', () => {
  const { db, dataset } = seeded();
  const id = dataset.legislators.find((l) => l.name === '丁學忠').id;
  const res = listLegislators(db, { id });
  assert.equal(res.total, 1);
  assert.equal(res.items[0].name, '丁學忠');
});

/* ---------------- 排行榜與新資料集（H1/H2/M2/M4/M5 之後新增） ---------------- */

const text = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

function seededFull() {
  const { db, dataset } = seeded();
  const fetchedAt = '2026-09-30T09:00:00.000Z';
  const idByName = new Map(dataset.legislators.map((l) => [l.name, l.id]));
  applyBills(db, normalizeBills([fixture('bills-page.json')], idByName), { fetchedAt });
  applySocial(db, normalizeSocial(text('social.csv'), new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]))).accounts, { fetchedAt });

  const newsIdByLegislator = new Map(dataset.legislators.map((l) => [l.id, l.id]));
  let serial = 0;
  for (const [id] of newsIdByLegislator) {
    const count = id === '00001' ? 5 : id === '00002' ? 3 : 1; // 讓第一名可預期
    upsertNews(
      db,
      id,
      Array.from({ length: count }, () => ({
        url: `https://news.example/${id}/${serial++}`,
        title: `${id} 的新聞`,
        source: '測試來源',
        published_at: new Date(Date.now() - serial * 3600_000).toISOString(),
      })),
      { fetchedAt },
    );
  }
  return db;
}

test('排行榜：三種榜都有資料、名次連續、intensity 以第一名為 1', () => {
  const db = seededFull();
  const boards = listRankings(db, { type: 'all', limit: 10 });

  // 新增「險勝」「得票流失」兩榜之後，這裡的清單沒有跟著更新 → 上游 main 一直是紅的（2026-10-02 修）
  assert.deepEqual(Object.keys(boards.boards).sort(), ['bills', 'close', 'drop', 'facebook', 'news']);
  for (const board of Object.values(boards.boards)) {
    assert.ok(board.title && board.note, '每個榜都要有標題與說明');
    // 險勝／流失榜來自選舉資料（靜態檔），這個 fixture 沒有選舉資料時可以是空的
    if (board.type !== 'close' && board.type !== 'drop') assert.ok(board.items.length > 0, `${board.type} 應該有資料`);
    board.items.forEach((item, i) => {
      assert.equal(item.rank, i + 1, '名次要連續');
      assert.ok(item.legislator.id && item.legislator.name, '每列都要有委員');
      assert.ok(item.intensity > 0 && item.intensity <= 1, 'intensity 必須在 (0,1]');
    });
    assert.equal(board.items[0].intensity, 1, '第一名長度為 1');
  }

  const news = boards.boards.news.items;
  assert.equal(news[0].legislator.id, '00001', '新聞數最多者應排第一');
  assert.equal(news[0].value, 5);
  assert.ok(news[0].value >= news[1].value, '新聞榜需遞減');

  const bills = boards.boards.bills.items;
  for (let i = 1; i < bills.length; i++) assert.ok(bills[i - 1].value >= bills[i].value, '法案榜需遞減');
  assert.ok(bills[0].lead_count >= 0 && bills[0].detail.label.includes('主提案'));

  const facebook = boards.boards.facebook.items;
  for (let i = 1; i < facebook.length; i++) {
    assert.ok(facebook[i - 1].raw_days <= facebook[i].raw_days, '臉書榜要依「幾天前」由小到大（越新越前面）');
  }
});

test('排行榜：只列入在職委員，且可只取單一榜', () => {
  const db = seededFull();
  // 讓某位已離職委員擁有大量新聞與提案，確認不會出現在排行榜
  const former = db.prepare('SELECT id FROM legislators WHERE leave_flag = 1 LIMIT 1').get().id;
  db.prepare(
    'INSERT OR IGNORE INTO bill_sponsors(bill_id, legislator_id, is_lead) SELECT id, ?, 1 FROM bills LIMIT 200',
  ).run(former);

  const boards = listRankings(db, { type: 'bills', limit: 50 });
  assert.equal(Object.keys(boards.boards).length, 1, 'type=bills 只回一個榜');
  assert.ok(!boards.boards.bills.items.some((i) => i.legislator.id === former), '離職委員不該進排行榜');

  const newsOnly = listRankings(db, { type: 'news', days: 1, limit: 3 });
  assert.deepEqual(Object.keys(newsOnly.boards), ['news']);
  assert.ok(newsOnly.boards.news.items.length <= 3);
  assert.equal(newsOnly.days, 1);
});

test('health：回報各資料集的最後同步時間與新聞狀態（M4/M5 可見性）', () => {
  const db = seededFull();
  const health = getHealth(db);
  assert.ok(health.datasets.bills.fetched_at);
  assert.ok(health.datasets.news.count > 0);
  assert.equal(health.datasets.social.count, health.db.social_accounts);
  assert.equal(health.db.bills > 0, true);
  assert.ok(Array.isArray(health.warnings));
});

/* ---------------- 日期區間／CSV／共同提案／比較 ---------------- */

test('議案：日期區間、主提案黨籍分布、CSV 匯出', () => {
  const { db } = withActivity();
  const all = listBills(db, { limit: 300 });
  const mid = '2026-08-27'; // fixture：08-26 157 件、08-27 72 件、08-28 71 件
  const recent = listBills(db, { from: mid, limit: 200 });
  assert.ok(recent.total > 0 && recent.total < all.total && recent.items.every((b) => b.latest_date >= mid));
  const older = listBills(db, { to: mid, limit: 200 });
  assert.ok(older.items.every((b) => b.latest_date <= mid));
  assert.equal(listBills(db, { from: 'not-a-date' }).total, all.total, '格式不對視為未指定');
  assert.equal(Object.values(all.parties).reduce((a, b) => a + b, 0), all.total, '黨籍分布加總＝件數');
  assert.equal(listBills(db, { all: true }).count, 300, 'all 不受 200 上限');

  const csv = billsCsv(listBills(db, { all: true }).items).split('\r\n');
  assert.equal(csv.length, 301);
  assert.ok(csv[0].startsWith('議案編號,'));
  assert.equal(csvRow(['a,b', 'say "hi"', 'x']), '"a,b","say ""hi""",x');
});

test('最近動態：ids 只列指定委員（追蹤名單）', () => {
  const { db, idByName } = withActivity();
  const id = idByName.get('丁學忠');
  const res = listActivity(db, { limit: 113, ids: id });
  assert.deepEqual(res.items.map((x) => x.legislator.id), [id]);
});

test('共同提案：夥伴排序、跨黨比例、黨籍矩陣', () => {
  const { db } = withActivity();
  const top = db.prepare('SELECT legislator_id AS id FROM bill_sponsors GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1').get().id;
  const res = listCosponsors(db, { legislator: top, limit: 5 });
  assert.ok(res.items.length > 0 && res.items.length <= 5);
  assert.ok(res.items.every((x, i, arr) => i === 0 || arr[i - 1].count >= x.count));
  assert.ok(!res.items.some((x) => x.id === top), '不含自己');
  assert.ok(res.cross_party_bills <= res.total_bills);
  assert.ok(Object.keys(listCosponsors(db, {}).matrix).length > 0);
  assert.equal(listCosponsors(db, { legislator: 'nobody' }).items.length, 0);
});

test('比較：兩位委員的統計與共同提案', () => {
  const { db } = withActivity();
  const [a, b] = db.prepare('SELECT legislator_id AS id FROM bill_sponsors GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 2').all().map((r) => r.id);
  const res = compareLegislators(db, { ids: `${a},${b},${a},missing` });
  assert.equal(res.count, 2, '去重、略過不存在的 id');
  assert.ok(res.items[0].bills >= res.items[0].lead_bills && res.items[0].bills >= res.items[0].passed_bills);
  const both = db.prepare('SELECT COUNT(*) AS n FROM bill_sponsors x JOIN bill_sponsors y ON x.bill_id = y.bill_id WHERE x.legislator_id = ? AND y.legislator_id = ?').get(a, b).n;
  assert.equal(res.shared.bills, Number(both));
});

test('議案：會期篩選，會期分布在會期條件前算，每筆附屆次', () => {
  const { db } = withActivity();
  const all = listBills(db, { limit: 5 });
  assert.equal(all.term, 11);
  assert.ok(all.sessions.length > 0);
  assert.equal(all.sessions.reduce((sum, s) => sum + s.count, 0), all.total);
  const seq = all.sessions[0].seq;
  const one = listBills(db, { session: seq, limit: 200 });
  assert.equal(one.total, all.sessions[0].count);
  assert.ok(one.items.every((b) => b.session === seq && b.term === 11));
  assert.deepEqual(one.sessions, all.sessions, '選了會期，會期清單不變');
});

test('各區域：在職委員依選區分組、縣市由北到南、最新動態依日期新到舊', () => {
  const { db, idByName } = withActivity();
  const res = listRegions(db, { per: 3 });
  assert.equal(res.items.reduce((sum, r) => sum + r.legislators.length, 0), 113, '每位在職委員剛好出現在一個區域');
  const names = res.items.map((r) => r.region);
  assert.ok(names.indexOf('臺北市') < names.indexOf('高雄市') && names.indexOf('高雄市') < names.indexOf('全國不分區'));
  for (const r of res.items) {
    assert.ok(r.latest.length <= 3);
    assert.ok(r.latest.every((x, i, a) => i === 0 || a[i - 1].date >= x.date));
  }
  const yunlin = res.items.find((r) => r.legislators.some((l) => l.id === idByName.get('丁學忠')));
  assert.equal(yunlin.region, '雲林縣');
  assert.ok(yunlin.latest.some((x) => x.kind === 'news' && x.text === '丁學忠質詢'));
});

test('基金／機關／財團法人／行政法人：名稱與簡稱歸到正式名稱，每個名稱只歸一類', () => {
  const titles = ['函送財團法人海外信用保證基金決算', '函送財團法人高等教育評鑑中心基金會等10家財團法人決算書案'];
  const tag = makeTagger(titles);
  const only = (type, names) => ({ fund: [], agency: [], foundation: [], administrative: [], [type]: names });
  assert.deepEqual(tag('檢送交通作業基金（國道公路建設管理基金）決議').fund, ['交通作業基金', '國道公路建設管理基金']);
  assert.deepEqual(tag('撥補台電711億'), only('fund', ['台灣電力股份有限公司']), '國營事業只算基金');
  assert.deepEqual(tag('交通部擬設立韌性特別基金'), { ...only('fund', ['其他基金']), agency: ['交通部'] }, '機關命中不影響「其他基金」');
  assert.deepEqual(tag('國家通訊傳播委員會預算凍結'), only('agency', ['國家通訊傳播委員會']));
  assert.deepEqual(tag(titles[1]), only('foundation', ['高等教育評鑑中心基金會']), '名稱內的「等」「中心」不截斷');
  assert.deepEqual(tag('海外信用保證基金增資'), only('foundation', ['海外信用保證基金']), '取出的財團法人不帶前綴也認得，且不算「其他基金」');
  assert.deepEqual(tag('國家表演藝術中心年度預算'), only('administrative', ['國家表演藝術中心']), '行政法人優先於機關代碼表');
  assert.deepEqual(tag('馬英九基金會陸生訪團'), only('foundation', ['其他基金會']));
  assert.deepEqual(tag('大學生參訪文化觀光'), only('fund', []), '泛用簡稱不算');

  const { db } = withActivity();
  db.prepare('INSERT INTO budget_bills (id, category, name, status, proposer, latest_date, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'b1', '法人預(決)算案', '函送就業安定基金115年度預算', '交付審查', '勞動部', '2026-09-01', 'https://example.com/b1',
  );
  const all = listFunds(db, {});
  assert.ok(all.items.every((x, i, a) => x.funds.length && (i === 0 || a[i - 1].date >= x.date)));
  assert.equal(Object.values(all.kinds).reduce((a, b) => a + b, 0), all.total);
  const jobs = listFunds(db, { fund: '就業安定基金' });
  assert.equal(jobs.kinds.budget, 1);
  assert.ok(jobs.items.every((x) => x.funds.includes('就業安定基金')));
  assert.equal(listFunds(db, { kind: 'report' }).total, 0);
  assert.equal(listFunds(db, { type: 'agency', fund: '就業安定基金' }).total, 0, '基金不出現在機關頁');
  db.prepare('INSERT INTO budget_bills (id, category, name, status, proposer, latest_date, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'b2', '預(決) 算決議案、定期報告', '函送114年度中央政府預算執行情形書面報告', '交付查照', '行政院主計總處', '2026-09-02', 'https://example.com/b2',
  );
  db.prepare('INSERT INTO budget_bills (id, category, name, status, proposer, latest_date, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'b3', '預(決) 算決議案、定期報告', '函送國防部主計局報告', '交付查照', '國防部', '2026-09-03', 'https://example.com/b3',
  );
  db.prepare('INSERT INTO budget_bills (id, category, name, status, proposer, latest_date, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'b4', '預(決) 算決議案、定期報告', '函送臺北市政府主計處資料', '交付查照', '臺北市政府', '2026-09-04', 'https://example.com/b4',
  );
  const dgbas = listFunds(db, { type: 'dgbas' });
  assert.deepEqual(dgbas.items.map((x) => x.funds), [['地方主計處'], ['僅提及主計'], ['主計總處提送']], '只說主計的另外標示，地方主計處單獨一類');
});

test('委員會動態：公報只留委員會紀錄、依委員會篩選（聯席會議兩邊都算）', async () => {
  const { committeesOf, normalizeCommitteeRecords } = await import('../server/normalize.mjs');
  const { applyCommitteeRecords, applyMeetings } = await import('../server/db.mjs');
  assert.deepEqual(committeesOf('社會福利及衛生環境、司法及法制委員會第2次聯席會議'), ['社會福利及衛生環境委員會', '司法及法制委員會']);
  assert.deepEqual(committeesOf('朝野黨團協商(財政委員會)'), ['財政委員會']);
  assert.deepEqual(committeesOf('全院委員會公聽會'), ['全院委員會']);
  assert.deepEqual(committeesOf('繼續審查114年度中央政府總預算案關於國軍退除役官兵輔導委員會'), [], '議程文字不當成委員會');
  assert.throws(() => normalizeCommitteeRecords([{}], 3), /gazetteagendas/);

  const records = normalizeCommitteeRecords([fixture('gazette-agendas.json')], 3);
  assert.equal(records.length, 6, '只留類別代碼 3');
  assert.ok(records.every((r) => r.id && r.title && r.html_url?.startsWith('https://') && r.date));

  const { db } = seeded();
  applyCommitteeRecords(db, records, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  applyMeetings(db, [{ date: '2026-08-20', committee: '財政委員會', joint: '經濟委員會', name: '財經聯席', content: '審查', speakers: [{ name: '丁學忠', id: null }] }], {
    fetchedAt: '2026-09-30T09:00:00.000Z',
  });
  const all = listCommitteeActivity(db, {});
  assert.equal(all.records.total, 6);
  assert.ok(all.records.items.every((x, i, a) => i === 0 || a[i - 1].date >= x.date));
  const order = ['內政委員會', '外交及國防委員會', '經濟委員會', '財政委員會', '教育及文化委員會', '交通委員會', '司法及法制委員會', '社會福利及衛生環境委員會'];
  const ranks = all.committees.map((c) => order.indexOf(c.name)).filter((i) => i >= 0);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '常設委員會依官網順序排');
  const econ = listCommitteeActivity(db, { committee: '經濟委員會' });
  assert.equal(econ.meetings.total, 1, '聯席會議也算在經濟委員會');
  assert.ok(econ.records.items.every((r) => r.committees.includes('經濟委員會')));
});

test('機關回覆與會議附件：依種類分開、標題對出委員、依會議名稱掛到會議上', async () => {
  const { normalizeCommitteeMeets } = await import('../server/normalize.mjs');
  const { applyCommitteeMeets, applyMeetings } = await import('../server/db.mjs');
  assert.throws(() => normalizeCommitteeMeets([{}]), /meets/);
  const meets = normalizeCommitteeMeets([fixture('meets.json')]);
  assert.equal(meets.length, 3);
  const edu = meets.find((m) => m.title.includes('教育及文化'));
  assert.ok(edu.video_url?.startsWith('https://ivod.ly.gov.tw/'));
  assert.deepEqual(edu.committees, ['教育及文化委員會']);
  assert.ok(meets.every((m) => new Set(m.attachments.map((a) => a.url)).size === m.attachments.length), '附件依連結去重');

  const { db } = seeded();
  applyCommitteeMeets(db, meets, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  applyMeetings(db, [{ date: edu.date, committee: '教育及文化委員會', joint: null, name: `(會議取消)立法院${edu.title.replace(/^立法院/, '')}`, content: '審查', speakers: [] }], {
    fetchedAt: '2026-09-30T09:00:00.000Z',
  });
  const res = listCommitteeActivity(db, { limit: 200 });
  assert.equal(res.meetings.items[0].video_url, edu.video_url, '去掉「(會議取消)」前綴後仍對得上');
  const inner = listCommitteeActivity(db, { committee: '內政委員會', limit: 200 });
  assert.ok(inner.replies.total > 0 && inner.replies.items.every((r) => r.committees.includes('內政委員會')));
  const named = inner.replies.items.find((r) => r.title.includes('徐欣瑩'));
  assert.deepEqual(named?.legislators.map((l) => l.name), ['徐欣瑩']);
});

test('社群整理表：有 Threads 欄位才讀，貼文日期與摘要跟著帳號', () => {
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  const ids = new Map(dataset.legislators.map((l) => [newsName(l.name), l.id]));
  const [head, first, ...rest] = text('social.csv').trimEnd().split(/\r?\n/);
  const csv = [`${head},Threads連結,Threads最新貼文日期,Threads最新貼文主題摘要`, `${first},https://www.threads.com/@wu_szuyao,2026-09-28,選戰摘要`, ...rest].join('\n');
  const threads = normalizeSocial(csv, ids).accounts.filter((a) => a.platform === 'threads');
  assert.deepEqual(threads.map((a) => [a.url, a.latest_post_date, a.latest_post_summary]), [['https://www.threads.com/@wu_szuyao', '2026-09-28', '選戰摘要']]);
  assert.equal(normalizeSocial(text('social.csv'), ids).accounts.filter((a) => a.platform === 'threads').length, 0, '沒有欄位就不產生 Threads');});

/* ---------------- 第三輪 review（2026-10-02）修掉的行為，每一條都先重現過才修 ---------------- */

test('F1: vocab=category 要把預算案一起算進來（曾經整批被靜默丟掉）', () => {
  const { db } = seeded();
  db.prepare(
    `INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url)
     VALUES('b1', 11, '11-5', '法案一', '三讀', '法律案', '', '[]', '2026-09-29', 'u')`,
  ).run();
  db.prepare(
    `INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url)
     VALUES('z1', 11, '11-5', '中央政府總預算案', '總預算', '交付審查', '行政院', '115', '2026-09-30', 'u')`,
  ).run();

  const topics = listTopics(db, { days: 'all', vocab: 'category' });
  const names = topics.items.map((i) => i.name);
  assert.ok(names.includes('中央政府總預算案'), `預算案的類別必須出現（實際：${names.join('、')}）`);
  assert.equal(topics.items.find((i) => i.name === '中央政府總預算案').count, 1);
  // 資料截止日也要把預算案算進去（只看 bills 的話 bills 一空整頁就回空）
  assert.equal(topics.data_to, '2026-09-30');
});

test('F2: /news 的 total 要跟 items 用同一組 JOIN（孤兒新聞不可讓 total 虛胖）', () => {
  const { db, dataset } = seeded();
  upsertNews(db, dataset.legislators[0].id, [{ title: '正常新聞', source: 'x', url: 'https://e/1', published_at: '2026-09-30T00:00:00.000Z' }], {
    fetchedAt: '2026-09-30T09:00:00.000Z',
  });
  // news 累積 180 天，但 legislators 每次同步整批重建 → 一定會有對不到委員的列
  db.prepare(
    `INSERT INTO news(legislator_id, title, source, url, published_at, fetched_at)
     VALUES('已經不在名錄的人', '孤兒新聞', 'x', 'https://e/orphan', '2026-09-30T00:00:00.000Z', '2026-09-30T09:00:00.000Z')`,
  ).run();

  const res = listNews(db, { limit: 10 });
  assert.equal(res.total, res.items.length, 'total 不可以比實際能回傳的列數多');
  assert.equal(res.total, 1);
});

test('F3: 名錄為空時 /committee-activity 不可以 500（空樣式 regex 的 TypeError）', () => {
  const db = openDb(':memory:');
  applyCommitteeMeets(
    db,
    [
      {
        meet_code: 'M1',
        title: '第11屆第5會期內政委員會第1次全體委員會議',
        date: '2026-09-30',
        committees: ['內政委員會'],
        video_url: null,
        attachments: [{ kind: 'reply', title: '書面答復', url: 'https://e/1' }],
      },
    ],
    { fetchedAt: '2026-09-30T09:00:00.000Z' },
  );
  const res = listCommitteeActivity(db, {});
  assert.equal(res.replies.total, 1);
  assert.deepEqual(res.replies.items[0].legislators, [], '沒有委員名錄時回空陣列，不是崩潰');
});

test('F4: 排行榜先在 SQL 過濾在職委員，離職者不可以佔走榜單名額', () => {
  const { db, dataset } = seeded();
  const former = dataset.legislators.find((l) => l.leave_flag);
  const sitting = dataset.legislators.find((l) => !l.leave_flag);
  assert.ok(former && sitting);
  const insert = db.prepare(
    `INSERT INTO news(legislator_id, title, source, url, published_at, fetched_at) VALUES(?, ?, 's', ?, '2026-09-30T00:00:00.000Z', '2026-09-30T09:00:00.000Z')`,
  );
  for (let i = 0; i < 9; i += 1) insert.run(former.id, `前委員新聞${i}`, `https://e/f${i}`);
  insert.run(sitting.id, '在職新聞', 'https://e/live');

  const board = listRankings(db, { type: 'news', days: 3650, limit: 1 }).boards.news;
  assert.equal(board.items.length, 1, 'limit=1 就該給出 1 位，即使第一名是離職者');
  assert.equal(board.items[0].legislator.id, sitting.id);
});

test('F6/F7/F9: LIKE 萬用字元要跳脫、first_date 不可外洩 "9999"、statuses 不可有 null', () => {
  const { db } = seeded();
  db.prepare(
    `INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url)
     VALUES('b1', 11, '11-5', '平均地權條例', '三讀', '法律案', '', '[]', '', 'u')`,
  ).run();
  db.prepare(
    `INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url)
     VALUES('b2', 11, '11-5', '沒有狀態的議案', NULL, '法律案', '', '[]', '2026-09-28', 'u')`,
  ).run();

  // ?q=% 若不跳脫，LIKE '%%%' 會符合全部議案
  assert.equal(listBills(db, { q: '%' }).total, 0, '% 是萬用字元，不是「全部」');
  assert.equal(listBills(db, { q: '平均' }).total, 1);
  assert.equal(listBills(db, { q: '_' }).total, 0);

  const res = listBills(db, {});
  assert.equal(res.first_date, '2026-09-28', 'latest_date 為空不可讓 "9999" 外洩');
  assert.ok(res.statuses.every((s) => s.name), 'status 為 NULL 的議案不該產生 {name:null} 的統計列');
  assert.deepEqual(res.statuses.map((s) => s.name), ['三讀']);
});

test('B4: 新聞全部失敗時 news_status 要寫 failed，不是 complete', async () => {
  const { db } = seeded();
  const result = await runNewsIngest(db, {
    logger: silent,
    delayMs: 0,
    fetchImpl: async () => {
      throw new FetchError('HTTP 503', { status: 503, attempts: 1 });
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(getMeta(db, 'news_status'), /^failed:/, '失敗不可以寫成 complete');
  // 而且要看得到（以前只有 partial 會變成 health 的 notice，failed 完全沒人顯示）
  const health = getHealth(db, { now: Date.parse('2026-09-30T10:00:00.000Z') });
  assert.ok(health.warnings.some((w) => w.includes('新聞同步失敗')), `warnings 應含新聞失敗，實際：${health.warnings}`);});

/* ---------------- 第三輪 review 第二階段：縣市／人口／選舉靜態資料 ---------------- */

test('靜態資料（人口／選舉／圖資）的資料截止與筆數要看得到，太舊要警告', () => {
  const { db } = seeded();
  const now = Date.parse('2026-10-02T00:00:00.000Z');
  const health = getHealth(db, { now });

  // 這五個檔案不在同步流程內（要手動重跑 build 腳本），所以 fetched_at 不存在，
  // 只有「資料截止」；以前 /health 完全看不到它們，畫面上的數字放多久都不會有訊號。
  const s = health.static_data;
  assert.ok(s, '/health 應該要有 static_data');
  assert.deepEqual(Object.keys(s).sort(), ['counties', 'demographics', 'legislator_votes', 'population_trend', 'recalls', 'town_map']);
  assert.equal(s.counties.count, 22);
  assert.equal(s.demographics.count, 368);
  assert.equal(s.town_map.count, 368);
  assert.match(s.counties.as_of, /^\d{4}-\d{2}$/, '人口資料要有 YYYY-MM 的截止月');
  assert.equal(s.counties.as_of, s.demographics.as_of, '同一份人口月報，兩邊的截止月要一致');
  assert.equal(health.static_data.population_trend.as_of, s.counties.as_of);

  // 現在（2026-10）人口是 2026-08 → 2 個月，還沒到門檻，不該誤報
  assert.ok(!health.warnings.some((w) => w.includes('人口資料')), `不該無故警告：${health.warnings}`);

  // 時鐘往後推到隔年 6 月 → 10 個月，應該提醒重跑 build
  const later = getHealth(db, { now: Date.parse('2027-06-01T00:00:00.000Z') });
  assert.ok(
    later.warnings.some((w) => w.includes('人口資料') && w.includes('build-county-stats')),
    `過期要提醒重跑 build：${later.warnings}`,
  );
});

test('monthsSince：只認 YYYY-MM，選舉年（YYYY）不誤判為過期', () => {
  const now = Date.parse('2026-10-02T00:00:00.000Z');
  assert.equal(monthsSince('2026-08', now), 2);
  assert.equal(monthsSince('2026-10', now), 0);
  assert.equal(monthsSince('2025-10', now), 12);
  assert.equal(monthsSince('2024', now), null, '只有年份（選舉）不該被當成月資料');
  assert.equal(monthsSince(null, now), null);
  assert.equal(monthsSince('', now), null);
  // 來源若給未來月份，不可以回負數（會讓「已 -3 個月」這種文案出現）
  assert.equal(monthsSince('2027-01', now), 0);
});

test('縣市／鄉鎮／委員的對應不變量：同名不會互相污染（現在成立，未來要繼續成立）', () => {
  const { db } = seeded();
  // 1) 委員以姓名比對選舉資料；同屆同名會直接對錯人
  const dupNames = db.prepare('SELECT name, COUNT(*) AS c FROM legislators GROUP BY name HAVING c > 1').all();
  assert.deepEqual(dupNames, [], `委員不可同名（姓名是選舉資料的 join key）：${JSON.stringify(dupNames)}`);

  // 2) 鄉鎮只能以 (縣市, 鄉鎮) 當 key：跨縣市同名（信義區、大安區…）是常態
  const demo = listDemographics(db);
  const townMap = getTownMap(db);
  const keys = (arr) => arr.map((t) => `${t.county}|${t.town}`);
  assert.equal(new Set(keys(demo.towns)).size, demo.towns.length, '(縣市,鄉鎮) 不可重複');
  assert.equal(new Set(keys(townMap.towns)).size, townMap.towns.length);
  assert.deepEqual([...new Set(keys(demo.towns))].sort(), [...new Set(keys(townMap.towns))].sort(), '兩份檔案的鄉鎮要一對一');
  const crossCounty = new Set(demo.towns.map((t) => t.town)).size;
  assert.ok(crossCounty < demo.towns.length, '本來就有跨縣市同名鄉鎮，所以單獨用鄉鎮名當 key 一定會壞');

  // 3) 縣市頁把委員掛到縣市上：只認 regionOf() 產生的縣市名，特殊身分不可被硬塞
  const counties = listCounties(db);
  assert.equal(counties.count, 22);
  const names = new Set(counties.items.map((c) => c.county));
  const stray = [];
  for (const l of db.prepare('SELECT name, area_name FROM legislators WHERE leave_flag = 0').all()) {
    const region = regionOf(l.area_name);
    if (!names.has(region) && !['全國不分區', '山地原住民', '平地原住民'].includes(region)) stray.push(`${l.name}:${region}`);
  }
  assert.deepEqual(stray, [], `不該有委員掛到不存在的縣市：${stray.join('、')}`);
  // 不分區／原住民不會被掛到任何縣市（22 縣市掛到的總數 + 特殊身分 = 在職人數）
  const attached = counties.items.reduce((n, c) => n + c.legislators.length, 0);
  assert.ok(attached > 0 && attached < 113, `只有區域／原住民委員會被掛到縣市（實際 ${attached}）`);
});

/* -------- 第三輪複審第二階段：靜態資料的失敗路徑與資料檔不變量 -------- */

test('靜態檔壞掉／不見時 /health 不可以 500，而且要看得到是哪一個檔', () => {
  const { db } = seeded();
  const now = Date.parse('2026-10-02T00:00:00.000Z');

  // 逐檔容錯：先前只要有任一檔案 ENOENT／JSON 壞掉，整個 /health 就 500 ——
  // 而那支端點正是發現檔案壞掉的唯一線索（／regions 也會一起被拖垮）。
  const broken = { counties: () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } };
  const health = getHealth(db, { now, staticLoaders: broken });
  assert.equal(health.static_data.counties.count, 0);
  assert.equal(health.static_data.counties.error, '檔案不存在');
  assert.ok(!/\/Users\/|\/private\//.test(health.static_data.counties.error), '錯誤訊息不該外洩絕對路徑');
  assert.ok(health.warnings.some((w) => w.includes('縣市人口與選舉指標') && w.includes('讀取失敗')), `要留下警告：${health.warnings}`);
  // 其他四個檔仍然正常
  assert.equal(health.static_data.demographics.count, 368);

  // 空檔案（count 0）也要警告，不能說 ok
  const empty = { town_map: () => ({ towns: [] }) };
  const h2 = getHealth(db, { now, staticLoaders: empty });
  assert.ok(h2.warnings.some((w) => w.includes('鄉鎮市區界圖資') && w.includes('空的')), `${h2.warnings}`);
});

test('空名冊時 legislator-votes 與排行榜不可以 500（loader 要先初始化）', () => {
  const db = openDb(':memory:');
  // 全新安裝、第一次同步還沒跑完：items 為空 → 以前不會呼叫 raceHistory → legislatorVotes 仍是 null
  const votes = listLegislatorVotes(db, {});
  assert.equal(votes.count, 0);
  assert.ok(Array.isArray(votes.years) && votes.years.length > 0, 'years 要有值，不是 null.years');
  assert.ok(votes.sources.length > 0);
  // 排行榜的 close／drop 榜也走同一條路徑
  const boards = listRankings(db, { type: 'all' });
  assert.ok(boards.boards.close && boards.boards.drop);
  assert.deepEqual(boards.boards.close.items, []);
});

test('S3: split-ticket 未知年份不再靜默假裝是最後一屆', () => {
  const { db } = seeded();
  const ok = listSplitTicket(db, { year: 2020 });
  assert.equal(ok.year, 2020);
  assert.equal(ok.fell_back, false);
  assert.equal(ok.requested_year, 2020);

  const bogus = listSplitTicket(db, { year: 9999 });
  assert.equal(bogus.year, 2024, '仍然回最後一屆，不讓畫面變空');
  assert.equal(bogus.fell_back, true, '但一定要說它退回了');
  assert.equal(bogus.requested_year, 9999);

  const none = listSplitTicket(db, {});
  assert.equal(none.fell_back, false, '沒指定年份不算退回');
  assert.equal(none.requested_year, null);
});

test('S2: 險勝榜的 intensity 不可以隨 ?limit= 改變', () => {
  const db = seededFull();
  const small = listRankings(db, { type: 'close', limit: 5 });
  const large = listRankings(db, { type: 'close', limit: 50 });
  const a = small.boards.close.items;
  const b = large.boards.close.items;
  assert.ok(a.length > 0, 'close 榜要有資料');
  assert.equal(a[0].intensity, 1, '第一名長度為 1');
  for (const item of a) {
    const same = b.find((x) => x.legislator.id === item.legislator.id);
    // 以前 span 是取 slice 後的 rows 算的，同一個人在 limit=5 與 50 下長度不一樣
    assert.equal(same?.intensity, item.intensity, `${item.legislator.name} 的長條不該隨 limit 改變`);
  }
});

test('資料檔不變量：margin_pct 與 margin 一致、2012 總統的政黨標籤正確', () => {
  const cs = dataFile('../../server/county-stats.json');
  const lv = dataFile('../../server/legislator-votes.json');

  // 二次四捨五入：margin_pct 必須等於用原始票數算出來的差距（否則 0.01pp 的誤差）
  for (const c of cs.counties) {
    for (const [key, e] of Object.entries(c.elections ?? {})) {
      if (e.margin == null) continue;
      assert.equal(e.margin_pct, Math.round((e.margin / e.valid) * 10000) / 100, `${c.county}/${key}`);
    }
  }
  for (const r of lv.races) {
    if (r.margin == null) continue;
    assert.equal(r.margin_pct, Math.round((r.margin / r.valid) * 10000) / 100, `${r.year}/${r.district}`);
  }

  // 2012 總統是馬英九／蔡英文／宋楚瑜（親民黨）；以前宋楚瑜的 369,588 票被標成「無黨籍」
  const total = {};
  for (const c of cs.counties) {
    for (const t of c.trends.president) {
      if (t.year !== 2012) continue;
      for (const [p, v] of Object.entries(t.votes)) total[p] = (total[p] ?? 0) + v;
    }
  }
  assert.deepEqual(total, { 中國國民黨: 6891139, 民主進步黨: 6093578, 親民黨: 369588 });
  assert.ok(!('無黨籍' in total), '2012 總統不該有無黨籍');

  // years 的語意是「有大選（三票對照）的年份」：補選年（2015／2019／2022／2023）刻意不在內，
  // 因為 /split-ticket 的年份選擇器直接用這個欄位，放進補選年只會讓那個選項查到空表。
  // 但它必須是**推導出來**的（不是硬編總統選舉年），否則以後少一屆就會與 races 分岔。
  const generalYears = [...new Set(lv.races.filter((r) => !r.by_election).map((r) => r.year))].sort((a, b) => a - b);
  assert.deepEqual(lv.years, generalYears, 'years 要等於有大選的年份');
  assert.deepEqual(lv.years, [2012, 2016, 2020, 2024]);
  const byElectionYears = lv.races.filter((r) => r.by_election).map((r) => r.year);
  assert.ok(byElectionYears.includes(2023), '補選場次仍在 races 裡（只是不在 years）');
});

/* -------- 罷免資料（中選會官方清單，scripts/fetch-cec-recalls.mjs） -------- */

test('罷免案：35 筆、來源是中選會官方、通過的只有陳柏惟，且在職委員對得到', () => {
  const { db } = seededWithRoster();
  const res = listRecalls(db);

  assert.equal(res.count, 35, '2015 起共 35 案（含 2025 兩波 31 案）');
  assert.deepEqual(res.terms, [11, 10, 9, 8]);
  assert.equal(res.passed, 1, '只有 2021 陳柏惟通過');
  assert.equal(res.items.find((r) => r.passed)?.name, '陳柏惟');
  // 來源必須是官方頁面（使用者指定），不是 GitHub 轉存
  assert.match(res.source.page, /^https:\/\/db\.cec\.gov\.tw\/ElecTable\/Recall/);
  assert.match(res.source.endpoint, /^https:\/\/db\.cec\.gov\.tw\/static\/elections\/list\/RCL_L0\.json$/);
  assert.ok(res.source.note.includes('只有案件清單') && res.source.note.includes('fetch-recall-results'), '限制與票數出處要寫在資料裡，不是只寫在 README');

  // 2025 兩波：7/26 有 24 案、8/23 有 7 案
  const jul = res.items.filter((r) => r.vote_date === '2025-07-26');
  const aug = res.items.filter((r) => r.vote_date === '2025-08-23');
  assert.equal(jul.length, 24);
  assert.equal(aug.length, 7);
  assert.ok(jul.every((r) => !r.passed), '2025 全部未通過');

  // 外層 area_name 不可信（蔡正元那筆在中選會的清單裡被標成雲林縣）→ 一律由標題解析
  const tsai = res.items.find((r) => r.name === '蔡正元');
  assert.equal(tsai.area, '臺北市');
  assert.equal(tsai.district, '第四選舉區');
  assert.equal(tsai.vote_date, '2015-02-14');
});

test('罷免案：委員自己的紀錄會出現在 /legislator-votes（丁學忠 2025-07-26 未通過）', () => {
  const { db } = seededWithRoster();
  const ding = db.prepare("SELECT id FROM legislators WHERE name = '丁學忠'").get();
  const res = listLegislatorVotes(db, { id: ding.id });
  const item = res.items[0];
  assert.equal(item.legislator.name, '丁學忠');
  assert.equal(item.recalls.length, 1);
  assert.equal(item.recalls[0].vote_date, '2025-07-26');
  assert.equal(item.recalls[0].area, '雲林縣');
  assert.equal(item.recalls[0].passed, false);

  // 在職名錄預設查詢：31 位在職委員有罷免紀錄（2025 兩波都是現任）
  const all = listLegislatorVotes(db, {});
  assert.equal(all.items.filter((i) => i.recalls.length).length, 31);
  // 沒有被罷免的委員是空陣列，不是 undefined（前端直接 .length）
  assert.ok(all.items.every((i) => Array.isArray(i.recalls)));
});

test('靜態資料清單要把罷免案也納入監控', () => {
  const { db } = seeded();
  const health = getHealth(db, { now: Date.parse('2026-10-02T00:00:00.000Z') });
  assert.ok(health.static_data.recalls, 'static_data 要有 recalls');
  assert.equal(health.static_data.recalls.count, 35);
  assert.match(health.static_data.recalls.as_of, /^\d{4}-\d{2}$/, '用 fetched_at 的年月當資料截止');
});

test('罷免票數：35 案都有官方票數，且數字自身一致', () => {
  const { db } = seededWithRoster();
  const res = listRecalls(db);

  assert.equal(res.with_results, 35, '35 案全部都有官方票數');
  assert.equal(res.results_sources.length, 6, '2025 兩份公告＋2017／2015／2022／2021 各一份文件');
  assert.match(res.results_sources[0].url, /^https:\/\/(web\.cec\.gov\.tw|gazette\.nat\.gov\.tw)\//);

  // 每一筆有票數的紀錄都要通過內部一致性（這也是解析公告表格時的防線）
  for (const r of res.items.filter((x) => x.results)) {
    const v = r.results;
    assert.equal(v.agree + v.disagree + v.invalid, v.voted, `${r.name}：同意＋不同意＋無效票要等於投票人數`);
    assert.ok(v.invalid > 0, `${r.name}：無效票應為正`);
    const share = Math.round((v.agree / v.electorate) * 10000) / 100;
    assert.equal(v.agree_share_pct, share, `${r.name}：同意票佔比要等於 同意÷投票人總數`);
    assert.equal(v.result_text, r.passed ? '通過' : '否決', `${r.name}：公告文字要與 vote_result 一致`);
    assert.match(v.document_url, /^https:\/\//);
    assert.ok(v.document, '每筆都要有官方文件名稱');
  }

  // 最強的一道驗證：用公告的票數**重算法定門檻**，結果要與中選會記載的結果一致。
  // 這證明抽出來的是真數字，而不是「欄位對了但來源錯」。
  //   2016 年底修法前：投票人數須達選舉人總數 1/2，且同意 > 不同意
  //   修法後：同意 > 不同意，且同意票須達選舉人總數 1/4（俗稱「四分之一門檻」）
  // 我們的案子只有 2015 蔡正元落在舊制，所以用 2017-01-01 當分界即可。
  const withResults = res.items.filter((x) => x.results);
  assert.equal(withResults.length, 35);
  for (const r of withResults) {
    const v = r.results;
    const agreeWins = v.agree > v.disagree;
    const oldRule = String(r.vote_date) < '2017-01-01';
    const thresholdOk = oldRule ? v.voted / v.electorate >= 0.5 : v.agree / v.electorate > 0.25;
    assert.equal(agreeWins && thresholdOk, r.passed, `${r.name}（${r.vote_date}）：用票數重算的結果應為 ${r.passed ? '通過' : '否決'}`);
  }
  // 因此「同意 > 不同意」不等於通過：蔡正元 97% 同意、黃國昌與林昶佐也都同意多於不同意，但都沒過門檻
  assert.deepEqual(
    withResults.filter((r) => r.results.agree > r.results.disagree).map((r) => r.name).sort(),
    ['林昶佐', '蔡正元', '陳柏惟', '黃國昌'],
  );
  assert.deepEqual(res.items.filter((r) => r.results && r.passed).map((r) => r.name), ['陳柏惟']);

  // 抽查：丁學忠（官方公告 114年8月1日）
  const ding = res.items.find((r) => r.name === '丁學忠').results;
  assert.deepEqual(
    { agree: ding.agree, disagree: ding.disagree, voted: ding.voted, invalid: ding.invalid, turnout: ding.turnout_pct },
    { agree: 57331, disagree: 77164, voted: 135470, invalid: 975, turnout: 49.87 },
  );

  // 三筆歷史案也補上了，而且各自對應不同格式的官方文件
  const byName = Object.fromEntries(res.items.map((r) => [r.name, r.results]));
  assert.equal(byName['黃國昌'].agree, 48693); // 投開票結果表的總計列
  assert.equal(byName['黃國昌'].disagree, 21748);
  assert.equal(byName['蔡正元'].agree, 76737); // 罷免實錄的內文
  assert.equal(byName['蔡正元'].disagree, 2196);
  assert.deepEqual(byName['蔡正元'].printed_agree_share, { pct: 97.22, of: 'valid' }, '實錄印的佔比分母是有效票，要記下來');
  assert.equal(byName['林昶佐'].agree, 54813); // 各投開票所得票數一覽表（ODS）的總計列
  assert.equal(byName['林昶佐'].disagree, 43340);
  assert.equal(byName['陳柏惟'].agree, 77899); // 公告的結果表是圖片 → 人工判讀
  assert.equal(byName['陳柏惟'].disagree, 73433);
  assert.equal(byName['陳柏惟'].invalid, 1235);
  assert.match(byName['陳柏惟'].read_from ?? '', /人工判讀/, '唯一一筆非機器解析的必須標示');
});
