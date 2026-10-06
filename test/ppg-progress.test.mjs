import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProgressOverride, getProgressOverrides, applyProgressOverrides } from '../server/db.mjs';
import { parseProgress, latestProgressDate, rocToIso, queryDateToIso, ppgBillUrl, fetchBillProgress } from '../server/ppg-progress.mjs';
import { runProgressDates } from '../server/ingest.mjs';
import { CONFIG } from '../server/config.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const silent = { log() {}, warn() {}, error() {} };
/** 真實的立法院議事暨公報資訊網議案頁（2026-10-06 抓的「115年度中央政府總預算追加預算案」） */
const ppgHtml = fixture('ppg-bill-301110233830000.html');
const servePpg = (html = ppgHtml) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { text: html, status: 200, headers: {}, bytes: html.length, sha256: 'x', attempts: 1 };
  };
  return { impl, calls };
};

test('官方議案頁解析：狀態、會議代碼、院會與日期都要抓對', () => {
  const entries = parseProgress(ppgHtml);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    status: '排入院會',
    meeting: '11-06-02',
    chamber: '院會',
    dates: ['2026-10-02', '2026-10-06', '2026-10-13'],
  });
});

test('官方議案頁解析：要忽略 HTML 註解與 Thymeleaf 模板（頁面裡有 100年12月12日 的樣板值）', () => {
  const dates = parseProgress(ppgHtml).flatMap((entry) => entry.dates);
  assert.ok(!dates.includes('2011-12-12'), '模板值不可以被當成日期');
  assert.ok(dates.every((date) => date >= '2020-01-01'));
});

test('最新進度日期：取已經發生的最新一個；全部在未來時退回最早的一個', () => {
  const entries = parseProgress(ppgHtml);
  assert.equal(latestProgressDate(entries, new Date('2026-10-06T10:00:00Z')), '2026-10-06');
  assert.equal(latestProgressDate(entries, new Date('2026-10-03T10:00:00Z')), '2026-10-02');
  assert.equal(latestProgressDate(entries, new Date('2026-09-01T10:00:00Z')), '2026-10-02', '都在未來時不要留空');
  assert.equal(latestProgressDate([], new Date('2026-10-06T10:00:00Z')), null);
});

test('日期轉換：民國年與 ivod 的 Querydate，超出合理範圍一律回 null', () => {
  assert.equal(rocToIso(115, '10', '02'), '2026-10-02');
  assert.equal(queryDateToIso('20261002'), '2026-10-02');
  assert.equal(rocToIso(80, 1, 1), null, '1991 年（第 7 屆以前）不接受');
  assert.equal(rocToIso(new Date().getFullYear() - 1911 + 5, 1, 1), null, '太遠的未來不接受');
  assert.equal(rocToIso(115, 13, 1), null, '月份不合法');
  assert.equal(queryDateToIso('2026100'), null);
});

test('抓取：議案頁網址是官方議事暨公報資訊網', async () => {
  assert.equal(ppgBillUrl('301110233830000'), 'https://ppg.ly.gov.tw/ppg/bills/301110233830000/details');
  const { impl, calls } = servePpg();
  const result = await fetchBillProgress('301110233830000', { fetchImpl: impl, now: new Date('2026-10-06T10:00:00Z') });
  assert.equal(result.date, '2026-10-06');
  assert.equal(calls.length, 1);
});

function seeded() {
  const db = openDb(':memory:');
  const insert = (table, id, session, latestDate) =>
    db
      .prepare(`INSERT INTO ${table}(${table === 'bills' ? 'id, term, session, name, latest_date, url' : 'id, term, session, category, name, status, proposer, fiscal_year, latest_date, url'}) VALUES(${table === 'bills' ? '?, ?, ?, ?, ?, ?' : '?, ?, ?, ?, ?, ?, ?, ?, ?, ?'})`)
      .run(...(table === 'bills' ? [id, 11, session, `${id} 案`, latestDate, `https://ex/${id}`] : [id, 11, session, '中央政府總預算案', `${id} 案`, '排入院會', '行政院', 115, latestDate, `https://ex/${id}`]));
  insert('budget_bills', 'current-nodate', 6, ''); // 本會期、沒有日期 → 要補
  insert('budget_bills', 'current-dated', 6, '2026-09-30'); // g0v 已給日期 → 不動
  insert('budget_bills', 'old-nodate', 3, ''); // 舊會期 → 不動
  insert('bills', 'bill-nodate', 6, ''); // 法案本會期沒日期 → 也要補
  return db;
}

