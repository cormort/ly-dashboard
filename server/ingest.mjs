import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { CONFIG } from './config.mjs';
import { openDb, recordSyncRun, saveSnapshot, applyDataset, applyBills, applyBudget, applyBudgetReports, applyCommitteeMeets, applyCommitteeRecords, applyMeetings, applySocial, applyCouncilSocial, upsertNews, upsertTopicNews, upsertArticles, pruneNews, pruneLogs, getMeta, setMeta } from './db.mjs';
import { buildDataset, normalizeCouncilSocial, normalizeBills, normalizeBudget, normalizeBudgetReports, normalizeCommitteeMeets, normalizeCommitteeRecords, normalizeMeetings, normalizeSocial, newsName, parseNewsRss, DataValidationError, NORMALIZER_VERSION } from './normalize.mjs';
import { fetchJson, FetchError, sha256 } from './fetch-ly.mjs';
import { ambiguousCouncilorNames, currentCouncilors, entityNewsTerms, makeTagger, mentionsKnownEntity } from './queries.mjs';
import { feedDate, feedFileUrl, outletLabel, parseFeedFile } from './news-feed.mjs';

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

/** 主計新聞的兩組查詢（每日同步與回補共用）：中央的主計總處、地方的縣市政府主計處 */
const DGBAS_QUERIES = [
  { key: 'dgbas:central', label: '主計總處', q: '("主計總處" OR "主計長")' },
  { key: 'dgbas:local', label: '地方主計處', q: '"主計處"' },
];

