/**
 * 把中選會「罷免投票結果」公告 PDF 裡的同意／不同意票數補進 `server/recalls.json`。
 *
 *   node scripts/fetch-recall-results.mjs           # 抓公告 PDF → 解析 → 更新 recalls.json
 *   node scripts/fetch-recall-results.mjs --check    # 只比對已 commit 的數字與 PDF，不寫檔
 *
 * 為什麼要繞這一圈：中選會「選舉資料庫」的罷免模組**只有案件清單與結果**，
 * 35 個立委罷免案的 `has_data` 全是 false、`data_prof_seq` 是空陣列（實測 2026-10-02），
 * 整個資料庫裡只有「高雄市第3屆市長韓國瑜罷免案」有投開票概況表。
 * 同意／不同意票數只存在於中選會的**公告 PDF**（與行政院公報），所以只能從那裡取。
 *
 * 依賴：`pdftotext`（poppler）。沒有它時腳本會停下來並說明，不會寫出半套資料。
 * 解析後會做兩道內部檢查才寫檔：
 *   1. 同意 + 不同意 ≤ 投票人數（差額＝無效票，必須為正）
 *   2. 同意 ÷ 投票人總數 要等於公告上的「同意票數佔原選舉區投票人總數比率」
 * 這兩道都會實測抓錯字（例如欄位位移）的情況。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECALLS = fileURLToPath(new URL('../server/recalls.json', import.meta.url));
const checkOnly = process.argv.includes('--check');

/** 每一次罷免投票的官方結果公告（同一天的所有案子都在同一份公告裡） */
const ANNOUNCEMENTS = [
  {
    vote_date: '2025-07-26',
    label: '中央選舉委員會公告（114年8月1日 中選務字第1143150602號）',
    url: 'https://web.cec.gov.tw/api/file/b35ac130-d35d-4a9e-a145-cee7b7c4b8d2.pdf',
  },
  {
    vote_date: '2025-08-23',
    label: '中央選舉委員會公告（114年8月29日 中選務字第1143150700號，行政院公報第031卷第165期）',
    url: 'https://gazette.nat.gov.tw/EG_FileManager/eguploadpub/eg031165/ch02/type3/gov15/num3/Eg.pdf',
  },
];

// 公告的表格是固定欄位：姓名 性別 出生 投票人總數 投票人數 投票率％ 同意 不同意 同意佔比％ 結果
const ROW = /^\s*(\S+)\s+([男女])\s+(\d{2}\.\d{2}\.\d{2})\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)％\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)％\s+(\S+)\s*$/gm;
const int = (s) => Number(String(s).replace(/,/g, ''));

async function pdfText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`公告 PDF 下載失敗：${url} → HTTP ${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), 'recall-'));
  const file = join(dir, 'announcement.pdf');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('找不到 pdftotext（poppler）：請先安裝，例如 brew install poppler');
    throw error;
  }
}

export function parseAnnouncement(text) {
  const rows = [];
  for (const m of text.matchAll(ROW)) {
    const [, name, sex, birth, electorate, voted, turnout, agree, disagree, share, result] = m;
    const row = {
      name,
      sex,
      birth: birth.replace(/\./g, '/'),
      electorate: int(electorate),
      voted: int(voted),
      turnout_pct: Number(turnout),
      agree: int(agree),
      disagree: int(disagree),
      agree_share_pct: Number(share),
      result_text: result,
      invalid: int(voted) - int(agree) - int(disagree),
    };
    if (row.agree + row.disagree > row.voted) throw new Error(`${name}：同意＋不同意（${row.agree + row.disagree}）超過投票人數（${row.voted}），欄位可能位移`);
    if (row.invalid <= 0) throw new Error(`${name}：無效票算出 ${row.invalid}，不合理`);
    const expected = Math.round((row.agree / row.electorate) * 10000) / 100;
    if (Math.abs(expected - row.agree_share_pct) > 0.02) {
      throw new Error(`${name}：同意票佔比 ${row.agree_share_pct}% 與重算的 ${expected}% 不符`);
    }
    rows.push(row);
  }
  return rows;
}

const data = JSON.parse(readFileSync(RECALLS, 'utf8'));
const byName = new Map(data.recalls.map((r) => [r.name, r]));
const collected = new Map();

for (const announcement of ANNOUNCEMENTS) {
  const rows = parseAnnouncement(await pdfText(announcement.url));
  console.log(`[results] ${announcement.vote_date}：解析 ${rows.length} 列（${announcement.label}）`);
  if (!rows.length) throw new Error(`${announcement.label} 沒有解析到任何資料列`);
  for (const row of rows) {
    const recall = byName.get(row.name);
    // 公告是「同一天所有案子」；對不到我們的清單或日期不符就停下來，不要靜默錯配
    if (!recall) throw new Error(`公告裡的「${row.name}」不在罷免清單中，可能解析錯了`);
    if (recall.vote_date !== announcement.vote_date) {
      throw new Error(`${row.name} 的投票日不符：清單 ${recall.vote_date}、公告 ${announcement.vote_date}`);
    }
    if (collected.has(row.name)) throw new Error(`${row.name} 在公告中出現兩次`);
    collected.set(row.name, { ...row, source: announcement });
  }
}

let changed = 0;
let mismatched = 0;
for (const [name, row] of collected) {
  const recall = byName.get(name);
  const next = {
    electorate: row.electorate,
    voted: row.voted,
    turnout_pct: row.turnout_pct,
    agree: row.agree,
    disagree: row.disagree,
    agree_share_pct: row.agree_share_pct,
    invalid: row.invalid,
    result_text: row.result_text,
    announcement: row.source.label,
    announcement_url: row.source.url,
  };
  const same = JSON.stringify(recall.results ?? null) === JSON.stringify(next);
  if (!same) changed += 1;
  if (recall.results && !same) {
    // 已經有數字卻不一樣 → 印出來讓人看，不要靜默覆蓋
    mismatched += 1;
    console.log(`  ⚠ ${name}：已 commit 的數字與公告不同`);
  }
  if (!checkOnly) recall.results = next;
}

const missing = data.recalls.filter((r) => !r.results && !collected.has(r.name));
console.log(`[results] 有票數 ${collected.size} 筆／共 ${data.recalls.length} 筆；本次變更 ${changed} 筆`);
if (missing.length) {
  console.log(`[results] 沒有票數的 ${missing.length} 筆（公告不在這份清單裡）：${missing.map((r) => `${r.name}(${r.vote_date})`).join('、')}`);
}

if (checkOnly) {
  console.log(`[results] --check：只比對，未寫檔${mismatched ? `（${mismatched} 筆不一致）` : '（全部一致）'}`);
} else {
  data.results_sources = ANNOUNCEMENTS.map((a) => ({ vote_date: a.vote_date, label: a.label, url: a.url }));
  data.results_updated_at = new Date().toISOString();
  writeFileSync(RECALLS, `${JSON.stringify(data)}\n`);
  console.log(`[results] 已更新 ${RECALLS}`);
}
