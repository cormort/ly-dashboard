import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, applyRollcalls, applyResolutions } from '../server/db.mjs';
import { normalizeRollcalls, normalizeResolutions, DataValidationError } from '../server/normalize.mjs';
import { listRollcalls, listResolutions } from '../server/queries.mjs';
import { runVotesIngest } from '../server/ingest.mjs';

/** 立法院 ID370 的原始形狀（一場表決一列，名單是「001王婉諭；002陳椒華；」） */
const rollcallRow = (over = {}) => ({
  term: '11',
  sessionPeriod: '05',
  sessionTimes: '23',
  meetingName: '第11屆第5會期第23次會議',
  voteDate: '115/05/20',
  voteTime: '11:01',
  voteIssue: '議事日程草案報告事項及質詢事項，民進黨黨團提議',
  voteType: '點名表決',
  votePresence: '104',
  voteAgree: '47',
  voteAgainst: '56',
  voteAbstain: '1',
  supporter: '001王定宇；002林俊憲；',
  opposer: '003王鴻薇；004伍麗華；',
  abstainer: '005陳椒華；',
  ...over,
});

const resolutionRow = (over = {}) => ({
  docuNo: '1150703496',
  itemNo: '001',
  title: '修正產業創新條例部分條文，咨請公布。',
  thirdReading: '11-05-23',
  note: '要求中央主管機關應於相關授權子法中，增訂建置高風險新創事業投資效益追蹤資料庫之規範。',
  url: 'https://ppg.ly.gov.tw/ppg/BillThirdReadingPassesClause/download/D_1.pdf',
  ...over,
});

const ROSTER = new Map([
  ['王定宇', 'LY-0001'],
  ['王鴻薇', 'LY-0002'],
  // 名錄的原住民委員會帶族名，表決名單只寫中文名
  ['伍麗華Saidhai‧Tahovecahe', 'LY-0003'],
]);

test('院會表決：日期轉西元、名單拆出代碼與姓名、族名用中文前綴對到委員', () => {
  const { votes, warnings } = normalizeRollcalls([rollcallRow()], ROSTER);
  assert.equal(votes.length, 1);
  const vote = votes[0];
  assert.equal(vote.vote_date, '2026-05-20', '民國 115/05/20 → 2026-05-20');
  assert.equal(vote.term, 11);
  assert.equal(vote.session_period, '05');
  assert.deepEqual(vote.supporters, [
    { code: '001', name: '王定宇', id: 'LY-0001' },
    { code: '002', name: '林俊憲', id: null },
  ]);
  assert.equal(vote.opposers[1].id, 'LY-0003', '「伍麗華」要對到名錄的「伍麗華Saidhai‧Tahovecahe」');
  assert.equal(vote.present, 104);
  assert.deepEqual(warnings, ['表決名單有 2 個姓名對不到本屆委員：林俊憲、陳椒華']);
});

test('院會表決：同一天同一議題只留一筆；沒有日期或議題的列跳過；空資料要炸', () => {
  const { votes } = normalizeRollcalls(
    [
      rollcallRow(),
      rollcallRow(), // 完全重複
      rollcallRow({ voteDate: '' }),
      rollcallRow({ voteIssue: '' }),
    ],
    ROSTER,
  );
  assert.equal(votes.length, 1);
  assert.throws(() => normalizeRollcalls([], ROSTER), DataValidationError);
  assert.throws(() => normalizeRollcalls(null, ROSTER), DataValidationError);
});

test('院會表決：新到舊排序（日期 → 時間）', () => {
  const { votes } = normalizeRollcalls(
    [
      rollcallRow({ voteDate: '115/05/20', voteTime: '09:00', voteIssue: 'A' }),
      rollcallRow({ voteDate: '115/05/21', voteTime: '10:00', voteIssue: 'B' }),
      rollcallRow({ voteDate: '115/05/21', voteTime: '14:00', voteIssue: 'C' }),
    ],
    ROSTER,
  );
  assert.deepEqual(votes.map((v) => v.issue), ['C', 'B', 'A']);
});

