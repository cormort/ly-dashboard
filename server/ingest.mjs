import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, recordSyncRun, saveSnapshot, applyDataset, applyBills, applyBudget, applyBudgetReports, applyMeetings, applySocial, upsertNews, pruneNews, getMeta, setMeta } from './db.mjs';
import { buildDataset, normalizeBills, normalizeBudget, normalizeBudgetReports, normalizeMeetings, normalizeSocial, newsName, parseNewsRss, DataValidationError, NORMALIZER_VERSION } from './normalize.mjs';
import { fetchJson, FetchError, sha256 } from './fetch-ly.mjs';

/**
 * Ingestion 管線：FETCH → VALIDATE → NORMALIZE → PERSIST。
 * 失敗策略：驗證不過或抓取失敗 → 保留舊資料、記錄失敗、標記 stale；絕不寫入半套資料、絕不放假資料。
 */
export async function runIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const startedAt = now();
  const startedMs = Date.now();
  const datasets = Object.entries(CONFIG.endpoints);
  const runs = [];
  let fetched;

  try {
    fetched = await Promise.all(
      datasets.map(async ([dataset, url]) => {
        const result = await fetchImpl(url, { ua: CONFIG.userAgent });
        return { dataset, url, ...result };
      }),
    );
  } catch (error) {
    const finishedAt = now().toISOString();
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    for (const [dataset] of datasets) {
      recordSyncRun(db, {
        dataset,
        status: 'failed',
        started_at: startedAt.toISOString(),
        finished_at: finishedAt,
        attempt: error?.attempts ?? null,
        http_status: error?.status ?? null,
        duration_ms: Date.now() - startedMs,
        ua: CONFIG.userAgent,
        error: message,
      });
      runs.push({ dataset, status: 'failed', error: message });
    }
    logger.error(`[ingest] 抓取失敗，保留既有資料：${message}`);
    return { status: 'failed', error: message, runs, changes: 0 };
  }

  const fetchedAt = now().toISOString();
  for (const item of fetched) {
    const inserted = saveSnapshot(db, item.dataset, {
      fetchedAt,
      sha256: item.sha256,
      bytes: item.bytes,
      json: item.json,
    });
    logger.log(`[ingest] ${item.dataset}：HTTP ${item.status}、${item.bytes} bytes、嘗試 ${item.attempts} 次、快照${inserted ? '已保存' : '已存在'}`);
  }

  const byDataset = Object.fromEntries(fetched.map((f) => [f.dataset, f]));
  // 版本前綴：正規化邏輯改了也要重寫，不能只看來源內容是否相同
  const combinedSha = `${NORMALIZER_VERSION}:${fetched.map((f) => f.sha256).join(':')}`;
  const alreadyApplied = getMeta(db, 'applied_sha') === combinedSha;

  let dataset;
  try {
    dataset = buildDataset(byDataset.id9.json, byDataset.id14.json, { sourceUrl: CONFIG.source.url });
  } catch (error) {
    const message = error instanceof DataValidationError ? `資料驗證失敗：${error.message}` : String(error?.message || error);
    const finishedAt = now().toISOString();
    for (const item of fetched) {
      recordSyncRun(db, {
        dataset: item.dataset,
        status: 'failed',
        started_at: startedAt.toISOString(),
        finished_at: finishedAt,
        attempt: item.attempts,
        http_status: item.status,
        duration_ms: Date.now() - startedMs,
        ua: CONFIG.userAgent,
        error: message,
      });
      runs.push({ dataset: item.dataset, status: 'failed', error: message });
    }
    logger.error(`[ingest] ${message}（保留既有資料，不改寫資料庫）`);
    return { status: 'failed', error: message, runs, changes: 0 };
  }

  const status = alreadyApplied ? 'skipped' : 'success';
  let applied = { changes: [] };
  if (!alreadyApplied) {
    applied = applyDataset(db, dataset, { fetchedAt, sourceUrl: CONFIG.source.url });
    setMeta(db, 'applied_sha', combinedSha);
  } else {
    setMeta(db, 'last_success_at', fetchedAt);
  }

  const finishedAt = now().toISOString();
  for (const item of fetched) {
    recordSyncRun(db, {
      dataset: item.dataset,
      status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt,
      records: item.dataset === 'id9' ? dataset.stats.legislators : dataset.seats.length,
      attempt: item.attempts,
      http_status: item.status,
      duration_ms: Date.now() - startedMs,
      ua: CONFIG.userAgent,
      error: null,
    });
    runs.push({ dataset: item.dataset, status, records: item.dataset === 'id9' ? dataset.stats.legislators : dataset.seats.length });
  }

  if (dataset.warnings.length) for (const w of dataset.warnings) logger.warn(`[ingest] 警告：${w}`);
  logger.log(
    `[ingest] ${status === 'skipped' ? '內容未變更，略過寫入' : `已套用：${dataset.stats.legislators} 位委員、${dataset.stats.seats} 筆席次、${dataset.stats.sessions} 個會期、異動 ${applied.changes.length} 筆`}`,
  );

  return {
    status,
    stats: dataset.stats,
    warnings: dataset.warnings,
    changes: applied.changes.length,
    runs,
    duration_ms: Date.now() - startedMs,
  };
}

