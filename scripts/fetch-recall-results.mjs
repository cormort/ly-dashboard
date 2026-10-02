/**
 * 把中選會「罷免投票結果」官方文件的同意／不同意票數補進 `server/recalls.json`。
 *
 *   node scripts/fetch-recall-results.mjs           # 抓官方文件 → 解析 → 更新 recalls.json
 *   node scripts/fetch-recall-results.mjs --check    # 只比對已 commit 的數字，不寫檔
 *
 * 為什麼要繞這一圈：中選會「選舉資料庫」的罷免模組**只有案件清單與結果**，
 * 35 個立委罷免案的 `has_data` 全是 false、`data_prof_seq` 是空陣列（實測 2026-10-02），
 * 整個資料庫只有「高雄市第3屆市長韓國瑜罷免案」有投開票概況表。
 * 同意／不同意票數只存在於官方的**公告／結果文件**裡，而且每一份的格式都不一樣
 * （見下面 SOURCES 的 kind），所以每一種格式各有一個小解析器。
 *
 * 依賴：`pdftotext`（poppler）與 `unzip`。缺任何一個都會停下來說明，不會寫出半套資料。
 *
 * 每一列寫入前都會通過 `verifyRow()`：
 *   1. 同意 ＋ 不同意 ＋ 無效票 ＝ 投票人數，且無效票不為負
 *   2. 投票人數 ÷ 選舉人總數 ＝ 文件上的投票率（誤差 ≤ 0.02）
 *   3. 文件若有印「同意票佔比」，重算要一致（分母各文件不同，一併記錄）
 *   4. 姓名必須在我們的清單中，且投票日相符
 * 這四道會抓到 PDF／試算表解析最常見的「欄位位移卻照樣算出數字」。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECALLS = fileURLToPath(new URL('../server/recalls.json', import.meta.url));
const checkOnly = process.argv.includes('--check');

/** 同一天的所有案子都在同一份公告裡（2025 兩波）；其餘是單一案件的歷史文件，格式各異 */
const SOURCES = [
  {
    kind: 'announcement-pdf',
    vote_date: '2025-07-26',
    expect: 24,
    label: '中央選舉委員會公告（114年8月1日 中選務字第1143150602號）',
    url: 'https://web.cec.gov.tw/api/file/b35ac130-d35d-4a9e-a145-cee7b7c4b8d2.pdf',
  },
  {
    kind: 'announcement-pdf',
    vote_date: '2025-08-23',
    expect: 7,
    label: '中央選舉委員會公告（114年8月29日 中選務字第1143150700號，行政院公報第031卷第165期）',
    url: 'https://gazette.nat.gov.tw/EG_FileManager/eguploadpub/eg031165/ch02/type3/gov15/num3/Eg.pdf',
  },
  {
    kind: 'ticket-summary-pdf',
    vote_date: '2017-12-16',
    label: '中選會「黃國昌罷免案投開票結果表」（新北市選舉委員會）',
    url: 'https://web.cec.gov.tw/api/file/c13d2d17-7e97-4c17-8a31-482256c9610e.pdf',
  },
  {
    kind: 'record-prose-pdf',
    vote_date: '2015-02-14',
    label: '中選會「蔡正元罷免案罷免實錄」（臺北市選舉委員會）',
    url: 'https://web.cec.gov.tw/api/file/7f84d09b-7426-4cce-aea4-6d9eca75063b.pdf',
  },
  {
    kind: 'ods-totals',
    vote_date: '2022-01-09',
    label: '中選會「林昶佐罷免案各投開票所得票數一覽表」（臺北市選舉委員會）',
    url: 'https://web.cec.gov.tw/api/file/c24b1e10-4608-41a9-b795-33105079ed3e.ods',
  },
  {
    kind: 'manual-image-table',
    vote_date: '2021-10-23',
    label: '中央選舉委員會公告（110年10月28日 中選務字第1103150452號，行政院公報第027卷第205期）',
    url: 'https://gazette.nat.gov.tw/EG_FileManager/eguploadpub/eg027205/ch02/type3/gov15/num3/Eg.pdf',
    // 這份公告的結果表是**圖片**（實測 pdfimages：747×221 JPEG，沒有文字層），
    // 環境裡也沒有 OCR，所以由人工判讀填入；數字仍會走同一套 verifyRow()
    // （同意＋不同意＋無效票＝投票人數、投票率＝投票人數÷選舉人總數、結果與名單相符）。
    // 這是唯一一筆不是機器解析的，寫入時會標 read_from 以示區別。
    read_from: '公告圖片（人工判讀，已通過算術驗證）',
    row: { name: '陳柏惟', sex: '男', birth: '74.07.10', electorate: 294976, voted: 152567, turnout_pct: 51.72, agree: 77899, disagree: 73433, printed_share_pct: null, printed_share_of: null, result_text: '通過' },
  },
];

