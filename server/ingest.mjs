import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { openDb, recordSyncRun, saveSnapshot, applyDataset, applyBills, applyBudget, applyBudgetReports, applyCommitteeMeets, applyCommitteeRecords, applyMeetings, applySocial, upsertNews, upsertTopicNews, pruneNews, pruneLogs, getMeta, setMeta } from './db.mjs';
import { buildDataset, normalizeBills, normalizeBudget, normalizeBudgetReports, normalizeCommitteeMeets, normalizeCommitteeRecords, normalizeMeetings, normalizeSocial, newsName, parseNewsRss, DataValidationError, NORMALIZER_VERSION } from './normalize.mjs';
import { fetchJson, FetchError, sha256 } from './fetch-ly.mjs';
import { entityNewsTerms, makeTagger, mentionsKnownEntity } from './queries.mjs';

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
    // B1：絕對下限（< 100）擋不住「id9 的 committee 欄位掉一半」這種部分回應：
    // 實測 783 筆席次掉到 367 筆仍會 status=success 並整批覆寫。改跟上次成功筆數比。
    guardShrink(db, 'seats', '委員會席次', dataset.stats.seats);
    guardShrink(db, 'legislators', '委員名錄', dataset.stats.legislators);
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
  // 基準筆數只在確定套用成功後才更新，否則失敗的那一版會把門檻往下拉
  recordCount(db, 'seats', dataset.stats.seats);
  recordCount(db, 'legislators', dataset.stats.legislators);

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

  const pruned = pruneLogs(db, CONFIG.retention);
  if (pruned.sync_runs || pruned.change_log) {
    logger.log(`[ingest] 清理舊紀錄：同步紀錄 ${pruned.sync_runs} 筆、異動紀錄 ${pruned.change_log} 筆（保留上限 ${CONFIG.retention.syncRuns}／${CONFIG.retention.changeLog}）`);
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
    // B2：ID223 也是整批覆寫，截斷的回應（例如只回一頁）不該蓋掉完整資料
    guardShrink(db, 'meetings', '委員會登記發言名單', meetings.length);
    const records = applyMeetings(db, meetings, { fetchedAt: now().toISOString() });
    recordCount(db, 'meetings', meetings.length);
    logger.log(`[meetings] 已套用：${records} 場委員會會議`);
    return { records, warnings };
  });
}

