import { CONFIG } from './config.mjs';
import { getMeta } from './db.mjs';

const nowIso = () => new Date().toISOString();

export function sourceInfo() {
  return { ...CONFIG.source };
}

export function currentTerm(db) {
  return Number(getMeta(db, 'term', '0')) || null;
}

export function currentSession(db) {
  const value = getMeta(db, 'current_session', '');
  return value || null;
}

export function isStale(db) {
  const last = getMeta(db, 'last_success_at');
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > CONFIG.staleAfterHours * 3600 * 1000;
}

export function envelope(db, { term = null, session = null } = {}) {
  return {
    generated_at: nowIso(),
    fetched_at: getMeta(db, 'last_success_at'),
    stale: isStale(db),
    source: sourceInfo(),
    ...(term ? { term } : {}),
    ...(term ? { session: session ?? null } : {}),
  };
}

export function getMetaPayload(db) {
  const term = currentTerm(db);
  const session = currentSession(db);
  const terms = db.prepare('SELECT no, label FROM terms ORDER BY no DESC').all().map((t) => ({
    no: Number(t.no),
    label: t.label,
    sessions: db
      .prepare('SELECT id, seq, label FROM sessions WHERE term_no = ? ORDER BY seq')
      .all(t.no)
      .map((s) => ({ id: s.id, seq: Number(s.seq), label: s.label })),
  }));
  const warnings = JSON.parse(getMeta(db, 'warnings', '[]'));
  return {
    meta: envelope(db, {}),
    terms,
    current: { term, session },
    warnings,
    counts: {
      terms: terms.length,
      sessions: terms.reduce((sum, t) => sum + t.sessions.length, 0),
    },
  };
}

function resolveScope(db, { term, session }) {
  const resolvedTerm = Number(term) || currentTerm(db);
  const sessions = db
    .prepare('SELECT id, seq FROM sessions WHERE term_no = ? ORDER BY seq')
    .all(resolvedTerm)
    .map((s) => ({ id: s.id, seq: Number(s.seq) }));
  const requested = session === undefined || session === null || session === '' ? currentSession(db) : String(session);
  const all = requested === 'all';
  const resolvedSession = all ? null : sessions.some((s) => s.id === requested) ? requested : sessions.at(-1)?.id ?? null;
  const sessionIds = all ? sessions.map((s) => s.id) : resolvedSession ? [resolvedSession] : [];
  return { term: resolvedTerm, session: resolvedSession, all, sessionIds, sessions };
}

/** 讀出某屆（可選會期）的委員視圖：資料庫只做撈取，過濾在 JS 做（規模 ≤ 200 筆，可讀性優先）。 */
export function listLegislators(db, query = {}) {
  const scope = resolveScope(db, query);
  if (!scope.term) return { meta: envelope(db), items: [], count: 0, total: 0, warnings: [] };

  const membershipRows = db
    .prepare(
      `SELECT m.legislator_id, m.session_id, m.party, m.caucus, m.area_name, m.leave_flag, m.leave_date, m.leave_reason
       FROM memberships m WHERE m.term_no = ?`,
    )
    .all(scope.term);

  const seatRows = scope.sessionIds.length
    ? db
        .prepare(
          `SELECT s.legislator_id, s.session_id, s.committee_id, s.is_convener, c.kind
           FROM committee_seats s JOIN committees c ON c.id = s.committee_id
           WHERE s.session_id IN (${scope.sessionIds.map(() => '?').join(',')})`,
        )
        .all(...scope.sessionIds)
    : [];

  const legislatorRows = db.prepare('SELECT * FROM legislators').all();
  const byId = new Map(legislatorRows.map((l) => [l.id, l]));

  const inScope = new Set(
    membershipRows.filter((m) => (scope.all ? true : scope.session ? m.session_id === scope.session : false)).map((m) => m.legislator_id),
  );

  const seatsByLegislator = new Map();
  for (const seat of seatRows) {
    if (!inScope.has(seat.legislator_id)) continue;
    const list = seatsByLegislator.get(seat.legislator_id) ?? [];
    list.push(seat);
    seatsByLegislator.set(seat.legislator_id, list);
  }

  const membershipByLegislator = new Map();
  for (const m of membershipRows) {
    if (!inScope.has(m.legislator_id)) continue;
    const existing = membershipByLegislator.get(m.legislator_id);
    // 非全屆次檢視時，代表該委員在此 scope 的 membership
    if (!existing || m.session_id === scope.session) membershipByLegislator.set(m.legislator_id, m);
  }

  let items = [...inScope].map((id) => {
    const l = byId.get(id);
    const m = membershipByLegislator.get(id) ?? {};
    const seats = seatsByLegislator.get(id) ?? [];
    const committees = [];
    for (const seat of seats) {
      const found = committees.find((c) => c.id === seat.committee_id);
      if (found) found.is_convener = found.is_convener || !!seat.is_convener;
      else committees.push({ id: seat.committee_id, kind: seat.kind, is_convener: !!seat.is_convener });
    }
    committees.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hant'));
    const sessions = [...new Set(membershipRows.filter((x) => x.legislator_id === id).map((x) => x.session_id).filter(Boolean))].sort();
    return {
      id,
      name: l?.name ?? id,
      ename: l?.ename ?? '',
      party: m.party ?? l?.party ?? '未提供',
      caucus: m.caucus ?? l?.caucus ?? '未提供',
      area_name: m.area_name ?? l?.area_name ?? '未提供',
      photo_url: l?.photo_url ?? '',
      degree: l?.degree ?? '',
      experience: l?.experience ?? '',
      term: scope.term,
      sessions,
      committees,
      is_convener: committees.some((c) => c.is_convener),
      former: !!m.leave_flag,
      leave_date: m.leave_date ?? '',
      leave_reason: m.leave_reason ?? '',
      source_url: l?.source_url ?? CONFIG.source.url,
    };
  });

  if (query.party) items = items.filter((x) => x.party === query.party);
  if (query.committee) items = items.filter((x) => x.committees.some((c) => c.id === query.committee));
  if (String(query.convener) === '1' || query.convener === true) items = items.filter((x) => x.is_convener);
  if (query.q) {
    const needle = String(query.q).trim().toLowerCase();
    items = items.filter((x) =>
      [x.name, x.ename, x.party, x.caucus, x.area_name, ...x.committees.map((c) => c.id)]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  const total = items.length;
  const limit = Math.max(1, Math.min(Number(query.limit) || 500, 1000));
  const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));

  return {
    meta: envelope(db, { term: scope.term, session: scope.session }),
    count: Math.max(0, Math.min(limit, total - offset)),
    total,
    items: items.slice(offset, offset + limit),
  };
}

