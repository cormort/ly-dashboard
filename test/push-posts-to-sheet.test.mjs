import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromCsv, pushRows } from '../scripts/push-posts-to-sheet.mjs';

const HEADER = '編號,姓名,政黨,選區/類別,臉書專頁名稱,最新貼文日期,最新貼文主題摘要,貼文或粉專連結';

test('寫回：只送有日期的列（抓不到就留空、不送出去，免得把表上舊值清掉）', () => {
  const csv = [
    HEADER,
    '1,吳思瑤,民主進步黨,臺北市第一選區,吳思瑤,2026-10-05,貼文摘要一,https://www.facebook.com/taipeineedyou',
    '2,陳永康,中國國民黨,不分區,陳永康,,,', // 沒抓到日期
    '3,王世堅,民主進步黨,臺北市第二選區,王世堅,2026-10-04,"有,逗號的摘要",https://www.facebook.com/wcc',
  ].join('\n');
  const rows = rowsFromCsv(csv);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['1', '3'],
    '沒有日期的列不該送出',
  );
  assert.equal(rows[1].summary, '有,逗號的摘要', '引號包住的逗號要正確解析');
  assert.equal(rows[0].date, '2026-10-05');
});

test('寫回：抓取 CSV 欄位改名或缺少必要欄位要擋下來，不能默默送錯', () => {
  assert.throws(() => rowsFromCsv('編號,姓名\n1,吳思瑤'), /缺少欄位/);
});

test('寫回：Apps Script 轉址鏈偶發失敗會自動重試（寫入是冪等的，重送不會重複寫）', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ ok: true, sheet: 'Untitled', updated: 1, unchanged: 0, blank: 0, notFound: 0 }) };
  };
  const out = await pushRows({ url: 'https://example.test/exec', token: 'x', rows: [{ id: '1', date: '2026-10-06', summary: '' }], fetchImpl: flaky, sleep: async () => {} });
  assert.equal(calls, 3, '要重試到成功為止');
  assert.equal(out.updated, 1);
});

test('寫回：拿回 doGet 的提示（{ok:true,hint:…}）不算成功——那代表 POST 被轉成 GET、根本沒寫入', async () => {
  let calls = 0;
  const hintOnly = async () => {
    calls++;
    return { ok: true, json: async () => ({ ok: true, hint: 'POST JSON {token, rows:[…]}' }) };
  };
  await assert.rejects(
    () => pushRows({ url: 'https://example.test/exec', token: 'x', rows: [{ id: '1', date: '2026-10-06', summary: '' }], fetchImpl: hintOnly, sleep: async () => {} }),
    /不是寫入結果/,
  );
  assert.equal(calls, 3, '要重試到次數用完才回報失敗');
});

test('寫回：token 錯這種再送也不會好的，不重試（避免無謂等待）', async () => {
  let calls = 0;
  const badToken = async () => {
    calls++;
    return { ok: true, json: async () => ({ ok: false, error: 'bad-token' }) };
  };
  await assert.rejects(() => pushRows({ url: 'https://example.test/exec', token: 'x', rows: [], fetchImpl: badToken, sleep: async () => {} }), /bad-token/);
  assert.equal(calls, 1, 'bad-token 只打一次');
});

test('寫回：Web App 回 ok:false 要當失敗（回傳值不能只印出來就算了）', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: false, error: 'bad-token' }) });
  await assert.rejects(() => pushRows({ url: 'https://example.test/exec', token: 'x', rows: [{ id: '1', date: '2026-10-05', summary: '' }], fetchImpl }), /bad-token/);
});

test('寫回：HTTP 非 200 或回應不是 JSON 也要丟錯', async () => {
  const noSleep = { sleep: async () => {}, attempts: 2 };
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => pushRows({ url: 'https://example.test/exec', token: 'x', rows: [], fetchImpl: http500, ...noSleep }), /HTTP 500/);
  const notJson = async () => ({ ok: true, json: async () => { throw new Error('not json'); } });
  await assert.rejects(() => pushRows({ url: 'https://example.test/exec', token: 'x', rows: [], fetchImpl: notJson, ...noSleep }), /不是 JSON/);
});

test('寫回：送出的內容是 {token, rows}，且不夾帶姓名等試算表沒有的欄位', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ ok: true, sheet: 'Untitled', updated: 1, unchanged: 0, blank: 0, notFound: 0 }) };
  };
  const rows = rowsFromCsv([HEADER, '1,吳思瑤,民主進步黨,臺北市第一選區,吳思瑤,2026-10-05,摘要,https://www.facebook.com/taipeineedyou'].join('\n'));
  const out = await pushRows({ url: 'https://example.test/exec', token: 'tok', rows, fetchImpl });
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(seen.body, { token: 'tok', rows: [{ id: '1', date: '2026-10-05', summary: '摘要' }] });
  assert.equal(out.updated, 1);
});
