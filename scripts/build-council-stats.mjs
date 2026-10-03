#!/usr/bin/env node
/**
 * 產生「議員」分頁用的靜態資料 server/council-stats.json：直轄市議員選舉結果。
 *
 * 這些資料幾年到一次，不放進每日同步流程，需要更新時手動重跑（同 county-stats.json 的做法）：
 *
 *   node scripts/fetch-cec-council.mjs              # 抓中選會原始檔到 .cache/cec-council
 *   node scripts/build-council-stats.mjs            # 預設做「新北市」
 *   node scripts/build-council-stats.mjs --county 臺北市
 *
 * 來源：中選會選舉資料庫（kiang/db.cec.gov.tw 轉存）。只涵蓋直轄市議員；縣市議員在另一個目錄，
 * 尚未納入（見 README「資料限制」）。
 *
 * 目前納入四屆：2010（第1屆）／2014（第2屆）／2018（第3屆）／2022（第4屆）。
 * 2010 是新北市升格後第一次選議員，四屆的區域議員都是 62 席，加上平地原住民 3 席、
 * 山地原住民 1 席，合計 66 席。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ELECTIONS } from './fetch-cec-council.mjs';

const { values: args } = parseArgs({
  options: {
    cache: { type: 'string', default: '.cache/cec-council' },
    county: { type: 'string', multiple: true },
    out: { type: 'string', default: 'server/council-stats.json' },
  },
});

const KIND_LABEL = { area: '區域', plain: '平地原住民', mountain: '山地原住民' };

/**
 * 各縣市的屆次編號與席次期望值。
 *
 * 屆次編號各縣市不同：新北市 2010 才升格，那一年是第 1 屆；臺北市 2010 是第 11 屆。
 * 席次期望值是**驗證用的**（fail closed）：來源檔案解析錯了、或某屆的選區被重劃，
 * 寧可整支 build 停下來，也不要讓錯的席次結構出貨。
 *
 * 來源與佐證：
 * - 新北市：四屆皆 66 席（區域 62、平地原住民 3、山地原住民 1）。
 * - 臺北市：第 11 屆（2010）62 席、第 12／13 屆（2014／2018）63 席、
 *   第 14 屆（2022）起 61 席（人口跌破 250 萬，士林北投與松山信義各減 1 席）。
 */
export const COUNTY_META = {
  新北市: {
    terms: { 2010: 1, 2014: 2, 2018: 3, 2022: 4 },
    seats: {
      2010: { area: 62, plain: 3, mountain: 1 },
      2014: { area: 62, plain: 3, mountain: 1 },
      2018: { area: 62, plain: 3, mountain: 1 },
      2022: { area: 62, plain: 3, mountain: 1 },
    },
  },
  臺北市: {
    terms: { 2010: 11, 2014: 12, 2018: 13, 2022: 14 },
    seats: {
      2010: { area: 60, plain: 1, mountain: 1 },
      2014: { area: 61, plain: 1, mountain: 1 },
      2018: { area: 61, plain: 1, mountain: 1 },
      2022: { area: 59, plain: 1, mountain: 1 },
    },
  },
};
/** 中選會檔名各年不一，欄位也曾調換（見 build()）；一律用前綴找檔 */
const FILES = ['elbase', 'elcand', 'elctks', 'elpaty', 'elprof'];

const rows = (file) =>
  readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/^'/, '').trim()));

/** 臺／台 混用是各年檔案的老問題，統一成「臺」 */
const fixName = (name) => String(name ?? '').replace(/^台/, '臺');

const round2 = (n) => Math.round(n * 100) / 100;
/**
 * 姓名比對用的鍵：原住民姓名的分隔符號各屆寫法不一，一律去掉。
 *
 * 另外中選會各屆檔案對同一個人的字形寫法也不同（實測：2018 寫「戴瑋姍」、2022 寫「戴瑋姗」），
 * 只用字串相等比對會把連任者誤判成「這一屆沒參選」。這裡只放**已實際觀察到**的字形差異，
 * 不是通用異體字表；新的差異會被下面的 `variantSuspects()` 抓出來放進 warnings。
 */
const NAME_ALIASES = new Map([['姗', '姍']]);
const nameKey = (name) =>
  String(name)
    .replace(/[\s‧·・．.]/g, '')
    .replace(/[\u{1F000}-\u{10FFFF}]/gu, (ch) => ch)
    .replace(/姗/g, (ch) => NAME_ALIASES.get(ch) ?? ch);

