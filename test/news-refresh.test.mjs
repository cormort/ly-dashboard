import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recordSyncRun } from '../server/db.mjs';
import { shouldRefreshNews } from '../server/index.mjs';

/**
 * 新聞階段自動重跑的決策：`shouldRefreshNews(db, { now, intervalMs })`。
 * 刻意「只」看新聞自己的最後成功時間（sync_runs 逐 dataset 有紀錄），不看全域的 last_success_at ——
 * 否則別階段剛跑完（更新了 last_success_at）會讓新聞永遠排不到。
 */

const NOW = Date.parse('2026-10-08T12:00:00+08:00');
const SIX_HOURS = 6 * 60 * 60 * 1000;
const hoursBefore = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

/** 寫一筆新聞的同步紀錄（finished_at 由呼叫端決定新舊） */
function dbWithNews({ hoursAgo = 1, status = 'success' } = {}) {
  const db = openDb(':memory:');
  recordSyncRun(db, {
    dataset: 'news',
    status,
    started_at: hoursBefore(hoursAgo + 0.1),
    finished_at: hoursBefore(hoursAgo),
    records: 10,
    attempt: 1,
  });
  return db;
}

test('新聞重跑：從沒成功過 → 要跑（第一次當然要抓）', () => {
  const db = openDb(':memory:');
  assert.equal(shouldRefreshNews(db, { now: NOW, intervalMs: SIX_HOURS, inflightScope: null }), true);
});

test('新聞重跑：最後一次成功還在 interval 內 → 不跑', () => {
  const db = dbWithNews({ hoursAgo: 1 });
  assert.equal(shouldRefreshNews(db, { now: NOW, intervalMs: SIX_HOURS, inflightScope: null }), false);
});

test('新聞重跑：interval=0（停用）→ 不跑，即使從沒成功過', () => {
  const empty = openDb(':memory:');
  assert.equal(shouldRefreshNews(empty, { now: NOW, intervalMs: 0, inflightScope: null }), false);
  const fresh = dbWithNews({ hoursAgo: 100 });
  assert.equal(shouldRefreshNews(fresh, { now: NOW, intervalMs: 0, inflightScope: null }), false);
});

test('新聞重跑：已經有同步在跑 → 不跑（single-flight）', () => {
  const empty = openDb(':memory:');
  assert.equal(shouldRefreshNews(empty, { now: NOW, intervalMs: SIX_HOURS, inflightScope: 'news' }), false);
  assert.equal(shouldRefreshNews(empty, { now: NOW, intervalMs: SIX_HOURS, inflightScope: 'all' }), false);
});

test('新聞重跑：超過 interval → 要跑（不是永遠不跑）', () => {
  const db = dbWithNews({ hoursAgo: 7 });
  assert.equal(shouldRefreshNews(db, { now: NOW, intervalMs: SIX_HOURS, inflightScope: null }), true);
});

test('新聞重跑：上次是失敗不算成功 → 要跑（重試有意義）', () => {
  const db = dbWithNews({ hoursAgo: 1, status: 'failed' });
  assert.equal(shouldRefreshNews(db, { now: NOW, intervalMs: SIX_HOURS, inflightScope: null }), true);
});

test('新聞重跑：只看新聞自己的紀錄，別階段剛成功不會讓它排不到', () => {
  const db = openDb(':memory:');
  // 別的階段（例如議事）剛剛成功，但新聞從來沒成功過
  recordSyncRun(db, {
    dataset: 'bills',
    status: 'success',
    started_at: hoursBefore(0.2),
    finished_at: hoursBefore(0.1),
    records: 100,
    attempt: 1,
  });
  assert.equal(shouldRefreshNews(db, { now: NOW, intervalMs: SIX_HOURS, inflightScope: null }), true, '新聞仍要跑');
});
