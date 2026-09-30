import { CONFIG } from './config.mjs';
import { getMeta } from './db.mjs';
import { readFileSync } from 'node:fs';
import { budgetTypes, committeesOf, newsName, regionOf } from './normalize.mjs';

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
  // 名錄表格要用的活動量：提案數、近期新聞數（一次 GROUP BY，不逐人查）
  const billCount = new Map(db.prepare('SELECT legislator_id, COUNT(*) AS n FROM bill_sponsors GROUP BY legislator_id').all().map((r) => [r.legislator_id, Number(r.n)]));
  const newsCount = new Map(db.prepare('SELECT legislator_id, COUNT(*) AS n FROM news GROUP BY legislator_id').all().map((r) => [r.legislator_id, Number(r.n)]));
  const socialByLegislator = new Map();
  for (const s of db.prepare('SELECT * FROM social_accounts ORDER BY platform, url').all()) {
    const list = socialByLegislator.get(s.legislator_id) ?? [];
    list.push({ platform: s.platform, name: s.page_name, url: s.url, latest_post_date: s.latest_post_date, latest_post_summary: s.latest_post_summary });
    socialByLegislator.set(s.legislator_id, list);
  }
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
    const areaName = m.area_name ?? l?.area_name ?? '未提供';
    return {
      id,
      name: l?.name ?? id,
      ename: l?.ename ?? '',
      sex: l?.sex ?? '',
      party: m.party ?? l?.party ?? '未提供',
      caucus: m.caucus ?? l?.caucus ?? '未提供',
      area_name: areaName,
      region: regionOf(areaName),
      photo_url: l?.photo_url ?? '',
      degree: l?.degree ?? '',
      experience: l?.experience ?? '',
      onboard_date: l?.onboard_date ?? '',
      contacts: JSON.parse(l?.contacts || '[]'),
      social: socialByLegislator.get(id) ?? [],
      bill_count: billCount.get(id) ?? 0,
      news_count: newsCount.get(id) ?? 0,
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

  if (query.id) items = items.filter((x) => x.id === query.id);
  if (query.party) items = items.filter((x) => x.party === query.party);
  if (query.region) items = items.filter((x) => x.region === query.region);
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
      `SELECT c.id, c.kind, s.legislator_id, MAX(s.is_convener) AS is_convener, l.name, l.party
       FROM committee_seats s
       JOIN committees c ON c.id = s.committee_id
       JOIN legislators l ON l.id = s.legislator_id
       WHERE s.session_id IN (${scope.sessionIds.map(() => '?').join(',')})
       GROUP BY c.id, s.legislator_id`,
    )
    .all(...scope.sessionIds);

  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.id) ?? { id: row.id, kind: row.kind, count: 0, parties: {}, conveners: [] };
    entry.count += 1;
    entry.parties[row.party ?? '未提供'] = (entry.parties[row.party ?? '未提供'] ?? 0) + 1;
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
    bills: count('bills'),
    budget_bills: count('budget_bills'),
    budget_reports: count('budget_reports'),
    committee_meetings: count('committee_meetings'),
    news: count('news'),
    social_accounts: count('social_accounts'),
  };
  const newsStatus = getMeta(db, 'news_status', '');
  const notices = [];
  if (newsStatus.startsWith('partial')) notices.push(`新聞同步未跑完（${newsStatus.split(':')[1]}）`);
  const socialCount = Number(getMeta(db, 'social_count', '0'));
  if (stats.social_accounts > 0 && socialCount > 0 && stats.social_accounts < socialCount) {
    notices.push(`社群帳號數（${stats.social_accounts}）少於上次成功同步（${socialCount}）`);
  }
  return {
    meta: envelope(db),
    ok: stats.legislators > 0 && !isStale(db),
    db: stats,
    datasets: {
      id9: { fetched_at: getMeta(db, 'last_success_at'), count: stats.legislators },
      id14: { fetched_at: getMeta(db, 'last_success_at'), count: stats.committee_seats },
      bills: { fetched_at: getMeta(db, 'bills_fetched_at'), count: stats.bills },
      budget: { fetched_at: getMeta(db, 'budget_fetched_at'), count: stats.budget_bills },
      news: { fetched_at: getMeta(db, 'news_fetched_at'), count: stats.news, status: newsStatus || null },
      social: { fetched_at: getMeta(db, 'social_fetched_at'), count: stats.social_accounts },
    },
    last_runs: lastRuns,
    warnings: [...JSON.parse(getMeta(db, 'warnings', '[]')), ...notices],
  };
}

/** 排行榜共用的委員基本資料 */
function legislatorIndex(db) {
  const map = new Map();
  for (const l of db.prepare('SELECT id, name, party, area_name, photo_url FROM legislators WHERE leave_flag = 0').all()) {
    map.set(l.id, { id: l.id, name: l.name, party: l.party, area_name: l.area_name, region: regionOf(l.area_name), photo_url: l.photo_url });
  }
  return map;
}

const withIntensity = (items) => {
  const top = items.length ? items[0].value : 0;
  return items.map((item, index) => ({ ...item, rank: index + 1, intensity: top > 0 ? Math.max(0.06, item.value / top) : 0 }));
};

/**
 * 排行榜：新聞曝光、臉書發文、法案提案。
 * 只列入在職委員（離職者仍有歷史提案，放在排行榜會誤導）。
 * 每項都回 intensity（0–1，相對第一名的長度），前端不必自己算。
 */
