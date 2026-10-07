/**
 * 把**本機抓到**的新聞推回 GitHub 的資料分支（`news-data`）。
 *
 * 為什麼要有這支：GitHub Actions 的收集端（`scripts/collect-news-rss.mjs`）只收媒體 RSS，
 * 它補的是「伺服器沒開時也不漏收」。反過來，伺服器自己抓到的（逐委員／逐機關的 Google 新聞、
 * 以及伺服器開著時輪詢到的媒體 RSS）原本只留在本機 SQLite —— 換一台機器當 server 就看不到、
 * 資料也只在那一台。這支把本機的收穫併進 `news/YYYY-MM-DD.ndjson`，讓資料分支成為共同的份。
 *
 * 格式與併檔規則**沿用 `server/news-feed.mjs`**（收集端、匯入端、這裡共用同一份定義）：
 * 同網址只留一行、新摘要空的話保留舊的、`collected_at` 保留第一次抓到的時間、依 `published_at`＋`url` 排序
 * → 同樣內容寫出來一模一樣，git diff 只會出現真的新增或變動的行。
 *
 * 與 Actions 同時寫同一個分支是**刻意允許**的（兩邊都靠 `mergeFeedFile` 合併、網址去重）：
 * 每一輪都先 `reset --hard origin/<branch>` 再重新合併本機的 items、然後才 push，
 * 所以不會出現 non-fast-forward；push 失敗會重試（見 syncNewsData 的 attempts）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedDate, mergeFeedFile, parseFeedFile } from './news-feed.mjs';
import { runGit } from '../scripts/push-fb-data.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_NEWS_BRANCH = 'news-data';

/** 資料分支的工作目錄（跟 push-fb-data 一樣放在 .cache 下，不進版控） */
export const workDirFor = (branch = DEFAULT_NEWS_BRANCH) => join(ROOT, '.cache', branch);

/** Google 新聞的轉址連結 → `origin: 'google'`；其餘（媒體 RSS）→ `'outlet'`（與匯入 CSV 同一條規則） */
export const originOf = (url) => (String(url ?? '').startsWith('https://news.google.com/') ? 'google' : 'outlet');

/**
 * DB 的列 → 收集檔的 items。同一網址只留一則（標題／來源取先出現的，發布時間取較新的）。
 * 缺 url／標題／發布時間的列直接略過（收集檔的格式要求這三個欄位）。
 */
export function feedItemsFromRows(rows, { collectedAt = null } = {}) {
  const byUrl = new Map();
  for (const row of rows ?? []) {
    const url = String(row?.url ?? '').trim();
    const title = String(row?.title ?? '').trim();
    const published = String(row?.published_at ?? '');
    if (!url || !title || Number.isNaN(Date.parse(published))) continue;
    const item = {
      url,
      title,
      summary: '',
      source: String(row?.source ?? '').trim(),
      published_at: published,
      // 這則是「本機什麼時候抓到的」；已經在收集檔裡的那一則會保留原本的 collected_at
      collected_at: String(row?.fetched_at ?? '') || collectedAt || undefined,
      origin: originOf(url),
    };
    const old = byUrl.get(url);
    if (!old) byUrl.set(url, item);
    else if (Date.parse(item.published_at) > Date.parse(old.published_at)) byUrl.set(url, { ...old, ...item, summary: old.summary || item.summary });
  }
  return [...byUrl.values()];
}

/** 依「臺灣時間的發布日」分組（回傳 Map<date, items>） */
export function groupByFeedDate(items) {
  const byDate = new Map();
  for (const item of items ?? []) {
    const date = feedDate(item.published_at);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  }
  return byDate;
}

/**
 * 把本機的 items 併進工作樹裡每一天的檔（讀既有的檔 → mergeFeedFile 合併 → 有變才寫）。
 * 回傳 { files, added }：files＝真的動到的相對路徑、added＝新增的則數（同一網址改標題不算新增）。
 */
export function writeFeedFiles({ workDir, items, collectedAt }) {
  const files = [];
  let added = 0;
  const byDate = groupByFeedDate(items);
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date);
    const relative = join('news', `${date}.ndjson`);
    const target = join(workDir, relative);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const after = mergeFeedFile(before, list, collectedAt);
    if (after === before) continue;
    const known = new Set(parseFeedFile(before).map((i) => i.url));
    added += parseFeedFile(after).filter((i) => !known.has(i.url)).length;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, after);
    files.push(relative);
  }
  return { files, added };
}