/** 上一屆當選、這一屆沒參選的人裡，有沒有跟某位候選人只差一個字的（＝可能是字形差異沒收進 alias） */
function variantSuspects(prevWinners, currentNames) {
  const out = [];
  for (const name of prevWinners.keys()) {
    if (currentNames.has(name) || name.length < 2) continue;
    for (const other of currentNames) {
      if (other.length !== name.length) continue;
      let diff = 0;
      for (let i = 0; i < name.length && diff <= 1; i += 1) if (name[i] !== other[i]) diff += 1;
      if (diff === 1) out.push(`${name} ↔ ${other}`);
    }
  }
  return out;
}

/** 政黨：中選會代碼查不到時**不可以**回「無黨籍」，那會產生看起來很合理的錯數字（同 build-county-stats 的 D60） */
function makePartyLookup(parties, missing) {
  return (code) => {
    const name = parties.get(String(code));
    if (!name) {
      missing.add(String(code));
      return `未知(${code})`;
    }
    if (name.startsWith('無黨籍') || name === '無') return '無黨籍';
    return name;
  };
}

/** 讀一組中選會 el* 原始檔 */
function loadElection(dir) {
  const files = new Map(FILES.map((prefix) => [prefix, join(dir, `${prefix}.csv`)]));
  return {
    names: new Map(rows(files.get('elbase')).map((r) => [r.slice(0, 5).join(''), fixName(r[5])])),
    parties: new Map(rows(files.get('elpaty')).map((r) => [r[0], r[1]])),
    cands: rows(files.get('elcand')),
    totals: rows(files.get('elctks')).filter((r) => Number(r[3]) === 0 && Number(r[4]) === 0 && Number(r[5]) === 0),
    prof: rows(files.get('elprof')).filter((r) => Number(r[3]) === 0 && Number(r[4]) === 0 && Number(r[5]) === 0),
    base: rows(files.get('elbase')),
  };
}

/** elprof 的欄位（四屆一致）：6 有效票、7 無效票、8 投票數、9 選舉人數、10 人口數、18 投票率 */
const profStats = (r) => ({
  valid: Number(r[6]),
  invalid: Number(r[7]),
  ballots: Number(r[8]),
  electorate: Number(r[9]),
  population: Number(r[10]),
  turnout: Number(r[18]),
});

/**
 * 一個縣市在一屆選舉的一個選舉種類（區域／平地原住民／山地原住民）下的所有選舉區。
 *
 * 注意：`elctks` 的選區合計列帶著候選人的選區別，2010–2018 的原住民選舉區編在 11／12，
 * 2022 因為新北市區域選區由 10 個分成 11 個而變成 12／13 —— 一律以檔內的號碼為準，不寫死。
 */