/** 某屆委員提案的分頁網址（g0v API 以中文欄位名當 query key） */
export function billsPageUrl(term, page) {
  const qs = new URLSearchParams({ 屆: String(term), 提案來源: '委員提案', limit: String(CONFIG.bills.pageSize), page: String(page) });
  return `${CONFIG.bills.url}?${qs}`;
}

/**
 * 預算類議案的網址：多個 議案類別 參數在 g0v API 是 OR。
 * 實測：翻頁超過約 1 萬筆會回 HTTP 413，所以依會期分開抓（`session`）；`agg` 用來先問出各會期筆數。
 */
export function budgetPageUrl(term, page, { session = null, agg = false } = {}) {
  const qs = new URLSearchParams({ 屆: String(term), limit: agg ? '1' : String(CONFIG.bills.pageSize), page: String(page) });
  for (const category of CONFIG.budget.categories) qs.append('議案類別', category);
  if (session !== null) qs.set('會期', String(session));
  if (agg) qs.set('agg', '會期');
  return `${CONFIG.bills.url}?${qs}`;
}

/** 依序抓完所有分頁（不併發）；分頁數異常時 fail closed */
async function fetchAllPages(urlFor, fetchImpl, dataset) {
  const pages = [];
  let attempts = 0;
  for (let page = 1, totalPages = 1; page <= totalPages; page++) {
    const result = await fetchImpl(urlFor(page), { ua: CONFIG.userAgent });
    attempts += result.attempts ?? 1;
    pages.push(result.json);
    totalPages = Number(result.json?.total_page) || 1;
    if (totalPages > 50) throw new DataValidationError(`${dataset} 分頁數異常（${totalPages}）`);
  }
  return { pages, attempts };
}

/** 預算審議同步：與委員提案各自 fail closed；只需要屆次，不需要對應委員。 */
export async function runBudgetIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const term = Number(getMeta(db, 'term'));
  const record = (fields) =>
    recordSyncRun(db, { dataset: 'budget', started_at: startedAt, finished_at: now().toISOString(), duration_ms: Date.now() - startedMs, ua: CONFIG.userAgent, ...fields });
  if (!term) {
    const error = '名錄尚未同步，無法判斷屆次';
    record({ status: 'failed', error });
    return { status: 'failed', error };
  }
  let attempts = 0;
  try {
    const summary = (await fetchImpl(budgetPageUrl(term, 1, { agg: true }), { ua: CONFIG.userAgent })).json;
    const sessions = (summary?.aggs?.[0]?.buckets ?? []).map((b) => b['會期']).filter((s) => s !== null && s !== undefined);
    if (sessions.length === 0) throw new DataValidationError('budget 取不到會期分布');
    const pages = [];
    for (const session of sessions) {
      const fetched = await fetchAllPages((page) => budgetPageUrl(term, page, { session }), fetchImpl, 'budget');
      attempts += fetched.attempts;
      pages.push(...fetched.pages);
    }
    const items = normalizeBudget(pages, summary.total);
    const applied = applyBudget(db, items, { fetchedAt: now().toISOString() });
    logger.log(`[budget] 已套用：${items.length} 筆預算類議案、狀態異動 ${applied.changes} 筆`);
    record({ status: 'success', records: items.length, attempt: attempts, http_status: 200 });
    return { status: 'success', items: items.length, changes: applied.changes };
  } catch (error) {
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    logger.error(`[budget] 同步失敗，保留既有資料：${message}`);
    record({ status: 'failed', attempt: attempts || null, http_status: error?.status ?? null, error: message });
    return { status: 'failed', error: message };
  }
}

