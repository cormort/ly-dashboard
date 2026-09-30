import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDataset,
  DataValidationError,
  normalizeId14,
  parseSeatLabel,
  committeeKind,
} from '../server/normalize.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const id9 = fixture('id9.json');
const id14 = fixture('id14.json');

// 這一組期望值是從真實 API 回應（2026-09-30 抓取）人工核算出來的，不是照著實作推的。
const TRUTH = {
  term: 11,
  legislators: 123,
  currentSession: '11-5',
  currentRoster: 113,
  seats: 783,
  sessions: 5,
  committees: 11,
  convenersCurrentSession: 23, // 去重後的人數（id14 該會期有 26 筆召委紀錄，有人同時擔任兩個委員會）
  convenersAnySession: 68,
};

test('parseSeatLabel 會剝掉「第N屆第M會期：」前綴', () => {
  assert.deepEqual(parseSeatLabel('第11屆第3會期：內政委員會'), { term: 11, seq: 3, committee: '內政委員會' });
  assert.deepEqual(parseSeatLabel('第4屆第1會期:財政委員會'), { term: 4, seq: 1, committee: '財政委員會' });
  assert.equal(parseSeatLabel('內政委員會'), null, '沒有會期前綴的字串不該被當成席次');
  assert.equal(parseSeatLabel('第11屆第3會期：'), null);
});

test('committeeKind 區分常設與特種委員會', () => {
  assert.equal(committeeKind('內政委員會'), 'standing');
  assert.equal(committeeKind('程序委員會'), 'special');
  assert.equal(committeeKind('修憲委員會'), 'special');
});

test('真實 fixture：buildDataset 產出與人工核算一致的資料集', () => {
  const ds = buildDataset(id9, id14, { sourceUrl: 'https://data.ly.gov.tw/' });

  assert.equal(ds.term, TRUTH.term);
  assert.equal(ds.legislators.length, TRUTH.legislators);
  assert.equal(ds.currentSession, TRUTH.currentSession);
  assert.equal(ds.sessions.length, TRUTH.sessions);
  assert.equal(ds.seats.length, TRUTH.seats);
  assert.equal(ds.committees.length, TRUTH.committees);

  const currentRoster = ds.memberships.filter((m) => m.session_id === TRUTH.currentSession);
  assert.equal(currentRoster.length, TRUTH.currentRoster, '本會期名錄應為 113 人');

  const convenerIds = (sessionId) =>
    new Set(ds.seats.filter((s) => (sessionId ? s.session_id === sessionId : true) && s.is_convener).map((s) => s.legislator_id));
  assert.equal(convenerIds(TRUTH.currentSession).size, TRUTH.convenersCurrentSession);
  assert.equal(convenerIds(null).size, TRUTH.convenersAnySession, '跨會期去重後應為 68 人，而非舊版的 84');
});

test('真實 fixture：委員會 id 全部是乾淨名稱，沒有任何會期前綴', () => {
  const ds = buildDataset(id9, id14);
  for (const committee of ds.committees) {
    assert.ok(committee.id.length > 0);
    assert.ok(!committee.id.includes('會期'), `委員會 id 不該含會期前綴：${committee.id}`);
    assert.ok(!committee.id.includes('：'), `委員會 id 不該含全形冒號：${committee.id}`);
  }
  assert.deepEqual(
    [...new Set(ds.committees.map((c) => c.id))].sort(),
    [
      '交通委員會',
      '修憲委員會',
      '內政委員會',
      '司法及法制委員會',
      '外交及國防委員會',
      '教育及文化委員會',
      '社會福利及衛生環境委員會',
      '程序委員會',
      '經濟委員會',
      '經費稽核委員會',
      '財政委員會',
    ].sort(),
  );
});

test('真實 fixture：所有席次與會期都只屬於本屆（不被 id14 的第 4–10 屆污染）', () => {
  const ds = buildDataset(id9, id14);
  for (const session of ds.sessions) assert.equal(session.term, TRUTH.term);
  for (const seat of ds.seats) assert.ok(seat.session_id.startsWith(`${TRUTH.term}-`), `席次越屆：${seat.session_id}`);
});

test('回歸測試：id14 中其他屆次的同名召委紀錄不得影響本屆', () => {
  const pastTermRow = {
    committee: '內政委員會',
    lgno: '09999',
    name: '丁學忠',
    term: '10',
    sessionPeriod: '1',
    isCoChairman: 'Y',
  };
  const polluted = { dataList: [...id14.dataList, pastTermRow] };
  const ds = buildDataset(id9, polluted);
  const target = ds.legislators.find((l) => l.name === '丁學忠');
  const seats = ds.seats.filter((s) => s.legislator_id === target.id);
  assert.ok(seats.length > 0);
  assert.ok(seats.every((s) => s.is_convener === false), '第 10 屆的召委紀錄不該讓本屆變成召委');
  assert.equal(normalizeId14(polluted, { term: 11 }).filter((r) => r.name === '丁學忠' && r.is_convener).length, 0);
});

test('id9 委員若在本屆委員會欄位中無任何會期，不編造會期而是留下警告', () => {
  const ds = buildDataset(id9, id14);
  const termLevel = ds.memberships.filter((m) => m.session_id === null);
  assert.equal(termLevel.length, 2, '游錫堃、李貞秀在本屆無委員會紀錄');
  assert.equal(ds.warnings.filter((w) => w.includes('無任何會期委員會紀錄')).length, 2);
  assert.ok(ds.stats.current_session === TRUTH.currentSession);
});

test('fail closed：資料形狀不對時丟 DataValidationError', () => {
  assert.throws(() => buildDataset({}, id14), DataValidationError);
  assert.throws(() => buildDataset({ dataList: id9.dataList.slice(0, 5) }, id14), DataValidationError);
  assert.throws(() => buildDataset(id9, { dataList: id14.dataList.slice(0, 10) }), DataValidationError);
  assert.throws(() => buildDataset({ dataList: id9.dataList.map((r) => ({ ...r, name: '' })) }, id14), DataValidationError);
});
