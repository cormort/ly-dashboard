import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  feedItemsFromRows,
  groupByFeedDate,
  originOf,
  rowsWithin,
  syncNewsData,
  writeFeedFiles,
} from '../server/news-push.mjs';
import { mergeFeedFile, parseFeedFile } from '../server/news-feed.mjs';

const GOOGLE_URL = 'https://news.google.com/rss/articles/CBMiAAA?oc=5';
const OUTLET_URL = 'https://www.cna.com.tw/news/aipl/202610060001.aspx';
const row = (url, title, published = '2026-10-06T03:00:00.000Z', extra = {}) => ({
  url,
  title,
  source: '中央社',
  published_at: published,
  fetched_at: '2026-10-06T04:00:00.000Z',
  ...extra,
});

/**
 * 只用到 prepare(sql).all(cutoff)：news／topic_news 兩張表的列都吃。
 * 真的查詢有 `WHERE published_at >= ?`，所以這裡也照著過濾 —— 這樣才驗得到 rowsWithin 傳的 cutoff 對不對。
 */
const fakeDb = (news = [], topic = []) => ({
  prepare: (sql) => ({
    all: (cutoff) => (String(sql).includes('topic_news') ? topic : news).filter((r) => !cutoff || r.published_at >= cutoff),
  }),
});

