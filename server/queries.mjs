import { CONFIG } from './config.mjs';
import { getMeta , getBudgetCommittees } from './db.mjs';
import { readFileSync } from 'node:fs';
import { budgetTypes, committeesOf, newsName, regionOf } from './normalize.mjs';
import { SYNC_SCOPES, datasetLabel, scopeDatasets } from './sync-scopes.mjs';

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

/**
 * `now` 可注入：測試若用固定時間戳寫入資料，卻拿「執行當下」判斷 stale，
 * 過了 staleAfterHours 之後測試就會自己變紅（會過期的測試）。
 * 不傳 `now` 時就是真實時間，正式路徑行為不變。
 */
export function isStale(db, now = Date.now()) {
  const last = getMeta(db, 'last_success_at');
  if (!last) return true;
  return now - new Date(last).getTime() > CONFIG.staleAfterHours * 3600 * 1000;
}

export function envelope(db, { term = null, session = null, now = Date.now() } = {}) {
  return {
    generated_at: new Date(now).toISOString(),
    fetched_at: getMeta(db, 'last_success_at'),
    stale: isStale(db, now),
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
  // 每位委員報導最多的媒體（同數量取名稱較前者）
  const topSource = new Map();
  for (const r of db.prepare("SELECT legislator_id, COALESCE(NULLIF(source, ''), '未知') AS name, COUNT(*) AS n FROM news GROUP BY 1, 2 ORDER BY n DESC, name").all()) {
    if (!topSource.has(r.legislator_id)) topSource.set(r.legislator_id, { name: r.name, count: Number(r.n) });
  }
  const socialByLegislator = new Map();
  for (const s of db.prepare('SELECT * FROM social_accounts ORDER BY platform, url').all()) {
    const list = socialByLegislator.get(s.legislator_id) ?? [];
    list.push({ platform: s.platform, name: s.page_name, url: s.url, latest_post_date: s.latest_post_date, latest_post_summary: s.latest_post_summary, source: s.source ?? 'sheet' });
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
      election: l ? electionSummary(l.name, scope.term) : null,
      top_source: topSource.get(id) ?? null,
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

/**
 * 同步範圍（下拉選單用）：每個範圍的最後一次同步時間、上次耗時、涵蓋的來源。
 *
 * `last_run_at` 取**涵蓋來源裡最舊的那一個**（＝這個範圍裡最久沒更新的來源），
 * 這樣按「全部」時顯示的是「上次**完整**跑完」的時間，不會被某一項剛跑過而誤導；
 * 有任何來源從未同步就回 null，前端顯示「尚未同步」。
 */
export function listSyncSources(db) {
  const latest = db
    .prepare('SELECT dataset, status, finished_at, duration_ms FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY dataset)')
    .all();
  const byDataset = new Map(latest.map((row) => [row.dataset, row]));

  const scopes = SYNC_SCOPES.map((scope) => {
    const datasets = scopeDatasets(scope.id);
    const sources = datasets.map((dataset) => {
      const run = byDataset.get(dataset) ?? null;
      return {
        dataset,
        label: datasetLabel(dataset),
        status: run?.status ?? 'never',
        finished_at: run?.finished_at ?? null,
        duration_ms: run?.duration_ms === undefined || run?.duration_ms === null ? null : Number(run.duration_ms),
      };
    });
    const finished = sources.map((source) => source.finished_at).filter(Boolean);
    const duration = sources.reduce((sum, source) => sum + (source.duration_ms ?? 0), 0);
    return {
      id: scope.id,
      label: scope.label,
      stages: scope.stages,
      datasets,
      // 更新頻率與冷卻時間：給下拉選單的說明用（見 server/sync-scopes.mjs 與 sync-guard.mjs）
      cadence: scope.cadence ?? null,
      cooldown_minutes: scope.cooldownMinutes ?? null,
      sources,
      last_run_at: sources.some((source) => !source.finished_at) ? null : finished.reduce((oldest, at) => (oldest < at ? oldest : at), finished[0]),
      last_duration_ms: duration || null,
      failed_sources: sources.filter((source) => source.status === 'failed').map((source) => source.dataset),
    };
  });

  return { meta: envelope(db), scopes };
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

/**
 * CR-9：`COUNT(*)` 的表名無法參數化（SQLite 不接受識別字佔位符），所以改成
 * **只從這份常數清單產生**，呼叫端再也傳不進任何字串 —— 這裡不再有插值注入的可能。
 * `[API 欄位名, 資料表名]`，順序即 `/health` 的 `db` 欄位順序。
 */
const HEALTH_TABLES = [
  ['legislators', 'legislators'],
  ['memberships', 'memberships'],
  ['committee_seats', 'committee_seats'],
  ['sessions', 'sessions'],
  ['committees', 'committees'],
  ['changes', 'change_log'],
  ['snapshots', 'raw_snapshots'],
  ['sync_runs', 'sync_runs'],
  ['bills', 'bills'],
  ['budget_bills', 'budget_bills'],
  ['budget_reports', 'budget_reports'],
  ['committee_meetings', 'committee_meetings'],
  ['news', 'news'],
  ['social_accounts', 'social_accounts'],
];

/**
 * 社群整理表的新鮮度：所有帳號「最新貼文日期」裡最新的一天（整理表是人工維護的，程式每天照抄，
 * 沒人更新時日期就停住）。超過 CONFIG.social.staleDays 天算過期，畫面上要標出來，不要讓舊日期看起來像最新。
 */
export function socialFreshness(db, now = Date.now(), table = 'social_accounts') {
  // table 只會是程式內的兩個固定值（立委 social_accounts、議員 council_social），不是使用者輸入
  const asOf = db.prepare(`SELECT MAX(latest_post_date) AS d FROM ${table === 'council_social' ? 'council_social' : 'social_accounts'} WHERE latest_post_date IS NOT NULL AND latest_post_date <> ''`).get()?.d ?? null;
  if (!asOf) return { as_of: null, age_days: null, stale: false, stale_days: CONFIG.social.staleDays };
  // 以臺灣的「今天」算天數：整理表的日期是臺灣日期
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const ageDays = Math.max(0, Math.round((Date.parse(today) - Date.parse(asOf)) / 86_400_000));
  return { as_of: asOf, age_days: ageDays, stale: ageDays > CONFIG.social.staleDays, stale_days: CONFIG.social.staleDays };
}

export function getHealth(db, { now = Date.now(), staticLoaders = undefined } = {}) {
  const lastRuns = db
    .prepare(
      `SELECT * FROM sync_runs
       WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY dataset)
       ORDER BY finished_at DESC, id DESC`,
    )
    .all()
    .map(toSyncRun);
  const configRetention = CONFIG.retention ?? { syncRuns: 0, changeLog: 0 };
  const stats = Object.fromEntries(
    HEALTH_TABLES.map(([key, table]) => [key, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]),
  );
  const newsStatus = getMeta(db, 'news_status', '');
  const notices = [];
  if (newsStatus.startsWith('partial')) notices.push(`新聞同步未跑完（${newsStatus.split(':')[1]}）`);
  // B4：全部失敗會寫 failed:…，以前沒有任何地方顯示它（前端看起來像「已完成」）
  if (newsStatus.startsWith('failed')) notices.push(`新聞同步失敗（${newsStatus.split(':')[1]}，保留上一版）`);
  const socialCount = Number(getMeta(db, 'social_count', '0'));
  if (stats.social_accounts > 0 && socialCount > 0 && stats.social_accounts < socialCount) {
    notices.push(`社群帳號數（${stats.social_accounts}）少於上次成功同步（${socialCount}）`);
  }
  const social = socialFreshness(db, now);
  if (social.stale) notices.push(`臉書整理表的最新貼文日期停在 ${social.as_of}（${social.age_days} 天前），試算表可能沒有人在更新`);
  const councilSocial = socialFreshness(db, now, 'council_social');
  if (councilSocial.stale) notices.push(`議員臉書整理表的最新貼文日期停在 ${councilSocial.as_of}（${councilSocial.age_days} 天前），試算表可能沒有人在更新`);

  // 靜態資料（人口／選舉／鄉鎮圖資）不在同步流程內，`stale`／`ok` 看不到它們。
  // 來源是月報，忘了重跑 build 腳本就會讓畫面上的數字放很久而沒有訊號，所以在這裡提醒。
  // 逐檔檢查（不是只看 counties）：任一個檔案壞掉、空掉、或過期都要看得見。
  const staticData = staticDataStatus(staticLoaders ?? {});
  for (const info of Object.values(staticData)) {
    if (info.error) notices.push(`靜態資料「${info.label}」讀取失敗：${info.error}`);
    else if (!info.count) notices.push(`靜態資料「${info.label}」是空的（0 筆）`);
    const age = monthsSince(info.as_of, now);
    if (info.stale_check !== false && age !== null && age > CONFIG.staticStaleMonths) {
      notices.push(`人口資料「${info.label}」的資料截止為 ${info.as_of}（已 ${age} 個月未更新），請重跑 scripts/build-county-stats.mjs`);
    }
  }

  return {
    meta: envelope(db, { now }),
    ok: stats.legislators > 0 && !isStale(db, now),
    db: stats,
    // 前端會顯示的兩種紀錄目前保留幾筆、上限多少（見 DECISIONS.md：為什麼是保留而不是不存）
    retention: {
      sync_runs: { kept: configRetention.syncRuns, current: stats.sync_runs },
      change_log: { kept: configRetention.changeLog, current: stats.changes },
    },
    // 不在同步流程內的靜態資料：只有「資料截止」與筆數，沒有 fetched_at（它們不是抓來的）
    static_data: staticData,
    // 社群整理表（人工維護）的新鮮度：立委側欄、臉書排行榜用來標「資料截至」與過期提醒
    social,
    council_social: councilSocial,
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
 * 排行榜：新聞曝光、臉書發文、法案提案，以及選舉兩榜（險勝、得票流失）。
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
    // 在職條件下推到 SQL：先在 LIMIT 之後才 filter，離職者會佔走名額，
    // 榜單就會靜默少於 limit（實測 limit=1 且第一名是離職者時回傳空榜）。
    const rows = db
      .prepare(
        `SELECT n.legislator_id, COUNT(*) AS value, MAX(n.published_at) AS latest
         FROM news n JOIN legislators l ON l.id = n.legislator_id AND l.leave_flag = 0
         WHERE n.published_at >= ? GROUP BY n.legislator_id ORDER BY value DESC, latest DESC LIMIT ?`,
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
        `SELECT s.legislator_id, s.page_name, s.url, s.latest_post_date, s.latest_post_summary
         FROM social_accounts s JOIN legislators l ON l.id = s.legislator_id AND l.leave_flag = 0
         WHERE s.latest_post_date <> '' ORDER BY s.latest_post_date DESC LIMIT ?`,
      )
      .all(resolvedLimit)
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
    const freshness = socialFreshness(db);
    boards.facebook = {
      type: 'facebook',
      title: '臉書發文排行',
      note: `依整理表記錄的最新貼文日期排序（0 天＝今天），只計在職委員。整理表資料截至 ${freshness.as_of ?? '—'}`,
      unit: '天前',
      items: withIntensity(items),
      // 整理表是人工維護的：過期時前端要標出來，排名不代表現在
      as_of: freshness.as_of,
      stale: freshness.stale,
      stale_note: freshness.stale ? `整理表已 ${freshness.age_days} 天沒有新的貼文日期，排行可能不是現況（點委員可在側欄直接看臉書最新貼文）` : null,
    };
  }

  if (wanted('bills')) {
    const rows = db
      .prepare(
        `SELECT s.legislator_id, COUNT(*) AS value, SUM(s.is_lead) AS leads, MAX(b.latest_date) AS latest
         FROM bill_sponsors s JOIN bills b ON b.id = s.bill_id
         JOIN legislators l ON l.id = s.legislator_id AND l.leave_flag = 0
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

  // 選舉兩榜：以在職委員最近一次（含補選）當選的選舉為準
  if (wanted('close') || wanted('drop')) {
    const latest = listLegislatorVotes(db)
      .items.filter((i) => index.has(i.legislator.id))
      .map((i) => ({ id: i.legislator.id, race: i.history.at(-1), prev: i.history.at(-2) }))
      .filter((x) => x.race?.elected && x.race.margin_pct !== null);
    if (wanted('close')) {
      const eligible = [...latest].sort((a, b) => a.race.margin_pct - b.race.margin_pct);
      const rows = eligible.slice(0, resolvedLimit);
      // 長條以「最接近的那一場」為滿格：與其他四個榜一致（第一名 intensity = 1），
      // 原本以最寬的差距當分母，最接近的一筆只有 0.83，圖上第一條不會滿，且與 test 的
      // 「每個榜第一名長度為 1」不變量矛盾（2026-10-02 修正，見 DECISIONS D57）。
      // 基準取**全部合格列**而不是 slice 後的 rows：否則同一人的長條會隨 ?limit= 改變
      // （實測廖偉翔 2.46 個百分點在 limit=5/10/20/50 下是 0.06/0.28/0.66/0.85）。
      const margins = eligible.map((x) => x.race.margin_pct);
      const closest = margins.length ? Math.min(...margins) : 0;
      const span = margins.length ? Math.max(...margins) - closest : 0;
      boards.close = {
        type: 'close',
        title: '險勝排行',
        note: '最近一次當選時領先最高票落選者的幅度，越小越前面（原住民選區為最後一席對落選頭）',
        unit: '個百分點',
        items: rows.map((x, i) => ({
          rank: i + 1,
          // 長條代表「多接近」：差距越小越長，最接近的一筆滿格
          intensity: span > 0 ? Math.max(0.06, 1 - ((x.race.margin_pct - closest) / span) * 0.94) : 1,
          value: x.race.margin_pct,
          value_display: `${x.race.margin_pct.toFixed(2)} 個百分點`,
          legislator: index.get(x.id),
          detail: {
            label: `${x.race.year}${x.race.by_election ? ' 補選' : ''} ${x.race.district}`,
            text: `領先 ${x.race.rival.name} ${x.race.margin.toLocaleString('zh-TW')} 票`,
            url: '',
          },
        })),
      };
    }
    if (wanted('drop')) {
      const rows = latest
        // 只比同一選區，避免選區重劃（例如 2024 新竹縣拆成兩區）造成的假流失
        .filter((x) => x.race.change !== null && x.race.change < 0 && x.prev.district === x.race.district)
        .sort((a, b) => a.race.change - b.race.change)
        .slice(0, resolvedLimit)
        .map((x) => ({
          legislator: index.get(x.id),
          value: -x.race.change,
          value_display: `${x.race.change.toLocaleString('zh-TW')} 票`,
          detail: {
            label: `${x.prev.year} → ${x.race.year}${x.race.by_election ? ' 補選' : ''}`,
            text: `${x.prev.votes.toLocaleString('zh-TW')} → ${x.race.votes.toLocaleString('zh-TW')} 票（${x.race.district}）`,
            url: '',
          },
        }));
      boards.drop = {
        type: 'drop',
        title: '得票流失排行',
        note: '最近一次當選與本人前一次在同一選區參選相比，得票減少最多者（仍當選）',
        unit: '票',
        items: withIntensity(rows),
      };
    }
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
  // LIKE 的 % 與 _ 是萬用字元：不跳脫的話 ?q=% 會回傳全部議案（且 total 跟著變成全部件數）。
  const like = (value) => `%${String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  if (needle) clauses.push("(b.name LIKE ? ESCAPE '\\' OR b.laws LIKE ? ESCAPE '\\')"), params.push(like(needle), like(needle));
  if (law) clauses.push("b.laws LIKE ? ESCAPE '\\'"), params.push(`%${JSON.stringify(String(law)).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
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
    if (row.status) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
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
    first_date: matching.reduce((min, r) => (r.latest_date && (!min || r.latest_date < min) ? r.latest_date : min), null),
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
/**
 * 熱門議題：依「受控詞彙」分組，支援 7／30／90 天區間。
 *
 * 每個詞彙都以**自己的**最新資料日為基準（bills 到 2026-10-13、公報紀錄只到 2026-08-26），
 * 否則用同一個 anchor 會讓委員會詞彙在 7 天區間永遠是空的。
 *
 * 回傳每一項：區間內件數、近 7 天件數、前一個等長區間的件數與增減、
 * 三讀件數、最新一筆的日期／狀態／議案、主提案人黨籍分布。
 */
const TOPIC_VOCABULARIES = {
  law: { label: '法律名稱', unit: '件', note: '議案涉及的法律' },
  category: { label: '議案類別', unit: '件', note: '議案的類別（含預算案）' },
  committee: { label: '委員會', unit: '場', note: '委員會會議紀錄場次' },
};

const shiftDays = (date, delta) => new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

export function listTopics(db, { days = 30, limit = 12, vocab = 'law' } = {}) {
  // days: 7／30／90，或 0／all = 本屆全部（近期活動稀疏時才有足夠樣本）
  const requestedDays = String(days ?? '').toLowerCase();
  const resolvedDays = requestedDays === 'all' ? 0 : Math.max(1, Math.min(Number(days) || 30, 365));
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const resolvedVocab = TOPIC_VOCABULARIES[vocab] ? vocab : 'law';
  const meta = TOPIC_VOCABULARIES[resolvedVocab];

  // 每個詞彙的資料截止日；類別詞彙同時涵蓋一般議案與預算案，不能只看 bills
  const maxOf = (sql) => db.prepare(sql).get().d;
  const anchor =
    resolvedVocab === 'committee'
      ? maxOf('SELECT MAX(date) AS d FROM committee_records')
      : resolvedVocab === 'category'
        ? maxOf('SELECT MAX(d) AS d FROM (SELECT MAX(latest_date) AS d FROM bills UNION ALL SELECT MAX(latest_date) AS d FROM budget_bills)')
        : maxOf('SELECT MAX(latest_date) AS d FROM bills');
  // 資料起點：前期區間若早於資料起點，就沒有可比較的基準，寧可說「無前期資料」也不要報錯誤的增減
  const earliest =
    resolvedVocab === 'committee'
      ? maxOf('SELECT MIN(date) AS d FROM committee_records')
      : resolvedVocab === 'category'
        ? maxOf("SELECT MIN(d) AS d FROM (SELECT MIN(latest_date) AS d FROM bills WHERE latest_date != '' UNION ALL SELECT MIN(latest_date) AS d FROM budget_bills WHERE latest_date != '')")
        : maxOf("SELECT MIN(latest_date) AS d FROM bills WHERE latest_date != ''");
  if (!anchor) {
    return {
      meta: envelope(db),
      vocab: resolvedVocab,
      vocabularies: Object.entries(TOPIC_VOCABULARIES).map(([id, v]) => ({ id, ...v })),
      window: { days: resolvedDays, from: null, to: null, recent_from: null },
      data_to: null,
      count: 0,
      items: [],
    };
  }

  // days = 0 代表「本屆全部」：沒有下界，也不跟前一期比較
  const allTime = resolvedDays === 0;
  const from = allTime ? '' : shiftDays(anchor, -resolvedDays);
  const previousFrom = allTime ? '' : shiftDays(anchor, -resolvedDays * 2);
  const recentFrom = shiftDays(anchor, -7);
  // 本屆累計沒有「前一期」；前期區間早於資料起點時也不可比
  const comparable = !allTime && (!earliest || previousFrom >= earliest);

  const items = new Map();
  const bump = (key, row, { dated, party, passed, current, recent, previous, latest }) => {
    const entry =
      items.get(key) ??
      {
        name: key,
        count: 0,
        recent_count: 0,
        previous_count: 0,
        passed: 0,
        latest_date: '',
        latest_status: '',
        latest_name: '',
        latest_url: '',
        parties: {},
      };
    if (current) entry.count += 1;
    if (recent) entry.recent_count += 1;
    if (previous) entry.previous_count += 1;
    if (passed) entry.passed += 1;
    if (dated && dated > entry.latest_date) {
      entry.latest_date = dated;
      entry.latest_status = row.status ?? '';
      entry.latest_name = row.name ?? '';
      entry.latest_url = row.url ?? '';
    }
    if (party) entry.parties[party] = (entry.parties[party] ?? 0) + 1;
    items.set(key, entry);
  };

  if (resolvedVocab === 'committee') {
    for (const row of db.prepare('SELECT date, committees, title, html_url, gazette_url FROM committee_records WHERE date >= ?').all(previousFrom)) {
      const dated = row.date ?? '';
      const current = !from || dated >= from;
      const recent = dated >= recentFrom;
      const previous = !allTime && dated >= previousFrom && dated < from;
      let names = [];
      try {
        names = JSON.parse(row.committees || '[]');
      } catch {
        names = [];
      }
      for (const name of names) {
        bump(name, { status: '', name: row.title, url: row.html_url ?? row.gazette_url ?? '' }, { dated, current, recent, previous, latest: true });
      }
    }
  } else {
    const billRows = db
      .prepare(
        `SELECT b.id, b.name, b.laws, b.category, b.status, b.latest_date, b.url, l.party AS lead_party
         FROM bills b
         LEFT JOIN bill_sponsors s ON s.bill_id = b.id AND s.is_lead = 1
         LEFT JOIN legislators l ON l.id = s.legislator_id
         WHERE b.latest_date >= ?`,
      )
      .all(previousFrom);
    // 類別詞彙把預算案一起算進來（議案類別本來就跨一般議案與預算案）。
    // 注意：這裡必須取 `category` 而不是別名 —— 取鍵的程式讀的是 row.category，
    // 一度寫成 `category AS laws` 導致所有預算案被靜默丟掉（它們不是 `laws` 這個 vocab 的資料）。
    const budgetRows =
      resolvedVocab === 'category'
        ? db.prepare('SELECT name, category, status, latest_date, url FROM budget_bills WHERE latest_date >= ?').all(previousFrom)
        : [];

    for (const row of [...billRows, ...budgetRows]) {
      const dated = row.latest_date ?? '';
      const current = !from || dated >= from;
      const recent = dated >= recentFrom;
      const previous = !allTime && dated >= previousFrom && dated < from;
      let keys = [];
      if (resolvedVocab === 'law') {
        try {
          keys = JSON.parse(row.laws || '[]');
        } catch {
          keys = [];
        }
      } else {
        keys = row.category ? [row.category] : [];
      }
      for (const key of keys) {
        bump(
          key,
          row,
          {
            dated,
            // 沒有對應到委員的主提案（黨團提案、資料缺漏）歸在「黨團／其他」，
            // 這樣黨籍分布的總和永遠等於件數，前端畫堆疊長條不會少一塊
            party: row.lead_party ?? '黨團／其他',
            passed: row.status === '三讀',
            current,
            recent,
            previous,
            latest: true,
          },
        );
      }
    }
  }

  const shaped = [...items.values()]
    .map((entry) => ({ ...entry, delta: comparable ? entry.count - entry.previous_count : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));

  return {
    meta: envelope(db),
    vocab: resolvedVocab,
    vocabularies: Object.entries(TOPIC_VOCABULARIES).map(([id, v]) => ({ id, ...v })),
    window: { days: resolvedDays, from: from || null, to: anchor, recent_from: recentFrom, previous_from: comparable ? previousFrom : null },
    comparable,
    data_from: earliest || null,
    data_to: anchor,
    distinct: shaped.length,
    count: Math.min(shaped.length, resolvedLimit),
    items: shaped.slice(0, resolvedLimit),
  };
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
/** 總覽縣市卡片用：人口、老年人口比率、2024 總統與 2022 縣市長勝選者；不分區、原住民為 null */
function countySummary(region) {
  const c = loadCountyStats().counties.find((x) => x.county === region);
  if (!c) return null;
  // 每一個欄位都可能是缺的（未來新增／改制的行政區、或來源少一場選舉）：
  // 少一個就讓整個 /regions 500 會連總覽頁都打不開，所以一律回 null。
  const winner = (e) => (e?.candidates?.length ? { name: e.candidates[0].name, party: e.candidates[0].party, pct: e.candidates[0].pct, margin_pct: e.margin_pct ?? null } : null);
  return {
    population: c.population ?? null,
    elderly_ratio: c.population ? Math.round((c.elderly / c.population) * 10000) / 100 : null,
    president_2024: winner(c.elections?.president_2024),
    mayor_2022: winner(c.elections?.mayor_2022),
  };
}

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
    .map((r) => ({
      ...r,
      latest: r.latest.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, resolvedPer),
      stats: countySummary(r.region),
    }));
  return { meta: envelope(db), count: items.length, items };
}

/** 縣市分頁：靜態的人口／選舉／地圖資料（scripts/build-county-stats.mjs 產生），加上各縣市在職區域立委 */
let countyStats = null;
const loadCountyStats = () => (countyStats ??= JSON.parse(readFileSync(new URL('./county-stats.json', import.meta.url), 'utf8')));

/** 議員分頁：直轄市議員選舉結果（scripts/build-council-stats.mjs 產生） */
let councilStats = null;
const loadCouncilStats = () => (councilStats ??= JSON.parse(readFileSync(new URL('./council-stats.json', import.meta.url), 'utf8')));

/** 議員 Facebook 粉專（scripts/build-council-facebook.mjs 產生）：只對最新一屆的當選人 */
let councilFacebook = null;
const loadCouncilFacebook = () => (councilFacebook ??= JSON.parse(readFileSync(new URL('./council-facebook.json', import.meta.url), 'utf8')));

/** 網址上的縣市名：去空白、臺／台統一；空字串視為沒指定 */
function fixCountyName(county) {
  const name = String(county ?? '').trim().replace(/^台/, '臺');
  return name || null;
}

/**
 * 議員分頁：直轄市議員選舉結果（四年一次，不在每日同步流程內）。
 *
 * `county` 省略時用資料檔裡的第一個縣市；沒有建置的縣市回 null（由 API 層轉成 404），
 * 不要回一個空殼讓前端以為「這個縣市沒有議員」。
 */
export function listCouncil(db, { county } = {}) {
  const data = loadCouncilStats();
  const available = data.counties.map((c) => c.county);
  const wanted = fixCountyName(county) ?? available[0];
  const found = data.counties.find((c) => c.county === wanted);
  if (!found) return null;
  return {
    meta: envelope(db),
    source: data.source,
    note: data.note,
    county: found.county,
    // 前端要拿它做縣市切換，所以連「有哪些縣市」一起回
    counties: available,
    terms: found.terms.map((t, i) => (i === 0 ? withFacebook(found.county, t) : t)),
    warnings: data.warnings ?? [],
  };
}

/** 最新一屆當選人加上 `facebook`（粉專網址）與 `facebook_status`（現任狀態）；對照表沒有的人不加欄位 */
function withFacebook(county, term) {
  const { links } = loadCouncilFacebook();
  return {
    ...term,
    districts: term.districts.map((d) => ({
      ...d,
      list: d.list.map((c) => {
        const hit = c.elected && links[`${county}|${Number(d.no)}|${c.name}`];
        return hit ? { ...c, facebook: hit.url, facebook_status: hit.status } : c;
      }),
    })),
  };
}

/** 粉專對照表裡已經不在議會的狀態（轉任立委、病逝、解職／停權）：近期動態不列這些人 */
const COUNCIL_DEPARTED = /轉任|病逝|解職|停權/;

/**
 * 現任直轄市議員：最新一屆當選人（扣掉已離開議會的），加上粉專對照表裡的遞補／補選者（extra）。
 * id 是「縣市|選區號|姓名」，與粉專對照表的 key 相同。姓名含私用區字元（□）的不拿來比對新聞。
 */
let currentCouncilorsCache = null;
export function currentCouncilors() {
  if (currentCouncilorsCache) return currentCouncilorsCache;
  const stats = loadCouncilStats();
  const { links = {}, extra = [], unmatched = [] } = loadCouncilFacebook();
  // 已被遞補的當選人：粉專對照表沒有他的列（unmatched），而同一選區列了遞補／補選的人（extra）。
  // 例：「新北市 第5選區 黃俊哲」沒有列、同區有「石一佑（現任（遞補））」→ 黃俊哲已不在議會
  const replacedDistricts = new Set(extra.filter((line) => /遞補|補選/.test(line)).map((line) => line.split(' ').slice(0, 2).join(' ')));
  const replaced = new Set(unmatched.filter((line) => replacedDistricts.has(line.split(' ').slice(0, 2).join(' '))));
  const out = [];
  for (const c of stats.counties) {
    const term = c.terms[0];
    for (const d of term.districts) {
      for (const p of d.list) {
        if (!p.elected) continue;
        const id = `${c.county}|${Number(d.no)}|${p.name}`;
        const hit = links[id];
        if (hit && COUNCIL_DEPARTED.test(hit.status)) continue;
        if (!hit && replaced.has(`${c.county} 第${Number(d.no)}選區 ${p.name}`)) continue;
        out.push({ id, name: p.name, county: c.county, district: d.name, party: p.party, facebook: hit?.url ?? null, status: hit?.status ?? null });
      }
    }
  }
  // 例：「新北市 第5選區 石一佑（現任（遞補））https://www.facebook.com/shihyiyou/」——中選會資料沒有遞補者，黨籍不明
  for (const line of extra) {
    const m = /^(\S+) 第(\d+)選區 (\S+?)（(.+)）(https?:\/\/\S+)$/.exec(line);
    if (m && !out.some((x) => x.id === `${m[1]}|${m[2]}|${m[3]}`)) {
      out.push({ id: `${m[1]}|${m[2]}|${m[3]}`, name: m[3], county: m[1], district: `第${m[2]}選舉區`, party: '', facebook: m[5], status: m[4] });
    }
  }
  return (currentCouncilorsCache = out);
}

/**
 * 光看姓名分不出是不是議員的名字：和縣市長（2022 當選人）、在職立委、部會首長同名的。
 * 這些名字（以及兩個字的名字）標題要有「議員」等線索才算（議員近期動態與每日議員新聞查詢共用）。
 */
export function ambiguousCouncilorNames(db) {
  return new Set([
    ...loadCountyStats().counties.map((c) => c.elections?.mayor_2022?.candidates?.[0]?.name).filter(Boolean),
    ...db.prepare('SELECT name FROM legislators WHERE leave_flag = 0').all().map((l) => newsName(l.name)),
    ...OFFICIALS.map((o) => o.name),
  ]);
}

/**
 * 全部新聞裡提到現任議員的報導（議員近期動態與全部新聞的「議員」類別共用）。規則見 listCouncilActivity 上方說明；
 * 每日同步／回補對議員查的 Google 新聞（topic 'councilor:<id>'）直接算在該議員名下。
 * 結果掛在全部新聞的快取上（entry.councilGroups 陣列＋entry.councilByGroup 對照），資料沒變就不重算。
 */
function ensureCouncilGroups(db, entry) {
  if (entry.councilGroups) return entry;
  const all = currentCouncilors();
  const byName = new Map();
  for (const c of all) if (!c.name.includes('□')) (byName.get(c.name) ?? byName.set(c.name, []).get(c.name)).push(c);
  const re = new RegExp([...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
  const ambiguous = ambiguousCouncilorNames(db);
  const byId = new Map(all.map((c) => [c.id, c]));
  entry.councilGroups = [];
  entry.councilByGroup = new Map();
  for (const g of entry.groups) {
    const names = new Set(
      [...g.title.matchAll(re)]
        .filter((m) => !OTHER_OFFICE_BEFORE.test(g.title.slice(0, m.index)))
        .map((m) => m[0])
        .filter((n) => (n.length > 2 && !ambiguous.has(n)) || g.title.includes('議員')),
    );
    const matched = new Map([...names].flatMap((n) => byName.get(n)).map((c) => [c.id, c]));
    for (const id of g.councilorIds ?? []) if (byId.has(id)) matched.set(id, byId.get(id));
    if (matched.size) {
      const councilors = [...matched.values()];
      entry.councilGroups.push({ group: g, councilors });
      entry.councilByGroup.set(g, councilors);
    }
  }
  return entry;
}

/**
 * 議員近期動態（議員頁「近期動態」）：全部新聞（allNewsGroups）裡，標題提到現任議員的報導。
 * 比對規則同委員新聞：標題含姓名；兩個字的名字另需標題含「議員」（沒有查詢條件把關，「黃仁」這種會撞到一般用語）。
 * 姓名前面緊接著別的職稱（「南投縣長許淑華」「立委某某」）不算；議員和縣市長、在職立委、部會首長同名時
 * （例如臺北市議員與南投縣長都叫許淑華），標題另需含「議員」才算——光看姓名分不出是誰。
 * 同名的議員（不同縣市）都會標上，選了縣市就只算那個縣市的。標記結果掛在全部新聞的快取上，資料沒變就不重算。
 */
const OTHER_OFFICE_BEFORE = /(縣長|市長|立委|委員|部長|院長|總統|主委|署長|局長|區長|鄉長|鎮長)$/;
/** 粉專牆沒給 limit 時只回最近更新的這幾位（需求：預設 5 位） */
export const SOCIAL_WALL_DEFAULT_LIMIT = 5;
const SOCIAL_WALL_MAX_LIMIT = 500;

/**
 * 委員粉專牆（`/api/v1/social/wall`）：把在職委員的 Facebook 粉專攤成一面牆。
 *
 * - 預設只回**最近更新**的前 5 位（依 `latest_post_date` 新到舊，沒有日期的排最後）；
 *   套了黨籍／縣市條件才把整個篩選結果展開（limit 由呼叫端決定，上限 500）。
 * - 兩組 facet 互相交叉：選了黨籍時縣市只列該黨真的有的人（反之亦然），
 *   否則會出現「點了變成空牆」的選項。
 * - 沒有粉專的委員不會出現（社群整理表沒有他的臉書網址），所以牆上的總數會小於委員總數。
 * - 這裡只讀整理表已經填好的日期，不猜、不補：抓不到貼文的委員就是沒有日期、排在最後。
 */
export function listSocialWall(db, { party = '', region = '', limit = SOCIAL_WALL_DEFAULT_LIMIT, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || SOCIAL_WALL_DEFAULT_LIMIT, SOCIAL_WALL_MAX_LIMIT));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const wantedParty = String(party ?? '').trim();
  const wantedRegion = String(region ?? '').trim();

  const all = db
    .prepare(
      `SELECT s.legislator_id, s.page_name, s.url, s.latest_post_date, s.latest_post_summary, s.source,
              l.name, l.party, l.area_name, l.photo_url
       FROM social_accounts s JOIN legislators l ON l.id = s.legislator_id
       WHERE s.platform = 'facebook' AND l.leave_flag = 0`,
    )
    .all()
    .map((row) => ({
      id: row.legislator_id,
      name: row.name,
      party: row.party ?? '',
      region: regionOf(row.area_name),
      area_name: row.area_name ?? '',
      photo_url: row.photo_url ?? null,
      page_name: row.page_name ?? '',
      url: row.url,
      latest_post_date: row.latest_post_date || null,
      latest_post_summary: row.latest_post_summary ?? '',
      source: row.source ?? 'sheet',
    }))
    // 新到舊；沒有日期的（整理表還沒抓到貼文）一律排最後
    .sort(
      (a, b) =>
        Number(Boolean(b.latest_post_date)) - Number(Boolean(a.latest_post_date)) ||
        String(b.latest_post_date ?? '').localeCompare(String(a.latest_post_date ?? '')) ||
        a.name.localeCompare(b.name, 'zh-Hant'),
    );

  const countBy = (rows, key) => {
    const counts = new Map();
    for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
  };
  const matched = all.filter((row) => (!wantedParty || row.party === wantedParty) && (!wantedRegion || row.region === wantedRegion));

  return {
    meta: envelope(db, { term: currentTerm(db), session: currentSession(db) }),
    count: Math.max(0, Math.min(resolvedLimit, matched.length - resolvedOffset)),
    total: matched.length,
    default_limit: SOCIAL_WALL_DEFAULT_LIMIT,
    party: wantedParty,
    region: wantedRegion,
    // 交叉 facet：各自排除自己那一維，只套用另一維
    parties: countBy(all.filter((row) => !wantedRegion || row.region === wantedRegion), 'party').sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')),
    regions: countBy(all.filter((row) => !wantedParty || row.party === wantedParty), 'region').sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')),
    // 整理表是人工／AI 維護的：過期時前端要標出來，否則舊日期看起來像最新
    social: socialFreshness(db),
    items: matched.slice(resolvedOffset, resolvedOffset + resolvedLimit),
  };
}

export function listCouncilActivity(db, { county = '', councilor = '', q = '', source = '', limit = 30, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const words = String(q ?? '').trim().split(/\s+/).filter(Boolean);
  // 議員臉書整理表（每日同步，見 runCouncilSocialIngest）：粉專網址以整理表為準，並附最新貼文；
  // 整理表把狀態改成轉任／病逝／解職的人不列為現任
  const sheet = new Map(db.prepare('SELECT * FROM council_social').all().map((r) => [r.councilor_id, r]));
  const all = currentCouncilors()
    .map((c) => {
      const s = sheet.get(c.id);
      return s ? { ...c, facebook: s.url, status: s.status ?? c.status, latest_post_date: s.latest_post_date || null, latest_post_summary: s.latest_post_summary || null } : { ...c, latest_post_date: null, latest_post_summary: null };
    })
    .filter((c) => !(c.status && COUNCIL_DEPARTED.test(c.status)));
  const active = new Set(all.map((c) => c.id));
  const counties = [...new Set(all.map((c) => c.county))];
  const wantedCounty = counties.includes(fixCountyName(county)) ? fixCountyName(county) : '';
  const entry = allNewsGroups(db);
  ensureCouncilGroups(db, entry);
  const inCounty = (c) => !wantedCounty || c.county === wantedCounty;
  const perCouncilor = new Map();
  const scoped = [];
  for (const { group, councilors } of entry.councilGroups) {
    const mine = councilors.filter((c) => active.has(c.id) && inCounty(c));
    if (!mine.length) continue;
    for (const c of mine) perCouncilor.set(c.id, (perCouncilor.get(c.id) ?? 0) + 1);
    scoped.push({ group, councilors: mine });
  }
  const searched = scoped.filter(({ group, councilors }) => (!councilor || councilors.some((c) => c.id === councilor)) && words.every((w) => group.text.includes(w)));
  const counts = new Map();
  for (const { group } of searched) counts.set(group.source, (counts.get(group.source) ?? 0) + 1);
  const matching = source ? searched.filter(({ group }) => group.source === source) : searched;
  const brief = ({ id, name, county: c, district, party }) => ({ id, name, county: c, district, party });
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at'), news_outlets_fetched_at: getMeta(db, 'news_outlets_fetched_at') },
    counties,
    county: wantedCounty,
    // 議員名單（臉書欄與下拉選單用）：依新聞則數排序；不受關鍵字、議員、媒體條件影響
    councilors: all
      .filter(inCounty)
      .map((c) => ({ ...c, count: perCouncilor.get(c.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.county.localeCompare(b.county, 'zh-Hant') || a.district.localeCompare(b.district, 'zh-Hant', { numeric: true }) || a.name.localeCompare(b.name, 'zh-Hant')),
    total: matching.length,
    source_total: counts.size,
    sources: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, count]) => ({ name, count })),
    first_date: entry.first,
    last_date: entry.last,
    // 議員臉書整理表的新鮮度（沒有整理表時 as_of 為 null）
    social: socialFreshness(db, Date.now(), 'council_social'),
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit).map(({ group: { url, title, source: s, published_at }, councilors }) => ({ url, title, source: s, published_at, councilors: councilors.map(brief) })),
  };
}

/** 議員資料有建置哪些縣市（給 404 的訊息用，不必先解析成功） */
export function councilCounties() {
  try {
    return loadCouncilStats().counties.map((c) => c.county);
  } catch {
    return [];
  }
}

/**
 * 靜態資料的「資料截止」與筆數，給 `/health` 用。
 *
 * 為什麼需要：這五個檔案**不在同步流程內**（要手動重跑 build 腳本），所以
 * `/health` 的 `ok`／`stale` 完全看不到它們 —— 人口月報是每月更新、選舉資料是每幾年一次，
 * 忘了重跑就能讓畫面上的數字放很久而沒有任何訊號。
 * 頁面上雖然有寫「人口為 2026-08」，但那是使用者要自己看懂；這裡讓它變成可監控的欄位。
 */
/** 延後求值：這張表引用的 loader 都宣告在檔案後半，模組載入時還沒有值 */
const staticDatasetDefs = () => [
  { key: 'counties', label: '縣市人口與選舉指標', load: loadCountyStats, count: (d) => d.counties?.length ?? 0, asOf: (d) => d.population_month ?? null },
  { key: 'demographics', label: '鄉鎮市區人口結構與得票', load: loadDemographics, count: (d) => d.towns?.length ?? 0, asOf: (d) => d.population_month ?? null },
  // population-trend 的 years 最後一筆是「最新一期」（可能帶月份，例如 2026-08）
  { key: 'population_trend', label: '每月人口趨勢', load: loadPopulationTrend, count: (d) => d.months?.length ?? 0, asOf: (d) => d.years?.at(-1) ?? null },
  { key: 'town_map', label: '鄉鎮市區界圖資', load: loadTownMap, count: (d) => d.towns?.length ?? 0, asOf: (d) => d.built_at ?? null },
  { key: 'recalls', label: '立委罷免案', load: loadRecalls, count: (d) => d.recalls?.length ?? 0, asOf: (d) => (d.fetched_at ? String(d.fetched_at).slice(0, 7) : null) },
  { key: 'legislator_votes', label: '立委歷次得票', load: loadLegislatorVotes, count: (d) => d.races?.length ?? 0, asOf: (d) => (d.years?.length ? String(d.years.at(-1)) : null) },
  // 議員選舉四年一次，用「超過 3 個月沒更新」來判斷它過期沒有意義（當選日隔天就超過了）；
  // 只監控「讀不到／是空的」，資料截止日期照樣回報給畫面看。
  {
    key: 'council',
    label: '議員選舉結果',
    load: loadCouncilStats,
    // 筆數＝各縣市屆次加總（目前六都共 24 屆：桃園 2014 才升格、另有升格前的 2009 桃園縣議員）；資料截止取最新一屆的投票日
    count: (d) => d.counties?.reduce((sum, c) => sum + c.terms.length, 0) ?? 0,
    asOf: (d) => d.counties?.[0]?.terms?.[0]?.date ?? null,
    stale: false,
  },
];

/**
 * 靜態資料的「資料截止」與筆數，給 `/health` 用。
 *
 * 為什麼需要：這五個檔案**不在同步流程內**（要手動重跑 build 腳本），所以
 * `/health` 的 `ok`／`stale` 完全看不到它們 —— 人口月報是每月更新、選舉資料是每幾年一次，
 * 忘了重跑就能讓畫面上的數字放很久而沒有任何訊號。
 * 頁面上雖然有寫「人口為 2026-08」，但那是使用者要自己看懂；這裡讓它變成可監控的欄位。
 *
 * 逐檔 try/catch：靜態檔壞掉時 `/health` **不可以跟著 500** —— 那支端點正是發現檔案壞掉的
 * 唯一線索（給它 500 等於在需要它的時候壞掉）。壞掉的檔回 `error` 欄位，由呼叫端變成 warning。
 */
export function staticDataStatus(overrides = {}) {
  const out = {};
  for (const ds of staticDatasetDefs()) {
    try {
      // overrides 只有測試會用：用來餵壞掉的 loader，驗證這裡真的逐檔容錯
      const data = (overrides[ds.key] ?? ds.load)();
      const count = ds.count(data);
      // count 0 不設 error：那是「空的」而不是「壞掉的」，兩者在 warnings 要分開講
      out[ds.key] = { as_of: ds.asOf(data), count, label: ds.label, stale_check: ds.stale !== false };
    } catch (error) {
      // 不要在 /health 的回應裡帶出伺服器絕對路徑（ENOENT 的訊息就含路徑）
      const reason = error?.code === 'ENOENT' ? '檔案不存在' : String(error?.message || error).slice(0, 200);
      out[ds.key] = { as_of: null, count: 0, label: ds.label, error: reason, stale_check: ds.stale !== false };
    }
  }
  return out;
}

/** `2026-08` 這種「資料截止」字串離現在幾個月（無法解析時回 null） */
export function monthsSince(asOf, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})/.exec(String(asOf ?? ''));
  if (!m) return null;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  const target = new Date(now);
  const current = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1);
  return Math.max(0, Math.round((current - then) / (30 * 86_400_000)));
}

export function listCounties(db) {
  loadCountyStats();
  const legislators = new Map();
  for (const l of db.prepare('SELECT id, name, party, area_name FROM legislators WHERE leave_flag = 0 ORDER BY area_name, name').all()) {
    const region = regionOf(l.area_name);
    legislators.set(region, [...(legislators.get(region) ?? []), { id: l.id, name: l.name, party: l.party, area_name: l.area_name }]);
  }
  const { counties, ...rest } = countyStats;
  return {
    meta: envelope(db),
    ...rest,
    count: counties.length,
    items: counties.map((c) => ({ ...c, legislators: legislators.get(c.county) ?? [] })),
  };
}

let recalls = null;
/** 中選會官方罷免清單（scripts/fetch-cec-recalls.mjs 產生）；檔案不存在時視為沒有資料（不讓 /legislator-votes 跟著 500） */
const loadRecalls = () => {
  if (recalls) return recalls;
  try {
    recalls = JSON.parse(readFileSync(new URL('./recalls.json', import.meta.url), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    recalls = { source: null, fetched_at: null, recalls: [] };
  }
  return recalls;
};

/**
 * 立委得票追蹤：在職委員歷次（2012 起，含補選）區域／原住民立委選舉的得票（server/legislator-votes.json）。
 * `id` 指定單一委員（含已離職）。
 * 以姓名比對（族語名分隔符號一律去掉）；不分區委員若曾參選區域也會列出。
 * `margin`：當選者對最高票落選者的領先票數，落選者對最低票當選者的差距（負值）；`change`：與本人前一次參選的得票差。
 */
let legislatorVotes = null;
const loadLegislatorVotes = () => (legislatorVotes ??= JSON.parse(readFileSync(new URL('./legislator-votes.json', import.meta.url), 'utf8')));
const round2 = (n) => Math.round(n * 100) / 100;
/** 同選區同黨的得票與得票率，以及委員個人票與它的差（票數、百分點）；`over` > 0 表示個人票多於政黨票 */
function partyShare(bucket, c) {
  const votes = bucket && c.party !== '無黨籍' ? bucket.votes[c.party] : undefined;
  if (votes === undefined) return null;
  const pct = (votes / bucket.valid) * 100;
  return { votes, pct: round2(pct), over: c.votes - votes, over_pct: round2(c.pct - pct) };
}
/** 姓名 → 歷次參選（依年份排序，含與前次的得票差）；只建一次 */
let historyByName = null;
const nameKey = (name) => String(name).replace(/[\s‧·・．.]/g, '');
function raceHistory(name) {
  if (!historyByName) {
    loadLegislatorVotes();
    const byName = new Map();
    for (const race of legislatorVotes.races) {
      const elected = race.candidates.filter((c) => c.elected);
      const losers = race.candidates.filter((c) => !c.elected);
      race.candidates.forEach((c, i) => {
        const rival = c.elected ? losers[0] : elected[elected.length - 1];
        const entry = {
          year: race.year,
          kind: race.kind,
          district: race.district,
          by_election: Boolean(race.by_election),
          party: c.party,
          votes: c.votes,
          pct: c.pct,
          rank: i + 1,
          elected: c.elected,
          seats: elected.length,
          candidates: race.candidates.length,
          rival: rival ? { name: rival.name, party: rival.party, votes: rival.votes } : null,
          margin: rival ? c.votes - rival.votes : null,
          margin_pct: rival ? Math.round((c.pct - rival.pct) * 100) / 100 : null,
          // 個人票對照政黨票：同選區同黨的總統得票、不分區政黨票（只有大選的區域立委有；無黨籍不比）
          president: partyShare(race.party_votes?.president, c),
          party_list: partyShare(race.party_votes?.party_list, c),
        };
        byName.set(nameKey(c.name), [...(byName.get(nameKey(c.name)) ?? []), entry]);
      });
    }
    historyByName = new Map(
      [...byName].map(([k, list]) => {
        const sorted = list.sort((a, b) => a.year - b.year);
        return [k, sorted.map((h, i) => ({ ...h, change: i ? h.votes - sorted[i - 1].votes : null }))];
      }),
    );
  }
  return historyByName.get(nameKey(name)) ?? [];
}

/**
 * 名冊與比較頁用的選舉摘要：該屆（第 N 屆＝2024 − (11 − N) × 4 年大選，含屆內補選）最後一次當選的選舉。
 * 不分區委員、或對不到紀錄者為 null。
 */
export function electionSummary(name, term = 11) {
  const start = 2024 - (11 - Number(term)) * 4;
  const race = raceHistory(name).filter((h) => h.elected && h.year >= start && h.year < start + 4).at(-1);
  if (!race) return null;
  return {
    year: race.year,
    district: race.district,
    by_election: race.by_election,
    votes: race.votes,
    pct: race.pct,
    margin: race.margin,
    margin_pct: race.margin_pct,
    rival: race.rival,
    change: race.change,
    party_list_over_pct: race.party_list?.over_pct ?? null,
    president_over_pct: race.president?.over_pct ?? null,
  };
}

/**
 * 分裂投票：某年大選各立委選區的區域立委候選人得票，以及同選區的總統票與不分區政黨票（投開票所加總）。
 * 前端依政黨算三種得票率與差距。
 */
export function listSplitTicket(db, { year = null } = {}) {
  const source = loadLegislatorVotes();
  const years = source.years;
  // years 是「有大選的年份」（補選年不在內，因為補選沒有三票對照）。
  // 使用者若在網址上手打一個不存在的年份，以前會靜默回最後一屆的資料 ——
  // 現在仍然回最後一屆（不讓畫面變空），但回應會明講 requested_year 與 fell_back。
  const requested = year === null || year === '' || year === undefined ? null : Number(year);
  const fellBack = requested !== null && !years.includes(requested);
  const y = years.includes(requested) ? requested : years[years.length - 1];
  const items = source.races
    .filter((r) => r.year === y && r.kind === '區域' && !r.by_election && r.party_votes)
    .map((r) => ({
      county: r.county,
      district: r.district,
      valid: r.valid,
      candidates: r.candidates.map(({ name, party, votes, pct, elected }) => ({ name, party, votes, pct, elected })),
      president: r.party_votes.president,
      party_list: r.party_votes.party_list,
    }));
  return { meta: envelope(db), years, year: y, requested_year: requested, fell_back: fellBack, count: items.length, items };
}

/** 鄉鎮市區界 SVG path（server/town-map.json，與縣市圖同一座標系） */
let townMap = null;
const loadTownMap = () => (townMap ??= JSON.parse(readFileSync(new URL('./town-map.json', import.meta.url), 'utf8')));
export function getTownMap(db) {
  loadTownMap();
  return { meta: envelope(db), ...townMap, count: townMap.towns.length };
}

/** 人口趨勢：2016 起每月縣市人口、每年 12 月年齡結構、各鄉鎮每年人口（server/population-trend.json） */
let populationTrend = null;
const loadPopulationTrend = () => (populationTrend ??= JSON.parse(readFileSync(new URL('./population-trend.json', import.meta.url), 'utf8')));
export function listPopulationTrend(db) {
  loadPopulationTrend();
  return { meta: envelope(db), ...populationTrend };
}

/** 人口結構 × 得票：368 鄉鎮市區的年齡結構與 2020／2024 總統、不分區政黨票（server/demographics.json） */
let demographics = null;
const loadDemographics = () => (demographics ??= JSON.parse(readFileSync(new URL('./demographics.json', import.meta.url), 'utf8')));
export function listDemographics(db) {
  loadDemographics();
  return { meta: envelope(db), ...demographics, count: demographics.towns.length };
}

export function listLegislatorVotes(db, { id = null } = {}) {
  // 罷免紀錄以姓名比對（中選會的清單只有姓名）。同名風險與 raceHistory 相同：
  // 目前名冊沒有同名者，且有測試盯著；未來若出現同名者要改成用候選人 id。
  const recallByName = new Map();
  for (const r of loadRecalls().recalls) {
    recallByName.set(nameKey(r.name), [...(recallByName.get(nameKey(r.name)) ?? []), r]);
  }
  const items = db
    .prepare(`SELECT id, name, party, area_name FROM legislators WHERE ${id ? 'id = ?' : 'leave_flag = 0'} ORDER BY area_name, name`)
    .all(...(id ? [id] : []))
    .map((l) => ({
      legislator: { id: l.id, name: l.name, party: l.party, area_name: l.area_name, region: regionOf(l.area_name) },
      history: raceHistory(l.name),
      recalls: recallByName.get(nameKey(l.name)) ?? [],
    }));
  // 一定要自己初始化：raceHistory() 只在 items 非空時才會被呼叫，
  // 空名冊（全新安裝、首次同步還沒跑完）時 legislatorVotes 仍是 null → 這裡 TypeError 500，
  // 而且會不會爆取決於前端先打哪一支 API。
  const source = loadLegislatorVotes();
  const recallSource = loadRecalls();
  return {
    meta: envelope(db),
    years: source.years,
    sources: source.sources,
    // 罷免案件清單來自中選會選舉資料庫；票數另由官方公告／結果文件補入
    recalls: recallSource.recalls,
    recalls_source: { ...recallSource.source, fetched_at: recallSource.fetched_at },
    // 票數的官方文件出處（35 案都有）
    recalls_results_sources: recallSource.results_sources ?? [],
    recalls_results_updated_at: recallSource.results_updated_at ?? null,
    count: items.length,
    items,
  };
}

/**
 * 立委罷免案清單（中選會官方，2015 起 35 案，含 2025 兩波 31 案）。
 * 屆次、投票日、被罷免人、選區、結果，以及 `results`（官方公告／結果文件的同意／不同意票數）。
 */
export function listRecalls(db) {
  const source = loadRecalls();
  const recalls = [...source.recalls].sort((a, b) => String(b.vote_date).localeCompare(String(a.vote_date)) || a.name.localeCompare(b.name, 'zh-Hant'));
  return {
    meta: envelope(db),
    source: { ...source.source, fetched_at: source.fetched_at },
    count: recalls.length,
    passed: recalls.filter((r) => r.passed).length,
    // 有官方票數的案數（目前 35 案都有）
    with_results: recalls.filter((r) => r.results).length,
    results_sources: source.results_sources ?? [],
    results_updated_at: source.results_updated_at ?? null,
    terms: [...new Set(recalls.map((r) => r.term))].sort((a, b) => b - a),
    items: recalls,
  };
}

export function listNews(db, { legislator = null, limit = 10 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
  // total 必須用「跟 items 同一組 JOIN」算：news 會累積 180 天，而 legislators 每次同步整批重建，
  // 中間一定有對不到委員的孤兒新聞；用 COUNT(*) FROM news 會得到比實際可回傳數量還大的 total。
  const from = 'FROM news n JOIN legislators l ON l.id = n.legislator_id';
  const total = legislator
    ? Number(db.prepare(`SELECT COUNT(*) AS n ${from} WHERE n.legislator_id = ?`).get(legislator).n)
    : Number(db.prepare(`SELECT COUNT(*) AS n ${from}`).get().n);
  const select = `SELECT n.*, l.name AS legislator_name, l.party AS legislator_party ${from}`;
  const order = 'ORDER BY n.published_at DESC, n.url LIMIT ?';
  const rows = legislator
    ? db.prepare(`${select} WHERE n.legislator_id = ? ${order}`).all(legislator, resolvedLimit)
    : db.prepare(`${select} ${order}`).all(resolvedLimit);
  // 新聞來源分析：各媒體的報導則數（同一網址只算一次）與提到的委員黨籍（人次）；取前 12 家
  const sourceRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(n.source, ''), '未知') AS name, l.party, COUNT(*) AS mentions, COUNT(DISTINCT n.url) AS articles
       FROM news n JOIN legislators l ON l.id = n.legislator_id ${legislator ? 'WHERE n.legislator_id = ?' : ''} GROUP BY 1, 2`,
    )
    .all(...(legislator ? [legislator] : []));
  const articles = new Map(
    db
      .prepare(`SELECT COALESCE(NULLIF(source, ''), '未知') AS name, COUNT(DISTINCT url) AS n FROM news ${legislator ? 'WHERE legislator_id = ?' : ''} GROUP BY 1`)
      .all(...(legislator ? [legislator] : []))
      .map((r) => [r.name, Number(r.n)]),
  );
  const parties = new Map();
  for (const r of sourceRows) (parties.get(r.name) ?? parties.set(r.name, {}).get(r.name))[r.party] = Number(r.mentions);
  const sources = [...articles]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => ({ name, count, parties: parties.get(name) ?? {} }));
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at'), news_source: { name: CONFIG.news.name, url: 'https://news.google.com/' } },
    total,
    count: rows.length,
    sources,
    source_total: articles.size,
    items: rows.map((r) => ({ legislator_id: r.legislator_id, legislator_name: r.legislator_name, legislator_party: r.legislator_party, title: r.title, source: r.source, url: r.url, published_at: r.published_at })),
  };
}

/**
 * 新聞頁：同一篇報導（網址相同）合併成一列，附上提到的委員；可依關鍵字（標題）、媒體、委員篩選。
 * `scope=officials` 改看機關首長（server/officials.json）的新聞，`legislator` 此時是首長姓名，另回傳 `people`（依則數排序）。
 * 媒體統計在套用媒體條件「之前」算（同 listBills），選了某家後其他家的數字不會消失。
 * `recent_7d`：符合條件者中，現在起算近 7 天的則數（總覽統計卡用；同步停了就會往下掉，與頁首「資料截至」一起看）。
 */
export function listNewsArticles(db, { q = '', source = '', legislator = '', scope = 'legislators', kind = '', limit = 30, offset = 0, all: exportAll = false } = {}) {
  // all：CSV 匯出用，回傳全部符合的（不分頁）
  const resolvedLimit = exportAll ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(Number(limit) || 30, 100));
  const resolvedOffset = exportAll ? 0 : Math.max(0, Math.trunc(Number(offset) || 0));
  const keyword = String(q).trim();
  if (scope === 'all') {
    // 未知的類別當成「全部」，不要回空清單讓人以為沒有新聞
    const resolvedKind = kind === 'other' || NEWS_KINDS.includes(kind) ? kind : '';
    return listAllNewsArticles(db, { keyword, source, kind: resolvedKind, limit: resolvedLimit, offset: resolvedOffset });
  }
  if (scope === 'agencies') return listAgencyNewsArticles(db, { keyword, source, agency: String(legislator ?? ''), limit: resolvedLimit, offset: resolvedOffset });
  const officials = scope === 'officials';
  const people = officials
    ? new Map(OFFICIALS.map((o) => [o.name, { id: o.name, name: o.name, party: `${o.agency}${o.title}` }]))
    : new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, { id: l.id, name: l.name, party: l.party }]));
  const newsRows = officials
    ? db.prepare("SELECT substr(topic, 10) AS legislator_id, * FROM topic_news WHERE topic LIKE 'official:%' ORDER BY published_at DESC, url").all()
    : db.prepare('SELECT * FROM news ORDER BY published_at DESC, url').all();
  const byUrl = new Map();
  const perPerson = new Map();
  for (const r of newsRows) {
    perPerson.set(r.legislator_id, (perPerson.get(r.legislator_id) ?? 0) + 1);
    if (legislator && r.legislator_id !== legislator) continue;
    if (keyword && !r.title.includes(keyword)) continue;
    const a = byUrl.get(r.url) ?? byUrl.set(r.url, { url: r.url, title: r.title, source: r.source || '未知', published_at: r.published_at, legislators: [] }).get(r.url);
    if (people.has(r.legislator_id)) a.legislators.push(people.get(r.legislator_id));
  }
  const all = [...byUrl.values()];
  const counts = new Map();
  for (const a of all) counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
  const matching = source ? all.filter((a) => a.source === source) : all;
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at') },
    total: matching.length,
    recent_7d: matching.filter((a) => a.published_at >= new Date(Date.now() - 7 * 86400000).toISOString()).length,
    source_total: counts.size,
    people: officials ? [...people.values()].map((p) => ({ ...p, count: perPerson.get(p.id) ?? 0 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')) : undefined,
    sources: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, count]) => ({ name, count })),
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit),
  };
}

