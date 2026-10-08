import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, getMeta } from '../server/db.mjs';
import { DataValidationError } from '../server/normalize.mjs';
import { applySeatOverrides, loadSeatOverrides, seatOverridesDigest } from '../server/committee-overrides.mjs';
import { runIngest } from '../server/ingest.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const silent = { log() {}, warn() {}, error() {} };
function recording() {
  return {
    logs: [], warns: [], errors: [],
    log(m) { this.logs.push(m); },
    warn(m) { this.warns.push(m); },
    error(m) { this.errors.push(m); },
    said(re) { return this.logs.some((m) => re.test(m)); },
  };
}
const respondWith = (payloadByDataset) => async (url) => {
  const key = url.includes('ID9') ? 'id9' : 'id14';
  return { json: payloadByDataset[key], status: 200, headers: {}, bytes: 100, sha256: `${key}-sha`, attempts: 1 };
};

/** 依補充表本身造一個合成 dataset（legislators = 表上所有名字），用來單獨驗補齊規則 */
function synthetic(overrides, { sessionId = '11-6', seats = [], sessions = null } = {}) {
  const names = new Set(Object.values(overrides.sessions[sessionId]).flatMap((e) => e.members));
  const legislators = [...names].map((name, i) => ({ id: `L${i}`, name }));
  const idOf = new Map(legislators.map((l) => [l.name, l.id]));
  return {
    term: 11,
    currentSession: sessionId,
    sessions: sessions ?? [{ id: sessionId, term: 11, seq: Number(sessionId.split('-')[1]), label: sessionId }],
    committees: [],
    legislators,
    memberships: [],
    seats: seats.map((s) => ({ session_id: sessionId, ...s })),
    warnings: [],
    stats: { legislators: legislators.length, memberships: 0, seats: seats.length, committees: 0, sessions: 1, current_session: sessionId, current_roster: 0, conveners_current_session: 0, conveners_any_session: 0 },
    idOf,
  };
}

/** 上游在 11-6 目前的實際樣子：只有交通委員會 14 席、沒有召委 */
const upstreamPartialSeats = (idOf) =>
  ['陳雪生', '洪孟楷', '魯明哲', '萬美玲', '黃健豪', '邱若華', '游顥', '李昆澤', '陳素月', '林俊憲', '許智傑', '何欣純', '徐富癸', '陳清龍'].map((name) => ({
    session_id: '11-6',
    committee_id: '交通委員會',
    legislator_id: idOf.get(name),
    is_convener: 0,
  }));

test('補充表（真實檔案）：11-6 八個委員會、113 席、16 位召委，且沒有跨委員會重複', () => {
  const overrides = loadSeatOverrides();
  assert.ok(overrides, 'server/committee-seats.json 應該存在');
  const table = overrides.sessions['11-6'];
  assert.ok(table, '應該有 11-6');
  assert.equal(Object.keys(table).length, 8, '八個常設委員會');

  let seats = 0;
  let conveners = 0;
  const seen = new Map();
  for (const [committee, entry] of Object.entries(table)) {
    assert.equal(entry.conveners.length, 2, `${committee} 應該有 2 位召委`);
    for (const c of entry.conveners) assert.ok(entry.members.includes(c), `${committee} 的召委要在委員名單內：${c}`);
    for (const name of entry.members) {
      seats += 1;
      assert.equal(seen.has(name), false, `${name} 同時出現在 ${seen.get(name)} 與 ${committee}`);
      seen.set(name, committee);
    }
    conveners += entry.conveners.length;
  }
  assert.equal(seats, 113, '立法院 113 席，每人只屬一個委員會');
  assert.equal(conveners, 16);
});

