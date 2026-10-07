import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applySocial } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { listSocialWall, SOCIAL_WALL_DEFAULT_LIMIT } from '../server/queries.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const FETCHED_AT = '2026-09-30T09:00:00.000Z';

/** 名錄用真正的 fixture，粉專用固定的小集合——測的是排序與 facet，不是抓取。 */
function seeded(accounts) {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json'), { sourceUrl: 'https://data.ly.gov.tw/' }), {
    fetchedAt: FETCHED_AT,
    sourceUrl: 'https://data.ly.gov.tw/',
  });
  applySocial(db, accounts, { fetchedAt: FETCHED_AT });
  return db;
}

const fb = (id, name, date, url = `https://www.facebook.com/${id}`) => ({
  legislator_id: id,
  platform: 'facebook',
  page_name: name,
  url,
  latest_post_date: date,
  latest_post_summary: `${name} 的最新貼文`,
});

/**
 * 七個粉專：四位國民黨、三位民進黨；其中牛煦庭（00002）整理表還沒抓到貼文日期（留空不是填今天）。
 * 另有一筆 Threads，牆上不該出現。
 */
const ACCOUNTS = [
  fb('00001', '丁學忠', '2026-09-30'),
  fb('00003', '王世堅', '2026-09-29'),
  fb('00004', '王育敏', '2026-09-28'),
  fb('00005', '王定宇', '2026-09-27'),
  fb('00006', '王美惠', '2026-09-26'),
  fb('00007', '王鴻薇', '2026-09-25'),
  fb('00002', '牛煦庭', ''),
  { legislator_id: '00002', platform: 'threads', page_name: '', url: 'https://www.threads.com/@niu', latest_post_date: '2026-09-30', latest_post_summary: 'Threads 貼文' },
];

test('粉專牆：預設只回最近更新的 5 位，且依貼文日期新到舊', () => {
  const wall = listSocialWall(seeded(ACCOUNTS), {});
  assert.equal(wall.default_limit, SOCIAL_WALL_DEFAULT_LIMIT);
  assert.equal(SOCIAL_WALL_DEFAULT_LIMIT, 5);
  assert.equal(wall.items.length, 5, '預設回 5 筆');
  assert.deepEqual(
    wall.items.map((i) => i.name),
    ['丁學忠', '王世堅', '王育敏', '王定宇', '王美惠'],
  );
  assert.equal(wall.total, 7, 'total 是符合條件的全部（7 位有臉書粉專），不是這一頁的 5 筆');
  assert.equal(wall.count, 5);
});

test('粉專牆：帶著最新一則貼文的讚數／留言數；抓不到就是 null（不寫 0）', () => {
  const db = seeded([
    { ...fb('00001', '丁學忠', '2026-09-30'), latest_post_likes: 1465, latest_post_comments: 103 },
    fb('00003', '王世堅', '2026-09-29'), // 整理表還沒有互動數
  ]);
  const wall = listSocialWall(db, { limit: 100 });
  const ding = wall.items.find((i) => i.name === '丁學忠');
  assert.equal(ding.latest_post_likes, 1465);
  assert.equal(ding.latest_post_comments, 103);
  const wang = wall.items.find((i) => i.name === '王世堅');
  assert.equal(wang.latest_post_likes, null, '沒有值＝null，畫面上不要顯示 0');
  assert.equal(wang.latest_post_comments, null);
});

test('粉專牆：沒有貼文日期的排在最後，不會被當成最新', () => {
  const wall = listSocialWall(seeded(ACCOUNTS), { limit: 100 });
  assert.equal(wall.items.length, 7);
  assert.equal(wall.items.at(-1).name, '牛煦庭', '整理表沒抓到日期的要排最後');
  assert.equal(wall.items.at(-1).latest_post_date, null);
});

test('粉專牆：只有 Facebook 上牆，Threads 不會出現', () => {
  const wall = listSocialWall(seeded(ACCOUNTS), { limit: 100 });
  assert.ok(wall.items.every((i) => !i.url.includes('threads.com')), 'Threads 不是粉專，不該上牆');
  assert.equal(wall.total, 7);
});