/** 全部新聞的類別：由「這則新聞被分派到哪裡」推出（news → 委員、topic_news 的 topic → 其餘） */
export const NEWS_KINDS = ['legislator', 'official', 'entity', 'dgbas', 'local_accounting', 'councilor'];
/**
 * 主計新聞（topic 'dgbas'）再依標題分兩類，規則同主計總處專頁（dgbasOf）：提到主計總處／主計長 → dgbas，
 * 縣市政府主計處 → local_accounting；只說「主計」的（主計局、泛稱）不歸類（沒有別的類別就是「其他」）。
 */
const kindOfTopic = (topic, title) => {
  if (topic.startsWith('official:')) return 'official';
  if (topic === 'entities') return 'entity';
  if (topic === 'dgbas') return DGBAS_RE.test(title) ? 'dgbas' : LOCAL_ACCOUNTING_RE.test(title) ? 'local_accounting' : null;
  return null;
};

/**
 * 全部新聞（新聞頁「全部新聞」）：原始新聞庫 articles（媒體 RSS 的每一則，不只提到委員／首長／機關的，
 * 加上 Google 新聞的結果），再併入 news／topic_news（articles 上線前抓的舊資料只在那兩張表）。
 * 不限期間（資料庫保存的都算，保存期限見 CONFIG.news.keepDays）。
 *
 * - 同一則報導可能有多個網址（Google 轉址、媒體原址），以「標題去掉空白」合併（同 db.mjs 的標題去重）。
 * - 類別（kinds）與提到的人（legislators）由 news／topic_news 推出；都沒有＝「其他」（只在原始新聞庫裡）。
 * - 關鍵字比對標題**與摘要**（摘要只用來搜尋、不回傳），空白分隔、全部符合才列出。
 * - `kind_counts` 在關鍵字之後、類別與媒體之前算；`sources` 在類別之後、媒體之前算（選了某家其他家不會消失）。
 */
