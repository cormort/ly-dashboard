/**
 * 抓中選會「罷免」表（官方選舉資料庫），寫出 `server/recalls.json`。
 *
 *   node scripts/fetch-cec-recalls.mjs            # 打真實網站（約 1 秒）
 *   node scripts/fetch-cec-recalls.mjs --check    # 只驗證遠端資料，不寫檔（CI／排程用）
 *
 * 為什麼另開一支腳本：`build-county-stats.mjs` 的設計是**離線**吃本機來源目錄
 * （中選會 el* 原始檔、內政部人口 CSV），不該混進網路請求；而且那支腳本要跑好幾分鐘，
 * 只為了更新一份 23KB 的罷免清單並不合理。
 *
 * 來源與限制（實測 2026-10-02）：
 * - 使用者指定的是 `https://db.cec.gov.tw/ElecTable/Recall?type=Legislator`（官方，HTML 頁面）。
 *   用瀏覽器實測，那個頁面**只**抓 `/static/elections/list/RCL_L0.json` 這一支資料
 *   （用 `performance.getEntriesByType('resource')` 確認），所以這裡直接抓同一支 JSON，
 *   不必爬 HTML。L0 = 立法委員。
 * - **中選會的罷免表沒有各案同意／不同意票數**（`has_data: false`、`vote_result` 只有 Y／N）。
 *   同一頁的附件下載路徑需要額外驗證，這裡不做，所以 `recalls.json` 只有：
 *   屆次、投票日、被罷免人、選區、結果（Y = 通過、N = 未通過）。
 * - 外層的 `area_name` 不可信（實測第 8 屆蔡正元那筆標成「雲林縣」，但標題寫臺北市），
 *   因此行政區一律從 `theme_name` 解析。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_URL = 'https://db.cec.gov.tw/ElecTable/Recall?type=Legislator';
const DATA_URL = 'https://db.cec.gov.tw/static/elections/list/RCL_L0.json';
const OUT = fileURLToPath(new URL('../server/recalls.json', import.meta.url));
const checkOnly = process.argv.includes('--check');

/** 「臺北市第11屆第4選舉區立法委員李彥秀罷免案」→ { area, district, name } */
export function parseRecallTitle(title) {
  const m = /^(.*?)第(?:.*?)屆(.*?)立法委員(.+?)罷免案$/.exec(String(title ?? ''));
  if (!m) return null;
  return {
    area: m[1].trim(),
    // 「第4選舉區」→「第4選舉區」；沒有選舉區（單一選區縣市）時是空字串
    district: m[2].trim(),
    name: m[3].trim(),
  };
}

/** 中選會清單（`[{term_index, time_items:[{theme_items:[…]}]}]`）→ 扁平的罷免紀錄 */
export function flattenRecalls(payload) {
  const out = [];
  for (const term of payload ?? []) {
    for (const time of term?.time_items ?? []) {
      for (const item of time?.theme_items ?? []) {
        const parsed = parseRecallTitle(item.theme_name);
        if (!parsed) continue;
        out.push({
          term: Number(term.term_index),
          vote_date: item.vote_date ?? null,
          name: parsed.name,
          area: parsed.area,
          district: parsed.district || null,
          // Y = 罷免通過、N = 未通過（中選會原始欄位）
          passed: item.vote_result === 'Y',
          result: item.vote_result ?? null,
          title: item.theme_name,
          theme_id: item.theme_id ?? null,
        });
      }
    }
  }
  // 同一天可能有多案；排序讓輸出穩定（也讓 git diff 可讀）
  return out.sort((a, b) => String(a.vote_date).localeCompare(String(b.vote_date)) || a.name.localeCompare(b.name, 'zh-Hant'));
}

const response = await fetch(DATA_URL, { headers: { accept: 'application/json' } });
if (!response.ok) throw new Error(`中選會罷免清單抓取失敗：HTTP ${response.status}`);
const payload = await response.json();
const recalls = flattenRecalls(payload);

// 守門：這份清單每次改版都可能改 schema。筆數或欄位不對就 fail closed，不要寫出半套資料。
if (recalls.length < 30) throw new Error(`罷免案筆數異常（${recalls.length} < 30）`);
const broken = recalls.filter((r) => !r.name || !r.vote_date || !r.term || r.result === null);
if (broken.length) throw new Error(`有 ${broken.length} 筆罷免紀錄欄位不完整：${broken.slice(0, 3).map((r) => r.title).join('、')}`);
if (!recalls.some((r) => r.passed)) throw new Error('沒有任何「通過」的罷免案，vote_result 的解讀可能錯了');

const byTerm = recalls.reduce((acc, r) => ({ ...acc, [r.term]: (acc[r.term] ?? 0) + 1 }), {});
console.log(`[recalls] ${recalls.length} 筆（屆次分布 ${JSON.stringify(byTerm)}）；通過 ${recalls.filter((r) => r.passed).length} 筆`);

if (checkOnly) {
  console.log('[recalls] --check：只驗證，未寫檔');
} else {
  // 保留 fetch-recall-results.mjs 補進去的票數：這支只重抓案件清單，不能把 results 洗掉
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const prevResults = new Map((prev.recalls ?? []).filter((r) => r.results).map((r) => [r.theme_id ?? r.title, r.results]));
  for (const r of recalls) {
    const kept = prevResults.get(r.theme_id ?? r.title);
    if (kept) r.results = kept;
  }
  const out = {
    source: {
      label: '中選會選舉資料庫（官方）',
      page: PAGE_URL,
      endpoint: DATA_URL,
      note: '罷免表只有案件清單（投票日與結果）；各案票數由 scripts/fetch-recall-results.mjs 從官方公告／結果文件補入。',
    },
    fetched_at: new Date().toISOString(),
    count: recalls.length,
    recalls,
    ...(prev.results_sources ? { results_sources: prev.results_sources } : {}),
    ...(prev.results_updated_at ? { results_updated_at: prev.results_updated_at } : {}),
  };
  const lost = (prev.recalls ?? []).filter((r) => r.results && !recalls.some((n) => (n.theme_id ?? n.title) === (r.theme_id ?? r.title)));
  if (lost.length) console.warn(`[recalls] 警告：${lost.length} 筆舊票數對不到新清單（${lost.map((r) => r.name).join('、')}），請重跑 fetch-recall-results.mjs`);
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  console.log(`[recalls] 已寫出 ${OUT}`);
}