test('補齊：上游只有交通委員會 14 席時，用補充表補成完整會期', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides, { seats: [] });
  dataset.seats = upstreamPartialSeats(dataset.idOf);
  const log = recording();
  const report = applySeatOverrides(dataset, overrides, { logger: log });

  assert.equal(report.applied.length, 1);
  assert.deepEqual(
    { session: report.applied[0].session, seats: report.applied[0].seats, conveners: report.applied[0].conveners, upstream: report.applied[0].upstreamSeats, committees: report.applied[0].committees },
    { session: '11-6', seats: 113, conveners: 16, upstream: 14, committees: 8 },
  );
  assert.equal(dataset.seats.length, 113);
  assert.equal(dataset.committees.length, 8, ' committees 也要補進來');
  assert.equal(dataset.seats.filter((s) => s.is_convener).length, 16);
  assert.equal(dataset.seats.filter((s) => s.session_id === '11-6').length, 113, '不該留著舊的 14 席');
  assert.equal(dataset.stats.seats, 113, 'stats 要重算');
  assert.equal(dataset.stats.conveners_current_session, 16);
  assert.equal(dataset.stats.committees, 8);
  assert.equal(report.applied[0].membershipsAdded, 113, '成員名單也要補（否則前端預設會期只列 14 人）');
  assert.equal(dataset.memberships.filter((m) => m.session_id === '11-6').length, 113);
  assert.equal(dataset.stats.current_roster, 113);
  assert.ok(dataset.memberships.every((m) => m.id === `${m.legislator_id}|11-6`));
  assert.ok(log.said(/11-6 用人工確認的官方一覽表補齊 8 個委員會、113 席、16 位召委（上游只給了 14 席；成員名單補 113 人、移除屆次層級 0 筆）/), log.logs.join(' / '));
  assert.equal(dataset.warnings.length, 1, '要留一條 warning 給 /api/v1/health 看');
});

test('補成員時：屆次層級（session_id 為 null）那筆要拿掉，上游獨有的人要保留並發警告', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides);
  dataset.seats = upstreamPartialSeats(dataset.idOf);
  // 模擬名錄：他在任何會期都沒有紀錄 → normalize 會給一筆屆次層級的 membership
  dataset.memberships = [
    { id: 'LX|11|term', legislator_id: 'LX', session_id: null, term: 11 },
    { id: 'X1|11-6', legislator_id: 'X1', session_id: '11-6', term: 11 }, // 上游 11-6 有、補充表沒列到的人
  ];
  dataset.legislators.push({ id: 'LX', name: '廖先翔', party: '中國國民黨', caucus: '中國國民黨', area_name: '新北市第12選舉區' });

  const report = applySeatOverrides(dataset, overrides, { logger: silent });
  assert.equal(report.applied[0].droppedTermRows, 1, '屆次層級那筆要拿掉');
  assert.ok(!dataset.memberships.some((m) => m.session_id === null), '不該留屆次層級的重複紀錄');
  assert.deepEqual(report.applied[0].upstreamOnly, ['X1'], '上游獨有的人要保留並回報');
  assert.ok(dataset.warnings.some((w) => /不在補充表中/.test(w)), dataset.warnings.join(' / '));
  assert.equal(dataset.memberships.filter((m) => m.session_id === '11-6').length, 114, '113 位補充表成員 ＋ 1 位上游獨有');
});

test('召委只標在名單上那兩位（同一人同時在 conveners 與 members）', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides);
  dataset.seats = upstreamPartialSeats(dataset.idOf);
  applySeatOverrides(dataset, overrides, { logger: silent });
  const nameOf = new Map(dataset.legislators.map((l) => [l.id, l.name]));
  const conveners = dataset.seats.filter((s) => s.is_convener).map((s) => nameOf.get(s.legislator_id)).sort();
  assert.deepEqual(conveners.sort(), [
    '陳培瑜', '陳昭姿', '陳菁徽', '王正旭', '王義川', '廖先翔', '林俊憲', '林德福', '李柏毅', '徐巧芯', '張雅琳', '鍾佳濱', '鄭正鈐', '葉元之', '邱若華', '賴惠員',
  ].sort());
});

test('上游已經補齊（席次不少於補充表）：整段略過，不覆寫', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides);
  const table = overrides.sessions['11-6'];
  dataset.seats = Object.entries(table).flatMap(([committee_id, entry]) =>
    entry.members.map((name) => ({ session_id: '11-6', committee_id, legislator_id: dataset.idOf.get(name), is_convener: entry.conveners.includes(name) })),
  );
  const log = recording();
  const report = applySeatOverrides(dataset, overrides, { logger: log });
  assert.equal(report.applied.length, 0);
  assert.match(report.skipped[0].reason, /上游已有 113 席/);
  assert.equal(dataset.seats.length, 113);
  assert.equal(log.said(/補齊/), false);
});

