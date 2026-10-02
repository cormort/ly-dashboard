#!/usr/bin/env node
/**
 * 產生「縣市」分頁用的靜態資料 server/county-stats.json（人口、選舉、地圖輪廓）。
 * 這些資料一年才變一次，不放進同步流程，需要更新時手動重跑：
 *
 *   git clone --depth 1 --filter=blob:none https://github.com/kiang/db.cec.gov.tw.git cec
 *   git clone --depth 1 --filter=blob:none https://github.com/kiang/data.moi.gov.tw.git moi
 *   curl -o twcounty2010.json https://raw.githubusercontent.com/ronnywang/twgeojson/master/twcounty2010.json
 *   node scripts/build-county-stats.mjs --cec cec --moi moi/raw/population/2026/08/data.csv --geo twcounty2010.json
 *
 * 來源：中選會選舉資料庫（kiang/db.cec.gov.tw 轉存）、內政部戶政司村里人口單一年齡（kiang/data.moi.gov.tw 轉存）、
 * ronnywang/twgeojson 縣市界。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    cec: { type: 'string' },
    moi: { type: 'string' },
    geo: { type: 'string' },
    out: { type: 'string', default: 'server/county-stats.json' },
    'legislators-out': { type: 'string', default: 'server/legislator-votes.json' },
  },
});
if (!args.cec || !args.moi || !args.geo) throw new Error('需要 --cec <dir> --moi <data.csv> --geo <geojson>');

const COUNTIES = [
  '基隆市', '臺北市', '新北市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '臺中市', '彰化縣', '南投縣', '雲林縣',
  '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣',
];
const fixName = (name) => (name === '桃園縣' ? '桃園市' : name.replace(/^台/, '臺'));

const rows = (file) =>
  readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/^'/, '').trim()));

/* ---------- 人口 ---------- */
function population(file) {
  const [header, ...data] = rows(file);
  const age0 = header.indexOf('0歲-男');
  const out = new Map();
  for (const r of data) {
    const county = fixName(r[2].slice(0, 3));
    const c = out.get(county) ?? { households: 0, population: 0, voting_age: 0, elderly: 0 };
    c.households += Number(r[4]);
    c.population += Number(r[5]);
    for (let age = 0; age <= 100; age += 1) {
      const n = Number(r[age0 + age * 2]) + Number(r[age0 + age * 2 + 1]);
      if (age >= 20) c.voting_age += n;
      if (age >= 65) c.elderly += n;
    }
    out.set(county, c);
  }
  return { month: data[0][0], counties: out };
}

/* ---------- 選舉（中選會 el* 原始檔） ---------- */
const party = (name) => (!name || name === '無' || name.startsWith('無黨籍') ? '無黨籍' : name);

/** 由候選人得票整理成一場選舉：依票數排序、算出與第二名的差距 */
function summarize(candidates, { electorate = null, turnout = null } = {}) {
  const valid = candidates.reduce((s, c) => s + c.votes, 0);
  const sorted = candidates
    .map((c) => ({ ...c, pct: Math.round((c.votes / valid) * 10000) / 100 }))
    .sort((a, b) => b.votes - a.votes);
  const [first, second] = sorted;
  return {
    electorate,
    turnout,
    valid,
    candidates: sorted,
    margin: second ? first.votes - second.votes : null,
    margin_pct: second ? Math.round((first.pct - second.pct) * 100) / 100 : null,
  };
}

/**
 * 讀一組中選會 el* 原始檔。各年檔名不一（elcand.csv、elcand_T1.csv，2024 區域立委的 elbase 拼成 elbese），
 * 2012／2014 的欄位還帶前導單引號（rows() 已去除）。
 */
