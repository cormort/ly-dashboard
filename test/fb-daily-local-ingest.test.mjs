/**
 * 「抓完直接寫進本機資料庫」的測試（scripts/fb-daily.mjs → server/ingest.mjs 的 `csvText`）。
 *
 * 背景：原本的路徑是「抓完 → 寫回 Google 整理表 → 觸發伺服器 → 伺服器再把整理表抓回來」，
 * 2026-10-10 就是卡在最後一步（同步被 409 擋掉）。抓取端手上本來就有格式相同的 CSV，
 * 直接匯入資料庫可以少掉這幾個環節 —— 這裡驗的就是那條路真的通，而且驗證機制還在。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, applyDataset } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { runSocialIngest, runSocialPostsIngest } from '../server/ingest.mjs';
import { ingestLocally } from '../scripts/fb-daily.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const silent = { log() {}, warn() {}, error() {} };
const id9 = JSON.parse(fixture('id9.json'));
const id14 = JSON.parse(fixture('id14.json'));

/** 免洗目錄 + 已寫入委員名錄的資料庫（本機匯入要靠姓名對 id）。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ly-local-ingest-'));
  const dbPath = join(dir, 'ly.db');
  const seed = openDb(dbPath);
  applyDataset(seed, buildDataset(id9, id14), { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  seed.close();
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  return { dir, dbPath, write };
}

test('本機直接寫入：用抓取端的 CSV 寫進資料庫，跳過 Google／GitHub', async () => {
  const { dbPath, write } = sandbox();
  const accountsCsv = write('posts-2026-10-10.csv', fixture('social.csv'));
  const postsCsv = write('posts-detail-2026-10-10.csv', fixture('posts-detail.csv'));

  const result = await ingestLocally({ accountsCsv, postsCsv, dbPath, logger: silent });
  assert.equal(result.accounts.status, 'success');
  assert.equal(result.accounts.accounts, 113, '與從試算表匯入同一份資料要得到同樣結果');
  assert.equal(result.posts.status, 'success');
  assert.ok(result.posts.posts > 0, '貼文層級也要一起寫進去');

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 113);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM social_posts').get().n > 0);
  const runs = db.prepare("SELECT dataset, status, http_status FROM sync_runs WHERE dataset IN ('social','social_posts') ORDER BY id").all();
  assert.deepEqual(runs.map((r) => `${r.dataset}:${r.status}`), ['social:success', 'social_posts:success']);
  assert.deepEqual(runs.map((r) => r.http_status), [null, null], '本機檔案不是 HTTP，不要假造 200');
  db.close();
});

test('本機直接寫入：資料明顯不對時 fail closed，不動資料庫裡現有的東西', async () => {
  const { dbPath, write } = sandbox();
  const good = write('posts-2026-10-10.csv', fixture('social.csv'));
  await ingestLocally({ accountsCsv: good, dbPath, logger: silent });

  // 只有 3 列的整理表（例如抓取腳本壞掉、只寫出殘檔）→ normalizeSocial 的絕對門檻就該擋下
  const broken = write('posts-broken.csv', '編號,姓名,政黨,選區/類別,臉書專頁名稱,最新貼文日期,最新貼文主題摘要,貼文或粉專連結\n1,甲,黨,區,粉專,2026-10-10,摘要,https://www.facebook.com/x\n');
  const result = await ingestLocally({ accountsCsv: broken, dbPath, logger: silent });
  assert.equal(result.accounts.status, 'failed');
  assert.match(String(result.accounts.error), /筆數異常|掉到/);

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n, 113, '失敗時保留舊資料');
  db.close();
});

test('csvText 就是「不要打網路」：給了就不會呼叫 fetch', async () => {
  const { dbPath } = sandbox();
  const db = openDb(dbPath);
  const explode = () => { throw new Error('不該打網路'); };
  const accounts = await runSocialIngest(db, { logger: silent, fetchImpl: explode, csvText: fixture('social.csv') });
  assert.equal(accounts.status, 'success');
  const posts = await runSocialPostsIngest(db, { logger: silent, fetchImpl: explode, csvText: fixture('posts-detail.csv') });
  assert.equal(posts.status, 'success');
  db.close();
});

test('csvText 有問題時要回 failed（不是靜靜地成功）', async () => {
  const { dbPath } = sandbox();
  const db = openDb(dbPath);
  const result = await runSocialIngest(db, { logger: silent, csvText: '<!DOCTYPE html>login' });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /缺少欄位/);
  db.close();
});
