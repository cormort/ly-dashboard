/**
 * scripts/social-source.mjs 的測試。
 *
 * 背景：2026-10-10 08:00 的每日抓取一開跑就 `fetch failed`（UND_ERR_CONNECT_TIMEOUT），
 * 秒殺結束、整天沒有資料，而 log 只有 “fetch failed” 四個字（真正的原因在 err.cause）。
 * 這裡驗的就是那兩件事：**連線失敗要等它恢復**、**錯誤要講得出原因**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeError, sheetCsvUrl, waitForCsv } from '../scripts/social-source.mjs';

const URL_DEFAULT = 'https://docs.google.com/spreadsheets/d/11XrvNGMKZb_8rekFdGIg5VsXcV8rdJkZjyzd1I4gAMM/export?format=csv&gid=1325033898';

test('整理表網址：預設值與抓取腳本用的是同一份表', () => {
  assert.equal(sheetCsvUrl({}), URL_DEFAULT);
  assert.equal(sheetCsvUrl({ LY_SOCIAL_GID: '42' }),
    'https://docs.google.com/spreadsheets/d/11XrvNGMKZb_8rekFdGIg5VsXcV8rdJkZjyzd1I4gAMM/export?format=csv&gid=42');
  assert.equal(sheetCsvUrl({ LY_SOCIAL_CSV: 'https://example.test/x.csv' }), 'https://example.test/x.csv');
  assert.equal(sheetCsvUrl({ LY_SOCIAL_CSV: 'https://example.test/x.csv', LY_SOCIAL_GID: '42' }),
    'https://example.test/x.csv', 'LY_SOCIAL_CSV 是整串覆寫，不該被 gid 蓋掉');
});

test('錯誤描述要把 cause 帶出來（fetch failed 本身沒有資訊）', () => {
  const netErr = Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.equal(describeError(netErr), 'fetch failed（UND_ERR_CONNECT_TIMEOUT）');
  assert.equal(describeError(new Error('HTTP 404')), 'HTTP 404');
  assert.equal(describeError(Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') })),
    'fetch failed（getaddrinfo ENOTFOUND）', 'cause 沒有 code 時退回 message');
});

/** 用假的 fetch 跑一次，回傳 log 行。 */
async function runWait(fetchImpl, opts = {}) {
  const original = globalThis.fetch;
  const lines = [];
  globalThis.fetch = fetchImpl;
  try {
    const ok = await waitForCsv('https://example.test/x.csv', (m) => lines.push(m),
      { attempts: 3, delayMs: 1, timeoutMs: 50, ...opts });
    return { ok, lines };
  } finally {
    globalThis.fetch = original;
  }
}

const csvResponse = () => ({
  ok: true,
  status: 200,
  text: async () => '編號,姓名,貼文或粉專連結\n1,甲,https://www.facebook.com/x\n',
});

test('連線失敗會等它恢復：第一次失敗、第二次成功', async () => {
  let calls = 0;
  const { ok, lines } = await runWait(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return csvResponse();
  });
  assert.equal(ok, true);
  assert.equal(calls, 2, '第一次失敗後要再試一次');
  assert.match(lines[0], /整理表連線檢查失敗（第 1\/3 次）：fetch failed（UND_ERR_CONNECT_TIMEOUT）/);
  assert.match(lines[1], /整理表連線恢復（第 2 次嘗試）/);
});

test('一直連不上：試滿次數回 false，每次都留下原因', async () => {
  const { ok, lines } = await runWait(async () => { throw new Error('HTTP 503'); });
  assert.equal(ok, false);
  assert.equal(lines.length, 3, '三次都要有紀錄');
  assert.match(lines[2], /第 3\/3 次）：HTTP 503$/);
});

test('連得到但不是整理表（例如被導到登入頁）也要算失敗', async () => {
  const { ok, lines } = await runWait(async () => ({ ok: true, status: 200, text: async () => '<html>登入</html>' }));
  assert.equal(ok, false);
  assert.match(lines[0], /回傳內容不是整理表 CSV/);
});
