import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncFbData, dateOf, redact } from '../scripts/push-fb-data.mjs';

const CSV_HEADER = '編號,姓名,政黨,選區/類別,臉書專頁名稱,最新貼文日期,最新貼文主題摘要,貼文或粉專連結';
const csvOf = (rows) => [CSV_HEADER, ...rows].join('\n') + '\n';
const ROWS_A = ['1,吳思瑤,民主進步黨,臺北市第一選區,吳思瑤,2026-10-05,摘要一,https://www.facebook.com/taipeineedyou'];
const ROWS_B = ['1,吳思瑤,民主進步黨,臺北市第一選區,吳思瑤,2026-10-06,摘要二,https://www.facebook.com/taipeineedyou'];

/** 做一個「遠端」bare repo，回傳 { url, workDir, csvPath, commitCount, show } */
function fixture({ rows = ROWS_A, date = '2026-10-06' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fb-data-test-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'fb-data', remote]);
  mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'fb-data'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'seed@example.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'seed'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), '# fb-data\n\n立委粉專每日抓取結果。\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'fb-data'], { cwd: seed });

  const csvPath = join(base, `posts-${date}.csv`);
  writeFileSync(csvPath, csvOf(rows));
  return {
    base,
    url: remote,
    workDir: join(base, 'work'),
    csvPath,
    date,
    commitCount: () => Number(execFileSync('git', ['rev-list', '--count', 'fb-data'], { cwd: remote, encoding: 'utf8' }).trim()),
    show: (path) => execFileSync('git', ['show', `fb-data:${path}`], { cwd: remote, encoding: 'utf8' }),
    log: (cwd) => execFileSync('git', ['log', '--format=%s', '-n', '1', 'fb-data'], { cwd, encoding: 'utf8' }).trim(),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('fb-data：第一次跑就把 CSV 推到資料分支，並留一份 latest.csv', () => {
  const f = fixture();
  try {
    const before = f.commitCount();
    const out = syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    assert.equal(out.status, 'pushed');
    assert.equal(out.rows, 1);
    assert.equal(f.commitCount(), before + 1, '應該多一個 commit');
    assert.match(f.show('posts/2026-10-06.csv'), /吳思瑤/, '日期檔要在資料分支裡');
    assert.equal(f.show('posts/latest.csv'), f.show('posts/2026-10-06.csv'), 'latest.csv 與當天檔內容一致');
    assert.equal(f.log(f.workDir), 'fb: 2026-10-06 抓取（1 列有日期）');
  } finally {
    f.cleanup();
  }
});

test('fb-data：內容沒變就不 commit、不 push（每天跑不會長出一堆空 commit）', () => {
  const f = fixture();
  try {
    syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    const after = f.commitCount();
    const again = syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    assert.equal(again.status, 'unchanged');
    assert.equal(f.commitCount(), after, '沒有新 commit');
  } finally {
    f.cleanup();
  }
});

test('fb-data：內容改了才 commit（同一天重跑抓到新貼文）', () => {
  const f = fixture();
  try {
    syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    writeFileSync(f.csvPath, csvOf(ROWS_B));
    const out = syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    assert.equal(out.status, 'pushed');
    assert.match(f.show('posts/2026-10-06.csv'), /摘要二/);
    assert.match(f.show('posts/latest.csv'), /摘要二/);
  } finally {
    f.cleanup();
  }
});

test('fb-data：--dry-run 只在本機預演，遠端不動', () => {
  const f = fixture();
  try {
    const before = f.commitCount();
    const out = syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir, dryRun: true });
    assert.equal(out.status, 'dry-run');
    assert.equal(f.commitCount(), before, '不該 push 上去');
  } finally {
    f.cleanup();
  }
});

test('fb-data：工作目錄已存在時要能更新（第二次執行不會撞到已存在的目錄）', () => {
  const f = fixture();
  try {
    syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    writeFileSync(f.csvPath, csvOf(ROWS_B));
    const out = syncFbData({ csvPath: f.csvPath, date: f.date, repoUrl: f.url, workDir: f.workDir });
    assert.equal(out.status, 'pushed', '重複使用同一個工作目錄要能 fetch／commit／push');
  } finally {
    f.cleanup();
  }
});

test('fb-data：日期取不出來時要擋下來，憑證網址要遮掉', () => {
  assert.throws(() => dateOf('/tmp/whatever.csv'), /看不出日期/);
  assert.equal(dateOf('/tmp/posts-2026-10-06.csv'), '2026-10-06');
  assert.equal(dateOf('/tmp/whatever.csv', '2026-10-06'), '2026-10-06');
  assert.equal(redact('fatal: https://x-access-token:secret@github.com/a/b.git'), 'fatal: https://<憑證>@github.com/a/b.git');
});
