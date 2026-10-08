import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
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
CREATE TABLE IF NOT EXISTS law_agencies (
  law_name TEXT PRIMARY KEY,
  agencies TEXT NOT NULL
);
-- 法律→主管機關的第二個來源（法務部全國法規資料庫）。與 law_agencies 分開放：
-- 兩個來源的填寫程度差很多（g0v 缺 1,119 部），分開才知道「上游問過但沒填」跟「根本沒問到」的差別。
CREATE TABLE IF NOT EXISTS moj_law_agencies (
  law_name TEXT PRIMARY KEY,
  agencies TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bill_cosigners (
  bill_id TEXT NOT NULL,
  legislator_id TEXT NOT NULL,
  PRIMARY KEY (bill_id, legislator_id)
);
CREATE INDEX IF NOT EXISTS idx_bill_cosigners_legislator ON bill_cosigners(legislator_id);
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
-- 原始新聞庫（全部新聞頁用）：媒體 RSS 的**每一則**都存（不只提到委員／首長／機關的），Google 新聞的結果也存。
-- 「這則提到誰」不存在這裡，由 news／topic_news 推出（見 queries.mjs listAllNewsArticles）。
-- summary 只拿來做關鍵字搜尋，不回傳給前端、不轉載；origin = 'outlet'（媒體 RSS）| 'google'。
CREATE TABLE IF NOT EXISTS articles (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT,
  origin TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_at DESC);
CREATE TABLE IF NOT EXISTS social_accounts (
  legislator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  page_name TEXT,
  url TEXT NOT NULL,
  latest_post_date TEXT,
  latest_post_summary TEXT,
  -- 最新一則貼文的互動數（讚／留言）；抓不到就 NULL，不用 0 假裝「沒有人按讚」
  latest_post_likes INTEGER,
  latest_post_comments INTEGER,
  -- 'sheet'（整理表）或 'override'（人工更正表）；用來分辨哪些是追蹤過的資料
  source TEXT,
  PRIMARY KEY (legislator_id, platform, url)
);
-- 議員臉書整理表（人工／AI 每日維護的 Google 試算表，格式見 docs/social-sheet-spec.md）：每次同步整批覆寫
CREATE TABLE IF NOT EXISTS council_social (
  councilor_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT,
  latest_post_date TEXT,
  latest_post_summary TEXT
);
-- 貼文層級（一列一則貼文）：來源是 scripts/fetch-fb-posts.mjs 每日抓取後推到 fb-data 分支的
-- posts-detail/latest.csv（見 server/ingest.mjs 的 runSocialPostsIngest）。
-- 整理表只有「最新一則」的 60 字摘要，「機關」頁要把委員貼文歸到機關時幾乎比對不到（實測全站 1 筆），
-- 所以另外留一份貼文層級的資料（摘要 400 字、每個粉專最多 5 則）。
CREATE TABLE IF NOT EXISTS social_posts (
  legislator_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- 貼文日期；FB 的 DOM 只給相對時間，只有「最新一則」拿得到絕對日期，其餘留空（不猜，見 DECISIONS D264）
  post_date TEXT,
  summary TEXT NOT NULL,
  url TEXT NOT NULL,
  likes INTEGER,
  comments INTEGER,
  -- 同一則貼文的指紋（摘要的 sha256 前 16 碼）：來源是同一個粉專時，日期常拿不到，只能靠內容去重
  fingerprint TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (legislator_id, platform, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_social_posts_legislator ON social_posts(legislator_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_date ON social_posts(post_date);
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
CREATE TABLE IF NOT EXISTS progress_overrides (
  dataset TEXT NOT NULL,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT,
  source TEXT NOT NULL DEFAULT 'ppg',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (dataset, id)
);
CREATE TABLE IF NOT EXISTS budget_committees (
  id TEXT PRIMARY KEY,
  committees TEXT NOT NULL DEFAULT '[]',
  status TEXT,
  meeting TEXT,
  fetched_at TEXT NOT NULL
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
  // 回補腳本（scripts/backfill-news.mjs）與伺服器是兩個行程、會同時寫：遇到鎖先等，不要立刻丟 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * 同一則報導的標題鍵：去掉空白。Google 新聞給的是 news.google.com 轉址、媒體 RSS 給的是原址，
 * 同一則報導兩個網址不同，只能靠標題認；轉載（例如 Yahoo 轉中央社）也一併算同一則。
 * 存在 news／topic_news 的 title_key 欄（有索引）；TITLE_KEY_SQL 只用來回填舊資料，兩者去掉的字元要一致。
 */
const titleKey = (title) => String(title ?? '').replace(/[ \u3000\t]/g, '');
const TITLE_KEY_SQL = "REPLACE(REPLACE(REPLACE(title, ' ', ''), '　', ''), char(9), '')";

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
  // 最新貼文的互動數（讚／留言）：新欄位對既有資料庫是 NULL，跑一次同步就會從整理表補上。
  // 順手清掉 applied_sha，讓「整理表內容沒變」的那一輪也會重新套用一次（否則要等到表有變動才會有數字）。
  if (!socialCols.has('latest_post_likes') || !socialCols.has('latest_post_comments')) {
    if (!socialCols.has('latest_post_likes')) db.exec('ALTER TABLE social_accounts ADD COLUMN latest_post_likes INTEGER');
    if (!socialCols.has('latest_post_comments')) db.exec('ALTER TABLE social_accounts ADD COLUMN latest_post_comments INTEGER');
    db.prepare("DELETE FROM meta WHERE key = 'social_applied_sha'").run();
  }
  // 新聞的標題鍵（去掉空白的標題）：同標題去重要靠索引查，不能每寫一筆就 REPLACE() 掃一次全表
  // （實測 10 萬則媒體新聞重新分派一次要 199 秒）。舊資料庫補欄位並回填，之後由 upsert 寫入。
  for (const table of ['news', 'topic_news']) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns.has('title_key')) db.exec(`ALTER TABLE ${table} ADD COLUMN title_key TEXT`);
    db.exec(`UPDATE ${table} SET title_key = ${TITLE_KEY_SQL} WHERE title_key IS NULL`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_news_title_key ON news(legislator_id, title_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_topic_news_title_key ON topic_news(topic, title_key)');
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

export function hasSnapshot(db, dataset, sha256) {
  return Boolean(db.prepare('SELECT 1 FROM raw_snapshots WHERE dataset = ? AND sha256 = ?').get(dataset, sha256));
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
/**
 * 「進度日期覆蓋」：g0v 的 LYAPI 對本會期的議案常常沒給 `議案流程[].日期`
 * （實測 2026-10-06：本會期 199 筆預算議案全部沒有），我們改從立法院議事暨公報資訊網
 * （ppg.ly.gov.tw）自己抓。抓到的日期存在這張表，因為每次同步都會 DELETE + INSERT
 * 重寫 bills／budget_bills（見 applyBills／applyBudget），存這裡才活得下來。
 */
/** 預算議案的委員會（存另一張表：同步會 DELETE + INSERT 重寫 budget_bills） */
export function upsertBudgetCommittees(db, { id, committees, status = null, meeting = null, fetchedAt }) {
  if (!id) return;
  db.prepare(
    `INSERT INTO budget_committees(id, committees, status, meeting, fetched_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET committees = excluded.committees, status = excluded.status, meeting = excluded.meeting, fetched_at = excluded.fetched_at`,
  ).run(id, JSON.stringify(committees ?? []), status, meeting, fetchedAt);
}

/** key 為議案編號 */
export function getBudgetCommittees(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM budget_committees').all()) {
    let committees = [];
    try {
      committees = JSON.parse(row.committees);
    } catch {
      committees = [];
    }
    map.set(row.id, { ...row, committees: Array.isArray(committees) ? committees : [] });
  }
  return map;
}

export function upsertProgressOverride(db, { dataset, id, date, status = null, source = 'ppg', fetchedAt }) {
  if (!dataset || !id) return;
  db.prepare(
    `INSERT INTO progress_overrides(dataset, id, date, status, source, fetched_at) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset, id) DO UPDATE SET date = excluded.date, status = excluded.status, source = excluded.source, fetched_at = excluded.fetched_at`,
  ).run(dataset, id, date ?? '', status, source, fetchedAt);
}

/** 全部覆蓋記錄（key 為 `dataset:id`） */
export function getProgressOverrides(db) {
  return new Map(db.prepare('SELECT * FROM progress_overrides').all().map((r) => [`${r.dataset}:${r.id}`, r]));
}

/**
 * 把覆蓋日期套用到資料表：**只補空的**（g0v 有給日期時以 g0v 為準，我們不覆蓋它）。
 * 每次同步寫完 bills／budget_bills 後呼叫，讓補過的日期不會因為同步被清掉。
 */
export function applyProgressOverrides(db) {
  const rows = db.prepare("SELECT dataset, id, date, status FROM progress_overrides WHERE date <> ''").all();
  const update = {
    bills: db.prepare("UPDATE bills SET latest_date = ? WHERE id = ? AND (latest_date = '' OR latest_date IS NULL)"),
    budget_bills: db.prepare("UPDATE budget_bills SET latest_date = ? WHERE id = ? AND (latest_date = '' OR latest_date IS NULL)"),
  };
  let applied = 0;
  for (const row of rows) {
    const stmt = update[row.dataset];
    if (!stmt) continue;
    applied += stmt.run(row.date, row.id).changes;
  }
  return applied;
}

/** 法律→主管機關（整批覆寫）。上游沒填的空陣列也存，才知道「問過了但沒有」。 */
export function applyLawAgencies(db, laws) {
  return replaceLawAgencies(db, 'law_agencies', laws);
}

/**
 * 法律→主管機關（法務部全國法規資料庫；整批覆寫）。
 * 與 applyLawAgencies 分開存，讓 queries 的對照順序（上游 → 全國法規資料庫 → 手工補）有依據。
 */
export function applyMojLawAgencies(db, laws) {
  return replaceLawAgencies(db, 'moj_law_agencies', laws);
}

function replaceLawAgencies(db, table, laws) {
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${table}`);
    const insert = db.prepare(`INSERT OR REPLACE INTO ${table}(law_name, agencies) VALUES(?, ?)`);
    for (const [name, agencies] of laws) insert.run(name, JSON.stringify(agencies));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function applyBills(db, { bills, sponsors, cosigners = [] }, { fetchedAt }) {
  const previous = new Map(db.prepare('SELECT id, status FROM bills').all().map((r) => [r.id, r.status]));
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM bill_sponsors');
    db.exec('DELETE FROM bill_cosigners');
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
    const insertCosigner = db.prepare('INSERT OR IGNORE INTO bill_cosigners(bill_id, legislator_id) VALUES(?, ?)');
    for (const c of cosigners) insertCosigner.run(c.bill_id, c.legislator_id);

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

    applyProgressOverrides(db);
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
    applyProgressOverrides(db);
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
 * 同一連結只存一次、同一位委員的同一個標題也只存一次（見 titleKey）；超過 keepDays 的刪除。
 */
export function upsertNews(db, legislatorId, items, { fetchedAt }) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO news(legislator_id, url, title, source, published_at, fetched_at, title_key) VALUES(?, ?, ?, ?, ?, ?, ?)',
  );
  const refresh = db.prepare('UPDATE news SET title = ?, source = ?, title_key = ? WHERE legislator_id = ? AND url = ?');
  const sameTitle = db.prepare('SELECT 1 FROM news WHERE legislator_id = ? AND title_key = ? AND url <> ? LIMIT 1');
  const insertItem = (item) => {
    const key = titleKey(item.title);
    if (sameTitle.get(legislatorId, key, item.url)) return 0;
    const result = insert.run(legislatorId, item.url, item.title, item.source, item.published_at, fetchedAt, key);
    if (Number(result.changes) === 0) refresh.run(item.title, item.source, key, legislatorId, item.url);
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

/**
 * 原始新聞庫：同一網址只存一次（再抓到時更新標題、媒體；新的摘要是空的就保留舊的）。
 * 不做標題去重 —— 這是原始資料，合併是查詢時的事（listAllNewsArticles）。
 */
export function upsertArticles(db, items, { origin, fetchedAt }) {
  const stmt = db.prepare(
    `INSERT INTO articles(url, title, summary, source, origin, published_at, fetched_at) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, source = excluded.source, summary = COALESCE(NULLIF(excluded.summary, ''), articles.summary)`,
  );
  // upsert 的 changes 會把「已存在、只是更新」也算 1，回傳值要的是真的新增幾則，所以比前後筆數
  const count = () => Number(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n);
  db.exec('BEGIN');
  try {
    const before = count();
    for (const i of items) stmt.run(i.url, i.title, i.summary || null, i.source || null, origin, i.published_at, fetchedAt);
    const added = count() - before;
    db.exec('COMMIT');
    return added;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function upsertTopicNews(db, topic, items, { fetchedAt }) {
  const stmt = db.prepare(
    'INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at, title_key) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(topic, url) DO UPDATE SET title = excluded.title, source = excluded.source, title_key = excluded.title_key',
  );
  const sameTitle = db.prepare('SELECT 1 FROM topic_news WHERE topic = ? AND title_key = ? AND url <> ? LIMIT 1');
  // 交易包起來，與本檔其他整批寫入一致：中途失敗就整批回滾，不留半套。
  db.exec('BEGIN');
  try {
    const added = items.reduce(
      (n, i) => {
        const key = titleKey(i.title);
        return sameTitle.get(topic, key, i.url) ? n : n + Number(stmt.run(topic, i.url, i.title, i.source, i.published_at, fetchedAt, key).changes);
      },
      0,
    );
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
    db.prepare('DELETE FROM articles WHERE published_at < ?').run(cutoff);
    const removed = Number(db.prepare('DELETE FROM news WHERE published_at < ?').run(cutoff).changes);
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 社群帳號整批覆寫（來源是人工整理表，以最新一版為準）。 */
/** 議員臉書整理表整批覆寫（來源是人工維護的試算表，以最新一版為準） */
export function applyCouncilSocial(db, rows) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM council_social');
    const insert = db.prepare('INSERT OR REPLACE INTO council_social(councilor_id, url, status, latest_post_date, latest_post_summary) VALUES(?, ?, ?, ?, ?)');
    for (const r of rows) insert.run(r.councilor_id, r.url, r.status, r.latest_post_date, r.latest_post_summary);
    db.exec('COMMIT');
    return rows.length;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

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
      `INSERT OR REPLACE INTO social_accounts(legislator_id, platform, page_name, url, latest_post_date, latest_post_summary, latest_post_likes, latest_post_comments, source)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of accounts) {
      insert.run(
        a.legislator_id,
        a.platform,
        a.page_name,
        a.url,
        a.latest_post_date,
        a.latest_post_summary,
        Number.isFinite(a.latest_post_likes) ? a.latest_post_likes : null,
        Number.isFinite(a.latest_post_comments) ? a.latest_post_comments : null,
        a.source ?? 'sheet',
      );
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

/** 貼文摘要的指紋（去重用；日期常常拿不到，只能靠內容） */
export function postFingerprint(summary) {
  return createHash('sha256').update(String(summary ?? '').trim()).digest('hex').slice(0, 16);
}

/**
 * 貼文層級資料（`social_posts`）：**累積式 upsert**（同一天的同一則靠 fingerprint 去重），
 * 不是每天把上一次的貼文換掉 —— 使用者要求「貼完也要累計」：機關頁的貼文數要能越積越多。
 *
 * 保留期（`keepDays`，預設 90 天）：
 * - 有日期的：超過保留期的舊貼文刪掉（否則會無限成長）。
 * - 沒有日期的（FB 的 DOM 只給相對時間，見 DECISIONS D264）：只保留「這一輪還有抓到」的那些，
 *   抓取端的頁面只看得到最近幾則，掉出頁面的就代表已經不是近期貼文了。
 */
export function applySocialPosts(db, rows, { fetchedAt, source = 'fb-detail', keepDays = 90 } = {}) {
  if (rows.length === 0) return { accumulated: Number(getMeta(db, 'social_posts_count', '0')) || 0, legislators: 0, added: 0, pruned: 0 };
  const legislators = [...new Set(rows.map((r) => r.legislator_id))];
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM social_posts').get().n);
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);

  db.exec('BEGIN');
  try {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO social_posts(legislator_id, platform, post_date, summary, url, likes, comments, fingerprint, source)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const existing = new Set(
      db.prepare('SELECT legislator_id, platform, fingerprint FROM social_posts').all().map((r) => `${r.legislator_id}|${r.platform}|${r.fingerprint}`),
    );
    let added = 0;
    const keep = new Map(); // legislator|platform → Set(這一輪的 fingerprint)
    for (const r of rows) {
      const fingerprint = postFingerprint(r.summary);
      const key = `${r.legislator_id}|${r.platform}`;
      if (!existing.has(`${key}|${fingerprint}`)) added += 1;
      (keep.get(key) ?? keep.set(key, new Set()).get(key)).add(fingerprint);
      insert.run(
        r.legislator_id,
        r.platform,
        r.post_date || null,
        r.summary,
        r.url,
        Number.isFinite(r.likes) ? r.likes : null,
        Number.isFinite(r.comments) ? r.comments : null,
        fingerprint,
        source,
      );
    }

    // 清掉過期／已經不在頁面上的
    const stale = db
      .prepare(
        `SELECT legislator_id, platform, fingerprint, post_date, summary FROM social_posts
         WHERE legislator_id IN (${legislators.map(() => '?').join(',')})`,
      )
      .all(...legislators);
    const del = db.prepare('DELETE FROM social_posts WHERE legislator_id = ? AND platform = ? AND fingerprint = ?');
    let pruned = 0;
    for (const row of stale) {
      const key = `${row.legislator_id}|${row.platform}`;
      const stillFresh = row.post_date ? row.post_date >= cutoff : (keep.get(key)?.has(row.fingerprint) ?? false);
      if (!stillFresh) {
        del.run(row.legislator_id, row.platform, row.fingerprint);
        pruned += 1;
      }
    }

    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM social_posts').get().n);
    setMeta(db, 'social_posts_fetched_at', fetchedAt);
    setMeta(db, 'social_posts_count', String(total));
    setMeta(db, 'social_posts_import_count', String(rows.length));
    db.exec('COMMIT');
    return { accumulated: total, legislators: legislators.length, added, pruned, imported: rows.length, before };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
