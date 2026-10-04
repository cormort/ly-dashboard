#!/usr/bin/env node
/**
 * 下載「直轄市議員選舉」的中選會原始檔（kiang/db.cec.gov.tw 轉存）到本機快取，
 * 給 scripts/build-council-stats.mjs 解析。只抓需要的 5 個檔，不做整庫 clone
 * （整個 repo 有上萬個檔，議員只用到其中 60 個）。
 *
 *   node scripts/fetch-cec-council.mjs            # 抓 2009／2010／2014／2018／2022
 *   node scripts/fetch-cec-council.mjs --force     # 已存在也重抓
 *   node scripts/fetch-cec-council.mjs --dir /tmp/cec
 *
 * 除了直轄市議員，另外抓 **2009 年的縣市議員**（目前只有桃園用到，見 build 腳本的 COUNTY_META）。
 * 縣市議員的欄位配置與直轄市議員一致，但每列前面**多一層「省市別」**（`03` 臺灣省／`04` 福建省），
 * 所以縣市是前**兩個**欄位（`03`＋`003`＝桃園縣）而不是一個，見 `countyFields`。
 *
 * 每個選舉種類一組檔（檔名各年不一，2024 立委的 elbase 曾拼成 elbese，所以用前綴找）：
 *   elbase.csv 區域代碼與名稱（縣市／鄉鎮市區／村里）
 *   elcand.csv 候選人（號次、姓名、政黨代號、性別、年齡、學歷、現任、當選註記）
 *   elctks.csv 各投開票所與選區合計得票
 *   elpaty.csv 政黨代號對照
 *   elprof.csv 選舉人數、投票率、人口數、候選與當選人數統計
 */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: '.cache/cec-council' },
    force: { type: 'boolean', default: false },
    raw: { type: 'string', default: 'https://raw.githubusercontent.com/kiang/db.cec.gov.tw/master/voteData' },
  },
});

const FILES = ['elbase.csv', 'elcand.csv', 'elctks.csv', 'elpaty.csv', 'elprof.csv'];

/**
 * 各屆「議員」的三個選舉種類目錄。區域＝議員(區域)選舉、平原＝議員(平地原住民)、
 * 山原＝議員(山地原住民)。2010 的目錄名是「五都市長議員及里長」。
 *
 * 屆次編號各縣市不同（新北市 2010 是第 1 屆、臺北市是第 11 屆），不放在這裡，見 build 腳本的 COUNTY_META。
 * `countyFields` 是「這份檔案用前幾個欄位辨識縣市」：直轄市議員的 elbase 第一欄就是縣市代碼（1 個），
 * 2009 縣市議員多一層省市別（2 個）。少了這個，篩出來的會是整個「臺灣省」而不是單一縣市。
 */
export const ELECTIONS = [
  {
    year: 2022,
    date: '2022-11-26',
    dirs: {
      area: '2022-111年地方公職人員選舉/T1/prv',
      plain: '2022-111年地方公職人員選舉/T2/prv',
      mountain: '2022-111年地方公職人員選舉/T3/prv',
    },
  },
  {
    year: 2018,
    date: '2018-11-24',
    dirs: {
      area: '2018-107年地方公職人員選舉/直轄市區域議員',
      plain: '2018-107年地方公職人員選舉/直轄市平原議員',
      mountain: '2018-107年地方公職人員選舉/直轄市山原議員',
    },
  },
  {
    year: 2014,
    date: '2014-11-29',
    dirs: {
      area: '2014-103年地方公職人員選舉/直轄市區域議員',
      plain: '2014-103年地方公職人員選舉/直轄市平原議員',
      mountain: '2014-103年地方公職人員選舉/直轄市山原議員',
    },
  },
  {
    year: 2010,
    date: '2010-11-27',
    dirs: {
      area: '20101127-五都市長議員及里長/區域議員',
      plain: '20101127-五都市長議員及里長/平地議員',
      mountain: '20101127-五都市長議員及里長/山地議員',
    },
  },
  {
    // 升格前的縣市議員。這個目錄裡有 18 個縣市（臺灣省 16＋福建省 2）；
    // 臺北縣／臺中縣市／臺南縣市／高雄縣市 2009 沒有改選（任期延長到 2010 升格），所以不在裡面。
    // 目前只有桃園縣用到（桃園 2014 年底才升格，2010–2014 這一任是桃園縣議會第 17 屆）。
    year: 2009,
    date: '2009-12-05',
    countyFields: 2,
    dirs: {
      area: '20091205-縣市長縣市議員及鄉鎮長/區域議員',
      plain: '20091205-縣市長縣市議員及鄉鎮長/平地議員',
      mountain: '20091205-縣市長縣市議員及鄉鎮長/山地議員',
    },
  },
];

/** 目錄與檔名都要做 URL 編碼，中文目錄名才抓得到 */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

async function download(url, target) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`下載到空檔：${url}`);
  writeFileSync(target, buf);
  return buf.length;
}

async function main() {
  const root = args.dir;
  let downloaded = 0;
  let skipped = 0;
  for (const election of ELECTIONS) {
    for (const [kind, dir] of Object.entries(election.dirs)) {
      const outDir = join(root, String(election.year), kind);
      mkdirSync(outDir, { recursive: true });
      for (const file of FILES) {
        const target = join(outDir, file);
        if (!args.force && existsSync(target) && statSync(target).size > 0) {
          skipped += 1;
          continue;
        }
        const size = await download(`${args.raw}/${encodePath(dir)}/${file}`, target);
        downloaded += 1;
        console.log(`${election.year} ${kind} ${file} ${size} bytes`);
      }
    }
  }
  console.log(`下載 ${downloaded} 個檔、跳過 ${skipped} 個已存在檔案 → ${root}`);
}

// 被 build 腳本 import 時不要自己跑
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