/** 工作樹準備好，而且跟遠端的分支一致（沒有工作樹就 clone；分支還不存在就建一個空的） */
function resetWorkTree({ repoUrl, workDir, branch, git }) {
  if (existsSync(join(workDir, '.git'))) {
    git(['fetch', '-q', '--depth', '1', 'origin', branch], workDir);
    git(['checkout', '-q', branch], workDir);
    // reset 不會丟東西：要寫進去的內容全部來自本機 DB 與遠端檔案，本機不保留未推的 commit
    git(['reset', '-q', '--hard', `origin/${branch}`], workDir);
    return;
  }
  try {
    rmSync(workDir, { recursive: true, force: true }); // clone 要求目標目錄不存在
    git(['clone', '--depth', '1', '--branch', branch, repoUrl, workDir], undefined);
  } catch {
    // 分支還不存在（第一次）：建一個同名的空分支
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    git(['init', '-q', '-b', branch], workDir);
    git(['remote', 'add', 'origin', repoUrl], workDir);
    git(['config', `branch.${branch}.remote`, 'origin'], workDir);
  }
}

/** 近 N 天的新聞列（委員新聞 ＋ 機關／議題新聞），依 url 去重交給 feedItemsFromRows */
export function rowsWithin(db, { days = 7, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const fields = 'url, title, source, published_at, fetched_at';
  return [
    ...db.prepare(`SELECT ${fields} FROM news WHERE published_at >= ?`).all(cutoff),
    ...db.prepare(`SELECT ${fields} FROM topic_news WHERE published_at >= ?`).all(cutoff),
  ];
}

/**
 * 真正做事的地方（測試用同一個函式打本機的 bare repo）。
 * 回傳 { status, files, added, items, branch }：status ∈ pushed／unchanged／dry-run。
 * 每一輪都先跟遠端對齊再重新合併，所以 Actions 同時在推也不會撞；push 失敗會重試 attempts 次。
 */
export async function syncNewsData({
  db,
  days = 7,
  repoUrl,
  workDir = workDirFor(),
  branch = DEFAULT_NEWS_BRANCH,
  dryRun = false,
  attempts = 3,
  log = () => {},
  git = runGit,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const collectedAt = now().toISOString();
  const items = feedItemsFromRows(rowsWithin(db, { days, now: now() }), { collectedAt });
  if (!items.length) {
    log(`[news-data] 近 ${days} 天沒有可推的新聞`);
    return { status: 'unchanged', files: [], added: 0, items: 0, branch };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      resetWorkTree({ repoUrl, workDir, branch, git });
      const { files, added } = writeFeedFiles({ workDir, items, collectedAt });
      if (!files.length) {
        log(`[news-data] ${branch}：沒有變動（本機 ${items.length} 則都已經在收集檔裡）`);
        return { status: 'unchanged', files: [], added: 0, items: items.length, branch };
      }
      git(['add', '-A'], workDir);
      if (!git(['diff', '--cached', '--name-only'], workDir)) {
        return { status: 'unchanged', files: [], added: 0, items: items.length, branch };
      }
      if (dryRun) {
        log(`[news-data] 預演：會更新 ${files.length} 個檔、新增 ${added} 則（不 commit、不 push）`);
        return { status: 'dry-run', files, added, items: items.length, branch };
      }
      git(
        [
          '-c',
          'user.name=news-pusher[bot]',
          '-c',
          'user.email=news-pusher@users.noreply.github.com',
          'commit',
          '-q',
          '-m',
          `news: 本機收穫 ${files.length} 個檔（新增 ${added} 則）`,
        ],
        workDir,
      );
      git(['push', '-q', 'origin', branch], workDir);
      log(`[news-data] 已推上 ${branch}：${files.join('、')}（新增 ${added} 則）`);
      return { status: 'pushed', files, added, items: items.length, branch, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        log(`[news-data] 第 ${attempt} 次失敗，重試：${String(error?.message ?? error).slice(0, 160)}`);
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError ?? new Error('推上資料分支失敗');
}