function loadCec(dir) {
  const files = readdirSync(dir);
  const file = (...prefixes) => join(dir, files.find((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.csv')));
  const names = new Map(rows(file('elbase', 'elbese')).map((r) => [r.slice(0, 5).join(''), r[5]]));
  const parties = new Map(rows(file('elpaty')).map((r) => [r[0], r[1]]));
  // 號次 → 候選人（只留正手）。全國性選舉以號次對應，地方選舉加上縣市（與選區）代碼
  const cands = new Map();
  // 號次在部分檔案補零（'001'），一律轉成數字字串
  const no = (v) => String(Number(v));
  for (const r of rows(file('elcand'))) {
    if (r[15] === 'Y') continue;
    const cand = { name: r[6], party: party(parties.get(r[7])) };
    if (r[0] === '00') cands.set(`#${no(r[5])}`, cand);
    else {
      cands.set(`${r[0]}${r[1]}${r[2]}#${no(r[5])}`, cand);
      cands.set(`${r[0]}${r[1]}#${no(r[5])}`, cand);
    }
  }
  const candOf = (r) => cands.get(`${r[0]}${r[1]}${r[2]}#${no(r[6])}`) ?? cands.get(`${r[0]}${r[1]}#${no(r[6])}`) ?? cands.get(`#${no(r[6])}`);
  const countyOf = (r) => fixName(names.get(`${r[0]}${r[1]}000000000`));
  // 選區（或縣市）合計列：鄉鎮、村里、投開票所代碼皆為 0
  // 2018 以前部分檔案的投開票所代碼寫成 '0'，以數值判斷
  const isTotal = (r) => Number(r[3]) === 0 && Number(r[4]) === 0 && Number(r[5]) === 0;
  const all = rows(file('elctks'));
  const totals = all.filter(isTotal);
  const prof = rows(file('elprof')).filter(isTotal);
  return { candOf, countyOf, totals, prof, all };
}

/** 縣市層級結果（總統、縣市長、不分區政黨票） */
function cecElection(dir) {
  const { candOf, countyOf, totals, prof } = loadCec(dir);
  const isCounty = (r) => Number(r[0]) !== 0 && Number(r[2]) === 0;
  const out = new Map();
  for (const r of totals.filter(isCounty)) {
    const county = countyOf(r);
    out.set(county, [...(out.get(county) ?? []), { ...candOf(r), votes: Number(r[7]) }]);
  }
  const meta = new Map(prof.filter(isCounty).map((r) => [countyOf(r), { electorate: Number(r[9]), turnout: Number(r[18]) }]));
  return new Map([...out].map(([county, list]) => [county, summarize(list, meta.get(county))]));
}

/** 立委選舉各選區結果：區域（縣市第 N 選舉區）或平地／山地原住民（全國一區） */
function districtRaces(dir, year, kind) {
  const { candOf, countyOf, totals } = loadCec(dir);
  const isRace = kind === '區域' ? (r) => Number(r[0]) !== 0 && Number(r[2]) !== 0 : (r) => Number(r[0]) === 0;
  const races = new Map();
  for (const r of totals.filter(isRace)) {
    const key = r.slice(0, 3).join('');
    const race = races.get(key) ?? { year, kind, key, county: kind === '區域' ? countyOf(r) : null, area: Number(r[2]), list: [] };
    race.list.push({ ...candOf(r), votes: Number(r[7]), elected: r[9] === '*' });
    races.set(key, race);
  }
  const perCounty = new Map();
  for (const race of races.values()) perCounty.set(race.county, (perCounty.get(race.county) ?? 0) + 1);
  return [...races.values()].map(({ list, area, ...race }) => {
    const { candidates, valid, margin, margin_pct } = summarize(list);
    const district = kind !== '區域' ? `${kind}選舉區` : perCounty.get(race.county) > 1 ? `${race.county}第${area}選舉區` : `${race.county}選舉區`;
    return { ...race, district, valid, margin, margin_pct, candidates };
  });
}

/**
 * 依立委選區加總同日的總統票與不分區政黨票：同一天投票、投開票所代碼相同，
 * 以區域立委檔的投開票所 → 選區對照，把總統／政黨票逐所歸到選區。回傳 Map(選區代碼 → { president, party_list })。
 */
function districtPartyVotes(dir) {
  const station = (r) => [r[0], r[1], r[3], r[4], Number(r[5])].join('-');
  const isStation = (r) => Number(r[5]) !== 0;
  const toDistrict = new Map();
  for (const r of rows(join(dir, '區域立委', readdirSync(join(dir, '區域立委')).find((f) => f.startsWith('elctks'))))) {
    if (isStation(r)) toDistrict.set(station(r), `${r[0]}${r[1]}${r[2]}`);
  }
  const out = new Map();
  let missing = 0;
  for (const [type, sub] of [['president', '總統'], ['party_list', '不分區政黨']]) {
    const { candOf, all } = loadCec(join(dir, sub));
    for (const r of all.filter(isStation)) {
      const district = toDistrict.get(station(r));
      if (!district) {
        missing += 1;
        continue;
      }
      const entry = out.get(district) ?? { president: { valid: 0, votes: {} }, party_list: { valid: 0, votes: {} } };
      const bucket = entry[type];
      const { party: p } = candOf(r);
      bucket.valid += Number(r[7]);
      bucket.votes[p] = (bucket.votes[p] ?? 0) + Number(r[7]);
      out.set(district, entry);
    }
  }
  if (missing) console.warn(`${dir}：${missing} 筆投開票所對不到立委選區（略過）`);
  return out;
}

/** 含引號欄位的 CSV（補選明細的數字寫成 "1,141"）；UTF-8 解不開時改用 Big5 */
function readCsv(file) {
  const buf = readFileSync(file);
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) text = new TextDecoder('big5').decode(buf);
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => (m[2] ?? m[1]).trim()).slice(0, -1));
}