/**
 * 合併後的全部新聞（未篩選）。10 萬則時讀表＋合併要 1 秒多，每次換頁、搜尋都重算太慢，
 * 所以依「三張表的筆數與最後抓取時間＋名錄筆數」快取；資料一變（同步寫入、過期刪除）版本就不同、自動重算。
 * 以 db 物件為鍵（WeakMap），測試裡各自的 in-memory DB 互不影響。
 */
const allNewsCache = new WeakMap();
function allNewsGroups(db) {
  const version = JSON.stringify(
    db
      .prepare(
        `SELECT (SELECT COUNT(*) || '|' || IFNULL(MAX(fetched_at), '') FROM articles) AS a,
                (SELECT COUNT(*) || '|' || IFNULL(MAX(fetched_at), '') FROM news) AS n,
                (SELECT COUNT(*) || '|' || IFNULL(MAX(fetched_at), '') FROM topic_news) AS t,
                (SELECT COUNT(*) FROM legislators) AS l`,
      )
      .get(),
  );
  const cached = allNewsCache.get(db);
  if (cached?.version === version) return cached;
  const legislators = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, { id: l.id, name: l.name, party: l.party, kind: 'legislator' }]));
  const officials = new Map(OFFICIALS.map((o) => [o.name, { id: o.name, name: o.name, party: `${o.agency}${o.title}`, kind: 'official' }]));
  const rows = [
    ...db.prepare('SELECT url, title, summary, source, published_at FROM articles').all(),
    ...db.prepare('SELECT legislator_id AS who, url, title, source, published_at FROM news').all().map((r) => ({ ...r, kind: 'legislator', person: legislators.get(r.who) })),
    ...db.prepare('SELECT topic, url, title, source, published_at FROM topic_news').all().map((r) => ({ ...r, kind: kindOfTopic(r.topic, r.title), person: r.topic.startsWith('official:') ? officials.get(r.topic.slice(9)) : undefined })),
  ];
  // 涵蓋期間算在任何篩選之前：它回答的是「資料庫裡有多久的新聞」，不是「搜尋結果落在哪段」
  let first = null;
  let last = null;
  const byTitle = new Map();
  for (const r of rows) {
    if (first === null || r.published_at < first) first = r.published_at;
    if (last === null || r.published_at > last) last = r.published_at;
    const key = r.title.replace(/[ \u3000\t]/g, '');
    let a = byTitle.get(key);
    if (!a) byTitle.set(key, (a = { url: r.url, title: r.title, source: r.source || '未知', published_at: r.published_at, kinds: [], legislators: [], text: r.title }));
    // 合併時保留第一筆的網址與媒體；第一筆沒有媒體名時才用後面的補
    if (a.source === '未知' && r.source) a.source = r.source;
    if (r.summary) a.text += `\n${r.summary}`;
    if (r.kind && !a.kinds.includes(r.kind)) a.kinds.push(r.kind);
    if (r.person && !a.legislators.some((p) => p.id === r.person.id)) a.legislators.push(r.person);
    if (r.topic?.startsWith('councilor:')) (a.councilorIds ??= []).push(r.topic.slice(10));
  }
  const groups = [...byTitle.values()].sort((a, b) => b.published_at.localeCompare(a.published_at) || a.url.localeCompare(b.url));
  const entry = { version, groups, first, last };
  allNewsCache.set(db, entry);
  return entry;
}

