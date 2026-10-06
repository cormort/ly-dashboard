#!/usr/bin/env node
/**
 * 把本機抓到的「最新貼文日期／摘要」寫回臉書整理表（立委）。
 *
 * 呼叫的是 Apps Script Web App（apps-script/Code.js，以 clasp 部署）：
 *   POST <webapp url>  { token, rows: [{ id, date, summary }] }
 * Web App 那一端會依「編號」對列寫入 F／G 欄，抓不到日期的列一律跳過（不填今天、不覆蓋舊值）。
 *
 * 用法：
 *   node scripts/push-posts-to-sheet.mjs [csv] [--dry-run]
 *   LY_SHEET_WEBAPP_URL=https://script.google.com/macros/s/…/exec LY_SHEET_TOKEN=… node scripts/push-posts-to-sheet.mjs
 *
 * csv 預設用 `.cache/posts-latest.csv`（每日抓取結束時會更新這一份）。
 * 沒有設定 url／token 就只印提示並以 exit 0 結束（本機沒設定時不該讓每日排程變失敗）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../server/normalize.mjs';

const DEFAULT_CSV = fileURLToPath(new URL('../.cache/posts-latest.csv', import.meta.url));

/**
 * 抓取 CSV → [{ id, date, summary }]：只帶有日期的列（沒抓到的留空、不送出去，
 * 免得把表上既有的值清掉）。
 */
export function rowsFromCsv(csvText) {
  const [header = [], ...rows] = parseCsv(csvText);
  const col = (label) => header.findIndex((h) => h.trim() === label);
  const iId = col('編號');
  const iDate = col('最新貼文日期');
  const iSum = col('最新貼文主題摘要');
  if (iId < 0 || iDate < 0 || iSum < 0) {
    throw new Error(`抓取 CSV 缺少欄位（編號／最新貼文日期／最新貼文主題摘要）：${header.join(',')}`);
  }
  const out = [];
  for (const row of rows) {
    const id = (row[iId] ?? '').trim();
    const date = (row[iDate] ?? '').trim();
    if (!id || !date) continue;
    out.push({ id, date, summary: (row[iSum] ?? '').trim() });
  }
  return out;
}

/** 送出並回傳 Apps Script 的回應；HTTP 非 200 或 ok:false 都當失敗丟出。 */
export async function pushRows({ url, token, rows, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, rows }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Web App 回應 HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('Web App 回應不是 JSON');
  if (!body.ok) throw new Error(`Web App 回報失敗：${body.error ?? 'unknown'}`);
  return body;
}

function parseArgs(argv) {
  const args = { csv: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (!a.startsWith('--') && !args.csv) args.csv = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.LY_SHEET_WEBAPP_URL?.trim() ?? '';
  const token = process.env.LY_SHEET_TOKEN?.trim() ?? '';
  const csvPath = args.csv || DEFAULT_CSV;

  if (!existsSync(csvPath)) {
    console.error(`[寫回] 找不到抓取檔：${csvPath}`);
    process.exitCode = 1;
    return;
  }
  const rows = rowsFromCsv(readFileSync(csvPath, 'utf8'));
  console.log(`[寫回] ${csvPath} → ${rows.length} 列有日期`);

  if (args.dryRun || !url || !token) {
    if (!args.dryRun) console.log('[寫回] 沒有設定 LY_SHEET_WEBAPP_URL／LY_SHEET_TOKEN，只做預演');
    console.log(`[寫回] 預演：會送出 ${rows.length} 列（${rows[0]?.id ?? '-'}…${rows.at(-1)?.id ?? '-'}）`);
    return;
  }

  try {
    const out = await pushRows({ url, token, rows });
    console.log(
      `[寫回] 工作表「${out.sheet}」：更新 ${out.updated}、未變 ${out.unchanged}、留空跳過 ${out.blank}` +
        `${out.notFound ? `、表上找不到 ${out.notFound} 列（${(out.notFoundIds ?? []).join('、')}）` : ''}`,
    );
  } catch (error) {
    console.error(`[寫回] 失敗：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