function buildKind(data, countyCode, countyName, kind, districtNumbers) {
  const { names, cands, totals, prof } = data;
  // 這幾個檔包含所有直轄市，key 一定要帶縣市代碼：只用「選區#號次」會讓不同縣市的同號候選人互相蓋掉
  const mine = (r) => r[0] === countyCode;
  const cityTotals = totals.filter(mine);
  const cityProf = prof.filter(mine);
  const byNo = new Map(cityTotals.map((r) => [`${r[2]}#${Number(r[6])}`, { votes: Number(r[7]), pct: Number(r[8]), elected: r[9] === '*' }]));
  const candidates = cands.filter((r) => mine(r) && districtNumbers.has(r[2]));
  const districts = [];
  for (const no of [...districtNumbers].sort()) {
    const list = candidates
      .filter((c) => c[2] === no)
      .map((c) => {
        const ticket = byNo.get(`${no}#${Number(c[5])}`);
        if (!ticket) throw new Error(`${countyName} ${kind} 選舉區 ${no} 號次 ${c[5]}（${c[6]}）查不到得票`);
        // 兩個檔都要說同一個人當選，對不上就是解析錯了，不要猜
        if ((c[14] === '*') !== ticket.elected) {
          throw new Error(`${countyName} ${kind} 選舉區 ${no} 號次 ${c[5]}（${c[6]}）的當選註記在 elcand 與 elctks 不一致`);
        }
        return {
          no: Number(c[5]),
          name: c[6],
          party: data.partyOf(c[7]),
          gender: c[8] === '2' ? '女' : '男',
          age: Number(c[10]) || null,
          education: c[12] || null,
          elected: ticket.elected,
          incumbent: c[13] === 'Y' ? true : c[13] === 'N' ? false : null,
          votes: ticket.votes,
        };
      })
      .sort((a, b) => b.votes - a.votes || a.no - b.no);
    const total = cityProf.find((r) => (kind === 'area' ? r[2] === no : Number(r[2]) === 0 || r[2] === no));
    if (!total) throw new Error(`${countyName} ${kind} 選舉區 ${no} 查不到選舉人數`);
    const stats = profStats(total);
    const valid = list.reduce((s, c) => s + c.votes, 0);
    if (valid !== stats.valid) throw new Error(`${countyName} ${kind} 選舉區 ${no} 得票合計 ${valid} 與 elprof 有效票 ${stats.valid} 不符`);
    const area = kind !== 'area' ? [] : [...new Set(data.base.filter((r) => mine(r) && r[2] === no && Number(r[3]) !== 0 && Number(r[4]) === 0).map((r) => fixName(r[5])))];
    const winners = list.filter((c) => c.elected);
    const losers = list.filter((c) => !c.elected);
    districts.push({
      no,
      kind,
      name: kind === 'area' ? `第${Number(no)}選舉區` : `${KIND_LABEL[kind]}選舉區`,
      area,
      ...stats,
      seats: winners.length,
      candidate_count: list.length,
      list: list.map((c) => ({ ...c, pct: round2((c.votes / valid) * 100) })),
      last_winner: winners.at(-1) ? { name: winners.at(-1).name, party: winners.at(-1).party, votes: winners.at(-1).votes, pct: round2((winners.at(-1).votes / valid) * 100) } : null,
      first_loser: losers[0] ? { name: losers[0].name, party: losers[0].party, votes: losers[0].votes, pct: round2((losers[0].votes / valid) * 100), margin: winners.at(-1) ? winners.at(-1).votes - losers[0].votes : null } : null,
    });
  }
  const seats = districts.reduce((s, d) => s + d.seats, 0);
  // 原住民選舉種類的 elprof 只有一列，把它當成整個種類的合計
  const whole = cityProf.find((r) => r[2] === '00') ?? cityProf.find((r) => districtNumbers.has(r[2]));
  return { kind, label: KIND_LABEL[kind], seats, districts, ...(whole ? profStats(whole) : {}), candidate_count: candidates.length };
}

function build(yearDir, election, countyName, termNo) {
  const kinds = {};
  for (const [kind, dir] of Object.entries(election.dirs)) {
    const data = loadElection(join(yearDir, kind));
    const countyCode = [...data.names].find(([, name]) => name === countyName)?.[0].slice(0, 2);
    if (!countyCode) throw new Error(`${election.year} ${kind}：找不到縣市「${countyName}」`);
    data.partyOf = makePartyLookup(data.parties, build.missingParties);
    // 候選人的選區別就是這份檔案的選舉區；不要自己假設 01..N
    const numbers = new Set(data.cands.filter((r) => r[0] === countyCode).map((r) => r[2]));
    kinds[kind] = buildKind(data, countyCode, countyName, kind, numbers);
  }
  const districts = Object.values(kinds).flatMap((k) => k.districts);
  const all = districts.flatMap((d) => d.list);
  const seats = districts.reduce((s, d) => s + d.seats, 0);
  const area = kinds.area;
  // 全市：區域的選舉人數不含原住民選舉人（原住民另有選舉區），所以不要把三個種類加起來當「總選舉人數」
  const parties = new Map();
  for (const c of all) {
    const p = parties.get(c.party) ?? { party: c.party, seats: 0, votes: 0, candidates: 0 };
    p.candidates += 1;
    p.votes += c.votes;
    if (c.elected) p.seats += 1;
    parties.set(c.party, p);
  }
  const valid = all.reduce((s, c) => s + c.votes, 0);
  const sorted = [...parties.values()].map((p) => ({ ...p, pct: round2((p.votes / valid) * 100), seat_pct: round2((p.seats / seats) * 100) })).sort((a, b) => b.seats - a.seats || b.votes - a.votes);
  const winners = all.filter((c) => c.elected).sort((a, b) => b.votes - a.votes);
  const losers = all.filter((c) => !c.elected).sort((a, b) => b.votes - a.votes);
  return {
    year: election.year,
    term: termNo,
    date: election.date,
    label: `第${termNo}屆`,
    seats,
    kinds: Object.values(kinds).map(({ districts: _d, ...rest }) => rest),
    districts,
    parties: sorted,
    valid,
    stats: {
      candidates: all.length,
      top: winners[0] ? { ...winners[0], district: districts.find((d) => d.list.includes(winners[0]))?.name } : null,
      lowest_winner: winners.at(-1) ? { ...winners.at(-1) } : null,
      highest_loser: losers[0] ? { ...losers[0] } : null,
      area_electorate: area.electorate ?? null,
      area_turnout: area.turnout ?? null,
    },
  };
}