/**
 * 一個獨立 fail closed 的同步階段：計時、寫 sync_runs、失敗時保留舊資料。
 * `work()` 回傳 `{ records, ...其他摘要 }`。
 */
async function runStage(db, dataset, { logger, now }, work) {
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const record = (fields) =>
    recordSyncRun(db, { dataset, started_at: startedAt, finished_at: now().toISOString(), duration_ms: Date.now() - startedMs, ua: CONFIG.userAgent, ...fields });
  try {
    const result = await work();
    record({ status: 'success', records: result.records, attempt: 1, http_status: 200 });
    return { status: 'success', ...result };
  } catch (error) {
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    logger.error(`[${dataset}] 同步失敗，保留既有資料：${message}`);
    record({ status: 'failed', http_status: error?.status ?? null, error: message });
    return { status: 'failed', error: message };
  }
}

/** 今天的民國日期，如 `1150930`（官方 WebAPI 的日期參數格式） */
const rocToday = (now) => {
  const d = now();
  return `${d.getFullYear() - 1911}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/** 本屆起始的民國日期：取名錄最早的就職日，沒有就退回 3 年前 */
const termStartRoc = (db, now) => {
  const first = db.prepare("SELECT MIN(onboard_date) AS d FROM legislators WHERE onboard_date <> ''").get()?.d;
  const d = first && !Number.isNaN(Date.parse(first)) ? new Date(first) : new Date(now().getTime() - 3 * 365 * 86_400_000);
  return `${d.getFullYear() - 1911}${String(d.getMonth() + 1).padStart(2, '0')}01`;
};

/** 預算中心評估報告：每種類型一個請求，本屆起迄今 */
export function runBudgetReportsIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  return runStage(db, 'budget_reports', { logger, now }, async () => {
    const from = termStartRoc(db, now);
    const responses = {};
    for (const type of CONFIG.budget.reportTypes) {
      const qs = new URLSearchParams({ type, from, to: rocToday(now), mode: 'json' });
      responses[type] = (await fetchImpl(`${CONFIG.budget.reportsUrl}?${qs}`, { ua: CONFIG.userAgent })).json;
    }
    const records = applyBudgetReports(db, normalizeBudgetReports(responses), { fetchedAt: now().toISOString() });
    logger.log(`[budget_reports] 已套用：${records} 份預算中心報告`);
    return { records };
  });
}

/** 委員會登記發言名單：本屆起迄今一次抓 */
export function runMeetingsIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  return runStage(db, 'meetings', { logger, now }, async () => {
    const slash = (roc) => `${roc.slice(0, -4)}/${roc.slice(-4, -2)}/${roc.slice(-2)}`;
    const qs = new URLSearchParams({
      meetingDateS: slash(termStartRoc(db, now)),
      meetingDateE: slash(rocToday(now)),
      meetingRoom: '',
      meetingTypeName: '',
      jointCommittee: '',
      fileType: 'json',
    });
    const result = await fetchImpl(`${CONFIG.budget.meetingsUrl}?${qs}`, { ua: CONFIG.userAgent, timeoutMs: CONFIG.budget.meetingsTimeoutMs });
    const idByName = new Map(db.prepare('SELECT name, id FROM legislators').all().map((r) => [r.name, r.id]));
    const { meetings, warnings } = normalizeMeetings(result.json, idByName);
    for (const w of warnings) logger.warn(`[meetings] 警告：${w}`);
    const records = applyMeetings(db, meetings, { fetchedAt: now().toISOString() });
    logger.log(`[meetings] 已套用：${records} 場委員會會議`);
    return { records, warnings };
  });
}

/**
 * 議案同步：與名錄分開 fail closed —— 議案抓不到不影響名錄，反之亦然。
 * 依序抓分頁（不併發，對社群維運的 API 客氣一點），驗證後整批覆寫。
 */
export async function runBillsIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const term = Number(getMeta(db, 'term'));
  const record = (fields) =>
    recordSyncRun(db, { dataset: 'bills', started_at: startedAt, finished_at: now().toISOString(), duration_ms: Date.now() - startedMs, ua: CONFIG.userAgent, ...fields });

  if (!term) {
    const error = '名錄尚未同步，無法對應提案委員';
    record({ status: 'failed', error });
    return { status: 'failed', error };
  }

  let attempts = 0;
  try {
    const fetched = await fetchAllPages((page) => billsPageUrl(term, page), fetchImpl, 'bills');
    const pages = fetched.pages;
    attempts = fetched.attempts;
    const idByName = new Map(db.prepare('SELECT name, id FROM legislators').all().map((r) => [r.name, r.id]));
    const normalized = normalizeBills(pages, idByName);
    const raw = JSON.stringify(pages);
    const snapshotted = saveSnapshot(db, 'bills', {
      fetchedAt: now().toISOString(),
      sha256: sha256(Buffer.from(raw, 'utf8')),
      bytes: Buffer.byteLength(raw),
      json: { pages: pages.length, bills: pages.map((page) => page.bills) },
    });
    const applied = applyBills(db, normalized, { fetchedAt: now().toISOString() });
    for (const w of normalized.warnings) logger.warn(`[bills] 警告：${w}`);
    logger.log(
      `[bills] 已套用：${normalized.bills.length} 筆議案、${normalized.sponsors.length} 筆提案人對應、狀態異動 ${applied.changes} 筆（快照${snapshotted ? '已保存' : '已存在'}）`,
    );
    record({ status: 'success', records: normalized.bills.length, attempt: attempts, http_status: 200 });
    return { status: 'success', bills: normalized.bills.length, sponsors: normalized.sponsors.length, changes: applied.changes, warnings: normalized.warnings };
  } catch (error) {
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    logger.error(`[bills] 同步失敗，保留既有議案：${message}`);
    record({ status: 'failed', attempt: attempts || null, http_status: error?.status ?? null, error: message });
    return { status: 'failed', error: message };
  }
}

export function newsFeedUrl(name) {
  const qs = new URLSearchParams({ q: `"${name}" 立委 when:${CONFIG.news.windowDays}d`, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  return `${CONFIG.news.url}?${qs}`;
}

const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * 新聞同步：在職委員逐位抓 Google News RSS（依序＋間隔，避免被限流）。
 * 單一委員失敗不影響其他人；超過一半失敗才整體標記 failed（多半是被擋或斷網）。
 */
export async function runNewsIngest(
  db,
  { logger = console, fetchImpl = fetchJson, now = () => new Date(), delayMs = CONFIG.news.delayMs, budgetMs = CONFIG.news.budgetMs } = {},
) {
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const deadline = startedMs + budgetMs;
  const legislators = db.prepare('SELECT id, name FROM legislators WHERE leave_flag = 0 ORDER BY id').all();
  const failures = [];
  const cutoff = new Date(now().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  let added = 0;
  let processed = 0;
  let partial = false;

  for (const [index, l] of legislators.entries()) {
    // M5：時間預算用完就停，剩下的委員下一輪再抓（新聞是累積寫入，不會遺失）
    if (Date.now() >= deadline) {
      partial = true;
      logger.warn(`[news] 時間預算 ${Math.round(budgetMs / 1000)} 秒用盡，已完成 ${processed}/${legislators.length} 位，其餘留待下次同步`);
      break;
    }
    if (index > 0) await pause(delayMs);
    processed += 1;
    try {
      const name = newsName(l.name);
      const { text } = await fetchImpl(newsFeedUrl(name), { ua: CONFIG.userAgent, text: true, retries: 2 });
      // 先濾掉超過保存期限的，否則會「寫入 → 被 prune → 下次又寫入」反覆循環
      const fresh = parseNewsRss(text, { name }).filter((n) => n.published_at >= cutoff);
      added += upsertNews(db, l.id, fresh, { fetchedAt: now().toISOString() });
    } catch (error) {
      failures.push(`${l.name}：${error?.message || error}`);
    }
  }
  const pruned = pruneNews(db, { keepDays: CONFIG.news.keepDays, now: now() });

  const failed = legislators.length === 0 || failures.length > processed / 2;
  const status = failed ? 'failed' : 'success';
  const notes = [];
  if (partial) notes.push(`時間預算用盡，只完成 ${processed}/${legislators.length} 位`);
  if (failures.length) notes.push(`${failures.length}/${processed} 位失敗，例：${failures.slice(0, 3).join('；')}`);
  const error = notes.length ? notes.join('；') : null;
  setMeta(db, 'news_status', partial ? `partial:${processed}/${legislators.length}` : `complete:${processed}/${legislators.length}`);
  if (!failed) setMeta(db, 'news_fetched_at', now().toISOString());
  recordSyncRun(db, {
    dataset: 'news',
    status,
    started_at: startedAt,
    finished_at: now().toISOString(),
    records: added,
    duration_ms: Date.now() - startedMs,
    ua: CONFIG.userAgent,
    error: legislators.length === 0 ? '名錄尚未同步' : error,
  });
  (failed ? logger.error : logger.log)(`[news] ${status}：新增 ${added} 則、清除過期 ${pruned} 則${error ? `（${error}）` : ''}`);
  return { status, added, pruned, failures: failures.length, processed, total: legislators.length, partial };
}

/** 社群帳號整理表：抓 CSV → 驗證 → 整批覆寫；失敗保留舊資料。 */
export async function runSocialIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const record = (fields) =>
    recordSyncRun(db, { dataset: 'social', started_at: startedAt, finished_at: now().toISOString(), duration_ms: Date.now() - startedMs, ua: CONFIG.userAgent, ...fields });
  try {
    const result = await fetchImpl(CONFIG.social.url, { ua: CONFIG.userAgent, text: true });
    const idByName = new Map(db.prepare('SELECT name, id FROM legislators WHERE leave_flag = 0').all().map((r) => [newsName(r.name), r.id]));
    const { accounts, warnings } = normalizeSocial(result.text, idByName);

    // M4：整理表是可被編輯的外部來源。除了絕對門檻（normalizeSocial 內），
    // 這裡再和「上一次的筆數」比：掉超過 20% 就 fail closed，寧可留舊資料。
    const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get().n);
    if (existing >= 50 && accounts.length < existing * 0.8) {
      throw new DataValidationError(`社群帳號由 ${existing} 筆掉到 ${accounts.length} 筆（< 80%），疑似整理表被改動`);
    }

    const snapshotted = saveSnapshot(db, 'social', {
      fetchedAt: now().toISOString(),
      sha256: sha256(Buffer.from(result.text, 'utf8')),
      bytes: Buffer.byteLength(result.text),
      json: { csv: result.text },
    });
    const applied = applySocial(db, accounts, { fetchedAt: now().toISOString() });
    for (const w of warnings) logger.warn(`[social] 警告：${w}`);
    logger.log(
      `[social] 已套用：${accounts.length} 個社群帳號（新增 ${applied.added}、移除 ${applied.removed}；快照${snapshotted ? '已保存' : '已存在'}）`,
    );
    record({ status: 'success', records: accounts.length, attempt: result.attempts ?? 1, http_status: result.status ?? 200 });
    return { status: 'success', accounts: accounts.length, changes: applied.added + applied.removed, warnings };
  } catch (error) {
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    logger.error(`[social] 同步失敗，保留既有資料：${message}`);
    record({ status: 'failed', http_status: error?.status ?? null, error: message });
    return { status: 'failed', error: message };
  }
}

/**
 * 名錄 → 議案 → 預算 → 社群 → 新聞；名錄失敗就不跑其餘（沒有名錄就對不到人）。
 * `LY_SKIP_BILLS` / `LY_SKIP_NEWS` / `LY_SKIP_SOCIAL` 可跳過外部來源（測試與離線驗證用）。
 */
export async function runAll(db, options = {}) {
  const skipped = (stage) => ({ status: 'skipped', reason: `${stage} 已由環境變數停用` });
  const roster = await runIngest(db, options);
  if (roster.status === 'failed') return roster;
  const bills = CONFIG.skip.bills ? skipped('bills') : await runBillsIngest(db, options);
  const budget = CONFIG.skip.budget ? skipped('budget') : await runBudgetIngest(db, options);
  const budgetReports = CONFIG.skip.budget ? skipped('budget_reports') : await runBudgetReportsIngest(db, options);
  const meetings = CONFIG.skip.budget ? skipped('meetings') : await runMeetingsIngest(db, options);
  const social = CONFIG.skip.social ? skipped('social') : await runSocialIngest(db, options);
  const news = CONFIG.skip.news ? skipped('news') : await runNewsIngest(db, options);
  return { ...roster, bills, budget, budget_reports: budgetReports, meetings, social, news };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  // CLI 模式：日誌走 stderr，stdout 只留 JSON，方便 `| jq` 或腳本解析。
  const toStderr = (...args) => console.error(...args);
  const result = await runAll(db, { logger: { log: toStderr, warn: toStderr, error: toStderr } });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}