test('補日期：只處理本會期沒有日期的議案，g0v 已給日期的不覆蓋，舊會期不動', async () => {
  const db = seeded();
  const { impl, calls } = servePpg();
  const result = await runProgressDates(db, { logger: silent, fetchImpl: impl, now: () => new Date('2026-10-06T10:00:00Z') });

  assert.deepEqual(calls.map((url) => url.split('/bills/')[1].split('/')[0]).sort(), ['bill-nodate', 'current-nodate']);
  assert.equal(result.checked, 2);
  assert.equal(result.filled, 2);
  const rows = db.prepare('SELECT id, latest_date FROM budget_bills ORDER BY id').all();
  assert.equal(rows.find((r) => r.id === 'current-nodate').latest_date, '2026-10-06', '補到的日期要寫進資料表');
  assert.equal(rows.find((r) => r.id === 'current-dated').latest_date, '2026-09-30', 'g0v 有給日期的不可以被我們蓋掉');
  assert.equal(rows.find((r) => r.id === 'old-nodate').latest_date, '', '舊會期不處理');
  assert.equal(db.prepare("SELECT latest_date FROM bills WHERE id = 'bill-nodate'").get().latest_date, '2026-10-06');
  assert.equal(db.prepare("SELECT status FROM sync_runs WHERE dataset = 'ppg_progress' ORDER BY id DESC").get().status, 'success');
});

test('補日期：同一天重跑不會再打一次官方網站（refreshHours 內跳過）', async () => {
  const db = seeded();
  const now = () => new Date('2026-10-06T10:00:00Z');
  const first = servePpg();
  await runProgressDates(db, { logger: silent, fetchImpl: first.impl, now });
  const second = servePpg();
  const result = await runProgressDates(db, { logger: silent, fetchImpl: second.impl, now });
  assert.equal(second.calls.length, 0, '剛查過就不該再抓');
  assert.equal(result.checked, 0);
});

test('補日期：抓不到日期（官方頁沒有）也要記一筆，並保留空白', async () => {
  const db = seeded();
  const empty = '<html><body><div id="section-3"><dl><dt><span class="Detail-SkedGroup-Sp">付委審查</span></dt><dd></dd></dl></div></body></html>';
  const { impl } = servePpg(empty);
  const result = await runProgressDates(db, { logger: silent, fetchImpl: impl, now: () => new Date('2026-10-06T10:00:00Z') });
  assert.equal(result.filled, 0);
  assert.equal(result.no_date, 2);
  assert.equal([...getProgressOverrides(db).values()].filter((o) => o.date === '').length, 2, '查過但沒有日期也要記錄（避免每天重打）');
  assert.equal(applyProgressOverrides(db), 0, '沒有日期就不該改動資料');
});

test('補日期：抓取失敗不可以寫入任何東西（fail closed）', async () => {
  const db = seeded();
  const boom = async () => {
    throw new Error('HTTP 500');
  };
  const result = await runProgressDates(db, { logger: silent, fetchImpl: boom, now: () => new Date('2026-10-06T10:00:00Z') });
  assert.equal(result.failed, 2);
  assert.equal(getProgressOverrides(db).size, 0, '失敗不留下紀錄，下一輪會再試');
  assert.equal(db.prepare("SELECT latest_date FROM budget_bills WHERE id = 'current-nodate'").get().latest_date, '');
});

test('補日期：已補過但過期的要回頭刷新（案子會繼續跑進度）', async () => {
  const db = seeded();
  const t0 = new Date('2026-10-01T00:00:00Z');
  const { impl } = servePpg();
  await runProgressDates(db, { logger: silent, fetchImpl: impl, now: () => t0 });
  const later = servePpg();
  const result = await runProgressDates(db, { logger: silent, fetchImpl: later.impl, now: () => new Date(t0.getTime() + (CONFIG.progress.refreshHours + 1) * 3600_000) });
  assert.equal(result.checked, 2, '超過 refreshHours 要再查一次');
});
