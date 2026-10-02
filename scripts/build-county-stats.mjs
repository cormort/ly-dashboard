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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { cec: { type: 'string' }, moi: { type: 'string' }, geo: { type: 'string' }, out: { type: 'string', default: 'server/county-stats.json' } },
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
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()));

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

function cecElection(dir) {
  const names = new Map(rows(join(dir, 'elbase.csv')).map((r) => [`${r[0]}${r[1]}${r[2]}${r[3]}${r[4]}`, r[5]]));
  const parties = new Map(rows(join(dir, 'elpaty.csv')).map((r) => [r[0], r[1]]));
  // 號次 → 候選人（總統選舉只留正手；縣市長以縣市代碼區分）
  const cands = new Map();
  for (const r of rows(join(dir, 'elcand.csv'))) {
    if (r[15] === 'Y') continue;
    cands.set(r[0] === '00' ? r[5] : `${r[0]}${r[1]}#${r[5]}`, { name: r[6], party: party(parties.get(r[7])) });
  }
  const out = new Map();
  const isCountyTotal = (r) => r[0] !== '00' && r[3] === '000' && r[4] === '0000' && r[5] === '0000';
  for (const r of rows(join(dir, 'elctks.csv')).filter(isCountyTotal)) {
    const county = fixName(names.get(`${r[0]}${r[1]}00${r[3]}${r[4]}`));
    const cand = cands.get(r[6]) ?? cands.get(`${r[0]}${r[1]}#${r[6]}`);
    const list = out.get(county) ?? [];
    list.push({ ...cand, votes: Number(r[7]) });
    out.set(county, list);
  }
  const prof = new Map();
  for (const r of rows(join(dir, 'elprof.csv')).filter(isCountyTotal)) {
    prof.set(fixName(names.get(`${r[0]}${r[1]}00${r[3]}${r[4]}`)), { electorate: Number(r[9]), turnout: Number(r[18]) });
  }
  return new Map([...out].map(([county, list]) => [county, summarize(list, prof.get(county))]));
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

/** 2018 縣市長只有 kiang 整理的候選人總表（沒有選舉人數） */
function summaryCsv(files) {
  const out = new Map();
  for (const file of files) {
    for (const r of rows(file).slice(1)) {
      const county = fixName(r[0]);
      const list = out.get(county) ?? [];
      list.push({ name: r[2], party: party(r[3]), votes: Number(r[11]) });
      out.set(county, list);
    }
  }
  return new Map([...out].map(([county, list]) => [county, summarize(list)]));
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
const pop = population(args.moi);
const president2024 = cecElection(join(args.cec, 'voteData/2024總統立委/總統'));
const president2020 = cecElection(join(args.cec, 'voteData/2020總統立委/總統'));
const mayor2022 = new Map([
  ...cecElection(join(args.cec, 'voteData/2022-111年地方公職人員選舉/C1/prv')),
  ...cecElection(join(args.cec, 'voteData/2022-111年地方公職人員選舉/C1/city')),
  ['嘉義市', chiayiRerun(join(args.cec, 'voteData/2022年_嘉義市長重行選舉'))],
]);
const mayor2018 = summaryCsv([join(args.cec, 'data/2018/直轄市長.csv'), join(args.cec, 'data/2018/縣市長.csv')]);
const paths = mapPaths(args.geo);

const counties = COUNTIES.map((county) => {
  const p = pop.counties.get(county);
  const missing = [p, president2024.get(county), president2020.get(county), mayor2022.get(county), mayor2018.get(county), paths[county]];
  if (missing.some((x) => !x)) throw new Error(`${county} 資料不完整：${missing.map((x) => (x ? 1 : 0)).join("")}`);
  return {
    county,
    ...p,
    elections: {
      president_2024: president2024.get(county),
      president_2020: president2020.get(county),
      mayor_2022: mayor2022.get(county),
      mayor_2018: mayor2018.get(county),
    },
    path: paths[county],
  };
});

const month = `${Number(pop.month.slice(0, 3)) + 1911}-${pop.month.slice(3)}`;
writeFileSync(
  args.out,
  `${JSON.stringify(
    {
      population_month: month,
      elections: {
        president_2024: { label: '2024 總統', date: '2024-01-13' },
        president_2020: { label: '2020 總統', date: '2020-01-11' },
        mayor_2022: { label: '2022 縣市長', date: '2022-11-26' },
        mayor_2018: { label: '2018 縣市長', date: '2018-11-24' },
      },
      sources: [
        { label: '中選會選舉資料庫（kiang/db.cec.gov.tw 轉存）', url: 'https://github.com/kiang/db.cec.gov.tw' },
        { label: `內政部戶政司村里人口單一年齡（${month}）`, url: 'https://github.com/kiang/data.moi.gov.tw' },
        { label: '縣市界（ronnywang/twgeojson）', url: 'https://github.com/ronnywang/twgeojson' },
      ],
      counties,
    },
    null,
    0,
  )}\n`,
);
console.log(`wrote ${args.out}: ${counties.length} 縣市，人口 ${month}`);