test('名錄裡還沒有這個會期：略過（不拿未來的表去補過去的資料集）', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides, { sessions: [{ id: '11-5', term: 11, seq: 5, label: '第 11 屆第 5 會期' }] });
  const report = applySeatOverrides(dataset, overrides, { logger: silent });
  assert.equal(report.applied.length, 0);
  assert.deepEqual(report.skipped, [{ session: '11-6', reason: '名錄裡還沒有這個會期' }]);
  assert.equal(dataset.seats.length, 0);
});

test('名字對不上名錄：整段失敗（寧可同步失敗也不要靜默漏人）', () => {
  const overrides = loadSeatOverrides();
  const dataset = synthetic(overrides);
  dataset.legislators = dataset.legislators.filter((l) => l.name !== '游顥');
  delete dataset.idOf;
  assert.throws(
    () => applySeatOverrides(dataset, overrides, { logger: silent }),
    (error) => error instanceof DataValidationError && /游顥/.test(error.message),
  );
  assert.equal(dataset.seats.length, 0, '丟錯前不應該動到席次');
});

test('補充表指紋：內容不同就不同（只改補充表也要重新套用）', () => {
  const overrides = loadSeatOverrides();
  const tweaked = JSON.parse(JSON.stringify(overrides));
  tweaked.sessions['11-6']['內政委員會'].conveners = ['廖先翔', '黃捷'];
  assert.notEqual(seatOverridesDigest(overrides), seatOverridesDigest(tweaked));
  assert.equal(seatOverridesDigest(null), seatOverridesDigest(null));
});

test('ingest 串接：測試 fixture 沒有 11-6 這個會期 → 真實補充表被略過，數字不變', async () => {
  const db = openDb(':memory:');
  const result = await runIngest(db, { logger: silent, fetchImpl: respondWith({ id9: fixture('id9.json'), id14: fixture('id14.json') }) });
  assert.equal(result.stats.seats, 783, 'fixture 的席次不該被補充表動到');
  assert.equal(result.seat_overrides.applied.length, 0);
  assert.deepEqual(result.seat_overrides.skipped, [{ session: '11-6', reason: '名錄裡還沒有這個會期' }]);
});

test('ingest 串接：上游 11-6 只有 1 席時用真實補充表補齊；來源沒變不重複套用，補充表改了要重套', async () => {
  const db = openDb(':memory:');
  // 模擬真實情況：上游的 11-6 只給了交通委員會（把 fixture 補一行第 6 會期）
  const id9 = JSON.parse(JSON.stringify(fixture('id9.json')));
  const rows = id9.dataList ?? id9;
  const target = rows.find((r) => String(r.committee).includes('交通委員會'));
  target.committee = `${target.committee}第11屆第6會期：交通委員會;`;
  const fetchImpl = respondWith({ id9, id14: fixture('id14.json') });

  const first = await runIngest(db, { logger: silent, fetchImpl });
  assert.equal(first.seat_overrides.applied.length, 1);
  assert.equal(first.seat_overrides.applied[0].session, '11-6');
  assert.equal(first.seat_overrides.applied[0].seats, 113);
  const seats = () => db.prepare("SELECT count(*) AS n FROM committee_seats WHERE session_id = '11-6'").get().n;
  const conveners = () => db.prepare("SELECT count(*) AS n FROM committee_seats WHERE session_id = '11-6' AND is_convener = 1").get().n;
  assert.equal(seats(), 113, '11-6 補成完整的 113 席');
  assert.equal(conveners(), 16);

  const second = await runIngest(db, { logger: silent, fetchImpl });
  assert.equal(second.status, 'skipped', '同樣的來源＋同樣的補充表 → 內容未變更');
  assert.equal(seats(), 113);

  // 只改補充表一個字（換一位召委）→ applied_sha 要跟著變，重新套用
  const tweaked = JSON.parse(JSON.stringify(loadSeatOverrides()));
  tweaked.sessions['11-6']['內政委員會'].conveners = ['廖先翔', '黃捷'];
  const third = await runIngest(db, { logger: silent, fetchImpl, seatOverrides: tweaked });
  assert.equal(third.status, 'success', '補充表改了就要重新套用');
  const 內政召委 = db
    .prepare("SELECT l.name FROM committee_seats cs JOIN legislators l ON l.id = cs.legislator_id WHERE cs.session_id = '11-6' AND cs.committee_id = '內政委員會' AND cs.is_convener = 1")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(內政召委, ['廖先翔', '黃捷'].sort());
  assert.equal(seats(), 113);
});
