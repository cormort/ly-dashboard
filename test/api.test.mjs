import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, saveSnapshot, recordSyncRun, getMeta } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { getHealth, getMetaPayload, listChanges, listCommittees, listLegislators, listSyncRuns } from '../server/queries.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

function seeded() {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'), { sourceUrl: 'https://data.ly.gov.tw/' });
  const fetchedAt = '2026-09-30T09:00:00.000Z';
  applyDataset(db, dataset, { fetchedAt, sourceUrl: 'https://data.ly.gov.tw/' });
  saveSnapshot(db, 'id9', { fetchedAt, sha256: 'a'.repeat(64), bytes: 1234, json: fixture('id9.json') });
  saveSnapshot(db, 'id9', { fetchedAt, sha256: 'a'.repeat(64), bytes: 1234, json: fixture('id9.json') }); // 重複不該再寫
  recordSyncRun(db, {
    dataset: 'id9',
    status: 'success',
    started_at: fetchedAt,
    finished_at: fetchedAt,
    records: dataset.stats.legislators,
    attempt: 1,
    http_status: 200,
    duration_ms: 1234,
    ua: 'ly-dashboard/1.0 (test)',
    error: null,
  });
  return { db, dataset };
}

test('寫入後：預設查詢是本會期 113 人，且委員會已正規化', () => {
  const { db } = seeded();
  const current = listLegislators(db, {});
  assert.equal(current.total, 113);
  assert.equal(current.meta.term, 11);
  assert.equal(current.meta.session, '11-5');
  assert.ok(current.items.every((x) => x.committees.every((c) => !c.id.includes('會期'))));

  const all = listLegislators(db, { session: 'all' });
  assert.equal(all.total, 123, '全屆次檢視才看得到 123 位追蹤對象（含 2 位無會期紀錄者）');

  // 立法院固定 113 席：每個會期名錄都應該是 113 人，但「組成人員」會因辭職／遞補而不同。
  for (const sessionId of ['11-1', '11-2', '11-3', '11-4', '11-5']) {
    assert.equal(listLegislators(db, { session: sessionId }).total, 113, `${sessionId} 應為 113 人`);
  }

  const s1 = listLegislators(db, { session: '11-1' });
  const s5 = listLegislators(db, { session: '11-5' });
  const names = (x) => x.items.map((i) => i.name);
  assert.ok(names(s1).includes('黃國昌'), '第 1 會期應包含後來辭職的黃國昌');
  assert.ok(!names(s5).includes('黃國昌'), '第 5 會期不該再出現已辭職者');
  assert.ok(names(s5).includes('劉書彬'), '第 5 會期應包含遞補者');
  assert.equal(s1.items.find((i) => i.name === '黃國昌').former, true, '離職者要標記為 former');
});

test('篩選：黨籍、委員會、只看召委、關鍵字', () => {
  const { db } = seeded();
  const kmt = listLegislators(db, { party: '中國國民黨' });
  assert.ok(kmt.total > 40 && kmt.total < 60);
  assert.ok(kmt.items.every((x) => x.party === '中國國民黨'));

  const interior = listLegislators(db, { committee: '內政委員會' });
  assert.ok(interior.total >= 10);
  assert.ok(interior.items.every((x) => x.committees.some((c) => c.id === '內政委員會')));

  const conveners = listLegislators(db, { convener: '1' });
  assert.equal(conveners.total, 23, '本會期召委 23 人（去重）');

  const search = listLegislators(db, { q: '雲林' });
  assert.ok(search.total >= 1);
  assert.ok(search.items.every((x) => `${x.name}${x.area_name}${x.party}`.includes('雲林') || x.area_name.includes('雲林')));
});

test('委員會端點：本會期 11 個委員會，且只包含本會期真實存在的', () => {
  const { db } = seeded();
  const committees = listCommittees(db, {});
  assert.equal(committees.count, 11);
  assert.equal(committees.meta.session, '11-5');
  for (const c of committees.items) {
    assert.ok(c.count > 0);
    assert.ok(!c.id.includes('會期'));
  }
  const interior = committees.items.find((c) => c.id === '內政委員會');
  assert.ok(interior.conveners.length >= 1);

  const session1 = listCommittees(db, { session: '11-1' });
  assert.equal(session1.count, 10, '第 1 會期只有 10 個委員會（修憲委員會尚未成立）');
});

test('health / meta / changes / sync-runs 端點形狀正確', () => {
  const { db } = seeded();
  const health = getHealth(db);
  assert.equal(health.db.legislators, 123);
  assert.equal(health.db.committee_seats, 783);
  assert.equal(health.db.snapshots, 1, '相同 sha256 的快照不重複寫入');
  assert.equal(health.last_runs[0].records, 123);
  assert.equal(health.meta.stale, false);

  const meta = getMetaPayload(db);
  assert.equal(meta.terms.length, 1);
  assert.equal(meta.terms[0].no, 11);
  assert.equal(meta.terms[0].sessions.length, 5);
  assert.deepEqual(meta.current, { term: 11, session: '11-5' });

  const changes = listChanges(db, { limit: 10 });
  assert.equal(changes.count, 0, '第一次寫入沒有前一份資料可比對，異動應為 0');

  const runs = listSyncRuns(db, { limit: 5 });
  assert.equal(runs.count, 1);
  assert.equal(runs.items[0].dataset, 'id9');
});

test('change_log：召委異動會被記錄（模擬真實改版）', () => {
  const db = openDb(':memory:');
  const id9 = fixture('id9.json');
  const id14 = fixture('id14.json');
  const fetchedAt = '2026-09-30T09:00:00.000Z';
  applyDataset(db, buildDataset(id9, id14), { fetchedAt });

  // 模擬：某位現任委員在 id14 中被標記為召委
  const target = id9.dataList.find((r) => r.name === '丁學忠');
  const patched = {
    dataList: id14.dataList.map((r) =>
      r.name === '丁學忠' && r.term === '11' && r.sessionPeriod === '5' && r.committee === '內政委員會'
        ? { ...r, isCoChairman: 'Y' }
        : r,
    ),
  };
  const after = buildDataset(id9, patched);
  const { changes } = applyDataset(db, after, { fetchedAt: '2026-09-30T10:00:00.000Z' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'is_convener');
  assert.equal(changes[0].old_value, '0');
  assert.equal(changes[0].new_value, '1');

  const logged = listChanges(db, { limit: 10 });
  assert.equal(logged.count, 1);
  assert.equal(logged.items[0].new_value, '1');
  assert.equal(logged.items[0].entity_id, '11-5|內政委員會|00001', '席次以穩定 id（立院 lgno）標識');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T10:00:00.000Z');
  assert.equal(target.name, '丁學忠');
});

test('寫入是交易：中途失敗不會留下半套資料', () => {
  const db = openDb(':memory:');
  const dataset = buildDataset(fixture('id9.json'), fixture('id14.json'));
  applyDataset(db, dataset, { fetchedAt: '2026-09-30T09:00:00.000Z' });
  const before = listLegislators(db, {}).total;

  const broken = structuredClone(dataset);
  broken.seats[0].legislator_id = null; // 觸發 NOT NULL / FK 失敗
  assert.throws(() => applyDataset(db, broken, { fetchedAt: '2026-09-30T11:00:00.000Z' }));
  assert.equal(listLegislators(db, {}).total, before, '失敗後仍應是舊資料');
  assert.equal(getMeta(db, 'last_success_at'), '2026-09-30T09:00:00.000Z');
});
