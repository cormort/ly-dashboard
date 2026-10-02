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
CREATE TABLE IF NOT EXISTS news (
  legislator_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (legislator_id, url)
);
CREATE INDEX IF NOT EXISTS idx_news_legislator_date ON news(legislator_id, published_at DESC);
-- 主題新聞（不限委員）：目前只有主計總處專頁用，topic = 'dgbas'
CREATE TABLE IF NOT EXISTS topic_news (
  topic TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (topic, url)
);
CREATE TABLE IF NOT EXISTS social_accounts (
  legislator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  page_name TEXT,
  url TEXT NOT NULL,
  latest_post_date TEXT,
  latest_post_summary TEXT,
  -- 'sheet'（整理表）或 'override'（人工更正表）；用來分辨哪些是追蹤過的資料
  source TEXT,
  PRIMARY KEY (legislator_id, platform, url)
);
CREATE TABLE IF NOT EXISTS budget_bills (
  id TEXT PRIMARY KEY,
  term INTEGER,
  session INTEGER,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT,
  proposer TEXT,
  fiscal_year INTEGER,
  latest_date TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS budget_reports (
  no TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  completed TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS committee_meetings (
  id INTEGER PRIMARY KEY,
  date TEXT,
  committee TEXT,
  joint TEXT,
  name TEXT,
  content TEXT,
  speakers TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS committee_records (
  id TEXT PRIMARY KEY,
  date TEXT,
  committees TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  gazette_url TEXT,
  html_url TEXT,
  pdf_url TEXT
);
CREATE TABLE IF NOT EXISTS committee_meets (
  code TEXT PRIMARY KEY,
  date TEXT,
  title TEXT NOT NULL,
  committees TEXT NOT NULL DEFAULT '[]',
  video_url TEXT,
  attachments TEXT NOT NULL DEFAULT '[]'
);
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
  const socialCols = new Set(db.prepare('PRAGMA table_info(social_accounts)').all().map((c) => c.name));
  if (!socialCols.has('source')) {
    db.exec('ALTER TABLE social_accounts ADD COLUMN source TEXT');
    db.prepare("DELETE FROM meta WHERE key = 'social_applied_sha'").run();
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
          // old_value 允許是空的：'（無）→ 有值' 也是一次異動（例如原本沒有黨籍、選區後補）。
          // 只有「新舊完全相同」才不記。
          if (String(oldValue ?? '') !== String(newValue ?? '')) {
            changes.push({ entity: 'legislator', entity_id: l.id, field, old_value: String(oldValue ?? ''), new_value: String(newValue ?? '') });
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
  const previous = new Map(db.prepare('SELECT id, status FROM bills').all().map((r) => [r.id, r.status]));
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

    // M2：議案進度異動留痕（哪些案子從什麼狀態變成什麼狀態）
    const insertChange = db.prepare(
      'INSERT INTO change_log(at, entity, entity_id, field, old_value, new_value) VALUES(?, ?, ?, ?, ?, ?)',
    );
    let changes = 0;
    for (const b of bills) {
      const before = previous.get(b.id);
      if (before !== undefined && before !== (b.status ?? null)) {
        insertChange.run(fetchedAt, 'bill', b.id, 'status', before, b.status ?? null);
        changes += 1;
      }
    }

    setMeta(db, 'bills_fetched_at', fetchedAt);
    setMeta(db, 'bills_count', String(bills.length));
    db.exec('COMMIT');
    return { changes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 預算類議案整批覆寫（與委員提案分開 fail closed），狀態變動寫入 change_log。 */
export function applyBudget(db, items, { fetchedAt }) {
  const previous = new Map(db.prepare('SELECT id, status FROM budget_bills').all().map((r) => [r.id, r.status]));
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM budget_bills');
    const insert = db.prepare(
      `INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChange = db.prepare('INSERT INTO change_log(at, entity, entity_id, field, old_value, new_value) VALUES(?, ?, ?, ?, ?, ?)');
    let changes = 0;
    for (const b of items) {
      insert.run(b.id, b.term, b.session, b.category, b.name, b.status, b.proposer, b.fiscal_year, b.latest_date, b.url);
      const before = previous.get(b.id);
      if (before !== undefined && before !== (b.status ?? null)) {
        insertChange.run(fetchedAt, 'budget', b.id, 'status', before, b.status ?? null);
        changes += 1;
      }
    }
    setMeta(db, 'budget_fetched_at', fetchedAt);
    db.exec('COMMIT');
    return { changes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 整批覆寫一張表（交易內；失敗回滾保留舊資料）並記下抓取時間 */
function replaceAll(db, table, columns, rows, metaKey, fetchedAt) {
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${table}`);
    const insert = db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`);
    for (const row of rows) insert.run(...columns.map((c) => row[c] ?? null));
    setMeta(db, metaKey, fetchedAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function applyBudgetReports(db, reports, { fetchedAt }) {
  // 同一報告編號可能同時出現在兩種類型：以後出現者為準
  const unique = [...new Map(reports.map((r) => [r.no, r])).values()];
  replaceAll(db, 'budget_reports', ['no', 'type', 'title', 'author', 'completed', 'url'], unique, 'budget_reports_fetched_at', fetchedAt);
  return unique.length;
}

export function applyMeetings(db, meetings, { fetchedAt }) {
  const rows = meetings.map((m) => ({ ...m, speakers: JSON.stringify(m.speakers) }));
  replaceAll(db, 'committee_meetings', ['date', 'committee', 'joint', 'name', 'content', 'speakers'], rows, 'meetings_fetched_at', fetchedAt);
  return rows.length;
}

export function applyCommitteeRecords(db, records, { fetchedAt }) {
  const rows = records.map((r) => ({ ...r, committees: JSON.stringify(r.committees) }));
  replaceAll(db, 'committee_records', ['id', 'date', 'committees', 'title', 'gazette_url', 'html_url', 'pdf_url'], rows, 'records_fetched_at', fetchedAt);
  return rows.length;
}

export function applyCommitteeMeets(db, meets, { fetchedAt }) {
  const rows = meets.map((m) => ({ ...m, committees: JSON.stringify(m.committees), attachments: JSON.stringify(m.attachments) }));
  replaceAll(db, 'committee_meets', ['code', 'date', 'title', 'committees', 'video_url', 'attachments'], rows, 'meets_fetched_at', fetchedAt);
  return rows.length;
}

/**
 * 新聞是**累積**的（不像名錄整批覆寫）：RSS 只給近期，覆寫會把歷史洗掉。
 * 同一連結只存一次；超過 keepDays 的刪除。
 */
export function upsertNews(db, legislatorId, items, { fetchedAt }) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO news(legislator_id, url, title, source, published_at, fetched_at) VALUES(?, ?, ?, ?, ?, ?)',
  );
  const refresh = db.prepare('UPDATE news SET title = ?, source = ? WHERE legislator_id = ? AND url = ?');
  const insertItem = (item) => {
    const result = insert.run(legislatorId, item.url, item.title, item.source, item.published_at, fetchedAt);
    if (Number(result.changes) === 0) refresh.run(item.title, item.source, legislatorId, item.url);
    return Number(result.changes);
  };
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const n of items) {
      added += insertItem(n);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return added;
}

export function upsertTopicNews(db, topic, items, { fetchedAt }) {
  const stmt = db.prepare(
    'INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(topic, url) DO UPDATE SET title = excluded.title, source = excluded.source',
  );
  // 交易包起來，與本檔其他整批寫入一致：中途失敗就整批回滾，不留半套。
  db.exec('BEGIN');
  try {
    const added = items.reduce((n, i) => n + Number(stmt.run(topic, i.url, i.title, i.source, i.published_at, fetchedAt).changes), 0);
    db.exec('COMMIT');
    return added;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 前端會顯示的「訊息」有兩種是**紀錄**而不是資料：同步紀錄（sync_runs）與異動紀錄（change_log）。
 * 它們本來就該留著（要能回看「什麼時候失敗、什麼欄位變了」），但不能無上限長大。
 * 這裡只保留最近 N 筆，其餘刪除；N 由 LY_SYNC_RUNS_KEEP / LY_CHANGE_LOG_KEEP 控制。
 */
export function pruneLogs(db, { syncRuns, changeLog } = {}) {
  const removed = { sync_runs: 0, change_log: 0 };
  // 兩張表要嘛都刪、要嘛都不刪（跟其他整批寫入一樣）；中途失敗不留半套。
  db.exec('BEGIN');
  try {
    if (syncRuns > 0) {
      removed.sync_runs = Number(
        db.prepare('DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT ?)').run(syncRuns).changes,
      );
    }
    if (changeLog > 0) {
      removed.change_log = Number(
        db.prepare('DELETE FROM change_log WHERE id NOT IN (SELECT id FROM change_log ORDER BY id DESC LIMIT ?)').run(changeLog).changes,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return removed;
}

export function pruneNews(db, { keepDays, now = new Date() }) {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM topic_news WHERE published_at < ?').run(cutoff);
    const removed = Number(db.prepare('DELETE FROM news WHERE published_at < ?').run(cutoff).changes);
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 社群帳號整批覆寫（來源是人工整理表，以最新一版為準）。 */
export function applySocial(db, accounts, { fetchedAt }) {
  const previous = new Set(
    db.prepare('SELECT legislator_id, platform, url FROM social_accounts').all().map((r) => `${r.legislator_id}|${r.platform}|${r.url}`),
  );
  const next = new Set(accounts.map((a) => `${a.legislator_id}|${a.platform}|${a.url}`));
  const added = [...next].filter((k) => !previous.has(k));
  const removed = [...previous].filter((k) => !next.has(k));

  db.exec('BEGIN');
  try {
    const insertChange = db.prepare(
      'INSERT INTO change_log(at, entity, entity_id, field, old_value, new_value) VALUES(?, ?, ?, ?, ?, ?)',
    );
    // 首次匯入不算「異動」（否則第一次同步會產生 113 筆假的變更紀錄）
    if (previous.size > 0) {
      for (const key of added) insertChange.run(fetchedAt, 'social_account', key, 'exists', null, '1');
      for (const key of removed) insertChange.run(fetchedAt, 'social_account', key, 'exists', '1', null);
    }

    db.exec('DELETE FROM social_accounts');
    const insert = db.prepare(
      `INSERT OR REPLACE INTO social_accounts(legislator_id, platform, page_name, url, latest_post_date, latest_post_summary, source)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of accounts) {
      insert.run(a.legislator_id, a.platform, a.page_name, a.url, a.latest_post_date, a.latest_post_summary, a.source ?? 'sheet');
    }
    setMeta(db, 'social_fetched_at', fetchedAt);
    setMeta(db, 'social_count', String(accounts.length));
    db.exec('COMMIT');
    return { added: added.length, removed: removed.length };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