/** 做一個「遠端」bare repo（news-data 分支），回傳常用的查詢函式 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'news-data-test-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'news-data', remote]);
  mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'news-data'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'seed@example.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'seed'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), '# news-data\n\n媒體 RSS 收集結果。\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'news-data'], { cwd: seed });
  return {
    url: remote,
    workDir: (name) => join(base, name),
    commitCount: () => Number(execFileSync('git', ['rev-list', '--count', 'news-data'], { cwd: remote, encoding: 'utf8' }).trim()),
    file: (path) => {
      try {
        return execFileSync('git', ['show', `news-data:${path}`], { cwd: remote, encoding: 'utf8' });
      } catch {
        return null;
      }
    },
    log: (cwd) => execFileSync('git', ['log', '--format=%s', '-n', '1', 'news-data'], { cwd, encoding: 'utf8' }).trim(),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('news-data：Google 轉址連結算 google、媒體 RSS 算 outlet（與匯入 CSV 同一條規則）', () => {
  assert.equal(originOf(GOOGLE_URL), 'google');
  assert.equal(originOf(OUTLET_URL), 'outlet');
  assert.equal(originOf(''), 'outlet');
});

test('news-data：DB 的列 → 收集檔 items（同網址去重、壞列略過、collected_at 用抓到的時間）', () => {
  const items = feedItemsFromRows([
    row(OUTLET_URL, '標題一'),
    row(OUTLET_URL, '標題一（重複）'),
    row(GOOGLE_URL, '標題二'),
    row('', '沒有網址'),
    row(OUTLET_URL, '沒有發布時間', 'not-a-date'),
  ]);
  assert.equal(items.length, 2, '同網址只留一則、壞列略過');
  const [outlet, google] = items;
  assert.equal(outlet.url, OUTLET_URL);
  assert.equal(outlet.origin, 'outlet');
  assert.equal(outlet.collected_at, '2026-10-06T04:00:00.000Z', 'collected_at 用本機抓到的時間');
  assert.equal(google.origin, 'google');
});

test('news-data：依臺灣時間的發布日分組（跨午夜不會歸錯天）', () => {
  const items = feedItemsFromRows([
    row(OUTLET_URL, '晚間', '2026-10-06T15:30:00.000Z'), // 臺灣時間 10-06 23:30
    row(GOOGLE_URL, '凌晨', '2026-10-06T16:30:00.000Z'), // 臺灣時間 10-07 00:30
  ]);
  const byDate = groupByFeedDate(items);
  assert.deepEqual([...byDate.keys()].sort(), ['2026-10-06', '2026-10-07']);
});

test('news-data：併檔是「合併＋去重」——已經在檔裡的那一則保留原本的 collected_at，只新增沒有的', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'news-merge-'));
  try {
    const first = writeFeedFiles({
      workDir,
      items: feedItemsFromRows([row(OUTLET_URL, '標題一')]),
      collectedAt: '2026-10-06T04:00:00.000Z',
    });
    assert.deepEqual(first.files, [join('news', '2026-10-06.ndjson')]);
    assert.equal(first.added, 1);

    // 第二次：同一則（collected_at 較新）＋一則新的
    const second = writeFeedFiles({
      workDir,
      items: feedItemsFromRows([row(OUTLET_URL, '標題一', '2026-10-06T03:00:00.000Z', { fetched_at: '2026-10-06T09:00:00.000Z' }), row(GOOGLE_URL, '標題二')]),
      collectedAt: '2026-10-06T09:00:00.000Z',
    });
    assert.equal(second.added, 1, '只有新的那一則算新增');
    const items = parseFeedFile(execFileSync('cat', [join(workDir, 'news', '2026-10-06.ndjson')], { encoding: 'utf8' }));
    assert.equal(items.length, 2);
    assert.equal(items.find((i) => i.url === OUTLET_URL).collected_at, '2026-10-06T04:00:00.000Z', '既有那則保留第一次抓到的時間');
    assert.equal(items.find((i) => i.url === GOOGLE_URL).collected_at, '2026-10-06T04:00:00.000Z');

    // 第三次：一模一樣的內容 → 不出現變動（不會長出一堆空 commit）
    const third = writeFeedFiles({
      workDir,
      items: feedItemsFromRows([row(OUTLET_URL, '標題一', '2026-10-06T03:00:00.000Z', { fetched_at: '2026-10-06T09:00:00.000Z' }), row(GOOGLE_URL, '標題二')]),
      collectedAt: '2026-10-06T10:00:00.000Z',
    });
    assert.deepEqual(third.files, [], '內容沒變就不該動檔');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('news-data：mergeFeedFile 尊重 items 自帶的 collected_at（本機推上來的「什麼時候抓到的」）', () => {
  const text = mergeFeedFile('', [{ ...row(OUTLET_URL, '標題一'), collected_at: '2026-10-06T04:00:00.000Z' }], '2026-10-07T00:00:00.000Z');
  assert.equal(parseFeedFile(text)[0].collected_at, '2026-10-06T04:00:00.000Z');
});

test('news-data：兩台裝置各自抓到的都會在（合併而不是覆蓋）——這就是跨裝置更新的關鍵', async () => {
  const f = fixture();
  try {
    // 裝置 A（Mac Mini）抓到媒體 RSS
    const a = await syncNewsData({ db: fakeDb([row(OUTLET_URL, 'A 抓到的')]), repoUrl: f.url, workDir: f.workDir('work-a') });
    assert.equal(a.status, 'pushed');
    // 裝置 B（筆電）抓到 Google 那一則
    const b = await syncNewsData({ db: fakeDb([], [row(GOOGLE_URL, 'B 抓到的')]), repoUrl: f.url, workDir: f.workDir('work-b') });
    assert.equal(b.status, 'pushed');
    const items = parseFeedFile(f.file('news/2026-10-06.ndjson'));
    assert.deepEqual(
      items.map((i) => i.title).sort(),
      ['A 抓到的', 'B 抓到的'],
      'B 不該把 A 推上去的蓋掉',
    );
    assert.equal(f.log(f.workDir('work-b')), 'news: 本機收穫 1 個檔（新增 1 則）');
  } finally {
    f.cleanup();
  }
});

test('news-data：內容沒變就不 commit、不 push；--dry-run 也不 push', async () => {
  const f = fixture();
  try {
    const db = fakeDb([row(OUTLET_URL, '標題一')]);
    const first = await syncNewsData({ db, repoUrl: f.url, workDir: f.workDir('work') });
    assert.equal(first.status, 'pushed');
    const after = f.commitCount();
    const again = await syncNewsData({ db, repoUrl: f.url, workDir: f.workDir('work') });
    assert.equal(again.status, 'unchanged');
    assert.equal(again.added, 0);
    assert.equal(f.commitCount(), after, '沒有新 commit');
    const dry = await syncNewsData({ db: fakeDb([row(OUTLET_URL, '標題一'), row(GOOGLE_URL, '標題二')]), repoUrl: f.url, workDir: f.workDir('work'), dryRun: true });
    assert.equal(dry.status, 'dry-run');
    assert.equal(f.commitCount(), after, '預演不該 push');
  } finally {
    f.cleanup();
  }
});

test('news-data：分支還不存在時自己建一個；沒有可推的新聞就什麼都不做', async () => {
  const f = fixture();
  try {
    const other = await syncNewsData({ db: fakeDb([row(OUTLET_URL, '標題一')]), repoUrl: f.url, workDir: f.workDir('work-2'), branch: 'news-data-second' });
    assert.equal(other.status, 'pushed');
    const listed = execFileSync('git', ['ls-tree', '--name-only', 'news-data-second'], { cwd: f.url, encoding: 'utf8' });
    assert.match(listed, /news/);

    const empty = await syncNewsData({ db: fakeDb([]), repoUrl: f.url, workDir: f.workDir('work-3') });
    assert.equal(empty.status, 'unchanged');
    assert.equal(empty.items, 0);
  } finally {
    f.cleanup();
  }
});

test('news-data：只推近 N 天（窗口外的舊聞不進分支）', () => {
  const now = new Date('2026-10-07T00:00:00.000Z');
  const db = fakeDb([
    row(OUTLET_URL, '今天的', '2026-10-06T03:00:00.000Z'),
    row(GOOGLE_URL, '上個月的', '2026-09-01T03:00:00.000Z'),
  ]);
  const rows = rowsWithin(db, { days: 7, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '今天的');
});