build.missingParties = new Set();

/** 同一屆裡同名不同人：先記錄不強修（同 D63），但要讓它可見 */
function duplicateNames(terms) {
  const out = [];
  for (const t of terms) {
    const seen = new Map();
    for (const d of t.districts) {
      for (const c of d.list) {
        const key = nameKey(c.name);
        if (seen.has(key) && seen.get(key) !== d.name) out.push(`${t.year} ${key}：${seen.get(key)}／${d.name}`);
        else seen.set(key, d.name);
      }
    }
  }
  return out;
}

/**
 * 與前一屆比較：政黨席次消長、現任連任／落馬、新人當選。
 *
 * 「現任」優先用中選會 elcand 的現任欄位（2014 起才有），2010 那一屆整欄都是 N，
 * 只能退回「前一屆的當選名單」。兩者不一致時一律採用中選會欄位並留下警告 ——
 * 姓名的字形差異會讓比對失準，實測 2018 的「戴瑋姍」在 2022 的檔案裡寫成「戴瑋姗」，
 * 用姓名比對會把她算成新任，而她其實是連任（還換了選區）。
 */
function compare(term, prev) {
  if (!prev) return null;
  const prevWinners = new Map(prev.districts.flatMap((d) => d.list.filter((c) => c.elected).map((c) => [nameKey(c.name), { ...c, district: d.name, kind: d.kind }])));
  const partySeat = (t) => new Map(t.parties.map((p) => [p.party, p]));
  const now = partySeat(term);
  const before = partySeat(prev);
  const parties = [...new Set([...now.keys(), ...before.keys()])]
    .map((party) => ({
      party,
      seats: now.get(party)?.seats ?? 0,
      prev_seats: before.get(party)?.seats ?? 0,
      delta: (now.get(party)?.seats ?? 0) - (before.get(party)?.seats ?? 0),
      votes: now.get(party)?.votes ?? 0,
      pct: now.get(party)?.pct ?? 0,
    }))
    .sort((a, b) => b.seats - a.seats || b.votes - a.votes);
  const winners = term.districts.flatMap((d) => d.list.filter((c) => c.elected).map((c) => ({ ...c, district: d.name, kind: d.kind })));
  const all = term.districts.flatMap((d) => d.list.map((c) => ({ ...c, district: d.name, kind: d.kind })));
  const byName = (key) => prevWinners.has(key);
  const hasFlag = all.some((c) => c.incumbent !== null);
  const wasIncumbent = (c) => (hasFlag ? c.incumbent === true : byName(nameKey(c.name)));
  // 兩個方法不一致時採用中選會欄位，並把差異數記下來（D63：先記錄、不強修）。
  // 不一致有正常理由：遞補當選、補選、換選區，所以不是錯誤，只是要讓人看得見認定依據。
  const mismatch = hasFlag ? all.filter((c) => c.incumbent !== null && byName(nameKey(c.name)) !== (c.incumbent === true)).map((c) => c.name) : [];
  // 上一屆當選、這一屆沒有出現在候選人裡。現任欄位說他有參選的就排除，
  // 免得姓名字形差異（戴瑋姍／戴瑋姗）把他誤判成退選。
  const nowNames = new Set(all.map((c) => nameKey(c.name)));
  const incumbentNow = new Set(all.filter((c) => c.incumbent === true).map((c) => nameKey(c.name)));
  return {
    year: prev.year,
    label: prev.label,
    parties,
    re_elected: winners.filter(wasIncumbent).length,
    defeated_incumbents: all
      .filter((c) => !c.elected && wasIncumbent(c))
      .sort((a, b) => b.votes - a.votes)
      .map((c) => ({ name: c.name, party: c.party, district: c.district, votes: c.votes, pct: c.pct })),
    freshmen: winners.filter((c) => !wasIncumbent(c)).length,
    not_running: [...prevWinners.values()]
      .filter((p) => !nowNames.has(nameKey(p.name)) && !incumbentNow.has(nameKey(p.name)))
      .map((p) => ({ name: p.name, party: p.party, district: p.district })),
    name_variant_suspects: variantSuspects(prevWinners, nowNames),
    // 中選會欄位缺漏（2010 整屆）時，「現任」只能靠姓名比對，講清楚
    incumbent_source: hasFlag ? 'cec' : 'name_match',
    incumbent_mismatch: mismatch,
  };
}

