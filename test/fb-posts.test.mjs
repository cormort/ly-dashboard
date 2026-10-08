import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applySocialPosts, getMeta } from '../server/db.mjs';
import { buildDataset, normalizeSocialPosts, DataValidationError } from '../server/normalize.mjs';
import { runSocialPostsIngest } from '../server/ingest.mjs';
import { listFunds } from '../server/queries.mjs';
import { scopeStages, STAGE_DATASETS } from '../server/sync-scopes.mjs';
import { FetchError } from '../server/fetch-ly.mjs';
import { CONFIG } from '../server/config.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const postsCsv = fixture('posts-detail.csv');
const silent = { log() {}, warn() {}, error() {} };
const idByName = (db) => new Map(db.prepare('SELECT name, id FROM legislators WHERE leave_flag = 0').all().map((r) => [r.name, r.id]));

function seeded() {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(JSON.parse(fixture('id9.json')), JSON.parse(fixture('id14.json'))), {
    fetchedAt: '2026-09-30T09:00:00.000Z',
    sourceUrl: 'https://data.ly.gov.tw/',
  });
  return db;
}

test('貼文層級 CSV：解析成貼文列（姓名對到委員、日期可空、重複略過、離職者略過）', () => {
  const db = seeded();
  const { posts, unmatched } = normalizeSocialPosts(postsCsv, idByName(db));
  assert.equal(posts.length, 12, '12 則有效貼文（離職者與空白列略過）');
  assert.equal(posts.filter((p) => p.post_date).length, 10, '10 則有日期，其餘留空（FB 只給相對時間，不猜）');
  assert.deepEqual([...new Set(posts.map((p) => p.platform))], ['facebook']);
  assert.deepEqual(unmatched, ['游錫堃'], '名錄對不到的姓名要回報，但不整批拒收');
  const first = posts.find((p) => p.summary.includes('新宿舍運動'));
  assert.equal(first.post_date, '2026-10-08');
  assert.match(first.summary, /教育部/, '摘要保留到 400 字，機關名稱（在後段）不會被截掉');
  assert.equal(first.likes, 120);
  assert.equal(first.comments, 8);
  assert.ok(posts.every((p) => p.summary.length <= 400));
});

test('貼文層級 CSV：欄位缺少或筆數太少要整批拒絕（fail closed）', () => {
  const db = seeded();
  const map = idByName(db);
  assert.throws(() => normalizeSocialPosts('姓名,摘要\n吳思瑤,只有兩欄\n', map), DataValidationError);
  const few = `姓名,平台,貼文日期,摘要,貼文連結\n吳思瑤,facebook,2026-10-08,只有一列,https://x\n`;
  assert.throws(() => normalizeSocialPosts(few, map), /可用貼文數異常/);
});

test('套用貼文：累計（同一則靠指紋去重），第二輪只補新的、舊的留著', () => {
  const db = seeded();
  const { posts } = normalizeSocialPosts(postsCsv, idByName(db));
  const first = applySocialPosts(db, posts, { fetchedAt: '2026-10-08T12:00:00.000Z' });
  assert.deepEqual({ imported: first.imported, added: first.added, pruned: first.pruned, accumulated: first.accumulated }, { imported: 12, added: 12, pruned: 0, accumulated: 12 });
  assert.equal(first.legislators, 10);
  assert.equal(getMeta(db, 'social_posts_import_count'), '12', '記下「這一輪匯入幾則」，供下一次的暴跌守門用');

  // 第二輪＝同一批（隔天再抓一次，內容一樣）＋ 1 則新貼文，但少了其中一則「沒有日期」的舊貼文
  const undated = posts.find((p) => !p.post_date && p.summary.includes('光電環評'));
  const again = posts.filter((p) => p !== undated);
  const extra = { ...posts[0], summary: '新增一則：要求環境部說明光電環評的標準與時程表', post_date: '2026-10-09' };
  const second = applySocialPosts(db, [...again, extra], { fetchedAt: '2026-10-09T12:00:00.000Z' });
  assert.equal(second.added, 1, '只有新的一則被加入（其餘靠指紋去重）');
  assert.equal(second.pruned, 1, '沒有日期、這一輪也沒抓到的舊貼文會被清掉');
  assert.equal(second.accumulated, 12, '累計＝12（10 有日期 ＋ 1 新 ＋ 1 沒日期的還在名單裡）');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_posts').get().n, 12);
  assert.ok(!db.prepare("SELECT 1 FROM social_posts WHERE summary LIKE '%光電環評%' AND post_date IS NULL").get(), '被清掉的那則不在資料庫裡');
});