export function listRankings(db, { type = 'all', days = 30, limit = 10 } = {}) {
  const resolvedDays = Math.max(1, Math.min(Number(days) || 30, 365));
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const wanted = (t) => type === 'all' || type === t;
  const index = legislatorIndex(db);
  const since = new Date(Date.now() - resolvedDays * 86_400_000).toISOString();
  const boards = {};

  if (wanted('news')) {
    const rows = db
      .prepare(
        `SELECT legislator_id, COUNT(*) AS value, MAX(published_at) AS latest FROM news
         WHERE published_at >= ? GROUP BY legislator_id ORDER BY value DESC, latest DESC LIMIT ?`,
      )
      .all(since, resolvedLimit);
    const latest = new Map();
    for (const row of rows) {
      const top = db
        .prepare('SELECT title, url, source, published_at FROM news WHERE legislator_id = ? ORDER BY published_at DESC LIMIT 1')
        .get(row.legislator_id);
      if (top) latest.set(row.legislator_id, top);
    }
    const items = rows
      .filter((row) => index.has(row.legislator_id))
      .map((row) => {
        const top = latest.get(row.legislator_id);
        return {
          legislator: index.get(row.legislator_id),
          value: Number(row.value),
          value_display: `${row.value} 則`,
          detail: { label: top?.source ?? '', text: top?.title ?? '', url: top?.url ?? '' },
        };
      });
    boards.news = {
      type: 'news',
      title: '新聞曝光排行',
      note: `近 ${resolvedDays} 天標題含委員姓名的報導數（Google 新聞，只計在職委員）`,
      unit: '則',
      items: withIntensity(items),
    };
  }

  if (wanted('facebook')) {
    const today = Date.now();
    const items = db
      .prepare(
        `SELECT s.legislator_id, s.page_name, s.url, s.latest_post_date, s.latest_post_summary FROM social_accounts s
         WHERE s.latest_post_date <> '' ORDER BY s.latest_post_date DESC LIMIT ?`,
      )
      .all(resolvedLimit)
      .filter((row) => index.has(row.legislator_id))
      .map((row) => {
        const ageDays = Math.max(0, Math.round((today - Date.parse(`${row.latest_post_date}T00:00:00+08:00`)) / 86_400_000));
        return {
          legislator: index.get(row.legislator_id),
          // 數值越小越新；為了讓長條一致（越長越前面），用「新鮮度」當強度，value 仍是天數
          value: Math.max(0, 60 - ageDays),
          value_display: ageDays === 0 ? '今天' : `${ageDays} 天前`,
          raw_days: ageDays,
          detail: { label: row.page_name || '臉書專頁', text: row.latest_post_summary || '（無摘要）', url: row.url },
        };
      });
    boards.facebook = {
      type: 'facebook',
      title: '臉書發文排行',
      note: '依整理表記錄的最新貼文日期排序（0 天＝今天），只計在職委員',
      unit: '天前',
      items: withIntensity(items),
    };
  }

  if (wanted('bills')) {
    const rows = db
      .prepare(
        `SELECT s.legislator_id, COUNT(*) AS value, SUM(s.is_lead) AS leads, MAX(b.latest_date) AS latest
         FROM bill_sponsors s JOIN bills b ON b.id = s.bill_id
         GROUP BY s.legislator_id ORDER BY value DESC, leads DESC LIMIT ?`,
      )
      .all(resolvedLimit);
    const latestBill = new Map();
    for (const row of rows) {
      const top = db
        .prepare(
          `SELECT b.name, b.latest_date, b.url FROM bill_sponsors s JOIN bills b ON b.id = s.bill_id
           WHERE s.legislator_id = ? ORDER BY b.latest_date DESC LIMIT 1`,
        )
        .get(row.legislator_id);
      if (top) latestBill.set(row.legislator_id, top);
    }
    const items = rows
      .filter((row) => index.has(row.legislator_id))
      .map((row) => {
        const top = latestBill.get(row.legislator_id);
        return {
          legislator: index.get(row.legislator_id),
          value: Number(row.value),
          value_display: `${row.value} 件`,
          lead_count: Number(row.leads),
          detail: { label: `主提案 ${row.leads} 件 · 最近 ${row.latest ?? ''}`, text: top?.name ?? '', url: top?.url ?? '' },
        };
      });
    boards.bills = {
      type: 'bills',
      title: '法案提案排行',
      note: '本屆委員提案數（含共同提案，第一位為主提案）',
      unit: '件',
      items: withIntensity(items),
    };
  }

  return {
    meta: { ...envelope(db), bills_fetched_at: getMeta(db, 'bills_fetched_at'), news_fetched_at: getMeta(db, 'news_fetched_at') },
    days: resolvedDays,
    limit: resolvedLimit,
    boards,
  };
}

/** 議案列的共用轉換 */
const toBill = (r) => ({
  id: r.id,
  term: r.term === null ? null : Number(r.term),
  name: r.name,
  status: r.status,
  category: r.category,
  session: r.session === null ? null : Number(r.session),
  laws: JSON.parse(r.laws || '[]'),
  latest_date: r.latest_date,
  url: r.url,
});

/**
 * 議案查詢。條件：`legislator`（該委員主提案或共同提案）、`q`（議案名稱或涉及法律的關鍵字）、
 * `law`（精確法律名稱）、`status`。回傳分頁結果＋在全部符合結果上算的主題（法律）與狀態統計。
 * ponytail: 撈出全部符合列再在 JS 統計／分頁（本屆約 7,400 件，數毫秒）；資料量大十倍再改 SQL 聚合。
 */