/**
 * 機關新聞（新聞頁「機關新聞」）：全部新聞裡，標題提到中央機關（fund-config 的 agencies，即「機關」頁的定義）的報導。
 * 每則附上提到的機關（agencies）；`agency` 只看某個機關；`people` 是有新聞的機關與則數（下拉選單用，不受篩選影響）。
 * 標記結果掛在全部新聞的快取上（allNewsGroups），資料沒變就不重算。
 */
function listAgencyNewsArticles(db, { keyword, source, agency, limit, offset }) {
  const words = keyword.split(/\s+/).filter(Boolean);
  const entry = allNewsGroups(db);
  if (!entry.agencyGroups) {
    const tagger = makeTagger([]);
    entry.agencyGroups = [];
    for (const g of entry.groups) {
      const agencies = tagger(g.title).agency;
      if (agencies.length) entry.agencyGroups.push({ group: g, agencies });
    }
  }
  const perAgency = new Map();
  for (const { agencies } of entry.agencyGroups) for (const a of agencies) perAgency.set(a, (perAgency.get(a) ?? 0) + 1);
  const all = entry.agencyGroups.filter(({ group, agencies }) => (!agency || agencies.includes(agency)) && words.every((w) => group.text.includes(w)));
  const counts = new Map();
  for (const { group } of all) counts.set(group.source, (counts.get(group.source) ?? 0) + 1);
  const matching = source ? all.filter(({ group }) => group.source === source) : all;
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at'), news_outlets_fetched_at: getMeta(db, 'news_outlets_fetched_at') },
    total: matching.length,
    recent_7d: matching.filter(({ group }) => group.published_at >= new Date(Date.now() - 7 * 86400000).toISOString()).length,
    source_total: counts.size,
    first_date: entry.first,
    last_date: entry.last,
    people: [...perAgency].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant')).map(([name, count]) => ({ id: name, name, party: '機關', count })),
    sources: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, count]) => ({ name, count })),
    items: matching.slice(offset, offset + limit).map(({ group: { text: _text, councilorIds: _ids, ...item }, agencies }) => ({ ...item, agencies })),
  };
}

