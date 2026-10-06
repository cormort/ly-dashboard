import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recordSyncRun } from '../server/db.mjs';
import { checkSyncGuard } from '../server/sync-guard.mjs';
import { SYNC_SCOPES, resolveScope, scopeDatasets } from '../server/sync-scopes.mjs';

const now = new Date('2026-10-06T12:00:00+08:00');
const minutesBefore = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();

/** 每個範圍涵蓋的資料集各寫一筆成功的同步紀錄（finished_at 由呼叫端決定新舊） */
function dbWithSync(scopeId, { minutesAgo = 2, status = 'success' } = {}) {
  const db = openDb(':memory:');
  for (const dataset of scopeDatasets(resolveScope(scopeId).id)) {
    recordSyncRun(db, {
      dataset,
      status,
      started_at: minutesBefore(minutesAgo + 1),
      finished_at: minutesBefore(minutesAgo),
      records: 10,
      attempt: 1,
    });
  }
  return db;
}

test('防呆：剛同步過的範圍直接擋下來，並說明「現在按不會取得更新的資料」', () => {
  const db = dbWithSync('social', { minutesAgo: 2 });
  const guard = checkSyncGuard(db, 'social', { now });
  assert.equal(guard.allow, false);
  assert.equal(guard.reason, 'sync_too_soon');
  assert.match(guard.message, /才同步過/);
  assert.match(guard.message, /不會取得更新的資料/);
  assert.match(guard.message, /仍要重跑/, '要留一條路給真的要重跑的人');
  assert.match(guard.message, /一天只有一輪/, '要講清楚來源的更新節奏，使用者才知道為什麼沒意義');
  assert.equal(guard.minutes_ago, 2);
});

test('防呆：超過各範圍的冷卻時間就放行', () => {
  for (const scope of SYNC_SCOPES) {
    const db = dbWithSync(scope.id, { minutesAgo: scope.cooldownMinutes + 5 });
    assert.equal(checkSyncGuard(db, scope.id, { now }).allow, true, `${scope.id} 應該放行`);
  }
});

test('防呆：force 可以強制重跑（按了「仍要重跑」就走這條）', () => {
  const db = dbWithSync('all', { minutesAgo: 1 });
  assert.equal(checkSyncGuard(db, 'all', { now }).allow, false);
  assert.deepEqual(checkSyncGuard(db, 'all', { now, force: true }), { allow: true });
});

test('防呆：從來沒同步過的範圍不擋（第一次當然要跑）', () => {
  const db = openDb(':memory:');
  assert.equal(checkSyncGuard(db, 'all', { now }).allow, true);
});

test('防呆：上次有來源失敗就不擋（重試有意義）', () => {
  const db = dbWithSync('roster', { minutesAgo: 1, status: 'failed' });
  assert.equal(checkSyncGuard(db, 'roster', { now }).allow, true);
});

test('防呆：已經有同步在跑就只講這件事，不讓人白按', () => {
  const db = openDb(':memory:');
  const guard = checkSyncGuard(db, 'news', { now, inflight: 'all' });
  assert.equal(guard.allow, false);
  assert.equal(guard.reason, 'sync_in_progress');
  assert.match(guard.message, /已經有同步在跑（全部）/);
  assert.equal(guard.inflight_scope, 'all');
});

test('防呆：不認識的範圍退回「全部」，冷卻時間用全部那一組', () => {
  const db = dbWithSync('all', { minutesAgo: 3 });
  const guard = checkSyncGuard(db, '這是亂打的', { now });
  assert.equal(guard.allow, false);
  assert.equal(guard.reason, 'sync_too_soon');
  assert.match(guard.message, /「全部」/);
});