/** 委員會會議紀錄（公報議程）與會議附件／機關回覆（meets）：本屆全部分頁依序抓 */
export function runRecordsIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  return runStage(db, 'records', { logger, now }, async () => {
    const term = Number(getMeta(db, 'term'));
    if (!term) throw new DataValidationError('名錄尚未同步，無法判斷屆次');
    const urlFor = (page) => `${CONFIG.records.url}?${new URLSearchParams({ 屆: String(term), limit: '1000', page: String(page) })}`;
    const { pages } = await fetchAllPages(urlFor, fetchImpl, 'records');
    const normalizedRecords = normalizeCommitteeRecords(pages, CONFIG.records.category);
    // B2：這張表也是先 DELETE 再整批 INSERT，只有「非空」驗證擋不住被截斷的回應
    guardShrink(db, 'records', '委員會會議紀錄', normalizedRecords.length);
    const records = applyCommitteeRecords(db, normalizedRecords, { fetchedAt: now().toISOString() });
    // 會議附件與機關回覆：同一來源的另一個端點，一起抓；多個「會議種類」參數是 OR
    const meetsUrl = (page) => {
      const qs = new URLSearchParams({ 屆: String(term), limit: '1000', page: String(page) });
      for (const t of CONFIG.records.meetTypes) qs.append('會議種類', t);
      return `${CONFIG.records.meetsUrl}?${qs}`;
    };
    const normalizedMeets = normalizeCommitteeMeets((await fetchAllPages(meetsUrl, fetchImpl, 'meets')).pages);
    guardShrink(db, 'meets', '委員會會議附件', normalizedMeets.length);
    const meets = applyCommitteeMeets(db, normalizedMeets, { fetchedAt: now().toISOString() });
    recordCount(db, 'records', normalizedRecords.length);
    recordCount(db, 'meets', normalizedMeets.length);
    logger.log(`[records] 已套用：${records} 筆委員會會議紀錄、${meets} 場會議附件`);
    return { records, meets };
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

const OFFICIALS = JSON.parse(readFileSync(new URL('./officials.json', import.meta.url), 'utf8')).officials;

export function newsFeedUrl(name, q = `"${name}" 立委`) {
  const qs = new URLSearchParams({ q: `${q} when:${CONFIG.news.windowDays}d`, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  return `${CONFIG.news.url}?${qs}`;
}

/** 多個名稱合成一次查詢：("A" OR "B" OR …) when:30d */
export function entityFeedUrl(terms) {
  return newsFeedUrl('', `(${terms.map((t) => `"${t}"`).join(' OR ')})`);
}

const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * 整批覆寫前的「相對筆數」門檻（fail closed）。
 *
 * 為什麼需要：絕對下限（例如 `length < 100`）擋不住「來源只回了一半」。
 * 真實值 783 筆時，掉到 367 筆照樣通過所有驗證、`status='success'`，
 * 而 applyDataset / replaceAll 是 DELETE + INSERT —— 一覆寫，完整的舊資料就沒了。
 * 這裡跟「上一次成功套用的筆數」比（記在 meta），不是跟目前列數比，
 * 否則每次掉一點、門檻跟著下修，最後什麼都擋不住（見 DECISIONS D51）。
 *
 * @param {number} nextCount 這次要寫入的筆數
 * @param {number} minRatio  允許的最低比例（預設 0.8 = 不得掉超過 20%）
 */
export function guardShrink(db, metaKey, label, nextCount, { minRatio = CONFIG.shrinkMinRatio } = {}) {
  if (CONFIG.allowShrink) return { previous: 0, next: nextCount };
  const previous = Number(getMeta(db, `${metaKey}_count`, '0')) || 0;
  if (previous > 0 && nextCount < previous * minRatio) {
    throw new DataValidationError(
      `${label}筆數異常：本次 ${nextCount} 筆，低於上次成功同步 ${previous} 筆的 ${Math.round(minRatio * 100)}%，` +
        '疑似來源回應被截斷；已中止寫入並保留舊資料（可用 LY_ALLOW_SHRINK=1 強制覆寫）',
      { previous, next: nextCount },
    );
  }
  return { previous, next: nextCount };
}

/** 成功套用後記下筆數，供下一次 guardShrink 當基準 */
export function recordCount(db, metaKey, count) {
  setMeta(db, `${metaKey}_count`, String(count));
}

/** 人工確認過的粉專更正表（覆蓋整理表）；檔案不存在時視為沒有更正 */
const SOCIAL_OVERRIDES = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./social-overrides.json', import.meta.url), 'utf8')).overrides ?? [];
  } catch {
    return [];
  }
})();

/**
 * 基金／機關／行政法人新聞。名稱每 CONFIG.news.entityBatch 個合成一次 OR 查詢，標題提到具名單位才收，
 * 存成 topic_news 'entities'（與機關首長新聞同為專屬查詢，所以新舊一致）。
 * 預算用不完時，下輪從上次停下的組別接著抓（meta news_entity_cursor），不會永遠只抓前面幾組。
 */
export async function runEntityNews(db, { logger = console, fetchImpl = fetchJson, now = () => new Date(), delayMs = 0, budgetMs = CONFIG.news.entityBudgetMs, cutoff }) {
  const terms = entityNewsTerms();
  const size = Math.max(1, CONFIG.news.entityBatch);
  const batches = [];
  for (let i = 0; i < terms.length; i += size) batches.push(terms.slice(i, i + size));
  const result = { processed: 0, total: batches.length, added: 0, failures: 0, partial: false };
  if (!batches.length) return result;

  const countEntities = () => Number(db.prepare("SELECT COUNT(*) AS n FROM topic_news WHERE topic = 'entities'").get().n);
  const before = countEntities();
  const tagger = makeTagger([]);
  const deadline = Date.now() + budgetMs;
  const start = Math.max(0, Number(getMeta(db, 'news_entity_cursor', '0')) || 0) % batches.length;
  for (let n = 0; n < batches.length; n += 1) {
    if (Date.now() >= deadline) {
      result.partial = true;
      logger.warn(`[news] 基金／機關新聞時間預算 ${Math.round(budgetMs / 1000)} 秒用盡，完成 ${result.processed}/${batches.length} 組，下輪接續`);
      break;
    }
    if (n > 0) await pause(delayMs);
    result.processed += 1;
    try {
      const { text } = await fetchImpl(entityFeedUrl(batches[(start + n) % batches.length]), { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { match: (title) => mentionsKnownEntity(tagger, title) }).filter((i) => i.published_at >= cutoff);
      upsertTopicNews(db, 'entities', items, { fetchedAt: now().toISOString() });
    } catch (error) {
      result.failures += 1;
      logger.warn(`[news] 基金／機關新聞第 ${(start + n) % batches.length + 1} 組抓取失敗：${error?.message || error}`);
    }
  }
  result.added = countEntities() - before; // upsert 的 changes 含更新既有列，不能直接加總
  setMeta(db, 'news_entity_cursor', String((start + result.processed) % batches.length));
  return result;
}

/**
 * 媒體官方 RSS（CONFIG.news.outlets）：每家抓一次，再依標題分派到既有的新聞對象，篩選規則與 Google 那一路相同：
 * 委員＝標題含漢名（兩個字的名字如「范雲」「黃捷」另需標題含「立委」或「委員」，因為沒有 Google 查詢的「立委」條件把關）、
 * 機關首長＝標題含姓名（有 hint 時另需含關鍵字）、主計＝標題含「主計」、基金機關＝標題提到具名單位。
 * 同一則報導從 Google 再抓到一次時，由 upsertNews／upsertTopicNews 的標題去重擋掉。
 */
export async function runOutletNews(db, { logger = console, fetchImpl = fetchJson, now = () => new Date(), cutoff, outlets = CONFIG.news.outlets }) {
  const result = { processed: 0, total: outlets.length, failures: 0, items: 0, added: 0 };
  const legislators = db.prepare('SELECT id, name FROM legislators WHERE leave_flag = 0').all().map((l) => ({ id: l.id, name: newsName(l.name) }));
  const tagger = makeTagger([]);
  const fetchedAt = now().toISOString();
  for (const outlet of outlets) {
    result.processed += 1;
    try {
      const { text } = await fetchImpl(outlet.url, { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { match: () => true, source: outlet.name }).filter((i) => i.published_at >= cutoff);
      result.items += items.length;
      for (const l of legislators) {
        const mine = items.filter((i) => i.title.includes(l.name) && (l.name.length > 2 || i.title.includes('立委') || i.title.includes('委員')));
        if (mine.length) result.added += upsertNews(db, l.id, mine, { fetchedAt });
      }
      for (const o of OFFICIALS) {
        const mine = items.filter((i) => i.title.includes(o.name) && (!o.hint || o.hint.some((h) => i.title.includes(h))));
        if (mine.length) upsertTopicNews(db, `official:${o.name}`, mine, { fetchedAt });
      }
      upsertTopicNews(db, 'dgbas', items.filter((i) => i.title.includes('主計')), { fetchedAt });
      upsertTopicNews(db, 'entities', items.filter((i) => mentionsKnownEntity(tagger, i.title)), { fetchedAt });
    } catch (error) {
      result.failures += 1;
      logger.warn(`[news] ${outlet.name} RSS 抓取失敗：${error?.message || error}`);
    }
  }
  return result;
}

/**
 * 新聞同步：在職委員逐位抓 Google News RSS（依序＋間隔，避免被限流）。
 * 單一委員失敗不影響其他人；超過一半失敗才整體標記 failed（多半是被擋或斷網）。
 */
export async function runNewsIngest(
  db,
  {
    logger = console,
    fetchImpl = fetchJson,
    now = () => new Date(),
    delayMs = CONFIG.news.delayMs,
    budgetMs = CONFIG.news.budgetMs,
    entityBudgetMs = CONFIG.news.entityBudgetMs,
  } = {},
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
  // 主計總處專頁：不限委員，標題提到「主計」的新聞都收（地方主計處等在頁面上另外標示）
  try {
    const { text } = await fetchImpl(newsFeedUrl('主計', '"主計"'), { ua: CONFIG.userAgent, text: true, retries: 2 });
    upsertTopicNews(db, 'dgbas', parseNewsRss(text, { name: '主計' }).filter((n) => n.published_at >= cutoff), { fetchedAt: now().toISOString() });
  } catch (error) {
    logger.warn(`[news] 主計總處新聞抓取失敗：${error?.message || error}`);
  }
  // 機關首長：逐位抓，標題含姓名才收（兩字姓名另需標題含機關關鍵字）；失敗只記警告
  for (const o of OFFICIALS) {
    if (Date.now() >= deadline) break;
    await pause(delayMs);
    try {
      const { text } = await fetchImpl(newsFeedUrl(o.name, `"${o.name}" ${o.agency}`), { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { name: o.name }).filter((n) => n.published_at >= cutoff && (!o.hint || o.hint.some((h) => n.title.includes(h))));
      upsertTopicNews(db, `official:${o.name}`, items, { fetchedAt: now().toISOString() });
    } catch (error) {
      logger.warn(`[news] ${o.agency}${o.title}${o.name} 新聞抓取失敗：${error?.message || error}`);
    }
  }
  // 基金／機關／行政法人：自己的 OR 批次查詢（不依賴委員新聞），有獨立時間預算；失敗只記警告
  const entity = await runEntityNews(db, { logger, fetchImpl, now, delayMs, budgetMs: entityBudgetMs, cutoff });
  // 媒體官方 RSS：只是補充來源，失敗不影響整體成敗，只記在 notes
  const outlet = await runOutletNews(db, { logger, fetchImpl, now, cutoff });
  added += outlet.added;
  const pruned = pruneNews(db, { keepDays: CONFIG.news.keepDays, now: now() });

  const failed = legislators.length === 0 || failures.length > processed / 2;
  const status = failed ? 'failed' : 'success';
  const notes = [];
  if (partial) notes.push(`時間預算用盡，只完成 ${processed}/${legislators.length} 位`);
  if (failures.length) notes.push(`${failures.length}/${processed} 位失敗，例：${failures.slice(0, 3).join('；')}`);
  if (entity.partial) notes.push(`基金／機關新聞時間預算用盡，本輪完成 ${entity.processed}/${entity.total} 組，下輪接續`);
  if (entity.failures) notes.push(`基金／機關新聞 ${entity.failures}/${entity.processed} 組失敗`);
  if (outlet.failures) notes.push(`媒體 RSS ${outlet.failures}/${outlet.total} 家抓取失敗`);
  const error = notes.length ? notes.join('；') : null;
  // 全部失敗時不可以寫 complete：health 的 notices 只看 partial，前端橫幅只看 sync_runs，
  // 若這裡寫 complete:113/113，等於在 UI 上說「新聞同步完成」而實際上什麼都沒抓到。
  const newsStatus = failed
    ? `failed:${processed}/${legislators.length}`
    : partial
      ? `partial:${processed}/${legislators.length}`
      : `complete:${processed}/${legislators.length}`;
  setMeta(db, 'news_status', newsStatus);
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
  return { status, added, pruned, failures: failures.length, processed, total: legislators.length, partial, entity, outlet };
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
    const { accounts, warnings, overridesApplied } = normalizeSocial(result.text, idByName, { overrides: SOCIAL_OVERRIDES });
    if (overridesApplied.length) logger.log(`[social] 已套用 ${overridesApplied.length} 筆人工更正：${overridesApplied.join('、')}`);

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
  const records = CONFIG.skip.bills ? skipped('records') : await runRecordsIngest(db, options);
  const social = CONFIG.skip.social ? skipped('social') : await runSocialIngest(db, options);
  const news = CONFIG.skip.news ? skipped('news') : await runNewsIngest(db, options);
  return { ...roster, bills, budget, budget_reports: budgetReports, meetings, records, social, news };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  // CLI 模式：日誌走 stderr，stdout 只留 JSON，方便 `| jq` 或腳本解析。
  const toStderr = (...args) => console.error(...args);
  const result = await runAll(db, { logger: { log: toStderr, warn: toStderr, error: toStderr } });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}
