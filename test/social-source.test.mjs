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
import { triggerSync } from '../scripts/fb-daily.mjs';

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

// ── 觸發本機伺服器同步（2026-10-10 在 08:55 被 409 擋掉就放棄，站上因此兩天沒更新）────

async function runTrigger(fetchImpl, attempts = 3) {
  const original = globalThis.fetch;
  const lines = [];
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); };
  try {
    const line = await triggerSync(8787, 'social', (m) => lines.push(m), { attempts, timeoutMs: 50, delayMs: 1 });
    return { line, lines, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const accepted = () => ({ status: 202, ok: true, text: async () => '{"accepted":true,"started":true}' });
const busy = () => ({
  status: 409,
  ok: false,
  text: async () => '{"reason":"sync_in_progress","message":"已經有同步在跑（新聞），同時只會跑一個"}',
});

test('觸發同步：帶 force=1（剛寫回試算表，不能因為冷卻防呆就不重讀）', async () => {
  const { line, calls } = await runTrigger(accepted);
  assert.equal(line, '已觸發（social）');
  assert.match(calls[0].url, /\/api\/v1\/sync\?scope=social&force=1$/);
  assert.equal(calls[0].options.method, 'POST');
});

test('觸發同步：伺服器正在跑別的同步（409 sync_in_progress）要排隊重試，不是失敗', async () => {
  let n = 0;
  const { line, lines, calls } = await runTrigger(async () => {
    n += 1;
    return n < 3 ? busy() : accepted();
  });
  assert.equal(line, '已觸發（social）');
  assert.equal(calls.length, 3, '兩次 409 之後第三次成功');
  assert.match(lines[0], /觸發同步未成（第 1\/3 次）：伺服器正在跑其他同步/);
  assert.match(lines.at(-1), /已觸發本機伺服器/);
});

test('觸發同步：一直失敗要照實回報（含原因），並說伺服器排程會接手', async () => {
  const { line, lines } = await runTrigger(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8787'); });
  assert.match(line, /^未觸發（connect ECONNREFUSED/);
  assert.equal(lines.filter((l) => l.includes('觸發同步未成')).length, 3);
  assert.match(lines.at(-1), /自己的排程會讀到同一份試算表/);
});

test('觸發同步：HTTP 不是 202 也要留下狀態碼與訊息（不能靜靜地當成已觸發）', async () => {
  const { line } = await runTrigger(async () => ({
    status: 409, ok: false, text: async () => '{"reason":"sync_too_soon","message":"剛剛才同步過"}',
  }), 1);
  assert.match(line, /^未觸發（HTTP 409/);
  assert.match(line, /sync_too_soon/);
});
