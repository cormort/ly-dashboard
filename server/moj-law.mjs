import { CONFIG } from './config.mjs';
import { canonicalAgency } from './agency-names.mjs';
import { readZipEntry } from './zip.mjs';
import { applyMojLawAgencies } from './db.mjs';

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
 * 抓全國法規資料庫的法律資料檔並整批覆寫 `moj_law_agencies`（法規名稱 → 主管機關）。
 *
 * 只依賴 fetchJson 的 `raw` 選項（回 Buffer），失敗就整段放棄：主管機關只是加值，
 * 抓不到時機關頁沿用上一輪的對照，不能讓議案同步跟著失敗。
 */
export async function syncMojLawAgencies(db, { fetchImpl, logger = console } = {}) {
  const response = await fetchImpl(mojLawAgenciesUrl(), { raw: true });
  const text = readZipEntry(response.buffer, mojSnapshotName()).toString('utf8');
  const laws = parseMojLaws(text);
  if (laws.size === 0) throw new Error('全國法規資料庫的法規資料檔解析後沒有任何主管機關');
  applyMojLawAgencies(db, laws);
  const agencies = new Set([...laws.values()].flat());
  logger.log?.(`[bills] 全國法規資料庫主管機關：${laws.size} 部法律、涉及 ${agencies.size} 個機關（${Math.round(response.bytes / 1024)} KB）`);
  return { laws: laws.size, agencies: agencies.size, bytes: response.bytes };
}