test('附帶決議：屆-會期-會次 兩種寫法都解析；note 空的跳過', () => {
  const { resolutions } = normalizeResolutions([
    resolutionRow(),
    resolutionRow({ docuNo: '1150703497', thirdReading: '11-05-23-01' }), // 四段寫法
    resolutionRow({ docuNo: '1150703498', thirdReading: '10-07-02-02' }),
    resolutionRow({ docuNo: '1150703499', note: '   ' }),
  ]);
  assert.equal(resolutions.length, 3, 'note 空白的不收');
  assert.deepEqual(
    resolutions.map((r) => [r.term, r.session_period, r.session_times]),
    [
      [11, '05', '23'],
      [11, '05', '23'],
      [10, '07', '02'],
    ],
  );
  assert.throws(() => normalizeResolutions([]), DataValidationError);
});

test('院會表決：分頁要翻到不滿 1000 筆為止（ID370 共 1,513 筆 → 兩頁）', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const calls = [];
  const page1 = Array.from({ length: 1000 }, (_, i) => rollcallRow({ voteIssue: `議題${i}`, voteDate: '115/05/20' }));
  const page2 = Array.from({ length: 513 }, (_, i) => rollcallRow({ voteIssue: `舊議題${i}`, voteDate: '112/02/21' }));
  const fetchImpl = async (url) => {
    calls.push(url);
    const id = new URL(url).searchParams.get('id');
    const page = Number(new URL(url).searchParams.get('page'));
    if (id === '370') return { json: { jsonList: page === 1 ? page1 : page === 2 ? page2 : [] }, status: 200, attempts: 1 };
    return { json: { jsonList: [resolutionRow()] }, status: 200, attempts: 1 };
  };
  const result = await runVotesIngest(db, { fetchImpl, logger: { log() {}, warn() {}, error() {} }, now: () => new Date('2026-10-19T00:00:00Z') });
  assert.equal(result.status, 'success');
  assert.equal(result.votes, 1513);
  assert.equal(result.resolutions, 1);
  // 370：第 2 頁只有 513 筆（< 1000）就結束，不必再問第 3 頁；373：一頁就結束
  assert.equal(calls.filter((u) => u.includes('id=370')).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rollcall_votes').get().n, 1513);
  // 每場表決：贊成 2 人、反對 2 人、棄權 1 人 → 5 票
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vote_ballots').get().n, 5 * 1513, '名單展開成一位委員一票一列');
});

test('查詢：依委員姓名只回他有投票的場次，並標出他自己的票', () => {
  const db = openDb(':memory:');
  migrate(db);
  applyRollcalls(
    db,
    normalizeRollcalls([rollcallRow(), rollcallRow({ voteIssue: '另一案', voteDate: '115/05/21' })], ROSTER).votes,
    { fetchedAt: 'x' },
  );
  const all = listRollcalls(db, {});
  assert.equal(all.total, 2);
  assert.equal(all.items[0].counts['贊成'], 2);
  const mine = listRollcalls(db, { legislator: '王鴻薇' });
  assert.equal(mine.total, 2);
  assert.equal(mine.items[0].mine, '反對', '王鴻薇在反對名單');
  const nobody = listRollcalls(db, { legislator: '不在名單上的人' });
  assert.equal(nobody.total, 0, '不在任何名單上的人不會有場次');
  // 關鍵字只比對議題與會議名稱
  assert.equal(listRollcalls(db, { q: '另一案' }).total, 1);
  assert.equal(listRollcalls(db, { term: 10 }).total, 0);
});

test('查詢：附帶決議可用屆次與關鍵字篩選，並回屆次統計', () => {
  const db = openDb(':memory:');
  migrate(db);
  applyResolutions(db, normalizeResolutions([resolutionRow(), resolutionRow({ docuNo: 'A2', thirdReading: '10-07-02-02', note: '要求經濟部提供資料' })]).resolutions, {
    fetchedAt: 'x',
  });
  const all = listResolutions(db, {});
  assert.equal(all.total, 2);
  assert.deepEqual(all.terms.map((t) => [t.term, t.count]), [[11, 1], [10, 1]]);
  assert.equal(listResolutions(db, { term: 10 }).total, 1);
  assert.equal(listResolutions(db, { q: '經濟部' }).total, 1);
  assert.equal(listResolutions(db, { q: '不存在的字' }).total, 0);
  assert.equal(all.items[0].session, '11-5', '會期代號去掉前導零');
});