function listAllNewsArticles(db, { keyword, source, kind, limit, offset }) {
  const words = keyword.split(/\s+/).filter(Boolean);
  const entry = ensureCouncilGroups(db, allNewsGroups(db));
  const { first, last } = entry;
  // 議員類別：提到現任議員的（標記結果在快取上，不改快取裡的 kinds，每次查詢另外組）
  const groups = entry.groups.map((g) => (entry.councilByGroup.has(g) ? { ...g, kinds: [...g.kinds, 'councilor'], councilors: entry.councilByGroup.get(g) } : g));
  const searched = words.length ? groups.filter((a) => words.every((w) => a.text.includes(w))) : groups;
  const kindCounts = { all: searched.length, other: 0, ...Object.fromEntries(NEWS_KINDS.map((k) => [k, 0])) };
  for (const a of searched) {
    if (!a.kinds.length) kindCounts.other += 1;
    for (const k of a.kinds) kindCounts[k] += 1;
  }
  const ofKind = !kind ? searched : kind === 'other' ? searched.filter((a) => !a.kinds.length) : searched.filter((a) => a.kinds.includes(kind));
  const all = ofKind; // groups 已依時間新→舊排好
  const counts = new Map();
  for (const a of all) counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
  const matching = source ? all.filter((a) => a.source === source) : all;
  return {
    meta: { ...envelope(db), news_fetched_at: getMeta(db, 'news_fetched_at'), news_outlets_fetched_at: getMeta(db, 'news_outlets_fetched_at') },
    total: matching.length,
    recent_7d: matching.filter((a) => a.published_at >= new Date(Date.now() - 7 * 86400000).toISOString()).length,
    source_total: counts.size,
    // 資料庫裡最早／最新一則的發布時間，畫面上要講清楚「所有期間」實際涵蓋到哪裡（不受篩選條件影響）
    first_date: first,
    last_date: last,
    kind_counts: kindCounts,
    sources: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([name, count]) => ({ name, count })),
    // 摘要只拿來搜尋，不回傳（text 是內部用的搜尋字串）
    items: matching.slice(offset, offset + limit).map(({ text: _text, councilorIds: _ids, councilors, ...item }) => ({
      ...item,
      ...(councilors ? { councilors: councilors.map(({ id, name, county, district, party }) => ({ id, name, county, district, party })) } : {}),
    })),
  };
}

