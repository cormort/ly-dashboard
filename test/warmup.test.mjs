import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { warmUp, WARMUP_QUERIES } from '../server/warmup.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const quiet = { log: () => {}, warn: () => {} };
const noYield = () => Promise.resolve();

test('預熱：清單裡的查詢在空資料庫與有名錄的資料庫都跑得完（參數寫錯會在這裡炸）', async () => {
  const empty = openDb(':memory:');
  assert.deepEqual(await warmUp(empty, { logger: quiet, yieldFn: noYield }), { ok: WARMUP_QUERIES.length, total: WARMUP_QUERIES.length });

  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json'), { sourceUrl: 'https://data.ly.gov.tw/' }), {
    fetchedAt: '2026-09-30T09:00:00.000Z',
    sourceUrl: 'https://data.ly.gov.tw/',
  });
  const warnings = [];
  const result = await warmUp(db, { logger: { log: () => {}, warn: (m) => warnings.push(m) }, yieldFn: noYield });
  assert.deepEqual(warnings, []);
  assert.equal(result.ok, WARMUP_QUERIES.length);
});

test('預熱：單支失敗只記 log，其他照跑；每支之前都讓出事件迴圈', async () => {
  const ran = [];
  const warnings = [];
  let yields = 0;
  const queries = [
    ['a', () => ran.push('a')],
    ['boom', () => { throw new Error('壞了'); }],
    ['c', () => ran.push('c')],
  ];
  const result = await warmUp(null, { queries, logger: { log: () => {}, warn: (m) => warnings.push(m) }, yieldFn: async () => { yields += 1; } });
  assert.deepEqual(ran, ['a', 'c']);
  assert.deepEqual(result, { ok: 2, total: 3 });
  assert.equal(yields, 3);
  assert.match(warnings[0], /boom.*壞了/);
});

test('預熱：清單涵蓋總覽頁（DashboardPage）打開時的每一支 API', () => {
  const page = readFileSync(fileURLToPath(new URL('../web/src/pages/DashboardPage.tsx', import.meta.url)), 'utf8');
  const paths = [...new Set([...page.matchAll(/buildUrl\('\/([^']+)'/g)].map((m) => m[1]))];
  assert.ok(paths.length >= 10, `應該抓到總覽頁的 API（實際 ${paths}）`);
  const labels = new Set(WARMUP_QUERIES.map(([label]) => label.split(' ')[0]));
  assert.deepEqual(paths.filter((p) => !labels.has(p)), [], '總覽頁新增了 API 就要一起加進預熱清單');
});
