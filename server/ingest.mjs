import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { openDb, recordSyncRun, saveSnapshot, applyDataset, getMeta, setMeta } from './db.mjs';
import { buildDataset, DataValidationError } from './normalize.mjs';
import { fetchJson, FetchError } from './fetch-ly.mjs';

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
  const combinedSha = fetched.map((f) => f.sha256).join(':');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(CONFIG.dbPath);
  // CLI 模式：日誌走 stderr，stdout 只留 JSON，方便 `| jq` 或腳本解析。
  const toStderr = (...args) => console.error(...args);
  const result = await runIngest(db, { logger: { log: toStderr, warn: toStderr, error: toStderr } });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'failed' ? 1 : 0);
}