/**
 * 預算類議案的審議狀態。**由 g0v 的議案狀態字串歸類**，畫面上要把定義寫出來（不能只給數字）。
 *
 * 分成五級而不是原來的三級（審議中／已結案／退回）：舊分類把「交付查照」這種**函件處理**
 * 也當成「已結案」，但立法院的預算議案裡這種函件是最大宗（實測 6,104 筆 vs 真的審查完畢 2,017 筆），
 * 混在一起會讓人以為「大部分都審完了」。
 *
 *   reviewed   已審竣：審查完畢（含逾審查期限）／三讀／視同審議通過
 *   in_review  審議中：已交付審查或協商、復議、排入院會（討論事項）
 *   pending    待審查：已排入院會但還沒進審查程序
 *   letter     函件處理：交付查照／函復機關／復請查照（不經審查，不算審竣也不算待審查）
 *   returned   退回：退回程序委員會
 *
 * 認不得的狀態一律算 pending（保守：不謊稱審竣）。
 */
const BUDGET_TYPES = ['general', 'subsidiary', 'special', 'supplementary'];
const BUDGET_STATE = new Map([
  ...['審查完畢', '審查完畢(逾審查期限)', '審查完畢(三讀)', '三讀', '三讀 (//通過)', '視同審議通過'].map((s) => [s, 'reviewed']),
  ...['交付審查', '交付處理', '交付協商', '復議', '排入院會(討論事項)'].map((s) => [s, 'in_review']),
  ...['排入院會', '中央政府總預算流程'].map((s) => [s, 'pending']),
  ...['交付查照', '函復機關', '復請查照'].map((s) => [s, 'letter']),
  ['退回程序委員會', 'returned'],
]);
export const BUDGET_STATES = ['reviewed', 'in_review', 'pending', 'letter', 'returned'];
export const budgetState = (status) => BUDGET_STATE.get(status) ?? 'pending';

/**
 * 多筆議案紀錄合成「一個案子」時的彙總狀態。
 *
 * 為什麼要合併：同一個預算案會有多筆議案紀錄（實測「115年度中央政府總預算案」有 **24 筆**——
 * 那是同一個預算案分別交付到不同委員會、不同會期審查的紀錄），清單上看起來就是同一行重複十幾次。
 *
 * 規則：全部都是函件處理 → 函件處理；需要審查的紀錄全部已審竣 → 已審竣；
 * 否則取其餘紀錄裡最「進行中」的狀態（審議中 > 待審查 > 退回）。
 */
export const budgetUnitState = (states) => {
  const reviewable = (states.reviewed ?? 0) + (states.in_review ?? 0) + (states.pending ?? 0) + (states.returned ?? 0);
  if (reviewable === 0) return 'letter';
  if (reviewable === (states.reviewed ?? 0)) return 'reviewed';
  if (states.in_review) return 'in_review';
  if (states.pending) return 'pending';
  return 'returned';
};

/** 進度排序（取代表紀錄用）：越前面越「有進展」 */
const BUDGET_STATE_RANK = { reviewed: 4, in_review: 3, pending: 2, letter: 1, returned: 0 };

/**
 * 一案一列：依（類別＋名稱）合併議案紀錄。
 * 代表紀錄取最有進展的（同狀態再比最新進度日期、議案編號），日期取全部紀錄的最新。
 */
export const mergeBudgetUnits = (list) => {
  const map = new Map();
  for (const r of list) {
    const state = budgetState(r.status);
    const key = `${r.category}\u0000${r.name}`;
    const hit = map.get(key);
    if (!hit) {
      map.set(key, { ...r, state, records: 1, states: { [state]: 1 }, ids: [r.id] });
      continue;
    }
    hit.records += 1;
    hit.states[state] = (hit.states[state] ?? 0) + 1;
    if (!hit.ids) hit.ids = [hit.id];
    hit.ids.push(r.id);
    if (String(r.latest_date ?? '') > String(hit.latest_date ?? '')) hit.latest_date = r.latest_date;
    const better =
      BUDGET_STATE_RANK[state] > BUDGET_STATE_RANK[hit.state] ||
      (BUDGET_STATE_RANK[state] === BUDGET_STATE_RANK[hit.state] && String(r.id) > String(hit.id));
    if (better) Object.assign(hit, { id: r.id, status: r.status, state, session: r.session, url: r.url, proposer: r.proposer });
    hit.state = budgetUnitState(hit.states);
  }
  return [...map.values()];
};

/** 一組預算議案的審議進度統計：總件數／已審竣／審議中／待審查／函件／退回，另給「尚未審竣」 */
export const budgetProgress = (list) => {
  const out = { total: list.length, reviewed: 0, in_review: 0, pending: 0, letter: 0, returned: 0, awaiting: 0 };
  // 合併後的單位自己帶 `state`（彙總狀態）；沒有的就用議案狀態推
  for (const r of list) out[r.state ?? budgetState(r.status)] += 1;
  out.awaiting = out.in_review + out.pending + out.returned;
  return out;
};

/**
 * 預算議案排序：主要以「最新進度日期」降冪，但**沒有日期的不可以一律塞到最後**。
 *
 * 實測（2026-10-06）：本會期（11-6）的預算議案在 g0v 上游的「議案流程」裡日期是空陣列
 * （199 筆全部沒有日期，包含「115年度中央政府總預算追加預算案」這種當前最重要的案子）。
 * 若只寫 `ORDER BY latest_date DESC`，空字串會排最後 ⇒ 最新會期的案子全部沉到最下面、
 * 日期還留白，畫面看起來就像「沒有依時間排序」。
 *
 * 規則：
 *   - 有日期 → 用日期。
 *   - 沒日期且屬於最新會期（或更後面）→ 當成最新（排最前面）。這種是「剛送進來、還沒有人會
 *     或委員會的進度」，對看預算的人來說正是最需要知道的。
 *   - 沒日期且是舊會期 → 排最後（上游缺資料，不是新的）。
 * 同一個排序鍵再依 會期、預算年度、議案編號 降冪，讓畫面穩定可重現。
 */
/** 沒有日期但屬最新會期的案子要排在最前面（比任何有日期的案子都新）用的哨兵值 */
const NEWEST_DATE = '9999-12-31';

/** 有效排序日期：有日期用日期；沒日期但屬最新會期 → 當最新；沒日期又是舊會期 → 排最後 */
export function effectiveSortDate(date, session, latestSession) {
  if (date) return date;
  return Number(session) >= latestSession ? NEWEST_DATE : '';
}

