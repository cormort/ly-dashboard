import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_SCOPES, SYNC_STAGES, DEFAULT_SCOPE, STAGE_DATASETS, resolveScope, scopeStages, scopeDatasets, datasetLabel, isKnownScope } from '../server/sync-scopes.mjs';

test('同步範圍：預設是全部，第一個選項就是它（下拉選單的預設值）', () => {
  assert.equal(DEFAULT_SCOPE, 'all');
  assert.equal(SYNC_SCOPES[0].id, 'all');
  assert.deepEqual(resolveScope(undefined).stages, SYNC_STAGES);
  assert.deepEqual(resolveScope('').stages, SYNC_STAGES, '空字串等同沒帶');
});

test('同步範圍：認不得的值一律退回全部（舊前端沒帶 scope 也不會壞）', () => {
  assert.equal(resolveScope('nope').id, 'all');
  assert.equal(resolveScope('SOCIAL').id, 'all', '大小寫不同不算同一個（避免前端拼錯卻靜默生效）');
  assert.equal(isKnownScope('social'), true);
  assert.equal(isKnownScope('SOCIAL'), false);
});

test('同步範圍：只重讀社群粉專＝委員粉專＋議員粉專，不會拖著跑新聞', () => {
  assert.deepEqual(scopeStages('social'), ['social', 'council_social']);
  assert.ok(!scopeStages('social').includes('news'), '重讀粉專不該跑新聞（實測新聞 763 秒）');
  assert.deepEqual(scopeDatasets('social'), ['social', 'council_social']);
});

test('同步範圍：名錄這一項涵蓋官方兩個資料集（id9／id14）', () => {
  assert.deepEqual(scopeDatasets('roster'), ['id9', 'id14']);
  assert.deepEqual(scopeDatasets('legislative'), ['bills', 'budget', 'budget_reports', 'meetings', 'records', 'ppg_progress']);
});

test('同步範圍：每個階段都要有 runner 對應的 dataset（少一個就會查不到上次同步時間）', () => {
  const allStages = new Set(SYNC_SCOPES.flatMap((scope) => scope.stages));
  assert.deepEqual([...allStages].sort(), [...SYNC_STAGES].sort(), '範圍用到的階段＝canonical 階段清單');
  assert.deepEqual(Object.keys(STAGE_DATASETS).sort(), [...SYNC_STAGES].sort(), '每個階段都要有 dataset 對應');
  for (const stage of SYNC_STAGES) assert.ok(STAGE_DATASETS[stage].length > 0, `${stage} 的 dataset 不可為空`);
});

test('同步範圍：dataset 標籤（給人看的名字；查不到的代號就原樣回傳）', () => {
  assert.equal(datasetLabel('social'), '委員粉專');
  assert.equal(datasetLabel('council_social'), '議員粉專');
  assert.equal(datasetLabel('id9'), 'ID9 立法委員名錄');
  assert.equal(datasetLabel('mystery'), 'mystery');
});