/**
 * 立委補選。2015 為 el* 原始檔（資料夾名如「2015台中市6」），2019 起為投開票所明細（cand.csv + prof.csv，
 * 資料夾名如「2023第10屆立法委員臺北市第3選舉區缺額補選」）。
 */
function byElections() {
  const out = [];
  const old = cec('立委補選');
  for (const name of readdirSync(old).filter((n) => /^2015/.test(n))) {
    const [, county, area] = name.match(/^2015(.{3})(\d*)$/);
    const district = `${fixName(county)}${area ? `第${area}` : ''}選舉區`;
    for (const race of districtRaces(join(old, name), 2015, '區域')) out.push({ ...race, district, by_election: true });
  }
  const recent = cec('立委補選(2019年後)');
  for (const name of readdirSync(recent)) {
    const [, year, district] = name.match(/^(\d{4})第\d+屆立法委員(.+?)缺額補選$/);
    const cands = readCsv(join(recent, name, 'cand.csv')).slice(1);
    const stations = readCsv(join(recent, name, 'prof.csv')).filter((r) => /^\d+$/.test(r[2]));
    const list = cands.map((c, i) => ({
      name: c[1],
      party: party(c[2]),
      votes: stations.reduce((sum, r) => sum + Number(r[3 + i].replace(/,/g, '')), 0),
    }));
    const top = Math.max(...list.map((c) => c.votes));
    const { candidates, valid, margin, margin_pct } = summarize(list.map((c) => ({ ...c, elected: c.votes === top })));
    out.push({ year: Number(year), kind: '區域', county: fixName(district.slice(0, 3)), district: fixName(district), valid, margin, margin_pct, candidates, by_election: true });
  }
  return out;
}

/** 每個縣市的歷次得票（依政黨加總），給「得票趨勢」用 */
function series(byYear) {
  const out = new Map();
  for (const [year, results] of byYear) {
    for (const [county, e] of results) {
      const votes = {};
      for (const c of e.candidates) votes[c.party] = (votes[c.party] ?? 0) + c.votes;
      const label = year === 2010 ? '2009／10' : String(year);
      out.set(county, [...(out.get(county) ?? []), { year, label, valid: e.valid, turnout: e.turnout, votes }]);
    }
  }
  return out;
}

/** 2022 嘉義市長延期重行選舉，只有投開票所明細 */
function chiayiRerun(dir) {
  const cands = rows(join(dir, 'cand.csv')).slice(1);
  const [, ...data] = rows(join(dir, 'prof.csv'));
  const votes = cands.map((_, i) => data.reduce((s, r) => s + Number(r[3 + i]), 0));
  const electorate = data.reduce((s, r) => s + Number(r[14]), 0);
  const cast = data.reduce((s, r) => s + Number(r[10]), 0);
  return summarize(
    cands.map((c, i) => ({ name: c[1], party: party(c[2]), votes: votes[i] })),
    { electorate, turnout: Math.round((cast / electorate) * 10000) / 100 },
  );
}

/* ---------- 地圖：投影成 SVG path，並以 Douglas–Peucker 簡化 ---------- */
const SCALE = 200; // 1 度 ≈ 200 單位
const COS = Math.cos((23.7 * Math.PI) / 180);
// 金門、連江離本島太遠，平移到臺灣海峽的空白處當插圖
const SHIFT = { 金門縣: [1.05, 0.05], 連江縣: [-0.55, -0.95] };

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  let max = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i];
    const len = Math.hypot(bx - ax, by - ay);
    // 封閉環首尾同點，改用到起點的距離
    const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

function mapPaths(file) {
  const geo = JSON.parse(readFileSync(file, 'utf8'));
  const paths = {};
  for (const feature of geo.features) {
    const county = fixName(feature.properties.county);
    const [dx, dy] = SHIFT[county] ?? [0, 0];
    const rings = feature.geometry.coordinates.flatMap((polygon) => polygon.slice(0, 1));
    paths[county] = rings
      .map((ring) => ring.map(([lon, lat]) => [(lon + dx - 119.2) * COS * SCALE, (25.5 - lat - dy) * SCALE]))
      .filter((ring) => {
        // 太小的小島略過，避免 path 過大
        const xs = ring.map((p) => p[0]);
        const ys = ring.map((p) => p[1]);
        return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) > 1.2;
      })
      .map((ring) => simplify(ring, 0.35))
      .filter((ring) => ring.length >= 4)
      .map((ring) => `M${ring.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`)
      .join('');
  }
  return paths;
}

