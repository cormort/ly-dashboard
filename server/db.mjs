import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS terms (
  no INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  term_no INTEGER NOT NULL REFERENCES terms(no),
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  UNIQUE(term_no, seq)
);
CREATE TABLE IF NOT EXISTS legislators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ename TEXT,
  sex TEXT,
  party TEXT,
  caucus TEXT,
  area_name TEXT,
  photo_url TEXT,
  degree TEXT,
  experience TEXT,
  onboard_date TEXT,
  leave_flag INTEGER NOT NULL DEFAULT 0,
  leave_date TEXT,
  leave_reason TEXT,
  contacts TEXT,
  source_url TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  legislator_id TEXT NOT NULL REFERENCES legislators(id),
  session_id TEXT REFERENCES sessions(id),
  term_no INTEGER NOT NULL,
  party TEXT,
  caucus TEXT,
  area_name TEXT,
  onboard_date TEXT,
  leave_flag INTEGER NOT NULL DEFAULT 0,
  leave_date TEXT,
  leave_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_memberships_session ON memberships(session_id);
CREATE TABLE IF NOT EXISTS committees (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS committee_seats (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  committee_id TEXT NOT NULL REFERENCES committees(id),
  legislator_id TEXT NOT NULL REFERENCES legislators(id),
  is_convener INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, committee_id, legislator_id)
);
CREATE TABLE IF NOT EXISTS raw_snapshots (
  dataset TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  gzip BLOB NOT NULL,
  PRIMARY KEY (dataset, sha256)
);
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_log_at ON change_log(at DESC);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  records INTEGER,
  attempt INTEGER,
  http_status INTEGER,
  duration_ms INTEGER,
  ua TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  term INTEGER,
  session INTEGER,
  name TEXT NOT NULL,
  status TEXT,
  category TEXT,
  proposer_text TEXT,
  laws TEXT,
  latest_date TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS bill_sponsors (
  bill_id TEXT NOT NULL REFERENCES bills(id),
  legislator_id TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bill_id, legislator_id)
);
CREATE INDEX IF NOT EXISTS idx_bill_sponsors_legislator ON bill_sponsors(legislator_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(SCHEMA);
  // ponytail: 手寫 ADD COLUMN，欄位變多時再引入遷移框架
  const cols = new Set(db.prepare('PRAGMA table_info(legislators)').all().map((c) => c.name));
  if (!cols.has('contacts')) {
    db.exec('ALTER TABLE legislators ADD COLUMN contacts TEXT');
    // 舊資料沒有這個欄位：清掉 applied_sha，下次同步即使內容未變也會重新套用
    db.prepare("DELETE FROM meta WHERE key = 'applied_sha'").run();
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value == null ? null : String(value),
  );
}

export function saveSnapshot(db, dataset, { fetchedAt, sha256, bytes, json }) {
  const existing = db.prepare('SELECT 1 FROM raw_snapshots WHERE dataset = ? AND sha256 = ?').get(dataset, sha256);
  if (existing) return false;
  db.prepare('INSERT INTO raw_snapshots(dataset, fetched_at, sha256, bytes, gzip) VALUES(?, ?, ?, ?, ?)').run(
    dataset,
    fetchedAt,
    sha256,
    bytes,
    gzipSync(Buffer.from(JSON.stringify(json), 'utf8')),
  );
  return true;
}

