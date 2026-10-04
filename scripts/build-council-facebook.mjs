#!/usr/bin/env node
/**
 * 把議員 Facebook 粉專對照表（scripts/council-facebook.csv）對到 server/council-stats.json 最新一屆的
 * 當選人，產生 server/council-facebook.json（key＝`縣市|選區編號|中選會姓名`）。
 *
 *   node scripts/build-council-facebook.mjs
 *
 * 對照表是「現任」名單，姓名與中選會檔案有差異，所以比對前先正規化：去掉括號備註（同名者的
 * 「張桂綿(蘆竹)」）、去掉原住民姓名的羅馬拼音、統一常見異體字。對不上的不硬配（見輸出）：
 * 中選會當選人已離任由遞補者接手的（對照表是新人），粉專不屬於當選人，所以不顯示。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const VARIANT = { 杰: '傑', 姗: '姍', 啓: '啟', 釆: '采', 椿: '樁', 黄: '黃' };
const norm = (s) =>
  s
    .replace(/[(（].*?[)）]/g, '')
    .replace(/[^一-鿿].*$/, '')
    .replace(/./g, (ch) => VARIANT[ch] ?? ch)
    .trim();

/** 最小 CSV 解析：這份檔案沒有帶逗號或引號的欄位 */
const rows = readFileSync(new URL('./council-facebook.csv', import.meta.url), 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split(','));

const sheet = new Map();
for (const [county, district, name, , url, , status] of rows) {
  const no = Number(district.match(/第(\d+)選區/)[1]);
  sheet.set(`${county}|${no}|${norm(name)}`, { url, status });
}

const stats = JSON.parse(readFileSync(new URL('../server/council-stats.json', import.meta.url), 'utf8'));
const out = {};
const missed = [];
let winners = 0;
for (const c of stats.counties) {
  const term = c.terms[0]; // 最新一屆
  for (const d of term.districts) {
    for (const x of d.list.filter((p) => p.elected)) {
      winners++;
      const hit = sheet.get(`${c.county}|${Number(d.no)}|${norm(x.name)}`);
      if (hit) out[`${c.county}|${Number(d.no)}|${x.name}`] = hit;
      else missed.push(`${c.county} 第${Number(d.no)}選區 ${x.name}`);
    }
  }
}

writeFileSync(
  new URL('../server/council-facebook.json', import.meta.url),
  JSON.stringify({ term_year: stats.counties[0].terms[0].year, source: '全臺六都直轄市議員 Facebook 粉專對照表', links: out }, null, 1) + '\n',
);
console.log(`當選人 ${winners}，對到粉專 ${Object.keys(out).length}，未對到 ${missed.length}`);
for (const m of missed) console.log('  未對到：', m);
