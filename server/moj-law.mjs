import { CONFIG } from './config.mjs';
import { canonicalAgency } from './agency-names.mjs';
import { readZipEntry } from './zip.mjs';
import { applyMojLawAgencies, getMeta, hasSnapshot, saveSnapshot, setMeta } from './db.mjs';
import { sha256 } from './fetch-ly.mjs';

/**
 * 全國法規資料庫（法務部）的「法律」→「主管機關」。
 *
 * 用途：委員提案的標題不一定寫機關（例如「『氣候變遷因應法』部分條文修正草案」），
 * 要知道這案子歸哪個機關管，只能拿「被修的那部法律」去查主管機關。
 * g0v 法規庫（`ly.govapi.tw/v2/laws`）有這個欄位，但 2,578 部母法裡有 1,119 部是空的
 * （實測 2026-10-08：環境部相關幾乎全空、農業部相關約 40 部），全國法規資料庫才填得滿。
 *
 * 資料來源與形狀：`law.moj.gov.tw/api/ch/law/json` 回一個 ZIP（ChLaw.json 約 26MB），
 * 每部法律有 `LawCategory`＝法規類別（例：`行政＞環境部＞氣候變遷目`、
 * `行政＞農業部＞綜合規劃目`、`司法＞院本部＞…`、`廢止法規＞憲法`），第二段就是主管機關。
 * 這個端點跟 repo 其他來源一樣要具名 UA（WAF 會擋預設 UA）。
 *
 * 注意：法規類別還會再細分到「目」（業務目），這裡只取機關那一段——
 * 機關頁要的是「哪個機關」，細分到目的話會變成一堆只出現一次的假機關。
 *
 * 「廢止法規＞教育部」這種條目（322 部）整批略過：那部法律已經廢止，第二段雖然是機關，
 * 但實測 7,402 筆提案沒有任何一筆會用到（留下的話只是多 322 筆沒用的列，還可能跟現行法同名）。
 */

const CATEGORY_SEPARATORS = /[＞>]/;

/** 法規類別 → 主管機關（現行全名）；取不到（只有一段、或是「廢止法規」開頭）回 null */
export function agencyFromLawCategory(category) {
  const parts = String(category ?? '')
    .split(CATEGORY_SEPARATORS)
    .map((p) => p.trim())
    .filter((p) => p && p !== '廢止法規');
  if (parts.length < 2) return null;
  return canonicalAgency(parts[1]) || null;
}

/**
 * 解析 ChLaw.json（法務部的 ZIP 內那個檔）的文字：法規名稱 → [主管機關]。
 * 上游的檔是 UTF-8 with BOM，`JSON.parse` 不吃 BOM，要先拿掉。
 */
export function parseMojLaws(text) {
  const raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  const laws = new Map();
  for (const law of raw.Laws ?? []) {
    const name = String(law.LawName ?? '').trim();
    const agency = agencyFromLawCategory(law.LawCategory);
    if (!name || !agency) continue;
    const agencies = laws.get(name) ?? [];
    if (!agencies.includes(agency)) laws.set(name, [...agencies, agency]);
  }
  return laws;
}

export function mojLawAgenciesUrl() {
  return CONFIG.mojLaws.url;
}

export function mojSnapshotName() {
  return 'ChLaw.json';
}

/**
 * 機關對照的內容指紋：只有法條真的更新（新增／刪除／改主管機關）才會變。
 *
 * 用「對照本身」而不是「ZIP 的位元組」當指紋，是因為法務部每天都會重產那個 ZIP
 * （實測：重生時還會鎖檔回 500「由於另一個處理序正在使用檔案…」），
 * 就算法條一字沒改，ZIP 的位元組也不一樣——拿 ZIP 當指紋會變成每次都重寫。
 */