export function listBills(db, { legislator = null, q = '', law = '', status = '', session = '', from = '', to = '', limit = 20, offset = 0, all = false } = {}) {
  const resolvedLimit = all ? Infinity : Math.max(1, Math.min(Number(limit) || 20, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const clauses = [];
  const params = [];
  if (legislator) clauses.push('b.id IN (SELECT bill_id FROM bill_sponsors WHERE legislator_id = ?)'), params.push(legislator);
  const needle = String(q ?? '').trim();
  if (needle) clauses.push('(b.name LIKE ? OR b.laws LIKE ?)'), params.push(`%${needle}%`, `%${needle}%`);
  if (law) clauses.push('b.laws LIKE ?'), params.push(`%${JSON.stringify(String(law))}%`);
  // 日期區間比對最新進度日期；只收 YYYY-MM-DD，其他格式當作未指定
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
  if (isDate(from)) clauses.push('b.latest_date >= ?'), params.push(String(from));
  if (isDate(to)) clauses.push('b.latest_date <= ?'), params.push(String(to));
  const statusFilter = status ? String(status) : '';
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const allRows = db.prepare(`SELECT b.* FROM bills b ${where} ORDER BY b.latest_date DESC, b.id DESC`).all(...params);
  // 會期分布在套用會期條件前算（同 L8），選了某會期下拉仍列出其他會期
  const sessionCounts = new Map();
  for (const row of allRows) if (row.session !== null) sessionCounts.set(Number(row.session), (sessionCounts.get(Number(row.session)) ?? 0) + 1);
  const rows = session ? allRows.filter((row) => String(row.session) === String(session)) : allRows;

  // 統計在「套用狀態篩選前」算（L8）：否則選了三讀之後下拉只剩三讀一個選項。
  const lawCounts = new Map();
  const statusCounts = new Map();
  for (const row of rows) {
    for (const name of JSON.parse(row.laws || '[]')) lawCounts.set(name, (lawCounts.get(name) ?? 0) + 1);
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  }
  const matching = statusFilter ? rows.filter((row) => row.status === statusFilter) : rows;
  // 主提案人黨籍分布（法律頁的「各黨提案」長條）；在套用狀態篩選後算，與列表一致
  const leadParty = new Map(
    db.prepare('SELECT s.bill_id, l.party FROM bill_sponsors s JOIN legislators l ON l.id = s.legislator_id WHERE s.is_lead = 1').all().map((r) => [r.bill_id, r.party]),
  );
  const partyCounts = {};
  for (const row of matching) {
    const party = leadParty.get(row.id) ?? '黨團／其他';
    partyCounts[party] = (partyCounts[party] ?? 0) + 1;
  }
  const ranked = (map, n) =>
    [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-Hant')).slice(0, n).map(([name, count]) => ({ name, count }));

  const page = matching.slice(resolvedOffset, resolvedOffset + resolvedLimit);
  const sponsorsByBill = new Map();
  if (page.length) {
    const sponsorRows = db
      .prepare(
        `SELECT s.bill_id, s.is_lead, l.id, l.name, l.party FROM bill_sponsors s JOIN legislators l ON l.id = s.legislator_id
         WHERE s.bill_id IN (${page.map(() => '?').join(',')}) ORDER BY s.is_lead DESC, l.name`,
      )
      .all(...page.map((r) => r.id));
    for (const r of sponsorRows) {
      const list = sponsorsByBill.get(r.bill_id) ?? [];
      list.push({ id: r.id, name: r.name, party: r.party, is_lead: Number(r.is_lead) === 1 });
      sponsorsByBill.set(r.bill_id, list);
    }
  }

  return {
    meta: { ...envelope(db), bills_fetched_at: getMeta(db, 'bills_fetched_at'), bills_source: { name: CONFIG.bills.name, url: CONFIG.bills.homepage } },
    total: matching.length,
    count: page.length,
    laws: ranked(lawCounts, 8),
    parties: partyCounts,
    term: currentTerm(db),
    sessions: [...sessionCounts].sort((a, b) => a[0] - b[0]).map(([seq, count]) => ({ seq, count })),
    first_date: matching.length ? matching.reduce((min, r) => (r.latest_date && r.latest_date < min ? r.latest_date : min), matching[0].latest_date || '9999') : null,
    statuses: ranked(statusCounts, 20),
    items: page.map((r) => {
      const sponsors = sponsorsByBill.get(r.id) ?? [];
      return { ...toBill(r), is_lead: legislator ? sponsors.some((x) => x.id === legislator && x.is_lead) : false, sponsors };
    }),
  };
}

/**
 * 熱門議題：最近 `days` 天（以資料中最新的議案日期為基準，資料延遲也不會變空）有進度的議案，依涉及法律分組。
 * 每個議題附件數、三讀件數、最新日期、主提案人黨籍分布。
 */
export function listTopics(db, { days = 30, limit = 12 } = {}) {
  const resolvedDays = Math.max(1, Math.min(Number(days) || 30, 365));
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const anchor = db.prepare('SELECT MAX(latest_date) AS d FROM bills').get().d;
  if (!anchor) return { meta: envelope(db), since: null, count: 0, items: [] };
  const since = new Date(Date.parse(`${anchor}T00:00:00Z`) - resolvedDays * 86_400_000).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT b.id, b.laws, b.status, b.latest_date, l.party AS lead_party
       FROM bills b
       LEFT JOIN bill_sponsors s ON s.bill_id = b.id AND s.is_lead = 1
       LEFT JOIN legislators l ON l.id = s.legislator_id
       WHERE b.latest_date >= ?`,
    )
    .all(since);
  const topics = new Map();
  for (const row of rows) {
    for (const law of JSON.parse(row.laws || '[]')) {
      const t = topics.get(law) ?? { law, count: 0, passed: 0, latest_date: '', parties: {} };
      t.count += 1;
      if (row.status === '三讀') t.passed += 1;
      if (row.latest_date > t.latest_date) t.latest_date = row.latest_date;
      const party = row.lead_party ?? '黨團／其他';
      t.parties[party] = (t.parties[party] ?? 0) + 1;
      topics.set(law, t);
    }
  }
  const items = [...topics.values()]
    .sort((a, b) => b.count - a.count || b.latest_date.localeCompare(a.latest_date))
    .slice(0, resolvedLimit);
  return { meta: envelope(db), since, count: items.length, items };
}

/**
 * 最近有動態的委員：各委員最新一則臉書貼文（整理表）、新聞、議案進度，取最近者排序；
 * 同一天以近 7 天新聞量多者在前。只列在職委員。
 */
export function listActivity(db, { limit = 12, ids = null } = {}) {
  const only = ids ? new Set(String(ids).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 12, 113));
  const legislators = db.prepare('SELECT id, name, party, area_name, photo_url FROM legislators WHERE leave_flag = 0').all();
  const latestNews = new Map();
  const recentNews = new Map();
  const newsRows = db.prepare('SELECT legislator_id, title, source, url, published_at FROM news ORDER BY published_at DESC').all();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  for (const n of newsRows) {
    if (!latestNews.has(n.legislator_id)) latestNews.set(n.legislator_id, { title: n.title, source: n.source, url: n.url, published_at: n.published_at });
    if (n.published_at >= weekAgo) recentNews.set(n.legislator_id, (recentNews.get(n.legislator_id) ?? 0) + 1);
  }
  const latestBill = new Map();
  for (const r of db.prepare('SELECT s.legislator_id, b.* FROM bill_sponsors s JOIN bills b ON b.id = s.bill_id ORDER BY b.latest_date DESC, b.id DESC').all()) {
    if (!latestBill.has(r.legislator_id)) latestBill.set(r.legislator_id, toBill(r));
  }
  const latestPost = new Map();
  for (const r of db.prepare("SELECT * FROM social_accounts WHERE latest_post_date <> '' ORDER BY latest_post_date DESC").all()) {
    if (!latestPost.has(r.legislator_id)) latestPost.set(r.legislator_id, { platform: r.platform, url: r.url, date: r.latest_post_date, summary: r.latest_post_summary });
  }
  const conveners = new Set(
    db.prepare('SELECT legislator_id FROM committee_seats WHERE session_id = ? AND is_convener = 1').all(getMeta(db, 'current_session', '')).map((r) => r.legislator_id),
  );

  const items = legislators
    .map((l) => {
      const post = latestPost.get(l.id) ?? null;
      const news = latestNews.get(l.id) ?? null;
      const bill = latestBill.get(l.id) ?? null;
      const activity_date = [post?.date, news?.published_at?.slice(0, 10), bill?.latest_date].filter(Boolean).sort().at(-1) ?? '';
      return {
        legislator: { id: l.id, name: l.name, party: l.party, area_name: l.area_name, region: regionOf(l.area_name), photo_url: l.photo_url, is_convener: conveners.has(l.id) },
        activity_date,
        news_7d: recentNews.get(l.id) ?? 0,
        post,
        news,
        bill,
      };
    })
    .filter((x) => x.activity_date && (!only || only.has(x.legislator.id)))
    .sort((a, b) => b.activity_date.localeCompare(a.activity_date) || b.news_7d - a.news_7d)
    .slice(0, resolvedLimit);
  return { meta: envelope(db), count: items.length, items };
}

/** 縣市由北到南、離島，最後是不分區與原住民；清單外的（未來新選區）排在最後 */
const REGION_ORDER = [
  '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
  '全國不分區', '平地原住民', '山地原住民',
];

/**
 * 各區域（縣市）最新動態：該區在職委員，以及委員們最近的貼文／新聞／提案（合併取最新 `per` 則）。
 * 動態來源與 listActivity 相同，只是改依選區分組。
 */
export function listRegions(db, { per = 3 } = {}) {
  const resolvedPer = Math.max(1, Math.min(Number(per) || 3, 10));
  const activity = new Map(listActivity(db, { limit: 113 }).items.map((a) => [a.legislator.id, a]));
  const regions = new Map();
  for (const l of db.prepare('SELECT id, name, party, area_name FROM legislators WHERE leave_flag = 0 ORDER BY name').all()) {
    const name = regionOf(l.area_name);
    const region = regions.get(name) ?? { region: name, legislators: [], news_7d: 0, latest: [] };
    const who = { id: l.id, name: l.name, party: l.party };
    region.legislators.push(who);
    const a = activity.get(l.id);
    if (a) {
      region.news_7d += a.news_7d;
      if (a.post) region.latest.push({ kind: 'post', date: a.post.date, text: a.post.summary || '最新貼文', url: a.post.url, legislator: who });
      if (a.news) region.latest.push({ kind: 'news', date: a.news.published_at.slice(0, 10), text: a.news.title, url: a.news.url, source: a.news.source, legislator: who });
      if (a.bill) region.latest.push({ kind: 'bill', date: a.bill.latest_date, text: a.bill.laws[0] ?? a.bill.name, url: a.bill.url, status: a.bill.status, legislator: who });
    }
    regions.set(name, region);
  }
  const rank = (name) => (REGION_ORDER.includes(name) ? REGION_ORDER.indexOf(name) : REGION_ORDER.length);
  const items = [...regions.values()]
    .sort((a, b) => rank(a.region) - rank(b.region) || a.region.localeCompare(b.region, 'zh-Hant'))
    .map((r) => ({ ...r, latest: r.latest.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, resolvedPer) }));
  return { meta: envelope(db), count: items.length, items };
}

export function listNews(db, { legislator = null, limit = 10 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
  const total = legislator
    ? Number(db.prepare('SELECT COUNT(*) AS n FROM news WHERE legislator_id = ?').get(legislator).n)
    : Number(db.prepare('SELECT COUNT(*) AS n FROM news').get().n);
  const select = 'SELECT n.*, l.name AS legislator_name, l.party AS legislator_party FROM news n JOIN legislators l ON l.id = n.legislator_id';
  const order = 'ORDER BY n.published_at DESC, n.url LIMIT ?';
  const rows = legislator
    ? db.prepare(`${select} WHERE n.legislator_id = ? ${order}`).all(legislator, resolvedLimit)
    : db.prepare(`${select} ${order}`).all(resolvedLimit);
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at'), news_source: { name: CONFIG.news.name, url: 'https://news.google.com/' } },
    total,
    count: rows.length,
    items: rows.map((r) => ({ legislator_id: r.legislator_id, legislator_name: r.legislator_name, legislator_party: r.legislator_party, title: r.title, source: r.source, url: r.url, published_at: r.published_at })),
  };
}

/**
 * 預算類議案的審議狀態分三類。定期報告多半「交付查照」即結案（不經審查），
 * 所以不套委員提案的五階段流程，只分審議中／已結案／退回。
 */
const BUDGET_TYPES = ['general', 'subsidiary', 'special', 'supplementary'];
const BUDGET_PENDING = new Set(['交付審查', '交付處理', '排入院會', '排入院會(討論事項)', '交付協商', '復議', '中央政府總預算流程']);
export const budgetState = (status) =>
  BUDGET_PENDING.has(status) ? 'pending' : status === '退回程序委員會' ? 'returned' : 'done';

/**
 * 預算審議：`category`、`q`（名稱或提案單位關鍵字）、`year`（預算年度）、`proposer`、`state`、分頁。
 * 統計依序在套用各自條件「之前」算（同 listBills 的 L8），選了某機關後機關清單不會只剩一個。
 */
export function listBudget(db, { category = '', type = '', q = '', year = '', proposer = '', state = '', limit = 30, offset = 0, all = false } = {}) {
  const resolvedLimit = all ? Infinity : Math.max(1, Math.min(Number(limit) || 30, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  // 預算類型在讀取時由名稱判斷（規則見 budgetTypes），改規則不必重新同步
  const rows = db.prepare('SELECT * FROM budget_bills ORDER BY latest_date DESC, id DESC').all().map((r) => ({ ...r, types: budgetTypes(r.name) }));
  const count = (list, key) => {
    const m = new Map();
    for (const r of list) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };
  const ranked = (map, n) => [...map].filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, n2]) => ({ name: String(name), count: n2 }));

  const categories = count(rows, (r) => r.category);
  const needle = String(q ?? '').trim();
  const base = rows.filter(
    (r) => (!category || r.category === category) && (!needle || r.name.includes(needle) || String(r.proposer ?? '').includes(needle)),
  );
  const typeCounts = Object.fromEntries(BUDGET_TYPES.map((t) => [t, base.filter((r) => r.types.includes(t)).length]));
  const byType = BUDGET_TYPES.includes(type) ? base.filter((r) => r.types.includes(type)) : base;
  const years = count(byType, (r) => r.fiscal_year);
  const byYear = year ? byType.filter((r) => String(r.fiscal_year) === String(year)) : byType;
  const proposers = count(byYear, (r) => r.proposer);
  const byProposer = proposer ? byYear.filter((r) => r.proposer === proposer) : byYear;
  const states = count(byProposer, (r) => budgetState(r.status));
  const matching = state ? byProposer.filter((r) => budgetState(r.status) === state) : byProposer;

  return {
    meta: { ...envelope(db), budget_fetched_at: getMeta(db, 'budget_fetched_at'), source: { name: CONFIG.bills.name, url: CONFIG.bills.homepage } },
    total: matching.length,
    count: Math.min(resolvedLimit, Math.max(0, matching.length - resolvedOffset)),
    categories: CONFIG.budget.categories.map((name) => ({ name, count: categories.get(name) ?? 0 })),
    years: [...years].filter(([y]) => y).sort((a, b) => b[0] - a[0]).map(([name, n]) => ({ name: String(name), count: n })),
    proposers: ranked(proposers, 15),
    states: { pending: states.get('pending') ?? 0, done: states.get('done') ?? 0, returned: states.get('returned') ?? 0 },
    types: typeCounts,
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit).map((r) => ({
      id: r.id,
      category: r.category,
      types: r.types,
      name: r.name,
      status: r.status,
      state: budgetState(r.status),
      proposer: r.proposer,
      fiscal_year: r.fiscal_year,
      session: r.session,
      latest_date: r.latest_date,
      url: r.url,
    })),
  };
}

/** 預算中心評估報告：依撰成日期新→舊；`type` 精確、`q` 比對標題 */
export function listBudgetReports(db, { type = '', q = '', limit = 20, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const needle = String(q ?? '').trim();
  const rows = db.prepare('SELECT * FROM budget_reports ORDER BY completed DESC, no DESC').all();
  const types = CONFIG.budget.reportTypes.map((name) => ({ name, count: rows.filter((r) => r.type === name).length }));
  const matching = rows.filter((r) => (!type || r.type === type) && (!needle || r.title.includes(needle)));
  return {
    meta: { ...envelope(db), reports_fetched_at: getMeta(db, 'budget_reports_fetched_at') },
    total: matching.length,
    types,
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit),
  };
}

/**
 * 議程涉及預算的委員會會議（會議事由含「預算」），附發言委員排行。
 * ponytail: 以關鍵字判斷「預算會議」，會把順帶處理預算書面報告的會議也算進去；要更準再改成比對議程類型。
 */
export function listBudgetMeetings(db, { limit = 15 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
  const rows = db.prepare("SELECT * FROM committee_meetings WHERE content LIKE '%預算%' ORDER BY date DESC, id DESC").all();
  const people = new Map(db.prepare('SELECT id, name, party, leave_flag FROM legislators').all().map((l) => [l.id, l]));
  const committees = new Map();
  const speakers = new Map();
  const items = rows.map((r) => {
    const list = JSON.parse(r.speakers || '[]');
    committees.set(r.committee, (committees.get(r.committee) ?? 0) + 1);
    for (const s of new Set(list.map((x) => x.id).filter(Boolean))) speakers.set(s, (speakers.get(s) ?? 0) + 1);
    return { date: r.date, committee: r.committee, joint: r.joint, name: r.name, content: r.content, speakers: list };
  });
  return {
    meta: { ...envelope(db), meetings_fetched_at: getMeta(db, 'meetings_fetched_at') },
    total: items.length,
    with_speakers: items.filter((m) => m.speakers.length).length,
    committees: [...committees].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    // 在職委員的發言場次排行（離職者不列入，理由同排行榜）
    speakers: [...speakers]
      .map(([id, count]) => ({ legislator: people.get(id), count }))
      .filter((x) => x.legislator && Number(x.legislator.leave_flag) === 0)
      .sort((a, b) => b.count - a.count || a.legislator.name.localeCompare(b.legislator.name, 'zh-Hant'))
      .slice(0, 20)
      .map(({ legislator: l, count }) => ({ legislator: { id: l.id, name: l.name, party: l.party }, count })),
    // 最近會議只列有發言名單的（黨團協商等沒有名單的會議只計入 total）
    items: items.filter((m) => m.speakers.length).slice(0, resolvedLimit),
  };
}

/**
 * 基金、機關、財團法人、行政法人四類，每個名稱只歸一類（行政法人 > 財團法人 > 基金 > 機關）。
 * - 基金：excel_merge 的 fund-config（全名＋不會誤判的簡稱；國營事業在預算上是營業基金，也算基金）；
 *   清單外凡含「基金」也算（新提設立的基金不會在清單裡），歸到「其他基金」
 * - 機關：政府機關代碼表的中央機關
 * - 行政法人：fund-config.json 的 administrative，加上標題中「行政法人XXX」
 * - 財團法人：標題中「財團法人XXX」取出的名稱（之後不帶前綴出現也算）；清單外的「基金會」歸到「其他基金會」
 */
const FUND_CONFIG = JSON.parse(readFileSync(new URL('./fund-config.json', import.meta.url), 'utf8'));
export const OTHER_FUND = '其他基金';
export const OTHER_FOUNDATION = '其他基金會';
export const ENTITY_TYPES = ['fund', 'agency', 'foundation', 'administrative'];
const LEGAL_RE = /(財團|行政)法人([^\s，、。；：「」『』（）()及和暨]{2,30}?(?:中心基金會|基金會|中心|研究院|協會|醫院|學會|基金|研究所|院|會|社))/g;
const escapeRe = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 依這批標題建立標記函式：回傳每個標題提到的四類名稱（正式名稱） */
export function makeTagger(texts) {
  const type = new Map(FUND_CONFIG.agencies.map((n) => [n, 'agency']));
  for (const n of FUND_CONFIG.names) type.set(n, 'fund');
  const legal = new Map(FUND_CONFIG.administrative.map((n) => [n, 'administrative']));
  for (const t of texts) for (const m of String(t ?? '').matchAll(LEGAL_RE)) if (!legal.has(m[2])) legal.set(m[2], m[1] === '行政' ? 'administrative' : 'foundation');
  for (const [n, k] of legal) type.set(n, k);
  const canon = new Map([...[...type.keys()].map((n) => [n, n]), ...Object.entries(FUND_CONFIG.aliases)]);
  // 長的排前面：正規式在同一位置會先吃「國立臺灣大學附設醫院作業基金」而非「國立臺灣大學校務基金」的前綴
  const re = new RegExp([...canon.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
  return (text) => {
    const t = String(text ?? '');
    const out = Object.fromEntries(ENTITY_TYPES.map((k) => [k, []]));
    for (const n of new Set((t.match(re) ?? []).map((k) => canon.get(k)))) out[type.get(n)].push(n);
    const rest = t.replace(re, ''); // 已認得的名稱（如「海外信用保證基金」）不再算進「其他」
    if (!out.fund.length && /基金(?!會)/.test(rest)) out.fund.push(OTHER_FUND);
    if (rest.includes('基金會')) out.foundation.push(OTHER_FOUNDATION);
    return out;
  };
}

const FUND_KINDS = ['news', 'post', 'bill', 'budget', 'report'];

/**
 * 總覽各來源（新聞、臉書、委員提案、預算審議、預算中心報告）中與某一類（`type`：fund／agency／foundation／administrative）相關的項目，依日期新→舊。
 * `fund` 精確篩選該類的名稱、`kind` 篩選來源；統計依序在各自條件之前算（同 listBudget）。
 * ponytail: 每次請求全表掃描約 2 萬列＋一個正規式（實測數十毫秒）；變慢再在同步時預先標記。
 */
export function listFunds(db, { type = 'fund', fund = '', kind = '', limit = 30, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const people = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, { id: l.id, name: l.name, party: l.party }]));
  const lead = new Map(db.prepare('SELECT bill_id, legislator_id FROM bill_sponsors WHERE is_lead = 1').all().map((r) => [r.bill_id, people.get(r.legislator_id)]));
  const resolvedType = ENTITY_TYPES.includes(type) ? type : 'fund';
  const rows = [
    ...db.prepare('SELECT * FROM news').all().map((r) => ({ kind: 'news', date: r.published_at.slice(0, 10), title: r.title, url: r.url, source: r.source, legislator: people.get(r.legislator_id) })),
    ...db
      .prepare("SELECT * FROM social_accounts WHERE latest_post_summary <> ''")
      .all()
      .map((r) => ({ kind: 'post', date: r.latest_post_date, title: r.latest_post_summary, url: r.url, legislator: people.get(r.legislator_id) })),
    ...db.prepare('SELECT * FROM bills').all().map((r) => ({ kind: 'bill', date: r.latest_date, title: r.name, url: r.url, status: r.status, legislator: lead.get(r.id) })),
    ...db.prepare('SELECT * FROM budget_bills').all().map((r) => ({ kind: 'budget', date: r.latest_date, title: r.name, url: r.url, status: r.status, source: r.proposer })),
    ...db.prepare('SELECT * FROM budget_reports').all().map((r) => ({ kind: 'report', date: r.completed, title: r.title, url: r.url, source: r.type })),
  ];
  const tag = makeTagger(rows.map((r) => r.title));
  // 各來源的資料期間（全部資料，不只命中的）：新聞只保留近一個月，件數少要看得出原因
  const periods = {};
  for (const r of rows) {
    const d = String(r.date ?? '').slice(0, 10);
    if (!d) continue;
    const p = (periods[r.kind] ??= { from: d, to: d });
    if (d < p.from) p.from = d;
    if (d > p.to) p.to = d;
  }
  const tagged = rows
    .map((r) => ({ ...r, date: r.date ?? '', legislator: r.legislator ?? null, funds: tag(r.title)[resolvedType] }))
    // 同一則新聞會掛在每位被提到的委員底下，只留一則
    .filter((r, i, all) => r.funds.length && (r.kind !== 'news' || all.findIndex((x) => x.kind === 'news' && x.url === r.url) === i))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

  const byKind = FUND_KINDS.includes(kind) ? tagged.filter((r) => r.kind === kind) : tagged;
  const funds = new Map();
  for (const r of byKind) for (const f of r.funds) funds.set(f, (funds.get(f) ?? 0) + 1);
  const byFund = fund ? tagged.filter((r) => r.funds.includes(fund)) : tagged;
  const matching = fund ? byKind.filter((r) => r.funds.includes(fund)) : byKind;
  return {
    meta: envelope(db),
    total: matching.length,
    kinds: Object.fromEntries(FUND_KINDS.map((k) => [k, byFund.filter((r) => r.kind === k).length])),
    periods,
    funds: [...funds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant')).slice(0, 40).map(([name, count]) => ({ name, count })),
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit),
  };
}

/**
 * 委員會動態：最新會議（官方 ID223：議程、登記發言委員；依名稱對上 g0v 的附件與影片）、
 * 機關回覆（部會對委員質詢的書面答復，g0v meets 附件）與會議紀錄（公報，含官員答詢全文）。
 * `committee` 為委員會全名，聯席會議會出現在每個參與的委員會；委員會清單依常設委員會在前、其餘依件數。
 */
export function listCommitteeActivity(db, { committee = '', limit = 20 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const people = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, l]));
  const meets = db.prepare('SELECT * FROM committee_meets ORDER BY date DESC, code DESC').all().map((m) => ({ ...m, committees: JSON.parse(m.committees), attachments: JSON.parse(m.attachments) }));
  // ID223 的會議名稱可能多了「(會議取消)」之類的前綴，比對前去掉
  const meetKey = (name) => String(name ?? '').replace(/^\s*[（(][^）)]*[）)]\s*/, '').replace(/\s/g, '');
  const meetByName = new Map(meets.map((m) => [meetKey(m.title), m]));
  const byHan = new Map([...people.values()].map((l) => [newsName(l.name), l]));
  const nameRe = new RegExp([...byHan.keys()].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length).join('|'), 'g');
  /** 回覆標題提到的委員：全名，或「邱委員慧洳」這種姓＋委員＋名 */
  const repliedTo = (title) => {
    const t = String(title).replace(/(.)委員(.{1,3}?)(?=[口書質答函_\-、，(（]|$)/g, '$1$2委員');
    return [...new Set(t.match(nameRe) ?? [])].map((n) => byHan.get(n)).map((l) => ({ id: l.id, name: l.name, party: l.party }));
  };
  const meetings = db
    .prepare('SELECT * FROM committee_meetings ORDER BY date DESC, id DESC')
    .all()
    .map((m) => ({
      date: m.date,
      name: m.name,
      content: m.content,
      committees: [...new Set([...committeesOf(m.committee), ...committeesOf(m.joint)])],
      video_url: meetByName.get(meetKey(m.name))?.video_url ?? null,
      attachments: (meetByName.get(meetKey(m.name))?.attachments ?? []).filter((a) => a.kind === 'attachment').map(({ title, url }) => ({ title, url })),
      speakers: JSON.parse(m.speakers || '[]').map((s) => {
        const l = s.id && people.get(s.id);
        return l ? { id: l.id, name: l.name, party: l.party } : { id: null, name: s.name, party: '' };
      }),
    }));
  const records = db
    .prepare('SELECT * FROM committee_records ORDER BY date DESC, id DESC')
    .all()
    .map((r) => ({ ...r, committees: JSON.parse(r.committees || '[]') }));

  const replies = meets.flatMap((m) =>
    m.attachments
      .filter((a) => a.kind === 'reply')
      .map((a) => ({ date: m.date, committees: m.committees, meeting: m.title, title: a.title, url: a.url, legislators: repliedTo(a.title) })),
  );

  const counts = new Map();
  for (const x of [...meetings, ...records]) for (const c of x.committees) counts.set(c, (counts.get(c) ?? 0) + 1);
  const standing = CONFIG.committeeOrder;
  const rank = (name) => (standing.includes(name) ? standing.indexOf(name) : standing.length);
  const pick = (list) => (committee ? list.filter((x) => x.committees.includes(committee)) : list);
  const period = (list) => (list.length ? { from: list.at(-1).date, to: list[0].date } : null);
  const m = pick(meetings);
  const r = pick(records);
  const rp = pick(replies);
  return {
    meta: { ...envelope(db), meetings_fetched_at: getMeta(db, 'meetings_fetched_at'), records_fetched_at: getMeta(db, 'records_fetched_at'), meets_fetched_at: getMeta(db, 'meets_fetched_at') },
    committees: [...counts]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    meetings: { total: m.length, period: period(meetings.filter((x) => x.date)), items: m.slice(0, resolvedLimit) },
    replies: { total: rp.length, period: period(replies.filter((x) => x.date)), items: rp.slice(0, resolvedLimit) },
    records: { total: r.length, period: period(records.filter((x) => x.date)), items: r.slice(0, resolvedLimit) },
  };
}

export function budgetCsv(items) {
  const TYPE_LABEL = { general: '總預算', subsidiary: '附屬單位預算', special: '特別預算', supplementary: '追加預算' };
  const header = ['議案編號', '類別', '預算類型', '名稱', '提案單位', '預算年度', '狀態', '最新進度日期', '連結'];
  return [
    csvRow(header),
    ...items.map((b) => csvRow([b.id, b.category, b.types.map((t) => TYPE_LABEL[t]).join('、'), b.name, b.proposer, b.fiscal_year, b.status, b.latest_date, b.url])),
  ].join('\r\n');
}

/** 三讀（含審查完畢後三讀、照案通過）視為通過 */
const PASSED = new Set(['三讀', '審查完畢(三讀)', '照案通過']);

/**
 * 共同提案網絡。
 * - 指定 `legislator`：最常一起連署的委員（含黨籍），以及跨黨合作比例（該委員的議案中，有他黨委員連署的占比）。
 * - 未指定：黨籍矩陣，rows＝主提案人黨籍、cols＝連署人黨籍，值＝連署人次（不含主提案人自己）。
 */
export function listCosponsors(db, { legislator = null, limit = 10 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  if (legislator) {
    const self = db.prepare('SELECT id, party FROM legislators WHERE id = ?').get(legislator);
    if (!self) return { meta: envelope(db), legislator, total_bills: 0, cross_party_bills: 0, items: [] };
    const rows = db
      .prepare(
        `SELECT o.bill_id, l.id, l.name, l.party FROM bill_sponsors me
         JOIN bill_sponsors o ON o.bill_id = me.bill_id AND o.legislator_id <> me.legislator_id
         JOIN legislators l ON l.id = o.legislator_id
         WHERE me.legislator_id = ?`,
      )
      .all(legislator);
    const partners = new Map();
    const crossBills = new Set();
    for (const r of rows) {
      const p = partners.get(r.id) ?? { id: r.id, name: r.name, party: r.party, count: 0 };
      p.count += 1;
      partners.set(r.id, p);
      if (r.party !== self.party) crossBills.add(r.bill_id);
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM bill_sponsors WHERE legislator_id = ?').get(legislator).n;
    const items = [...partners.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')).slice(0, resolvedLimit);
    return { meta: envelope(db), legislator, total_bills: Number(total), cross_party_bills: crossBills.size, items };
  }
  const rows = db
    .prepare(
      `SELECT ll.party AS lead_party, lc.party AS co_party, COUNT(*) AS n
       FROM bill_sponsors lead
       JOIN bill_sponsors co ON co.bill_id = lead.bill_id AND co.is_lead = 0
       JOIN legislators ll ON ll.id = lead.legislator_id
       JOIN legislators lc ON lc.id = co.legislator_id
       WHERE lead.is_lead = 1
       GROUP BY 1, 2`,
    )
    .all();
  const matrix = {};
  for (const r of rows) (matrix[r.lead_party] ??= {})[r.co_party] = Number(r.n);
  return { meta: envelope(db), matrix };
}

/** 兩位（或多位）委員並排比較：提案、三讀、新聞、委員會，以及彼此的共同提案與共同委員會。 */
export function compareLegislators(db, { ids = '' } = {}) {
  const list = [...new Set(String(ids).split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 4);
  const session = currentSession(db);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const billSets = new Map();
  const items = [];
  for (const id of list) {
    const l = db.prepare('SELECT id, name, party, area_name, photo_url, leave_flag FROM legislators WHERE id = ?').get(id);
    if (!l) continue;
    const bills = db.prepare('SELECT b.id, b.status, b.laws, s.is_lead FROM bill_sponsors s JOIN bills b ON b.id = s.bill_id WHERE s.legislator_id = ?').all(id);
    billSets.set(id, new Set(bills.map((b) => b.id)));
    const lawCounts = new Map();
    for (const b of bills) for (const law of JSON.parse(b.laws || '[]')) lawCounts.set(law, (lawCounts.get(law) ?? 0) + 1);
    const committees = db.prepare('SELECT committee_id, is_convener FROM committee_seats WHERE session_id = ? AND legislator_id = ?').all(session ?? '', id);
    items.push({
      legislator: { id: l.id, name: l.name, party: l.party, area_name: l.area_name, region: regionOf(l.area_name), photo_url: l.photo_url, former: Number(l.leave_flag) === 1 },
      bills: bills.length,
      lead_bills: bills.filter((b) => Number(b.is_lead) === 1).length,
      passed_bills: bills.filter((b) => PASSED.has(b.status)).length,
      news_30d: Number(db.prepare('SELECT COUNT(*) AS n FROM news WHERE legislator_id = ? AND published_at >= ?').get(id, monthAgo).n),
      committees: committees.map((c) => ({ id: c.committee_id, is_convener: Number(c.is_convener) === 1 })),
      top_laws: [...lawCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    });
  }
  const [first, ...rest] = items;
  const shared = first
    ? {
        bills: [...billSets.get(first.legislator.id)].filter((b) => rest.every((x) => billSets.get(x.legislator.id).has(b))).length,
        committees: first.committees.map((c) => c.id).filter((c) => rest.every((x) => x.committees.some((y) => y.id === c))),
      }
    : { bills: 0, committees: [] };
  return { meta: envelope(db), count: items.length, items, shared };
}

/** RFC 4180：含逗號、引號、換行的欄位加引號，引號重複 */
export const csvRow = (cells) => cells.map((c) => (/[",\n\r]/.test(String(c ?? '')) ? `"${String(c).replace(/"/g, '""')}"` : String(c ?? ''))).join(',');

export function billsCsv(items) {
  const header = ['議案編號', '屆', '會期', '議案名稱', '狀態', '最新進度日期', '涉及法律', '主提案人', '連署人', '連結'];
  const lines = items.map((b) =>
    csvRow([
      b.id,
      b.term,
      b.session,
      b.name,
      b.status,
      b.latest_date,
      b.laws.join('、'),
      b.sponsors.filter((s) => s.is_lead).map((s) => s.name).join('、'),
      b.sponsors.filter((s) => !s.is_lead).map((s) => s.name).join('、'),
      b.url,
    ]),
  );
  return [csvRow(header), ...lines].join('\r\n');
}