/* ---------- 組合 ---------- */
const cec = (path) => join(args.cec, 'voteData', path);
const PRESIDENT = { 2012: '20120114-總統及立委', 2016: '2016總統立委', 2020: '2020總統立委', 2024: '2024總統立委' };
const both = (...maps) => new Map(maps.flatMap((m) => [...m]));

const pop = population(args.moi);
const president = new Map(Object.entries(PRESIDENT).map(([year, dir]) => [Number(year), cecElection(cec(`${dir}/總統`))]));
const partyList = new Map(Object.entries(PRESIDENT).map(([year, dir]) => [Number(year), cecElection(cec(`${dir}/不分區政黨`))]));
const mayor = new Map([
  // 2009 縣市長（17 縣市）與 2010 五都市長合為同一輪，年份記 2010、標示「2009／10」
  [2010, both(cecElection(cec('20091205-縣市長縣市議員及鄉鎮長/縣市長')), cecElection(cec('20101127-五都市長議員及里長/市長')))],
  [2014, both(cecElection(cec('2014-103年地方公職人員選舉/直轄市市長')), cecElection(cec('2014-103年地方公職人員選舉/縣市市長')))],
  [2018, both(cecElection(cec('2018-107年地方公職人員選舉/直轄市市長')), cecElection(cec('2018-107年地方公職人員選舉/縣市市長')))],
  [
    2022,
    both(
      cecElection(cec('2022-111年地方公職人員選舉/C1/prv')),
      cecElection(cec('2022-111年地方公職人員選舉/C1/city')),
      new Map([['嘉義市', chiayiRerun(cec('2022年_嘉義市長重行選舉'))]]),
    ),
  ],
]);
const trends = { president: series(president), mayor: series(mayor), party_list: series(partyList) };
const paths = mapPaths(args.geo);

const counties = COUNTIES.map((county) => {
  const elections = {
    president_2024: president.get(2024).get(county),
    president_2020: president.get(2020).get(county),
    mayor_2022: mayor.get(2022).get(county),
    mayor_2018: mayor.get(2018).get(county),
  };
  const p = pop.counties.get(county);
  const parts = [p, ...Object.values(elections), paths[county], ...Object.values(trends).map((t) => t.get(county))];
  if (parts.some((x) => !x)) throw new Error(`${county} 資料不完整：${parts.map((x) => (x ? 1 : 0)).join('')}`);
  return {
    county,
    ...p,
    elections,
    trends: Object.fromEntries(Object.entries(trends).map(([type, t]) => [type, t.get(county)])),
    path: paths[county],
  };
});

const month = `${Number(pop.month.slice(0, 3)) + 1911}-${pop.month.slice(3)}`;
const sources = [
  { label: '中選會選舉資料庫（kiang/db.cec.gov.tw 轉存）', url: 'https://github.com/kiang/db.cec.gov.tw' },
  { label: `內政部戶政司村里人口單一年齡（${month}）`, url: 'https://github.com/kiang/data.moi.gov.tw' },
  { label: '縣市界（ronnywang/twgeojson）', url: 'https://github.com/ronnywang/twgeojson' },
];
writeFileSync(
  args.out,
  `${JSON.stringify({
    population_month: month,
    elections: {
      president_2024: { label: '2024 總統', date: '2024-01-13' },
      president_2020: { label: '2020 總統', date: '2020-01-11' },
      mayor_2022: { label: '2022 縣市長', date: '2022-11-26' },
      mayor_2018: { label: '2018 縣市長', date: '2018-11-24' },
    },
    trend_types: { president: '總統', mayor: '縣市長', party_list: '不分區政黨票' },
    sources,
    counties,
  })}\n`,
);
console.log(`wrote ${args.out}: ${counties.length} 縣市，人口 ${month}`);

/* ---------- 立委選舉（區域、平地／山地原住民），2012 起 ---------- */
const races = Object.entries(PRESIDENT).flatMap(([year, dir]) => [
  // 區域立委附上同選區的總統票與政黨票（個人票對照政黨票用）
  ...(() => {
    const partyVotes = districtPartyVotes(cec(dir));
    return districtRaces(cec(`${dir}/區域立委`), Number(year), '區域').map((race) => ({ ...race, party_votes: partyVotes.get(race.key) }));
  })(),
  ...districtRaces(cec(`${dir}/平地立委`), Number(year), '平地原住民'),
  ...districtRaces(cec(`${dir}/山地立委`), Number(year), '山地原住民'),
]).concat(byElections()).map(({ key, ...race }) => race);
writeFileSync(args['legislators-out'], `${JSON.stringify({ years: Object.keys(PRESIDENT).map(Number), sources: sources.slice(0, 1), races })}\n`);
console.log(`wrote ${args['legislators-out']}: ${races.length} 場`);