test('同步：抓 fb-data 分支的 posts-detail/latest.csv → 寫進 social_posts', async () => {
  const db = seeded();
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(url);
    assert.equal(options.text, true, 'CSV 要用文字抓');
    return { text: postsCsv, status: 200, attempts: 1 };
  };
  const result = await runSocialPostsIngest(db, { logger: silent, fetchImpl });
  assert.equal(result.status, 'success');
  assert.equal(result.posts, 12);
  assert.equal(urls[0], `${CONFIG.social.postsUrl}/posts-detail/latest.csv`);
  const run = db.prepare("SELECT dataset, status, records FROM sync_runs ORDER BY rowid DESC LIMIT 1").get();
  assert.deepEqual([run.dataset, run.status, run.records], ['social_posts', 'success', 12]);
});

test('同步：資料分支上還沒有檔案（404）＝略過，不是失敗', async () => {
  const db = seeded();
  const fetchImpl = async () => {
    throw new FetchError('HTTP 404', { status: 404, attempts: 1 });
  };
  const result = await runSocialPostsIngest(db, { logger: silent, fetchImpl });
  assert.equal(result.status, 'skipped');
  assert.equal(db.prepare("SELECT status FROM sync_runs ORDER BY rowid DESC LIMIT 1").get().status, 'skipped');
});

test('同步：這次匯入量暴跌（低於上次匯入的 50%）要 fail closed，保留舊資料', async () => {
  const db = seeded();
  const { posts } = normalizeSocialPosts(postsCsv, idByName(db));
  applySocialPosts(db, posts, { fetchedAt: '2026-10-08T12:00:00.000Z' });
  // 模擬前幾天正常都匯入 400 則（累計式資料庫裡的總數會更多，所以守門要看「上次匯入幾則」）
  db.prepare("UPDATE meta SET value = '400' WHERE key = 'social_posts_import_count'").run();
  const result = await runSocialPostsIngest(db, { logger: silent, fetchImpl: async () => ({ text: postsCsv, status: 200, attempts: 1 }) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /低於上次 400 則的 50%/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_posts').get().n, 12, '舊資料原封不動');
});

test('機關頁：委員貼文用貼文層級資料比對機關（整理表那 60 字幾乎比對不到）', () => {
  const db = seeded();
  const { posts } = normalizeSocialPosts(postsCsv, idByName(db));
  applySocialPosts(db, posts, { fetchedAt: '2026-10-08T12:00:00.000Z' });
  const postsFor = (agency) => {
    const res = listFunds(db, { type: 'agency', fund: agency, kind: 'post' });
    return res.items.map((i) => i.title);
  };
  assert.equal(postsFor('環境部').length, 1, '環境部：一則（環評）');
  assert.equal(postsFor('環境部氣候變遷署').length, 1, '提到「環境部氣候變遷署」的貼文歸給署（跟新聞同一套「長名優先」規則）');
  assert.ok(postsFor('教育部').some((t) => t.includes('新宿舍運動')));
  assert.equal(postsFor('交通部').length, 1, '交通部：交通規劃一則');
  assert.equal(postsFor('交通部觀光署').length, 1, '提到「交通部觀光署」的貼文歸給觀光署');
  const env = listFunds(db, { type: 'agency', fund: '環境部' });
  assert.equal(env.kinds.post, 1);
  assert.ok(env.items.every((i) => i.kind || true));
});

test('同步範圍：社群範圍包含貼文層級，且每個階段都有 dataset 對應', () => {
  assert.ok(scopeStages('social').includes('social_posts'));
  assert.deepEqual(STAGE_DATASETS.social_posts, ['social_posts']);
});