export function budgetBillsByProgress(db) {
  const rows = db.prepare('SELECT * FROM budget_bills').all();
  const latestSession = rows.reduce((max, r) => Math.max(max, Number(r.session) || 0), 0);
  const key = (r) => effectiveSortDate(r.latest_date, r.session, latestSession);
  return rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    if (Number(a.session) !== Number(b.session)) return Number(b.session) - Number(a.session);
    const ya = Number(a.fiscal_year) || 0;
    const yb = Number(b.fiscal_year) || 0;
    if (ya !== yb) return yb - ya;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * 預算審議：`category`、`q`（名稱或提案單位關鍵字）、`year`（預算年度）、`proposer`、`state`、分頁。
 * 統計依序在套用各自條件「之前」算（同 listBills 的 L8），選了某機關後機關清單不會只剩一個。
 */
export function listBudget(
  db,
  { category = '', type = '', q = '', year = '', proposer = '', state = '', limit = 30, offset = 0, all = false, groupBy = '', perGroup = 5, scope: scopeArg = 'bills', merge = 'name' } = {},
) {
  const resolvedLimit = all ? Infinity : Math.max(1, Math.min(Number(limit) || 30, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  // 「議案本身」的類別（中央政府總預算案、法人預(決)算案）；其餘是決議案／定期報告（回覆決議的函件）
  const billCats = new Set(CONFIG.budget.billCategories ?? []);
  const isBill = (r) => billCats.has(r.category);
  const allRows = budgetBillsByProgress(db).map((r) => ({ ...r, types: budgetTypes(r.name, { billCategory: isBill(r) }) }));
  /**
   * 統計範圍：`bills`（預設）只算**預算案本身**，`all` 連決議案／定期報告一起算。
   *
   * 為什麼要分：報告類（實測 10,801 件「函送…補（捐）助經費彙總表／執行情形報告，請查照案」）
   * 在 g0v 的議案狀態常常是「交付審查」，照狀態分類就會變成「審議中」，
   * 於是 114 年度顯示「已審竣 1,371／尚未審竣 1,100」，但**真正的預算案只有 74／67 件**。
   * 這些報告的審查進度另外看得到（切到 `all`），兩組數字不互相混。
   *
   * 注意：**類別件數（categories）不受範圍影響**——那是導覽用的，
   * 「決議書面報告 10,801」要一直看得到，否則使用者找不到那些報告。
   */
  const scope = scopeArg === 'all' ? 'all' : 'bills';
  // 一案一列（預設）：同一案名的多筆議案紀錄合成一列，見 mergeBudgetUnits
  const mergeUnits = merge === 'none' ? false : true;
  const allUnits = mergeUnits ? mergeBudgetUnits(allRows) : allRows;
  const rows = scope === 'bills' ? allUnits.filter(isBill) : allUnits;
  const recordsInScope = (scope === 'bills' ? allRows.filter(isBill) : allRows).length;
  const count = (list, key) => {
    const m = new Map();
    for (const r of list) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };
  const ranked = (map, n) => [...map].filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, n2]) => ({ name: String(name), count: n2 }));

  const categories = count(allUnits, (r) => r.category);
  const needle = String(q ?? '').trim();
  const base = rows.filter(
    (r) => (!category || r.category === category) && (!needle || r.name.includes(needle) || String(r.proposer ?? '').includes(needle)),
  );
  const typeCounts = Object.fromEntries(BUDGET_TYPES.map((t) => [t, base.filter((r) => r.types.includes(t)).length]));
  const byType = BUDGET_TYPES.includes(type) ? base.filter((r) => r.types.includes(type)) : base;
  // 年度：`unknown` 代表上游沒給年度（實測 1,565 筆，多半是決議函），要看得見而不是被藏起來
  const yearKey = (r) => (r.fiscal_year === null || r.fiscal_year === undefined || r.fiscal_year === '' ? 'unknown' : String(r.fiscal_year));
  const byYearOrder = (a, b) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : Number(b) - Number(a));
  const yearKeys = [...new Set(byType.map(yearKey))].sort(byYearOrder);
  const years = yearKeys.map((name) => {
    const list = byType.filter((r) => yearKey(r) === name);
    return { name, count: list.length, progress: budgetProgress(list) };
  });
  const byYear = year ? byType.filter((r) => yearKey(r) === String(year)) : byType;
  const proposers = count(byYear, (r) => r.proposer);
  const byProposer = proposer ? byYear.filter((r) => r.proposer === proposer) : byYear;
  /**
   * 同一組篩選條件（類別／關鍵字／類型／年度／機關／狀態）套到任一組資料上。
   * 給開關的數字用：兩個範圍的件數都要是**目前篩選下**的數字，否則切換鈕上的數字跟清單對不起來
   * （例如只篩 115 年度時，鈕上寫「含報告類 11,292」但清單只有 367 件）。
   */
  const applyFilters = (list) => {
    const baseList = list.filter(
      (r) => (!category || r.category === category) && (!needle || r.name.includes(needle) || String(r.proposer ?? '').includes(needle)),
    );
    const typed = BUDGET_TYPES.includes(type) ? baseList.filter((r) => r.types.includes(type)) : baseList;
    const dated = year ? typed.filter((r) => yearKey(r) === String(year)) : typed;
    const byAgency = proposer ? dated.filter((r) => r.proposer === proposer) : dated;
    return state ? byAgency.filter((r) => (r.state ?? budgetState(r.status)) === state) : byAgency;
  };
  const matching = applyFilters(rows);
  const billsMatching = applyFilters(allUnits.filter(isBill));
  const allMatching = applyFilters(allUnits);
  const sumRecords = (list) => list.reduce((n, r) => n + (r.records ?? 1), 0);
  const resolvedPerGroup = Math.max(1, Math.min(Number(perGroup) || 5, 50));
  // 委員會存在另一張表（同步會重寫 budget_bills），讀取時套用；合併的列取成員紀錄的聯集
  const committeeMap = getBudgetCommittees(db);
  const committeesOfUnit = (unit) => {
    const ids = unit.ids ?? [unit.id];
    const out = [];
    for (const id of ids) {
      for (const name of committeeMap.get(id)?.committees ?? []) if (!out.includes(name)) out.push(name);
    }
    return out;
  };

  const itemOf = (r) => ({
    id: r.id,
    category: r.category,
    types: r.types,
    name: r.name,
    status: r.status,
    state: r.state ?? budgetState(r.status),
    /** 合併了幾筆議案紀錄（一案一列時才有意義） */
    records: r.records ?? 1,
    /** 各狀態各有幾筆紀錄（前端顯示「9 筆已審查完畢、13 筆交付審查」用） */
    record_states: r.states ?? { [r.state ?? budgetState(r.status)]: 1 },
    proposer: r.proposer,
    fiscal_year: r.fiscal_year,
    session: r.session,
    latest_date: r.latest_date,
    url: r.url,
    /** 交付哪個委員會（逐筆抓 /bill/{id}，見 runBudgetCommittees）；合併的列是聯集 */
    committees: committeesOfUnit(r),
  });
  // `group_by=year`：分年度呈現用。每一組給統計與前幾筆（其餘用「看這一年全部」帶 year 條件再查）
  const groups =
    groupBy === 'year'
      ? yearKeys
          .map((name) => {
            const list = matching.filter((r) => yearKey(r) === name);
            return { name, total: list.length, progress: budgetProgress(list), items: list.slice(0, resolvedPerGroup).map(itemOf) };
          })
          .filter((group) => group.total > 0)
      : [];

  return {
    meta: { ...envelope(db), budget_fetched_at: getMeta(db, 'budget_fetched_at'), source: { name: CONFIG.bills.name, url: CONFIG.bills.homepage } },
    // 統計範圍與說明（前端要做開關與提示）
    scope,
    scope_note:
      scope === 'bills'
        ? '統計只算預算案本身（總預算案、法人預決算案）；決議書面報告等報告類另計'
        : '統計含決議案／定期報告（函送…請查照案的報告）',
    all_scope_total: mergeUnits ? allMatching.length : sumRecords(allMatching),
    bills_scope_total: mergeUnits ? billsMatching.length : sumRecords(billsMatching),
    // 一案一列 vs 每筆議案（前端做開關用）：數字是**目前篩選下**的，切換鈕才跟清單一致
    merge: mergeUnits ? 'name' : null,
    // 兩種模式下都要給「合併後會是幾件」，否則切到每筆議案時一案一列那顆鈕會顯示 0
    merged_total: mergeUnits ? matching.length : new Set(matching.map((r) => `${r.category}\u0000${r.name}`)).size,
    records_total: sumRecords(matching),
    // 兩個範圍在目前篩選下各有幾件（單位／紀錄），給「只算預算案／含報告類」開關
    scope_totals: {
      bills: mergeUnits ? billsMatching.length : sumRecords(billsMatching),
      all: mergeUnits ? allMatching.length : sumRecords(allMatching),
    },
    total: matching.length,
    count: Math.min(resolvedLimit, Math.max(0, matching.length - resolvedOffset)),
    // is_bills：這一類是不是「議案本身」（前端點到報告類的類別時要自動把範圍切到 all，不然會是空的）
    categories: CONFIG.budget.categories.map((name) => ({ name, count: categories.get(name) ?? 0, is_bills: billCats.has(name) })),
    years,
    proposers: ranked(proposers, 15),
    // 審議進度統計：總件數／已審竣／審議中／待審查／函件／退回（見 budgetProgress 的定義）
    progress: budgetProgress(matching),
    types: typeCounts,
    group_by: groupBy === 'year' ? 'year' : null,
    per_group: resolvedPerGroup,
    groups,
    items: matching.slice(resolvedOffset, resolvedOffset + resolvedLimit).map(itemOf),
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
const OFFICIALS = JSON.parse(readFileSync(new URL('./officials.json', import.meta.url), 'utf8')).officials;
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

/**
 * 新聞同步用的搜尋詞：基金／機關／行政法人各一個（有簡稱取最短的簡稱，如「台電」），順序固定。
 * 簡稱已在 fund-config 挑過不會誤判的；標題比對仍交給 makeTagger，所以全名與簡稱都認得。
 */
export function entityNewsTerms() {
  const shortest = new Map();
  for (const n of [...FUND_CONFIG.names, ...FUND_CONFIG.agencies, ...FUND_CONFIG.administrative]) shortest.set(n, n);
  for (const [alias, canonical] of Object.entries(FUND_CONFIG.aliases)) {
    if (shortest.has(canonical) && alias.length < shortest.get(canonical).length) shortest.set(canonical, alias);
  }
  return [...new Set(shortest.values())];
}

/** 標題是否提到具名的基金／機關／行政法人（不算泛稱的「其他基金／其他基金會」） */
export function mentionsKnownEntity(tagger, title) {
  const t = tagger(title);
  return [...t.fund, ...t.agency, ...t.administrative].some((n) => n !== OTHER_FUND);
}

const FUND_KINDS = ['news', 'post', 'bill', 'budget', 'report'];

/**
 * 主計總處專頁（`type=dgbas`）：預算類議案的提案機關是主計總處 →「主計總處提送」；標題提到 →「提及主計總處」；
 * 只說「主計」的另外標示：縣市政府主計處 →「地方主計處」，其餘（主計局、泛稱主計）→「僅提及主計」。
 */
const DGBAS_RE = /主計總處|主計長/;
const LOCAL_ACCOUNTING_RE = /[縣市](政府)?主計處/;
const dgbasOf = (r) => [
  ...(r.kind === 'budget' && DGBAS_RE.test(r.source ?? '') ? ['主計總處提送'] : []),
  ...(DGBAS_RE.test(r.title) ? ['提及主計總處'] : LOCAL_ACCOUNTING_RE.test(r.title) ? ['地方主計處'] : r.title.includes('主計') ? ['僅提及主計'] : []),
];

/**
 * 基金／機關／財團法人／行政法人頁與「我的機關」共用：把新聞、臉書、提案、預算審議、預算中心報告攤成同一種資料列。
 * `type === 'dgbas'` 另收不限委員的主計總處新聞；基金／機關新聞（topic_news 'entities'）所有類別都收。
 */
function collectFundRows(db, resolvedType) {
  const budgetRows = db.prepare('SELECT * FROM budget_bills').all();
  const billRows = db.prepare('SELECT * FROM bills').all();
  // 上游對本會期的議案常常沒有日期；沒有日期不代表最舊（見 effectiveSortDate）
  const latestSession = [...budgetRows, ...billRows].reduce((max, r) => Math.max(max, Number(r.session) || 0), 0);
  const people = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, { id: l.id, name: l.name, party: l.party }]));
  const lead = new Map(db.prepare('SELECT bill_id, legislator_id FROM bill_sponsors WHERE is_lead = 1').all().map((r) => [r.bill_id, people.get(r.legislator_id)]));
  const rows = [
    ...db.prepare('SELECT * FROM news').all().map((r) => ({ kind: 'news', date: r.published_at.slice(0, 10), title: r.title, url: r.url, source: r.source, legislator: people.get(r.legislator_id) })),
    // 主計總處專頁另收不限委員的主計總處新聞（ingest 的 topic_news）
    ...(resolvedType === 'dgbas'
      ? db.prepare("SELECT * FROM topic_news WHERE topic = 'dgbas'").all().map((r) => ({ kind: 'news', date: r.published_at.slice(0, 10), title: r.title, url: r.url, source: r.source }))
      : []),
    // 基金／機關／行政法人自己的新聞（ingest 的 topic_news 'entities'，不限委員）：與機關首長新聞同樣是專屬查詢，新舊才一致
    ...db.prepare("SELECT * FROM topic_news WHERE topic = 'entities'").all().map((r) => ({ kind: 'news', date: r.published_at.slice(0, 10), title: r.title, url: r.url, source: r.source })),
    ...db
      .prepare("SELECT * FROM social_accounts WHERE latest_post_summary <> ''")
      .all()
      .map((r) => ({ kind: 'post', date: r.latest_post_date, title: r.latest_post_summary, url: r.url, legislator: people.get(r.legislator_id) })),
    ...billRows.map((r) => ({ kind: 'bill', date: r.latest_date, sort_date: effectiveSortDate(r.latest_date, r.session, latestSession), title: r.name, url: r.url, status: r.status, legislator: lead.get(r.id) })),
    ...budgetRows.map((r) => ({ kind: 'budget', date: r.latest_date, sort_date: effectiveSortDate(r.latest_date, r.session, latestSession), title: r.name, url: r.url, status: r.status, source: r.proposer })),
    ...db.prepare('SELECT * FROM budget_reports').all().map((r) => ({ kind: 'report', date: r.completed, title: r.title, url: r.url, source: r.type })),
  ];
  return rows;
}