export function newsFeedUrl(name, q = `"${name}" 立委`) {
  const qs = new URLSearchParams({ q: `${q} when:${CONFIG.news.windowDays}d`, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  return `${CONFIG.news.url}?${qs}`;
}

/** 多個名稱合成一次查詢：("A" OR "B" OR …) when:30d */
export function entityFeedUrl(terms) {
  return newsFeedUrl('', `(${terms.map((t) => `"${t}"`).join(' OR ')})`);
}

/** Google 新聞的結果也存進原始新聞庫。它的 description 只是「標題＋媒體」的 HTML，沒有搜尋價值，不存摘要 */
function saveGoogleArticles(db, items, now) {
  if (items.length) upsertArticles(db, items.map((i) => ({ ...i, summary: '' })), { origin: 'google', fetchedAt: now().toISOString() });
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
      saveGoogleArticles(db, items, now);
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
  const result = { processed: 0, total: outlets.length, failures: 0, items: 0, stored: 0, added: 0 };
  const targets = outletTargets(db);
  const fetchedAt = now().toISOString();
  for (const outlet of outlets) {
    result.processed += 1;
    try {
      const { text } = await fetchImpl(outlet.url, { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { match: () => true, source: outlet.name }).filter((i) => i.published_at >= cutoff);
      result.items += items.length;
      // 先整批存進原始新聞庫（全部新聞頁的關鍵字搜尋靠它），再分派給委員／首長／主計／基金機關
      result.stored += upsertArticles(db, items, { origin: 'outlet', fetchedAt });
      result.added += dispatchOutletItems(db, items, targets, { fetchedAt });
    } catch (error) {
      result.failures += 1;
      logger.warn(`[news] ${outletLabel(outlet)} RSS 抓取失敗：${error?.message || error}`);
    }
  }
  return result;
}

/** 分派對象：在職委員（漢名）＋標記基金機關用的 tagger；首長名單是模組常數 OFFICIALS */
function outletTargets(db) {
  return {
    legislators: db.prepare('SELECT id, name FROM legislators WHERE leave_flag = 0').all().map((l) => ({ id: l.id, name: newsName(l.name) })),
    tagger: makeTagger([]),
  };
}

/** 依標題把媒體新聞分派到 news／topic_news（規則見 runOutletNews 上方說明）；回傳新增的委員新聞則數 */
function dispatchOutletItems(db, items, { legislators, tagger }, { fetchedAt }) {
  let added = 0;
  for (const l of legislators) {
    const mine = items.filter((i) => i.title.includes(l.name) && (l.name.length > 2 || i.title.includes('立委') || i.title.includes('委員')));
    if (mine.length) added += upsertNews(db, l.id, mine, { fetchedAt });
  }
  for (const o of OFFICIALS) {
    const mine = items.filter((i) => i.title.includes(o.name) && (!o.hint || o.hint.some((h) => i.title.includes(h))));
    if (mine.length) upsertTopicNews(db, `official:${o.name}`, mine, { fetchedAt });
  }
  upsertTopicNews(db, 'dgbas', items.filter((i) => i.title.includes('主計')), { fetchedAt });
  upsertTopicNews(db, 'entities', items.filter((i) => mentionsKnownEntity(tagger, i.title)), { fetchedAt });
  return added;
}

/**
 * 原始新聞庫裡的媒體新聞重新分派一次（每日新聞同步時跑）。換了首長（officials.json）、
 * 委員名錄或基金機關清單之後，舊新聞也會標到新的人／機關；已分派過的由 upsert 去重，不會重複。
 * 只會「補標」不會「拿掉」：換下來的首長，舊新聞仍留在他名下（那時他確實是首長）。
 */
export function retagOutletArticles(db, { cutoff, now = () => new Date() }) {
  const items = db.prepare("SELECT url, title, source, published_at FROM articles WHERE origin = 'outlet' AND published_at >= ?").all(cutoff);
  return { items: items.length, added: dispatchOutletItems(db, items, outletTargets(db), { fetchedAt: now().toISOString() }) };
}

/**
 * 匯入 GitHub Actions 收集的媒體 RSS（CONFIG.news.feedUrl，news-data 分支每天一個檔）。
 *
 * 為什麼：本機的 RSS 輪詢只在伺服器開著時才有（手機休眠就停），收集端在 GitHub 上每小時跑，
 * 這裡把它收到的補進來。本機直接抓的仍然保留，兩邊依網址去重。
 *
 * 讀幾天：距離上次成功匯入幾天就讀幾天（至少 2 天，跨午夜不漏；第一次讀滿保存期限）。
 * 有檔案讀失敗就不推進「上次匯入」，下次會多讀；檔案不存在（404，那天還沒收集）不算失敗。
 */
export async function runNewsFeedImport(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const result = { files: 0, items: 0, stored: 0, added: 0, failures: 0, latest_collected_at: null };
  if (!CONFIG.news.feedUrl) return { ...result, skipped: true };
  const keepDays = CONFIG.news.keepDays;
  const last = getMeta(db, 'news_feed_imported_at');
  const days = last ? Math.min(keepDays, Math.max(2, Math.ceil((now().getTime() - Date.parse(last)) / 86_400_000) + 1)) : keepDays;
  const cutoff = new Date(now().getTime() - keepDays * 86_400_000).toISOString();
  const targets = outletTargets(db);
  const fetchedAt = now().toISOString();
  for (let d = 0; d < days; d += 1) {
    const date = feedDate(new Date(now().getTime() - d * 86_400_000).toISOString());
    let text;
    try {
      const headers = CONFIG.news.feedToken ? { authorization: `Bearer ${CONFIG.news.feedToken}` } : {};
      ({ text } = await fetchImpl(feedFileUrl(CONFIG.news.feedUrl, date), { ua: CONFIG.userAgent, text: true, retries: 1, headers }));
    } catch (error) {
      if (error?.status === 404) continue;
      result.failures += 1;
      logger.warn(`[news] 收集檔 ${date} 讀取失敗：${error?.message || error}`);
      continue;
    }
    const items = parseFeedFile(text).filter((i) => i.published_at >= cutoff);
    result.files += 1;
    result.items += items.length;
    for (const i of items) if (i.collected_at && (!result.latest_collected_at || i.collected_at > result.latest_collected_at)) result.latest_collected_at = i.collected_at;
    // 從「下載 CSV」併進來的歷史新聞帶 origin（多半是 Google 新聞），照實存；其餘是媒體 RSS
    for (const origin of ['outlet', 'google']) {
      const part = items.filter((i) => (i.origin ?? 'outlet') === origin);
      if (part.length) result.stored += upsertArticles(db, part, { origin, fetchedAt });
    }
    result.added += dispatchOutletItems(db, items, targets, { fetchedAt });
  }
  if (!result.failures) setMeta(db, 'news_feed_imported_at', now().toISOString());
  if (result.latest_collected_at) setMeta(db, 'news_feed_latest_collected_at', result.latest_collected_at);
  return result;
}

/** 收集端是不是停了：回傳要放進同步備註的文字，正常時回 null */
function feedStaleNote(db, now) {
  if (!CONFIG.news.feedUrl) return null;
  const latest = getMeta(db, 'news_feed_latest_collected_at');
  // 私人 repo 沒帶 token 時 GitHub 一律回 404，看起來跟「還沒收集」一樣，所以提示要查 token
  if (!latest) return `RSS 收集檔讀不到任何資料${CONFIG.news.feedToken ? '' : '（repo 是私人的話要設 LY_GITHUB_TOKEN）'}`;
  const hours = Math.floor((now().getTime() - Date.parse(latest)) / 3_600_000);
  return hours > CONFIG.news.feedStaleHours ? `RSS 收集端（GitHub Actions）最後一次收集是 ${hours} 小時前，可能停了` : null;
}

/**
 * 媒體 RSS 的獨立輪詢（排程每 CONFIG.news.outletIntervalMs 一次，見 index.mjs startScheduler）。
 * 為什麼要比每日同步頻繁：feed 只留最新幾十則（實測中央社 20、自由 40、公視 25），
 * 一天抓一次的話，中間被擠出 feed 的報導就永遠收不到了。
 */
export async function runOutletPoll(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - CONFIG.news.keepDays * 86_400_000).toISOString();
  const result = await runOutletNews(db, { logger, fetchImpl, now, cutoff });
  if (result.failures < result.total) setMeta(db, 'news_outlets_fetched_at', now().toISOString());
  const feed = await runNewsFeedImport(db, { logger, fetchImpl, now });
  logger.log(
    `[news] 媒體 RSS 輪詢：${result.items} 則（新增 ${result.stored} 則進新聞庫、${result.added} 則委員新聞）${result.failures ? `，${result.failures}/${result.total} 家失敗` : ''}` +
      (feed.skipped ? '' : `；收集檔 ${feed.files} 個、新增 ${feed.stored} 則`),
  );
  return { ...result, feed };
}

/* ---------------- 近半年新聞回補（一次性，scripts/backfill-news.mjs） ---------------- */

/** Google 新聞的日期區間查詢：`q after:YYYY-MM-DD before:YYYY-MM-DD`（before 不含當天） */
export function rangeFeedUrl(q, from, to) {
  const day = (d) => d.toISOString().slice(0, 10);
  const qs = new URLSearchParams({ q: `${q} after:${day(from)} before:${day(to)}`, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  return `${CONFIG.news.url}?${qs}`;
}

/**
 * 回補的對象，查詢字與「標題要不要收」的規則和每日同步（runNewsIngest／runEntityNews）一致：
 * 委員 `"漢名" 立委`、首長 `"姓名" 機關`（有 hint 另需標題含關鍵字）、主計 `"主計"`、基金機關的 OR 批次。
 * key 是接續用的識別：名錄或清單變了，已完成的 key 仍然算完成，新增的對象下次會補到。
 */
export function backfillTargets(db) {
  const tagger = makeTagger([]);
  const size = Math.max(1, CONFIG.news.entityBatch);
  const terms = entityNewsTerms();
  const targets = db
    .prepare('SELECT id, name FROM legislators WHERE leave_flag = 0 ORDER BY id')
    .all()
    .map((l) => {
      const name = newsName(l.name);
      return { key: `legislator:${l.id}`, label: name, q: `"${name}" 立委`, parse: (text) => parseNewsRss(text, { name }), write: (db2, items, at) => upsertNews(db2, l.id, items, { fetchedAt: at }) };
    });
  for (const o of OFFICIALS) {
    targets.push({
      key: `official:${o.name}`,
      label: `${o.agency}${o.title}${o.name}`,
      q: `"${o.name}" ${o.agency}`,
      parse: (text) => parseNewsRss(text, { name: o.name }).filter((n) => !o.hint || o.hint.some((h) => n.title.includes(h))),
      write: (db2, items, at) => upsertTopicNews(db2, `official:${o.name}`, items, { fetchedAt: at }),
    });
  }
  for (const { key, label, q } of DGBAS_QUERIES) {
    targets.push({ key, label, q, parse: (text) => parseNewsRss(text, { name: '主計' }), write: (db2, items, at) => upsertTopicNews(db2, 'dgbas', items, { fetchedAt: at }) });
  }
  for (let i = 0; i < terms.length; i += size) {
    const batch = terms.slice(i, i + size);
    targets.push({
      // 以批次的第一個名稱當 key：清單增減時批次會位移，最多重抓幾組，不會漏
      key: `entities:${batch[0]}`,
      label: `基金機關（${batch[0]} 等 ${batch.length} 個）`,
      q: `(${batch.map((t) => `"${t}"`).join(' OR ')})`,
      parse: (text) => parseNewsRss(text, { match: (title) => mentionsKnownEntity(tagger, title) }),
      write: (db2, items, at) => upsertTopicNews(db2, 'entities', items, { fetchedAt: at }),
    });
  }
  // 直轄市議員排在最後：已經回補到一半或做完的人，加了議員之後只會接著補議員，前面的進度不動
  const ambiguous = ambiguousCouncilorNames(db);
  for (const c of currentCouncilors()) {
    if (c.name.includes('□')) continue;
    const keep = councilorTitleFilter(c, ambiguous);
    targets.push({
      key: `councilor:${c.id}`,
      label: `${c.county}議員${c.name}`,
      q: councilorQuery(c),
      parse: (text) => parseNewsRss(text, { name: c.name }).filter(keep),
      write: (db2, items, at) => upsertTopicNews(db2, `councilor:${c.id}`, items, { fetchedAt: at }),
    });
  }
  return targets;
}

/** 把 [from, to) 切成每 days 天一段（最後一段到 to 為止） */
function slices(from, to, days) {
  const out = [];
  for (let t = from.getTime(); t < to.getTime(); t += days * 86_400_000) out.push([new Date(t), new Date(Math.min(t + days * 86_400_000, to.getTime()))]);
  return out;
}

/**
 * 近 keepDays 天的新聞回補（一次性；每日同步只看近 30 天）。
 *
 * - 每個對象按月查，Google 新聞一次最多回約 100 則：回了 ≥ CAP 則就把那個月細切成週、週再切成日，
 *   新聞少的對象（大多數）一個月一次就夠，新聞多的才多打幾次。
 * - 可中斷接續：進度（起訖日、已完成的對象、目前對象做到第幾個月）存在 meta `news_backfill`，
 *   每做完一個月就存一次。時間預算用完、或連續 maxFailures 次失敗（多半是被 Google 限流）就停下。
 * - 寫入規則與每日同步相同（同標題去重、存進原始新聞庫），補完直接出現在各新聞頁。
 */
export const BACKFILL_CAP = 95;
export async function runNewsBackfill(
  db,
  { logger = console, fetchImpl = fetchJson, now = () => new Date(), delayMs = 2000, budgetMs = 30 * 60 * 1000, maxFailures = 5, reset = false } = {},
) {
  const saved = reset ? null : JSON.parse(getMeta(db, 'news_backfill', 'null') ?? 'null');
  const state = saved?.done
    ? saved
    : (() => {
        // 起點對齊到當天 00:00 UTC：日期區間查詢以「天」為單位
        const to = new Date(`${now().toISOString().slice(0, 10)}T00:00:00.000Z`);
        to.setUTCDate(to.getUTCDate() + 1);
        const from = new Date(to.getTime() - CONFIG.news.keepDays * 86_400_000);
        return { from: from.toISOString(), to: to.toISOString(), done: [], current: null };
      })();
  const save = () => setMeta(db, 'news_backfill', JSON.stringify(state));
  const day = (d) => d.toISOString().slice(0, 10);
  const cutoff = state.from;
  const months = slices(new Date(state.from), new Date(state.to), 30);
  const targets = backfillTargets(db);
  const done = new Set(state.done);
  const deadline = Date.now() + budgetMs;
  // 已完成數只算現在的對象（舊的 key，例如拆分前的 'dgbas'，不算）
  const result = { requests: 0, added: 0, failures: 0, targets: targets.length, completed: targets.filter((t) => done.has(t.key)).length, stopped: null };
  let consecutive = 0;
  let first = true;

  /** 查一段：回了 ≥ CAP 則就細切（月 → 週 → 日），日已經是最細了就照收 */
  const fetchSlice = async (target, from, to, level) => {
    if (Date.now() >= deadline) throw Object.assign(new Error('budget'), { budget: true });
    if (!first) await pause(delayMs);
    first = false;
    result.requests += 1;
    // 心跳：每 20 次請求印一次目前做到哪（新聞多的對象一組就要打上百次）
    if (result.requests % 20 === 0) logger.log(`[backfill] …已打 ${result.requests} 次請求，目前：${target.label} ${day(from)}`);
    let items;
    try {
      const { text } = await fetchImpl(rangeFeedUrl(target.q, from, to), { ua: CONFIG.userAgent, text: true, retries: 2 });
      items = target.parse(text).filter((i) => i.published_at >= cutoff);
      consecutive = 0;
    } catch (error) {
      result.failures += 1;
      consecutive += 1;
      logger.warn(`[backfill] ${target.label} ${from.toISOString().slice(0, 10)}～${to.toISOString().slice(0, 10)} 失敗：${error?.message || error}`);
      if (consecutive >= maxFailures) throw Object.assign(new Error('failures'), { failures: true });
      return false;
    }
    if (items.length >= BACKFILL_CAP && level !== 'day') {
      // 細切會一口氣打很多次（一個月切到日最多 30 次），先說一聲，不然看起來像當掉
      logger.log(`[backfill] ${target.label} ${day(from)}～${day(to)} 超過 ${BACKFILL_CAP} 則，細切成${level === 'month' ? '週' : '日'}查…`);
      for (const [a, b] of slices(from, to, level === 'month' ? 7 : 1)) {
        if (!(await fetchSlice(target, a, b, level === 'month' ? 'week' : 'day'))) return false;
      }
      return true;
    }
    const at = now().toISOString();
    if (target.key.startsWith('legislator:')) result.added += target.write(db, items, at);
    else target.write(db, items, at);
    saveGoogleArticles(db, items, now);
    return true;
  };

  try {
    for (const target of targets) {
      if (done.has(target.key)) continue;
      // 每組各自記到第幾個月（progress）：中途插入新的對象（例如主計拆成兩組）時，
      // 原本做到一半的那組不會因為 current 被蓋掉而重頭來。舊版只有 current，一併沿用
      state.progress ??= state.current ? { [state.current.key]: state.current.month } : {};
      const startMonth = state.progress[target.key] ?? 0;
      for (let m = startMonth; m < months.length; m += 1) {
        // 失敗的月份不前進：下次從這個月重來（寫入是冪等的，重抓不會重複）
        if (!(await fetchSlice(target, months[m][0], months[m][1], 'month'))) {
          state.current = { key: target.key, month: m };
          state.progress[target.key] = m;
          save();
          m -= 1;
          continue;
        }
        state.current = { key: target.key, month: m + 1 };
        state.progress[target.key] = m + 1;
        save();
      }
      done.add(target.key);
      state.done = [...done];
      state.current = null;
      delete state.progress[target.key];
      save();
      result.completed = targets.filter((t) => done.has(t.key)).length;
      logger.log(`[backfill] ${result.completed}/${targets.length} ${target.label} 完成`);
    }
  } catch (error) {
    if (error?.budget) result.stopped = 'budget';
    else if (error?.failures) result.stopped = 'failures';
    else throw error;
  }
  if (!result.stopped) setMeta(db, 'news_backfill_done_at', now().toISOString());
  return result;
}

/** 各直轄市在標題裡常見的簡稱：兩字名或同名議員的新聞，標題有「議員」或縣市簡稱才收 */
const COUNTY_CUES = {
  新北市: ['新北'],
  臺北市: ['北市', '臺北', '台北'],
  桃園市: ['桃園', '桃市'],
  臺中市: ['中市', '臺中', '台中'],
  臺南市: ['南市', '臺南', '台南'],
  高雄市: ['高雄', '高市'],
};

/** 議員的 Google 新聞查詢字（每日同步與回補共用） */
const councilorQuery = (c) => `"${c.name}" ${c.county}議員`;

/** 議員新聞的標題篩選：要含姓名；兩字名或同名的另需「議員」或縣市簡稱（每日同步與回補共用） */
function councilorTitleFilter(c, ambiguous) {
  const needsCue = c.name.length <= 2 || ambiguous.has(c.name);
  const cues = ['議員', ...(COUNTY_CUES[c.county] ?? [])];
  return (item) => item.title.includes(c.name) && (!needsCue || cues.some((k) => item.title.includes(k)));
}

/**
 * 現任直轄市議員的 Google 新聞：逐位查「"姓名" 縣市議員」近 30 天，存成 topic_news 'councilor:<id>'（並進新聞庫）。
 * 標題要含姓名；兩字名、或與縣市長／立委／部會首長同名的，標題另需含「議員」或縣市簡稱。
 * 有獨立的時間預算（CONFIG.news.councilBudgetMs），用完就停、下輪從停下的議員接續（meta news_council_cursor）。
 */
export async function runCouncilNews(db, { logger = console, fetchImpl = fetchJson, now = () => new Date(), delayMs = 0, budgetMs = CONFIG.news.councilBudgetMs, cutoff }) {
  const councilors = currentCouncilors().filter((c) => !c.name.includes('□'));
  const result = { processed: 0, total: councilors.length, added: 0, failures: 0, partial: false };
  if (!councilors.length || budgetMs <= 0) return { ...result, skipped: true };
  const ambiguous = ambiguousCouncilorNames(db);
  const deadline = Date.now() + budgetMs;
  const start = Math.max(0, Number(getMeta(db, 'news_council_cursor', '0')) || 0) % councilors.length;
  const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM topic_news WHERE topic LIKE 'councilor:%'").get().n);
  const before = count();
  for (let n = 0; n < councilors.length; n += 1) {
    if (Date.now() >= deadline) {
      result.partial = true;
      logger.warn(`[news] 議員新聞時間預算 ${Math.round(budgetMs / 1000)} 秒用盡，完成 ${result.processed}/${councilors.length} 位，下輪接續`);
      break;
    }
    if (n > 0) await pause(delayMs);
    const c = councilors[(start + n) % councilors.length];
    result.processed += 1;
    try {
      const { text } = await fetchImpl(newsFeedUrl(c.name, councilorQuery(c)), { ua: CONFIG.userAgent, text: true, retries: 2 });
      const keep = councilorTitleFilter(c, ambiguous);
      const items = parseNewsRss(text, { name: c.name }).filter((i) => i.published_at >= cutoff && keep(i));
      upsertTopicNews(db, `councilor:${c.id}`, items, { fetchedAt: now().toISOString() });
      saveGoogleArticles(db, items, now);
    } catch (error) {
      result.failures += 1;
      logger.warn(`[news] ${c.county}議員${c.name} 新聞抓取失敗：${error?.message || error}`);
    }
  }
  result.added = count() - before;
  setMeta(db, 'news_council_cursor', String((start + result.processed) % councilors.length));
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
    councilBudgetMs = CONFIG.news.councilBudgetMs,
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
      saveGoogleArticles(db, fresh, now);
    } catch (error) {
      failures.push(`${l.name}：${error?.message || error}`);
    }
  }
  // 主計總處專頁：不限委員，主計總處與地方主計處分兩次查（各有自己的約 100 則上限，合查時地方的常被擠掉），
  // 都寫進 'dgbas'；頁面上再依標題分「提及主計總處」「地方主計處」「僅提及主計」（queries.mjs dgbasOf）
  for (const { label, q } of DGBAS_QUERIES) {
    try {
      const { text } = await fetchImpl(newsFeedUrl('主計', q), { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { name: '主計' }).filter((n) => n.published_at >= cutoff);
      upsertTopicNews(db, 'dgbas', items, { fetchedAt: now().toISOString() });
      saveGoogleArticles(db, items, now);
    } catch (error) {
      logger.warn(`[news] ${label}新聞抓取失敗：${error?.message || error}`);
    }
  }
  // 機關首長：逐位抓，標題含姓名才收（兩字姓名另需標題含機關關鍵字）；失敗只記警告
  for (const o of OFFICIALS) {
    if (Date.now() >= deadline) break;
    await pause(delayMs);
    try {
      const { text } = await fetchImpl(newsFeedUrl(o.name, `"${o.name}" ${o.agency}`), { ua: CONFIG.userAgent, text: true, retries: 2 });
      const items = parseNewsRss(text, { name: o.name }).filter((n) => n.published_at >= cutoff && (!o.hint || o.hint.some((h) => n.title.includes(h))));
      upsertTopicNews(db, `official:${o.name}`, items, { fetchedAt: now().toISOString() });
      saveGoogleArticles(db, items, now);
    } catch (error) {
      logger.warn(`[news] ${o.agency}${o.title}${o.name} 新聞抓取失敗：${error?.message || error}`);
    }
  }
  // 基金／機關／行政法人：自己的 OR 批次查詢（不依賴委員新聞），有獨立時間預算；失敗只記警告
  const entity = await runEntityNews(db, { logger, fetchImpl, now, delayMs, budgetMs: entityBudgetMs, cutoff });
  // 直轄市議員：自己的逐位查詢與時間預算；失敗只記警告
  const council = await runCouncilNews(db, { logger, fetchImpl, now, delayMs, budgetMs: councilBudgetMs, cutoff });
  // 媒體官方 RSS：只是補充來源，失敗不影響整體成敗，只記在 notes
  const outlet = await runOutletNews(db, { logger, fetchImpl, now, cutoff });
  added += outlet.added;
  if (outlet.failures < outlet.total) setMeta(db, 'news_outlets_fetched_at', now().toISOString());
  // GitHub Actions 收集的媒體 RSS：補伺服器沒開時漏掉的
  const feed = await runNewsFeedImport(db, { logger, fetchImpl, now });
  added += feed.added;
  // 每日一次對整個原始新聞庫重新分派：名單換過之後，舊新聞也標得到新的人／機關
  const retag = retagOutletArticles(db, { cutoff, now });
  added += retag.added;
  const pruned = pruneNews(db, { keepDays: CONFIG.news.keepDays, now: now() });

  const failed = legislators.length === 0 || failures.length > processed / 2;
  const status = failed ? 'failed' : 'success';
  const notes = [];
  if (partial) notes.push(`時間預算用盡，只完成 ${processed}/${legislators.length} 位`);
  if (failures.length) notes.push(`${failures.length}/${processed} 位失敗，例：${failures.slice(0, 3).join('；')}`);
  if (entity.partial) notes.push(`基金／機關新聞時間預算用盡，本輪完成 ${entity.processed}/${entity.total} 組，下輪接續`);
  if (entity.failures) notes.push(`基金／機關新聞 ${entity.failures}/${entity.processed} 組失敗`);
  if (council.partial) notes.push(`議員新聞時間預算用盡，本輪完成 ${council.processed}/${council.total} 位，下輪接續`);
  if (council.failures) notes.push(`議員新聞 ${council.failures}/${council.processed} 位失敗`);
  if (outlet.failures) notes.push(`媒體 RSS ${outlet.failures}/${outlet.total} 家抓取失敗`);
  if (feed.failures) notes.push(`RSS 收集檔 ${feed.failures} 個讀取失敗`);
  const stale = feedStaleNote(db, now);
  if (stale) notes.push(stale);
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
  return { status, added, pruned, failures: failures.length, processed, total: legislators.length, partial, entity, council, outlet, feed };
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
 * 議員臉書整理表（CONFIG.social.councilUrl，格式見 docs/social-sheet-spec.md）：抓 CSV → 驗證 → 整批覆寫；
 * 失敗保留舊資料。沒設網址就跳過（議員的粉專網址仍來自 server/council-facebook.json）。
 */
export async function runCouncilSocialIngest(db, { logger = console, fetchImpl = fetchJson, now = () => new Date() } = {}) {
  if (!CONFIG.social.councilUrl) return { status: 'skipped', reason: '沒有設定 LY_COUNCIL_SOCIAL_CSV' };
  const startedAt = now().toISOString();
  const startedMs = Date.now();
  const record = (fields) =>
    recordSyncRun(db, { dataset: 'council_social', started_at: startedAt, finished_at: now().toISOString(), duration_ms: Date.now() - startedMs, ua: CONFIG.userAgent, ...fields });
  try {
    const result = await fetchImpl(CONFIG.social.councilUrl, { ua: CONFIG.userAgent, text: true });
    const { rows, warnings } = normalizeCouncilSocial(result.text, currentCouncilors());
    // 同立委整理表（M4）：和上一次比，掉超過 20% 就 fail closed，寧可留舊資料
    const existing = Number(db.prepare('SELECT COUNT(*) AS n FROM council_social').get().n);
    if (existing >= 50 && rows.length < existing * 0.8) {
      throw new DataValidationError(`議員臉書帳號由 ${existing} 筆掉到 ${rows.length} 筆（< 80%），疑似整理表被改動`);
    }
    applyCouncilSocial(db, rows);
    setMeta(db, 'council_social_fetched_at', now().toISOString());
    for (const w of warnings) logger.warn(`[council-social] 警告：${w}`);
    logger.log(`[council-social] 已套用：${rows.length} 位議員的臉書資料`);
    record({ status: 'success', records: rows.length, attempt: result.attempts ?? 1, http_status: result.status ?? 200 });
    return { status: 'success', rows: rows.length, warnings };
  } catch (error) {
    const message = error instanceof FetchError ? `${error.message}（嘗試 ${error.attempts} 次）` : String(error?.message || error);
    logger.error(`[council-social] 同步失敗，保留既有資料：${message}`);
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
  const councilSocial = CONFIG.skip.social ? skipped('council_social') : await runCouncilSocialIngest(db, options);
  const news = CONFIG.skip.news ? skipped('news') : await runNewsIngest(db, options);
  return { ...roster, bills, budget, budget_reports: budgetReports, meetings, records, social, council_social: councilSocial, news };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  // CLI 模式：日誌走 stderr，stdout 只留 JSON，方便 `| jq` 或腳本解析。
  const toStderr = (...args) => console.error(...args);
  const result = await runAll(db, { logger: { log: toStderr, warn: toStderr, error: toStderr } });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}