test('粉專牆：兩組 facet 互相交叉，不會給出點了變空白的選項', () => {
  const db = seeded(ACCOUNTS);
  const all = listSocialWall(db, {});
  assert.deepEqual(
    all.parties.map((p) => `${p.name}:${p.count}`),
    ['中國國民黨:4', '民主進步黨:3'],
  );
  assert.equal(all.regions.reduce((sum, r) => sum + r.count, 0), 7);

  // 選了臺北市之後，黨籍 facet 只剩臺北市真的有的人（國民黨 王鴻薇、民進黨 王世堅）
  const taipei = listSocialWall(db, { region: '臺北市' });
  assert.deepEqual(
    taipei.parties.map((p) => `${p.name}:${p.count}`),
    ['中國國民黨:1', '民主進步黨:1'],
  );
  assert.equal(taipei.total, 2);
  assert.deepEqual(
    taipei.items.map((i) => i.name),
    ['王世堅', '王鴻薇'],
  );

  // 反向：選了民進黨之後，縣市 facet 不含只有國民黨的雲林縣
  const dpp = listSocialWall(db, { party: '民主進步黨' });
  assert.equal(dpp.total, 3);
  assert.ok(!dpp.regions.some((r) => r.name === '雲林縣'), '雲林縣只有國民黨，民進黨的縣市 facet 不該列出');
  assert.deepEqual(
    dpp.regions.map((r) => r.name).sort(),
    ['嘉義市', '臺南市', '臺北市'].sort(),
  );
});

test('粉專牆：套了條件就展開整個篩選結果，預設的 5 筆不再是上限', () => {
  const db = seeded(ACCOUNTS);
  const noFilter = listSocialWall(db, {});
  assert.equal(noFilter.items.length, 5, '沒條件時預設 5 筆');

  const filtered = listSocialWall(db, { party: '中國國民黨', limit: 60 });
  assert.equal(filtered.total, 4);
  assert.equal(filtered.items.length, 4, '套了黨籍條件要展開整個結果，不受預設 5 筆限制');
  assert.deepEqual(
    filtered.items.map((i) => i.name),
    ['丁學忠', '王育敏', '王鴻薇', '牛煦庭'],
  );
});

test('粉專牆：limit／offset 有界，且不會超過總數', () => {
  const db = seeded(ACCOUNTS);
  assert.equal(listSocialWall(db, { limit: 0 }).items.length, SOCIAL_WALL_DEFAULT_LIMIT, 'limit=0 視為沒給，回預設');
  assert.equal(listSocialWall(db, { limit: -3 }).items.length, 1, '負數夾成 1 筆，不會整批倒出');
  assert.equal(listSocialWall(db, { limit: 99999 }).items.length, 7, '上限夾住，且不超過實際筆數');
  assert.equal(listSocialWall(db, { limit: 3, offset: 5 }).items.length, 2);
  assert.equal(listSocialWall(db, { limit: 3, offset: 99 }).items.length, 0);
  assert.equal(listSocialWall(db, { limit: 3, offset: 99 }).count, 0);
});

test('粉專牆：沒有粉專的委員不會出現，總數小於委員總數', () => {
  const db = seeded(ACCOUNTS);
  const wall = listSocialWall(db, { limit: 500 });
  assert.equal(wall.total, 7);
  assert.ok(wall.total < 113, '只有整理表有臉書網址的委員才上牆');
  assert.ok(!wall.items.some((i) => i.name === '韓國瑜'), '沒有粉專資料的委員不該被塞進牆裡');
});

test('粉專牆：每一筆都帶著可用的黨籍、縣市與粉專網址', () => {
  const wall = listSocialWall(seeded(ACCOUNTS), { limit: 100 });
  for (const item of wall.items) {
    assert.match(item.url, /^https:\/\/www\.facebook\.com\//);
    assert.ok(item.party, `${item.name} 應該有黨籍`);
    assert.ok(item.region, `${item.name} 應該有縣市`);
    assert.ok(item.id && item.name, '要有委員 id 與姓名');
    assert.ok(item.source, '要標出來源（sheet／override），才知道是不是人工更正過的');
  }
  assert.equal(wall.items.find((i) => i.name === '王育敏').region, '全國不分區', '不分區立委的縣市就是全國不分區');
});

test('粉專牆：meta 依 API 契約帶 term／session，且回報整理表新鮮度', () => {
  const wall = listSocialWall(seeded(ACCOUNTS), {});
  assert.ok(wall.meta.generated_at, 'meta.generated_at');
  assert.ok(wall.meta.source?.name, 'meta.source');
  assert.equal(typeof wall.meta.stale, 'boolean');
  assert.ok(wall.meta.term, 'meta.term');
  assert.equal(wall.social.as_of, '2026-09-30', '整理表資料截至＝最新的一筆貼文日期');
  assert.equal(typeof wall.social.stale, 'boolean');
});

test('粉專牆：沒有粉專資料時回空牆，不編造任何一筆', () => {
  const wall = listSocialWall(seeded([]), {});
  assert.equal(wall.total, 0);
  assert.equal(wall.count, 0);
  assert.deepEqual(wall.items, []);
  assert.deepEqual(wall.parties, []);
  assert.deepEqual(wall.regions, []);
  assert.equal(wall.social.as_of, null);
});
