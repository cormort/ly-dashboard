import { CONFIG } from './config.mjs';
import { getMeta } from './db.mjs';
import { regionOf } from './normalize.mjs';

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
export function listBills(db, { legislator = null, q = '', law = '', status = '', limit = 20, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const clauses = [];
  const params = [];
  if (legislator) clauses.push('b.id IN (SELECT bill_id FROM bill_sponsors WHERE legislator_id = ?)'), params.push(legislator);
  const needle = String(q ?? '').trim();
  if (needle) clauses.push('(b.name LIKE ? OR b.laws LIKE ?)'), params.push(`%${needle}%`, `%${needle}%`);
  if (law) clauses.push('b.laws LIKE ?'), params.push(`%${JSON.stringify(String(law))}%`);
  const statusFilter = status ? String(status) : '';
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT b.* FROM bills b ${where} ORDER BY b.latest_date DESC, b.id DESC`).all(...params);

  // 統計在「套用狀態篩選前」算（L8）：否則選了三讀之後下拉只剩三讀一個選項。
  const lawCounts = new Map();
  const statusCounts = new Map();
  for (const row of rows) {
    for (const name of JSON.parse(row.laws || '[]')) lawCounts.set(name, (lawCounts.get(name) ?? 0) + 1);
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  }
  const matching = statusFilter ? rows.filter((row) => row.status === statusFilter) : rows;
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
export function listActivity(db, { limit = 12 } = {}) {
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
    .filter((x) => x.activity_date)
    .sort((a, b) => b.activity_date.localeCompare(a.activity_date) || b.news_7d - a.news_7d)
    .slice(0, resolvedLimit);
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