export function listCommittees(db, query = {}) {
  const scope = resolveScope(db, query);
  if (!scope.term || !scope.sessionIds.length) {
    return { meta: envelope(db, { term: scope.term, session: scope.session }), count: 0, items: [] };
  }
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, s.legislator_id, MAX(s.is_convener) AS is_convener, l.name
       FROM committee_seats s
       JOIN committees c ON c.id = s.committee_id
       JOIN legislators l ON l.id = s.legislator_id
       WHERE s.session_id IN (${scope.sessionIds.map(() => '?').join(',')})
       GROUP BY c.id, s.legislator_id`,
    )
    .all(...scope.sessionIds);

  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.id) ?? { id: row.id, kind: row.kind, count: 0, conveners: [] };
    entry.count += 1;
    if (Number(row.is_convener) === 1) entry.conveners.push({ id: row.legislator_id, name: row.name });
    map.set(row.id, entry);
  }
  const items = [...map.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id, 'zh-Hant'));
  return {
    meta: envelope(db, { term: scope.term, session: scope.session }),
    count: items.length,
    items,
  };
}

export function listChanges(db, { since = null, limit = 100 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const rows = since
    ? db.prepare('SELECT * FROM change_log WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?').all(since, resolvedLimit)
    : db.prepare('SELECT * FROM change_log ORDER BY at DESC, id DESC LIMIT ?').all(resolvedLimit);
  return {
    meta: envelope(db),
    count: rows.length,
    items: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      entity: r.entity,
      entity_id: r.entity_id,
      field: r.field,
      old_value: r.old_value,
      new_value: r.new_value,
    })),
  };
}

function toSyncRun(r) {
  return {
    id: Number(r.id),
    dataset: r.dataset,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
    records: r.records === null ? null : Number(r.records),
    attempt: r.attempt === null ? null : Number(r.attempt),
    http_status: r.http_status === null ? null : Number(r.http_status),
    duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
    ua: r.ua,
    error: r.error,
  };
}

export function listSyncRuns(db, { limit = 50 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 50, 1000));
  const rows = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(resolvedLimit);
  return {
    meta: envelope(db),
    count: rows.length,
    items: rows.map(toSyncRun),
  };
}

export function getHealth(db) {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const lastRuns = db
    .prepare(
      `SELECT * FROM sync_runs
       WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY dataset)
       ORDER BY finished_at DESC, id DESC`,
    )
    .all()
    .map(toSyncRun);
  const stats = {
    legislators: count('legislators'),
    memberships: count('memberships'),
    committee_seats: count('committee_seats'),
    sessions: count('sessions'),
    committees: count('committees'),
    changes: count('change_log'),
    snapshots: count('raw_snapshots'),
  };
  return {
    meta: envelope(db),
    ok: stats.legislators > 0 && !isStale(db),
    db: stats,
    last_runs: lastRuns,
    warnings: JSON.parse(getMeta(db, 'warnings', '[]')),
  };
}