export function recordSyncRun(db, run) {
  db.prepare(
    `INSERT INTO sync_runs(dataset, status, started_at, finished_at, records, attempt, http_status, duration_ms, ua, error)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.dataset,
    run.status,
    run.started_at,
    run.finished_at ?? null,
    run.records ?? null,
    run.attempt ?? null,
    run.http_status ?? null,
    run.duration_ms ?? null,
    run.ua ?? null,
    run.error ?? null,
  );
}

function readSeatMap(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT session_id, committee_id, legislator_id, is_convener FROM committee_seats').all()) {
    map.set(`${row.session_id}|${row.committee_id}|${row.legislator_id}`, Number(row.is_convener));
  }
  return map;
}

function readLegislatorMap(db) {
  const map = new Map();
  const rows = db
    .prepare('SELECT id, name, party, caucus, area_name, degree, experience, photo_url, leave_flag FROM legislators')
    .all();
  for (const row of rows) map.set(row.id, row);
  return map;
}

/**
 * 以單一交易把正規化後的資料寫進資料庫，並在覆蓋前算出 change_log。
 * 任何例外都會 rollback，舊資料不會被半寫入的新資料污染。
 */
export function applyDataset(db, dataset, { fetchedAt, sourceUrl }) {
  const at = fetchedAt;
  const previousSeats = readSeatMap(db);
  const previousLegislators = readLegislatorMap(db);
  const changes = [];

  // CR-5: O(1) name lookup（取代舊版 .find() 的 O(n²) 掃描）
  const legislatorNameById = new Map(dataset.legislators.map((l) => [l.id, l.name]));
  const seatLabel = (sessionId, committeeId, legislatorId) => {
    const name = legislatorNameById.get(legislatorId) ?? previousLegislators.get(legislatorId)?.name ?? legislatorId;
    return `${sessionId} ${committeeId} ${name}`;
  };

  const nextSeatKeys = new Set(dataset.seats.map((s) => `${s.session_id}|${s.committee_id}|${s.legislator_id}`));
  for (const seat of dataset.seats) {
    const key = `${seat.session_id}|${seat.committee_id}|${seat.legislator_id}`;
    const before = previousSeats.get(key);
    const after = seat.is_convener ? 1 : 0;
    if (before !== undefined && before !== after) {
      changes.push({
        entity: 'committee_seat',
        entity_id: key,
        field: 'is_convener',
        old_value: String(before),
        new_value: String(after),
      });
    }
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM committee_seats');
    db.exec('DELETE FROM memberships');
    db.exec('DELETE FROM committees');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM legislators');

    db.prepare('INSERT INTO terms(no, label) VALUES(?, ?) ON CONFLICT(no) DO UPDATE SET label = excluded.label').run(
      dataset.term,
      `第 ${dataset.term} 屆`,
    );

    const insertSession = db.prepare('INSERT INTO sessions(id, term_no, seq, label) VALUES(?, ?, ?, ?)');
    for (const s of dataset.sessions) insertSession.run(s.id, s.term, s.seq, s.label);

    const insertLegislator = db.prepare(
      `INSERT INTO legislators(id, name, ename, sex, party, caucus, area_name, photo_url, degree, experience,
                               onboard_date, leave_flag, leave_date, leave_reason, contacts, source_url)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of dataset.legislators) {
      insertLegislator.run(
        l.id,
        l.name,
        l.ename,
        l.sex,
        l.party,
        l.caucus,
        l.area_name,
        l.photo_url,
        l.degree,
        l.experience,
        l.onboard_date,
        l.leave_flag ? 1 : 0,
        l.leave_date,
        l.leave_reason,
        JSON.stringify(l.contacts ?? []),
        l.source_url,
      );
      const before = previousLegislators.get(l.id);
      if (before) {
        for (const [field, oldValue, newValue] of [
          ['party', before.party, l.party],
          ['area_name', before.area_name, l.area_name],
          ['leave_flag', String(before.leave_flag), l.leave_flag ? '1' : '0'],
        ]) {
          if (oldValue !== null && oldValue !== undefined && String(oldValue) !== String(newValue ?? '')) {
            changes.push({ entity: 'legislator', entity_id: l.id, field, old_value: String(oldValue), new_value: String(newValue ?? '') });
          }
        }
      }
    }

    const insertMembership = db.prepare(
      `INSERT INTO memberships(id, legislator_id, session_id, term_no, party, caucus, area_name, onboard_date,
                               leave_flag, leave_date, leave_reason)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of dataset.memberships) {
      insertMembership.run(
        m.id,
        m.legislator_id,
        m.session_id,
        m.term,
        m.party,
        m.caucus,
        m.area_name,
        m.onboard_date,
        m.leave_flag ? 1 : 0,
        m.leave_date,
        m.leave_reason,
      );
    }

    const insertCommittee = db.prepare('INSERT INTO committees(id, kind) VALUES(?, ?)');
    for (const c of dataset.committees) insertCommittee.run(c.id, c.kind);

    const insertSeat = db.prepare(
      'INSERT INTO committee_seats(session_id, committee_id, legislator_id, is_convener) VALUES(?, ?, ?, ?)',
    );
    for (const s of dataset.seats) insertSeat.run(s.session_id, s.committee_id, s.legislator_id, s.is_convener ? 1 : 0);

    const insertChange = db.prepare(
      'INSERT INTO change_log(at, entity, entity_id, field, old_value, new_value) VALUES(?, ?, ?, ?, ?, ?)',
    );
    for (const c of changes) insertChange.run(at, c.entity, c.entity_id, c.field, c.old_value ?? null, c.new_value ?? null);

    // CR-1: metadata 寫入移入交易內，確保資料與 metadata 的原子一致性
    setMeta(db, 'last_success_at', at);
    setMeta(db, 'term', dataset.term);
    setMeta(db, 'current_session', dataset.currentSession ?? '');
    setMeta(db, 'source_url', sourceUrl ?? '');
    setMeta(db, 'warnings', JSON.stringify(dataset.warnings ?? []));

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { changes, stats: dataset.stats, seatLabel };
}

/** 議案整批覆寫（單一交易）；bill_sponsors.legislator_id 不設 FK，名錄重建時不必連動刪議案。 */
export function applyBills(db, { bills, sponsors }, { fetchedAt }) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM bill_sponsors');
    db.exec('DELETE FROM bills');
    const insertBill = db.prepare(
      `INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bills) {
      insertBill.run(b.id, b.term, b.session, b.name, b.status, b.category, b.proposer_text, JSON.stringify(b.laws), b.latest_date, b.url);
    }
    const insertSponsor = db.prepare('INSERT OR IGNORE INTO bill_sponsors(bill_id, legislator_id, is_lead) VALUES(?, ?, ?)');
    for (const s of sponsors) insertSponsor.run(s.bill_id, s.legislator_id, s.is_lead ? 1 : 0);
    setMeta(db, 'bills_fetched_at', fetchedAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