/** 一個縣市的完整資料：四屆的結果與跨屆比較 */
function buildCounty(countyName) {
  const meta = COUNTY_META[countyName];
  if (!meta) throw new Error(`沒有「${countyName}」的屆次與席次設定，請先在 COUNTY_META 補上再重跑`);
  const terms = [];
  for (const election of [...ELECTIONS].sort((a, b) => b.year - a.year)) {
    const termNo = meta.terms[election.year];
    if (!termNo) throw new Error(`${countyName} 沒有 ${election.year} 的屆次編號`);
    terms.push(build(join(args.cache, String(election.year)), election, countyName, termNo));
  }
  // 席次是這個功能的骨幹，錯了整個分析都會歪 —— 直接擋下來
  for (const t of terms) {
    const expected = meta.seats[t.year];
    if (!expected) throw new Error(`${countyName} 沒有 ${t.year} 的席次期望值`);
    for (const k of t.kinds) {
      if (k.seats !== expected[k.kind]) throw new Error(`${countyName} ${t.year} ${k.label} 席次 ${k.seats}，預期 ${expected[k.kind]}`);
    }
    const total = Object.values(expected).reduce((a, b) => a + b, 0);
    if (t.seats !== total) throw new Error(`${countyName} ${t.year} 總席次 ${t.seats}，預期 ${total}`);
  }
  const withCompare = terms.map((t) => ({ ...t, compare: compare(t, terms.find((p) => p.year === t.year - 4) ?? null) }));
  return { county: countyName, terms: withCompare, duplicates: duplicateNames(terms) };
}

function main() {
  const counties = (args.county?.length ? args.county : Object.keys(COUNTY_META)).map(fixName);
  const built = counties.map(buildCounty);
  if (build.missingParties.size) {
    throw new Error(`有查不到的政黨代號，請補上對照後再重跑：${[...build.missingParties].join(', ')}`);
  }
  const payload = {
    built_at: new Date().toISOString(),
    source: { label: '中選會選舉資料庫（kiang/db.cec.gov.tw 轉存）', url: 'https://github.com/kiang/db.cec.gov.tw' },
    note: '直轄市議員選舉。屆次編號各縣市不同（新北市 2010 升格後為第 1 屆，臺北市同一年是第 11 屆）。區域議員選舉人數不含原住民選舉人（原住民另有選舉區）。',
    counties: built.map(({ county, terms }) => ({ county, terms })),
    warnings: built.flatMap(({ county, duplicates }) => duplicates.map((d) => `${county} 同屆同名不同選區：${d}`)),
  };
  const tmp = `${args.out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`);
  renameSync(tmp, args.out);
  for (const { county, terms } of built) {
    for (const t of terms) {
      console.log(`${county} ${t.year} ${t.label}：${t.seats} 席（${t.kinds.map((k) => `${k.label} ${k.seats}`).join('／')}）、候選 ${t.stats.candidates} 人、政黨 ${t.parties.length} 個`);
    }
  }
  for (const w of payload.warnings) console.log(`警告：${w}`);
  // 疑似字形差異只是「請人工確認」的清單（實測都是不同人），所以不進 warnings、也不顯示在頁面上
  for (const { county, terms } of built) {
    for (const t of terms) {
      if (t.compare?.name_variant_suspects.length) {
        console.log(`待確認（${county} ${t.year} 與 ${t.compare.year} 的姓名只差一個字，可能只是不同人）：${t.compare.name_variant_suspects.join('、')}`);
      }
    }
  }
  console.log(`寫入 ${args.out}（${built.map((b) => b.county).join('、')}）`);
}

main();
