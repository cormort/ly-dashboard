#!/usr/bin/env node
/**
 * 把每日抓取結果推到遠端的資料分支（預設 `fb-data`），比照 `news-data` 的做法：
 * 主分支（main）只放程式，資料放資料分支，遠端讀得到、也多一份備份。
 *
 *   posts/YYYY-MM-DD.csv   當天抓取的整理表格式 CSV
 *   posts/latest.csv       同一份內容（遠端隨時抓這一個檔就知道最新狀態）
 *
 * 用法：
 *   node scripts/push-fb-data.mjs [csv] [--dir .cache/fb-data] [--branch fb-data] [--dry-run]
 *   csv 預設 `.cache/posts-latest.csv`；日期從檔名（posts-YYYY-MM-DD.csv）或 --date 取。
 *
 * 沒有變動就不 commit（比對 staged 差異），commit 成功才 push；任何步驟失敗都以非零 exit 回報，
 * 讓呼叫端（scripts/fb-daily.sh）只記 log、不讓整個每日排程失敗。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { rowsFromCsv } from './push-posts-to-sheet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 把可能夾帶憑證的網址遮掉（git 的錯誤訊息會原樣印出 remote URL）。 */
export function redact(text) {
  return String(text ?? '').replace(/\/\/[^/@\s]*@/g, '//<憑證>@');
}

export function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || '').toString();
    throw new Error(`git ${args[0]} 失敗：${redact(detail).slice(0, 400)}`);
  }
}

/** 要寫進資料分支的檔案與內容。 */
export function planFiles({ csvPath, date }) {
  const content = readFileSync(csvPath, 'utf8');
  return { content, files: { [`posts/${date}.csv`]: content, 'posts/latest.csv': content } };
}

/** 檔名或 --date 取得日期（YYYY-MM-DD）；判斷「有幾列有日期」用同一套 CSV 解析。 */
export function dateOf(csvPath, explicit) {
  if (explicit) return explicit;
  const m = /posts-(\d{4}-\d{2}-\d{2})\.csv$/.exec(csvPath);
  if (!m) throw new Error(`從檔名看不出日期（${csvPath}）；請加 --date YYYY-MM-DD`);
  return m[1];
}

function ensureWorkTree({ repoUrl, workDir, branch, git }) {
  if (!existsSync(join(workDir, '.git'))) {
    mkdirSync(dirname(workDir), { recursive: true });
    try {
      git(['clone', '--depth', '1', '--branch', branch, repoUrl, workDir], undefined);
    } catch {
      // 分支還不存在（第一次）：建一個同名的空分支
      rmSync(workDir, { recursive: true, force: true });
      mkdirSync(workDir, { recursive: true });
      git(['init', '-q', '-b', branch], workDir);
      git(['remote', 'add', 'origin', repoUrl], workDir);
      git(['config', `branch.${branch}.remote`, 'origin'], workDir);
    }
    return;
  }
  git(['fetch', '-q', 'origin', branch], workDir);
  git(['checkout', '-q', branch], workDir);
  git(['merge', '-q', '--ff-only', `origin/${branch}`], workDir);
}

/**
 * 真正做事的地方（測試用同一個函式打本機的 bare repo）。
 * 回傳 { status, files, rows }：status ∈ pushed／committed／unchanged／dry-run
 */
export function syncFbData({
  csvPath,
  date,
  repoUrl,
  workDir,
  branch = 'fb-data',
  dryRun = false,
  log = () => {},
  git = runGit,
} = {}) {
  const { content, files } = planFiles({ csvPath, date });
  const rows = rowsFromCsv(content).length;

  ensureWorkTree({ repoUrl, workDir, branch, git });

  const relative = [];
  for (const [rel, body] of Object.entries(files)) {
    const target = join(workDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    relative.push(rel);
  }

  git(['add', '-A'], workDir);
  const staged = git(['diff', '--cached', '--name-only'], workDir);
  if (!staged) {
    log(`[fb-data] ${branch}：沒有變動（${relative.join('、')}）`);
    return { status: 'unchanged', files: relative, rows };
  }
  if (dryRun) {
    log(`[fb-data] 預演：會 commit ${staged.split('\n').length} 個檔案、不 push`);
    return { status: 'dry-run', files: relative, rows };
  }

  git(
    [
      '-c',
      'user.name=fb-collector[bot]',
      '-c',
      'user.email=fb-collector@users.noreply.github.com',
      'commit',
      '-q',
      '-m',
      `fb: ${date} 抓取（${rows} 列有日期）`,
    ],
    workDir,
  );
  git(['push', '-q', 'origin', branch], workDir);
  log(`[fb-data] 已推上 ${branch}：${relative.join('、')}（${rows} 列有日期）`);
  return { status: 'pushed', files: relative, rows };
}

function parseArgs(argv) {
  const args = {
    csv: '',
    dir: join(ROOT, '.cache/fb-data'),
    branch: process.env.LY_FB_DATA_BRANCH || 'fb-data',
    date: '',
    dryRun: false,
    remote: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--remote') args.remote = argv[++i];
    else if (!a.startsWith('--') && !args.csv) args.csv = a;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = resolve(args.csv || join(ROOT, '.cache/posts-latest.csv'));
  if (!existsSync(csvPath)) {
    console.error(`[fb-data] 找不到抓取檔：${csvPath}`);
    process.exitCode = 1;
    return;
  }
  const repoUrl = args.remote || runGit(['remote', 'get-url', 'origin'], ROOT);
  try {
    syncFbData({
      csvPath,
      date: dateOf(csvPath, args.date),
      repoUrl,
      workDir: resolve(args.dir),
      branch: args.branch,
      dryRun: args.dryRun,
      log: (m) => console.log(m),
    });
  } catch (error) {
    console.error(`[fb-data] 失敗：${redact(error.message)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