export function mojMappingDigest(laws) {
  const text = [...laws.entries()]
    .map(([name, agencies]) => `${name}|${[...agencies].sort().join(',')}`)
    .sort()
    .join('\n');
  return sha256(Buffer.from(text, 'utf8'));
}

const ZIP_SNAPSHOT_DATASET = 'moj_laws';
const DIGEST_META_KEY = 'moj_law_agencies_digest';

/** moj_law_agencies 目前的列數與機關數（跳過更新時要用來回報） */
function currentMapping(db) {
  const rows = db.prepare('SELECT agencies FROM moj_law_agencies').all();
  return { laws: rows.length, agencies: new Set(rows.flatMap((r) => JSON.parse(r.agencies))).size };
}

/**
 * 抓全國法規資料庫的法律資料檔並整批覆寫 `moj_law_agencies`（法規名稱 → 主管機關）。
 *
 * 只依賴 fetchJson 的 `raw` 選項（回 Buffer），失敗就整段放棄：主管機關只是加值，
 * 抓不到時機關頁沿用上一輪的對照，不能讓議案同步跟著失敗。
 *
 * **法條沒更新就不動**（使用者 2026-10-08 指定）：機關清單是從這張表長出來的，
 * 每次同步都重寫的話，機關清單會跟著法務部的產檔節奏（每天）變動，但內容其實一樣。
 * 兩層跳過：① ZIP 位元組與上次完全相同 → 連解析都省；② 位元組不同但對照指紋相同
 * （他們重產檔、法條沒動）→ 不寫資料庫。要重新寫入只有兩條路：對照真的變了，
 * 或資料庫裡本來就是空的（換機器／重建時不能因為有舊快照就跳過）。
 */
export async function syncMojLawAgencies(db, { fetchImpl, logger = console, fetchedAt } = {}) {
  const response = await fetchImpl(mojLawAgenciesUrl(), { raw: true });
  const before = currentMapping(db);
  const kb = Math.round(response.bytes / 1024);
  if (before.laws > 0 && hasSnapshot(db, ZIP_SNAPSHOT_DATASET, sha256(response.buffer))) {
    logger.log?.(`[bills] 全國法規資料庫沒有更新（同一份檔案 ${kb} KB），沿用 ${before.laws} 部法律的主管機關`);
    return { laws: before.laws, agencies: before.agencies, bytes: response.bytes, unchanged: true };
  }
  const text = readZipEntry(response.buffer, mojSnapshotName()).toString('utf8');
  const laws = parseMojLaws(text);
  if (laws.size === 0) throw new Error('全國法規資料庫的法規資料檔解析後沒有任何主管機關');
  const digest = mojMappingDigest(laws);
  if (before.laws > 0 && getMeta(db, DIGEST_META_KEY) === digest) {
    saveSnapshot(db, ZIP_SNAPSHOT_DATASET, {
      fetchedAt: fetchedAt ?? new Date().toISOString(),
      sha256: sha256(response.buffer),
      bytes: response.bytes,
      json: { laws: laws.size },
    });
    logger.log?.(`[bills] 全國法規資料庫重新產檔但法條沒變（${laws.size} 部），機關清單不動`);
    return { laws: before.laws, agencies: before.agencies, bytes: response.bytes, unchanged: true };
  }
  applyMojLawAgencies(db, laws);
  setMeta(db, DIGEST_META_KEY, digest);
  saveSnapshot(db, ZIP_SNAPSHOT_DATASET, {
    fetchedAt: fetchedAt ?? new Date().toISOString(),
    sha256: sha256(response.buffer),
    bytes: response.bytes,
    json: { laws: laws.size, agencies: new Set([...laws.values()].flat()).size },
  });
  const agencies = new Set([...laws.values()].flat());
  logger.log?.(`[bills] 全國法規資料庫主管機關：${laws.size} 部法律、涉及 ${agencies.size} 個機關（${kb} KB）`);
  return { laws: laws.size, agencies: agencies.size, bytes: response.bytes, unchanged: false };
}