/**
 * 總覽各來源（新聞、臉書、委員提案、預算審議、預算中心報告）中與某一類（`type`：fund／agency／foundation／administrative）相關的項目，依日期新→舊。
 * `fund` 精確篩選該類的名稱、`kind` 篩選來源；統計依序在各自條件之前算（同 listBudget）。
 * ponytail: 每次請求全表掃描約 2 萬列＋一個正規式（實測數十毫秒）；變慢再在同步時預先標記。
 */
export function listFunds(db, { type = 'fund', fund = '', kind = '', limit = 30, offset = 0 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const resolvedType = ENTITY_TYPES.includes(type) || type === 'dgbas' ? type : 'fund';
  const rows = collectFundRows(db, resolvedType);
  const tag = resolvedType === 'dgbas' ? dgbasOf : ((t) => (r) => t(r.title)[resolvedType])(makeTagger(rows.map((r) => r.title)));
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
    .map((r) => ({ ...r, date: r.date ?? '', legislator: r.legislator ?? null, funds: tag(r) }))
    // 同一則新聞會掛在每位被提到的委員底下，只留一則
    .filter((r, i, all) => r.funds.length && (r.kind !== 'news' || all.findIndex((x) => x.kind === 'news' && x.url === r.url) === i))
    .sort((a, b) => (b.sort_date ?? b.date).localeCompare(a.sort_date ?? a.date) || a.title.localeCompare(b.title));

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

/** 「我的機關」可選的機關：機關清單（行政院所屬機關代碼表）＋首長名單裡的機關，各自附上現任首長 */
export function listAgencies() {
  const heads = new Map();
  for (const o of OFFICIALS) heads.set(o.agency, [...(heads.get(o.agency) ?? []), { name: o.name, title: o.title }]);
  return [...new Set([...FUND_CONFIG.agencies, ...heads.keys()])]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    .map((name) => ({ name, heads: heads.get(name) ?? [] }));
}

const AGENCY_KINDS = ['news', 'bill', 'budget', 'report', 'post'];
const DGBAS_AGENCY = '行政院主計總處';

/**
 * 「我的機關」首頁：以單一機關為中心彙整各來源。
 * 比對：標題（預算審議另看提案單位）含機關全名或其簡稱（fund-config 的 aliases）。
 * 不用 makeTagger，因為首長名單裡的「行政院」「公共工程委員會」不在機關清單內，用它會整個漏掉。
 * 回傳：各來源（件數＋最新幾則）、首長新聞、近期議程提到該機關的會議、機關書面回覆，以及「誰在關注」
 * （新聞／臉書／提案掛名的委員，加上提到該機關的會議中登記發言的委員，依次數排序）。
 * 沒給 name 或不認得時 `agency` 為 null，只回機關清單供選單使用。
 */
export function getAgencyHome(db, { name = '', per = 5 } = {}) {
  const agencies = listAgencies();
  const known = agencies.find((a) => a.name === String(name).trim());
  const base = { meta: envelope(db), agencies };
  if (!known) return { ...base, agency: null };

  const resolvedPer = Math.max(1, Math.min(Number(per) || 5, 20));
  const terms = [known.name, ...Object.entries(FUND_CONFIG.aliases).filter(([, canonical]) => canonical === known.name).map(([alias]) => alias)];
  const hit = (text) => terms.some((t) => String(text ?? '').includes(t));
  const byDate = (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || String(a.title ?? '').localeCompare(String(b.title ?? ''));

  // 「誰在關注」要算到每位被掛名的委員，所以先留著去重前的列；顯示用的 matched 才把同一則新聞合併成一則
  // 主計總處另有專屬的主計新聞來源（topic_news 'dgbas'），沿用主計總處專頁的資料列，才不會因移到這裡而變少
  const hits = collectFundRows(db, known.name === DGBAS_AGENCY ? 'dgbas' : 'agency').filter((r) => hit(r.title) || (r.kind === 'budget' && hit(r.source)));
  const matched = hits
    .filter((r, i, all) => r.kind !== 'news' || all.findIndex((x) => x.kind === 'news' && x.url === r.url) === i)
    .sort(byDate);
  const kinds = Object.fromEntries(
    AGENCY_KINDS.map((k) => {
      const list = matched.filter((r) => r.kind === k);
      return [k, { total: list.length, items: list.slice(0, resolvedPer) }];
    }),
  );

  const officialNews = known.heads.flatMap((h) =>
    db.prepare('SELECT * FROM topic_news WHERE topic = ? ORDER BY published_at DESC, url').all(`official:${h.name}`).map((r) => ({ kind: 'news', date: r.published_at.slice(0, 10), title: r.title, url: r.url, source: r.source, head: h.name })),
  ).sort(byDate);

  const people = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, { id: l.id, name: l.name, party: l.party }]));
  const meetings = db
    .prepare('SELECT * FROM committee_meetings ORDER BY date DESC, id DESC')
    .all()
    .filter((m) => hit(m.name) || hit(m.content))
    .map((m) => ({
      date: m.date,
      name: m.name,
      committees: [...new Set([...committeesOf(m.committee), ...committeesOf(m.joint)])],
      speakers: JSON.parse(m.speakers || '[]').map((s) => people.get(s.id) ?? { id: null, name: s.name, party: '' }),
    }));
  const replies = db
    .prepare('SELECT * FROM committee_meets ORDER BY date DESC, code DESC')
    .all()
    .flatMap((m) =>
      JSON.parse(m.attachments || '[]')
        .filter((a) => a.kind === 'reply' && hit(a.title))
        .map((a) => ({ date: m.date, meeting: m.title, title: a.title, url: a.url })),
    );

  const watch = new Map();
  const bump = (l) => {
    if (l?.id) watch.set(l.id, { ...l, count: (watch.get(l.id)?.count ?? 0) + 1 });
  };
  for (const r of hits) bump(r.legislator);
  for (const m of meetings) for (const sp of m.speakers) bump(sp);
  const watchers = [...watch.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant')).slice(0, 8);

  return {
    ...base,
    agency: { name: known.name, heads: known.heads, terms },
    kinds,
    official_news: { total: officialNews.length, items: officialNews.slice(0, resolvedPer) },
    meetings: { total: meetings.length, items: meetings.slice(0, resolvedPer) },
    replies: { total: replies.length, items: replies.slice(0, resolvedPer) },
    watchers,
  };
}

/**
 * 委員會動態：最新會議（官方 ID223：議程、登記發言委員；依名稱對上 g0v 的附件與影片）、
 * 機關回覆（部會對委員質詢的書面答復，g0v meets 附件）與會議紀錄（公報，含官員答詢全文）。
 * `committee` 為委員會全名，聯席會議會出現在每個參與的委員會；委員會清單依常設委員會在前、其餘依件數。
 * `q` 為空白分隔的關鍵字、任一符合即列出（「我的機關」以機關全名＋簡稱連過來，簡稱不一定是全名的子字串）：
 * 會議比對名稱與議程、回覆與紀錄比對標題，與 getAgencyHome 的比對一致；委員會件數只算符合的，資料期間仍是全部資料。
 */
export function listCommitteeActivity(db, { committee = '', q = '', limit = 20 } = {}) {
  const resolvedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  const terms = String(q ?? '').split(/\s+/).filter(Boolean);
  const hit = (...texts) => !terms.length || terms.some((t) => texts.some((x) => String(x ?? '').includes(t)));
  const people = new Map(db.prepare('SELECT id, name, party FROM legislators').all().map((l) => [l.id, l]));
  const meets = db.prepare('SELECT * FROM committee_meets ORDER BY date DESC, code DESC').all().map((m) => ({ ...m, committees: JSON.parse(m.committees), attachments: JSON.parse(m.attachments) }));
  // ID223 的會議名稱可能多了「(會議取消)」之類的前綴，比對前去掉
  const meetKey = (name) => String(name ?? '').replace(/^\s*[（(][^）)]*[）)]\s*/, '').replace(/\s/g, '');
  const meetByName = new Map(meets.map((m) => [meetKey(m.title), m]));
  const byHan = new Map([...people.values()].map((l) => [newsName(l.name), l]));
  // 名錄是空的（全新資料庫、或同步尚未跑完）時，join('|') 會變成空字串的樣式，
  // match('') 會回傳一堆空字串，後面 byHan.get('') 是 undefined → 直接 TypeError 500。
  const hanNames = [...byHan.keys()].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  const nameRe = hanNames.length ? new RegExp(hanNames.join('|'), 'g') : null;
  /** 回覆標題提到的委員：全名，或「邱委員慧洳」這種姓＋委員＋名 */
  const repliedTo = (title) => {
    if (!nameRe) return [];
    const t = String(title).replace(/(.)委員(.{1,3}?)(?=[口書質答函_\-、，(（]|$)/g, '$1$2委員');
    return [...new Set(t.match(nameRe) ?? [])].map((n) => byHan.get(n)).filter(Boolean).map((l) => ({ id: l.id, name: l.name, party: l.party }));
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

  const qMeetings = meetings.filter((x) => hit(x.name, x.content));
  const qRecords = records.filter((x) => hit(x.title));
  const qReplies = replies.filter((x) => hit(x.title));
  const counts = new Map();
  for (const x of [...qMeetings, ...qRecords]) for (const c of x.committees) counts.set(c, (counts.get(c) ?? 0) + 1);
  const standing = CONFIG.committeeOrder;
  const rank = (name) => (standing.includes(name) ? standing.indexOf(name) : standing.length);
  const pick = (list) => (committee ? list.filter((x) => x.committees.includes(committee)) : list);
  const period = (list) => (list.length ? { from: list.at(-1).date, to: list[0].date } : null);
  const m = pick(qMeetings);
  const r = pick(qRecords);
  const rp = pick(qReplies);
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
  // 「一案一列」時 items 是合併後的案子：多給「議案紀錄筆數」與各狀態筆數，才知道那一列代表幾筆紀錄
  const merged = items.some((b) => (b.records ?? 1) > 1);
  const header = ['議案編號', '類別', '預算類型', '名稱', '提案單位', '預算年度', '狀態', '最新進度日期', '連結'];
  if (merged) header.push('議案紀錄筆數', '狀態筆數');
  return [
    csvRow(header),
    ...items.map((b) => {
      const row = [b.id, b.category, b.types.map((t) => TYPE_LABEL[t]).join('、'), b.name, b.proposer, b.fiscal_year, b.status, b.latest_date, b.url];
      if (merged) {
        const states = b.record_states ?? {};
        row.push(b.records ?? 1, Object.entries(states).map(([k, n]) => `${CSV_STATE_LABEL[k] ?? k} ${n}`).join('、'));
      }
      return csvRow(row);
    }),
  ].join('\r\n');
}

/** CSV 裡的狀態名稱（沿用畫面上的說法） */
const CSV_STATE_LABEL = { reviewed: '已審竣', in_review: '審議中', pending: '待審查', letter: '函件處理', returned: '退回' };

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
      top_sources: db
        .prepare("SELECT COALESCE(NULLIF(source, ''), '未知') AS name, COUNT(*) AS count FROM news WHERE legislator_id = ? GROUP BY 1 ORDER BY count DESC, name LIMIT 5")
        .all(id)
        .map((r) => ({ name: r.name, count: Number(r.count) })),
      top_laws: [...lawCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
      election: electionSummary(l.name),
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

const NEWS_KIND_LABEL = { legislator: '委員', official: '首長', entity: '機關／基金', dgbas: '主計總處', local_accounting: '地方主計', councilor: '議員' };
const SCOPE_KIND_LABEL = { legislators: '委員', officials: '首長', agencies: '機關' };

/**
 * 新聞 CSV（新聞頁「下載 CSV」）：listNewsArticles 的 items，欄位與畫面一致。
 * 發布時間轉成臺灣時間的「YYYY-MM-DD HH:mm」（Excel 直接看得懂）；摘要只拿來搜尋，不匯出。
 * 類別：全部新聞用每則的 kinds（沒有＝其他），委員／首長新聞頁就是該頁的類別。
 */
export function newsCsv(items, scope = 'legislators') {
  // 機關新聞多一欄「提到的機關」
  const agencies = scope === 'agencies';
  const header = ['發布時間', '媒體', '標題', '類別', ...(agencies ? ['提到的機關'] : []), '提到的委員／首長／議員', '連結'];
  const taipei = (iso) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  const kindOf = (a) => (scope === 'all' ? (a.kinds?.length ? a.kinds.map((k) => NEWS_KIND_LABEL[k]).join('、') : '其他') : SCOPE_KIND_LABEL[scope] ?? '');
  // 提到的人：委員／首長，加上議員（標縣市，例如「臺北市議員秦慧珠」）
  const people = (a) => [...a.legislators.map((p) => p.name), ...(a.councilors ?? []).map((c) => `${c.county}議員${c.name}`)].join('、');
  const lines = items.map((a) => csvRow([taipei(a.published_at), a.source, a.title, kindOf(a), ...(agencies ? [(a.agencies ?? []).join('、')] : []), people(a), a.url]));
  return [csvRow(header), ...lines].join('\r\n');
}

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