const int = (s) => Number(String(s).replace(/[,\s]/g, ''));

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`找不到 ${cmd}：請先安裝（例如 brew install poppler / unzip）`);
    throw error;
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`官方文件下載失敗：${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function pdfText(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-'));
  const file = join(dir, 'doc.pdf');
  writeFileSync(file, buffer);
  return run('pdftotext', ['-layout', file, '-']);
}

/** 公告的固定欄位表：姓名 性別 出生 選舉人總數 投票人數 投票率％ 同意 不同意 同意佔比％ 結果 */
const ANNOUNCEMENT_ROW = /^\s*(\S+)\s+([男女])\s+(\d{2}\.\d{2}\.\d{2})\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)％\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)％\s+(\S+)\s*$/gm;

function parseAnnouncement(text) {
  return [...text.matchAll(ANNOUNCEMENT_ROW)].map(([, name, sex, birth, electorate, voted, turnout, agree, disagree, share, result]) => ({
    name,
    sex,
    birth,
    electorate: int(electorate),
    voted: int(voted),
    turnout_pct: Number(turnout),
    agree: int(agree),
    disagree: int(disagree),
    printed_share_pct: Number(share),
    printed_share_of: 'electorate',
    result_text: result,
  }));
}

/** 投開票結果表：總計列＝同意 不同意 有效票 無效票 投票人數 已領未投 發出票 用餘票 選舉人數 投票率 */
function parseTicketSummary(text) {
  const line = text.split('\n').find((l) => /^\s*總計/.test(l));
  if (!line) throw new Error('找不到「總計」列');
  // 注意順序：先試小數（27.75%），否則 [\d,]+ 會先吃掉 "27" 讓欄位整體位移
  const nums = [...line.matchAll(/(\d[\d,]*(?:\.\d+)?%?)/g)].map((m) => m[1]).filter((x) => /\d/.test(x));
  if (nums.length < 10) throw new Error(`總計列欄位數不足（${nums.length}）：${line.trim()}`);
  const [agree, disagree, valid, invalid, voted, , , , electorate, turnout] = nums;
  if (int(agree) + int(disagree) !== int(valid)) throw new Error(`總計列不一致：同意＋不同意（${int(agree) + int(disagree)}）≠ 有效票（${int(valid)}）`);
  return [{
    name: null, // 由 SOURCES 的 vote_date 對到清單裡唯一的案子
    electorate: int(electorate),
    voted: int(voted),
    turnout_pct: Number(String(turnout).replace('%', '')),
    agree: int(agree),
    disagree: int(disagree),
    invalid: int(invalid),
    printed_share_pct: null,
    printed_share_of: null,
    result_text: null,
  }];
}

/** 罷免實錄的內文：「投票人總數計 X 人，投票人數為 Y 人，投票率為 Z％，有效票為…同意罷免票數為 A 票，佔 P%；不同意罷免票數 B 票，佔 Q%，無效票為 C 票」 */
function parseRecordProse(text) {
  const flat = text.replace(/\s+/g, '');
  const pick = (re, what) => {
    const m = re.exec(flat);
    if (!m) throw new Error(`實錄內文找不到${what}`);
    return m[1];
  };
  const electorate = int(pick(/投票人總數計([\d,]+)人/, '投票人總數'));
  const voted = int(pick(/投票人數為([\d,]+)人/, '投票人數'));
  const turnout = Number(pick(/投票率為([\d.]+)％/, '投票率'));
  const agree = int(pick(/同意罷免票數為([\d,]+)票/, '同意票數'));
  const share = Number(pick(/同意罷免票數為[\d,]+票，佔([\d.]+)%/, '同意票佔比'));
  const disagree = int(pick(/不同意罷免票數([\d,]+)票/, '不同意票數'));
  const invalid = int(pick(/無效票為([\d,]+)票/, '無效票'));
  return [{
    name: null,
    electorate,
    voted,
    turnout_pct: turnout,
    agree,
    disagree,
    invalid,
    // 實錄印的佔比是「同意 ÷ 有效票」，與 2025 公告的「同意 ÷ 選舉人總數」不同 → 記下分母
    printed_share_pct: share,
    printed_share_of: 'valid',
    result_text: null,
  }];
}

/** ODS 一覽表的「總計」列：同意 不同意 有效票 無效票 投票數 已領未投 發出票 用餘票 選舉人數 投票率 */
function parseOdsTotals(buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-'));
  const file = join(dir, 'doc.ods');
  writeFileSync(file, buffer);
  const xml = run('unzip', ['-p', file, 'content.xml']);
  const rows = [];
  for (const row of xml.split(/<table:table-row[\s>]/).slice(1)) {
    const cells = [...row.matchAll(/<table:table-cell[\s\S]*?(?:\/>|<\/table:table-cell>)/g)].map((m) => {
      const texts = [...m[0].matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)].map((t) => t[1].replace(/<[^>]+>/g, ''));
      return texts.join('');
    });
    if (cells[0]?.trim() === '總計') rows.push(cells);
  }
  if (rows.length !== 1) throw new Error(`ODS 應該只有一個「總計」列，找到 ${rows.length} 個`);
  const c = rows[0];
  const [agree, disagree, valid, invalid, voted] = [c[3], c[4], c[5], c[6], c[7]].map(int);
  const electorate = int(c[11]);
  const turnout = Number(String(c[12] ?? '').replace('%', ''));
  if (agree + disagree !== valid) throw new Error(`ODS 總計列不一致：同意＋不同意（${agree + disagree}）≠ 有效票（${valid}）`);
  return [{ name: null, electorate, voted, turnout_pct: turnout, agree, disagree, invalid, printed_share_pct: null, printed_share_of: null, result_text: null }];
}

/** 四道防線；任何一道不過就中止，不寫檔 */
function verifyRow(row, recall, source) {
  const where = row.name ?? `${source.label}（${recall.name}）`;
  if (row.agree + row.disagree > row.voted) throw new Error(`${where}：同意＋不同意（${row.agree + row.disagree}）超過投票人數（${row.voted}）`);
  const invalid = row.invalid ?? row.voted - row.agree - row.disagree;
  if (invalid < 0) throw new Error(`${where}：無效票算出 ${invalid}，不合理`);
  if (row.agree + row.disagree + invalid !== row.voted) throw new Error(`${where}：同意＋不同意＋無效票 ≠ 投票人數`);
  const turnout = Math.round((row.voted / row.electorate) * 10000) / 100;
  if (Math.abs(turnout - row.turnout_pct) > 0.02) throw new Error(`${where}：投票率 ${row.turnout_pct}% 與重算的 ${turnout}% 不符`);
  if (row.printed_share_pct !== null && row.printed_share_pct !== undefined) {
    const denominator = row.printed_share_of === 'valid' ? row.agree + row.disagree : row.electorate;
    const share = Math.round((row.agree / denominator) * 10000) / 100;
    if (Math.abs(share - row.printed_share_pct) > 0.02) throw new Error(`${where}：文件上的同意佔比 ${row.printed_share_pct}% 與重算的 ${share}%（分母 ${row.printed_share_of}）不符`);
  }
  if (row.result_text) {
    const expected = recall.passed ? '通過' : '否決';
    if (row.result_text !== expected && row.result_text !== (recall.passed ? '同意' : '不同意')) {
      throw new Error(`${where}：文件寫「${row.result_text}」但清單結果是 ${expected}`);
    }
  }
  return { ...row, invalid };
}

const data = JSON.parse(readFileSync(RECALLS, 'utf8'));
const byName = new Map(data.recalls.map((r) => [r.name, r]));
const collected = new Map();

for (const source of SOURCES) {
  const targets = source.vote_date
    ? data.recalls.filter((r) => r.vote_date === source.vote_date && !collected.has(r.name))
    : [];
  let buffer = null;
  if (source.kind !== 'manual-image-table') buffer = await download(source.url);

  let rows;
  if (source.kind === 'announcement-pdf') rows = parseAnnouncement(pdfText(buffer));
  else if (source.kind === 'ticket-summary-pdf') rows = parseTicketSummary(pdfText(buffer));
  else if (source.kind === 'record-prose-pdf') rows = parseRecordProse(pdfText(buffer));
  else if (source.kind === 'ods-totals') rows = parseOdsTotals(buffer);
  else if (source.kind === 'manual-image-table') rows = [{ ...source.row, name: targets[0]?.name ?? null }];
  else throw new Error(`未知的 kind：${source.kind}`);

  // 單一案件的文件沒有姓名、靠投票日對案子：那一天必須剛好只有一案，否則會對錯人
  if (source.kind !== 'announcement-pdf' && targets.length !== 1) throw new Error(`${source.label}：投票日 ${source.vote_date} 應對到 1 案，實際 ${targets.length} 案`);
  if (source.expect && rows.length !== source.expect) throw new Error(`${source.label}：預期 ${source.expect} 列，實際 ${rows.length} 列`);
  if (!rows.length) throw new Error(`${source.label}：沒有解析到任何資料列`);

  for (const row of rows) {
    // 公告是一天的所有案子（用姓名對）；單一案件的文件沒有姓名（用投票日對）
    const recall = row.name ? byName.get(row.name) : targets[0];
    if (!recall) throw new Error(`${source.label}：${row.name ?? source.vote_date} 對不到罷免清單`);
    if (recall.vote_date !== source.vote_date) throw new Error(`${recall.name} 的投票日不符：清單 ${recall.vote_date}、文件 ${source.vote_date}`);
    if (collected.has(recall.name)) throw new Error(`${recall.name} 重複出現`);
    const verified = verifyRow(row, recall, source);
    collected.set(recall.name, {
      electorate: verified.electorate,
      voted: verified.voted,
      turnout_pct: verified.turnout_pct,
      agree: verified.agree,
      disagree: verified.disagree,
      invalid: verified.invalid,
      // 統一用「同意 ÷ 選舉人總數」讓跨案可比；文件若印的是別的分母，另外記下來
      agree_share_pct: Math.round((verified.agree / verified.electorate) * 10000) / 100,
      ...(verified.printed_share_pct === null || verified.printed_share_pct === undefined
        ? {}
        : { printed_agree_share: { pct: verified.printed_share_pct, of: verified.printed_share_of } }),
      result_text: verified.result_text ?? (recall.passed ? '通過' : '否決'),
      document: source.label,
      document_url: source.url,
      ...(source.read_from ? { read_from: source.read_from } : {}),
    });
    console.log(`  ✓ ${recall.name}（${recall.vote_date}）：同意 ${verified.agree.toLocaleString()}／不同意 ${verified.disagree.toLocaleString()}，投票率 ${verified.turnout_pct}%`);
  }
}

let changed = 0;
for (const [name, next] of collected) {
  if (JSON.stringify(byName.get(name).results ?? null) !== JSON.stringify(next)) changed += 1;
  if (!checkOnly) byName.get(name).results = next;
}

const missing = data.recalls.filter((r) => !r.results && !collected.has(r.name));
console.log(`[results] 有票數 ${collected.size} 筆／共 ${data.recalls.length} 筆；本次變更 ${changed} 筆`);
if (missing.length) console.log(`[results] 仍缺：${missing.map((r) => `${r.name}(${r.vote_date})`).join('、')}`);

if (checkOnly) {
  console.log(`[results] --check：只比對，未寫檔${changed ? `（${changed} 筆不一致）` : '（全部一致）'}`);
} else {
  data.results_sources = SOURCES.map((s) => ({ vote_date: s.vote_date, label: s.label, url: s.url, kind: s.kind, ...(s.read_from ? { read_from: s.read_from } : {}) }));
  data.results_updated_at = new Date().toISOString();
  writeFileSync(RECALLS, `${JSON.stringify(data)}\n`);
  console.log(`[results] 已更新 ${RECALLS}`);
}
