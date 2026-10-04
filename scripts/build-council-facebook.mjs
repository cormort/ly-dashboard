#!/usr/bin/env node
/**
 * 把議員 Facebook 粉專對照表（scripts/council-facebook.csv）對到 server/council-stats.json 最新一屆的
 * 當選人，產生 server/council-facebook.json（key＝`縣市|選區編號|中選會姓名`）。
 *
 *   node scripts/build-council-facebook.mjs
 *   node scripts/build-council-facebook.mjs --csv /tmp/改過的.csv    # 試別的對照表（檢查用）
 *
 * 對照表是「現任」名單，姓名與中選會檔案有差異，所以比對前先正規化：去掉括號備註（同名者的
 * 「張桂綿(蘆竹)」）、去掉原住民姓名的羅馬拼音、統一常見異體字。對不上的不硬配（見輸出）：
 * 中選會當選人已離職、由遞補者接手的（對照表是遞補者），粉專不屬於當選人，所以不顯示。
 *
 * **對不上的兩個方向都要報告**（2026-10-04 補）：
 *   - `unmatched`：當選人沒有粉專列 —— 可能是「還沒查」也可能是「這個人不在對照表的選區」
 *   - `extra`：對照表有列、但不在這一屆這一區的當選名單 —— 遞補者，或**掛錯選區**的資料
 *
 * 為什麼要多報 `extra`：原本只印 `unmatched`，所以桃園「第 3 選區寫成張桂綿、朱珍瑤被放到第 1 選區」
 * 這種錯只看得到「兩位當選人沒對到」，看不出是對照表把名字掛到別的選區去了。
 * 另外兩條 fail-closed 的規則：
 *   - `samePersonTwoDistricts`：同一個人在同一縣市不可能同時當選兩個選區，出現就是資料錯
 *     （同名不同人的情形六都 377 位當選人裡沒有，真的遇到再放行）。
 *   - `現任` 的人不可以是 `extra`：不是 2022 當選人卻列在這一區，只可能是遞補或補選，
 *     狀態要寫「現任（遞補）」「現任（補選）」。寫成「現任」就是掛錯選區或狀態沒更新。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    csv: { type: 'string', default: new URL('./council-facebook.csv', import.meta.url).pathname },
    out: { type: 'string', default: new URL('../server/council-facebook.json', import.meta.url).pathname },
  },
});

const VARIANT = { 杰: '傑', 姗: '姍', 啓: '啟', 釆: '采', 椿: '樁', 黄: '黃' };
const norm = (s) =>
  s
    .replace(/[(（].*?[)）]/g, '')
    .replace(/[^一-鿿].*$/, '')
    .replace(/./g, (ch) => VARIANT[ch] ?? ch)
    .trim();

/** 最小 CSV 解析：這份檔案沒有帶逗號或引號的欄位 */
const rows = readFileSync(args.csv, 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.split(','));

const districtNo = (district) => Number(district.match(/第(\d+)選區/)[1]);

const sheet = new Map();
const duplicateRows = [];
const samePersonTwoDistricts = [];
const urlOwners = new Map();
const seenPerson = new Map();
for (const [county, district, name, , url, , status] of rows) {
  const no = districtNo(district);
  const key = `${county}|${no}|${norm(name)}`;
  if (sheet.has(key)) duplicateRows.push(`${county} 第${no}選區 ${name}`);
  sheet.set(key, { url, status });

  const person = `${county}|${norm(name)}`;
  const previous = seenPerson.get(person);
  if (previous && previous.no !== no) samePersonTwoDistricts.push(`${county} ${name}：第${previous.no}選區／第${no}選區`);
  else seenPerson.set(person, { no });

  const owners = urlOwners.get(url) ?? [];
  owners.push(`${county} ${name}`);
  urlOwners.set(url, owners);
}
// 同一個粉專網址掛在兩個不同的人身上一定是錯的（同一個人換選區不會換網址）
const sharedUrls = [...urlOwners].filter(([, owners]) => new Set(owners.map((o) => norm(o.split(' ').pop()))).size > 1);

const problems = [
  duplicateRows.length ? `對照表有重複的列：${duplicateRows.join('、')}` : null,
  samePersonTwoDistricts.length ? `同一個人在同一縣市出現於兩個選區：${samePersonTwoDistricts.join('、')}` : null,
  sharedUrls.length ? `同一個粉專網址掛在不同人身上：${sharedUrls.map(([u, o]) => `${u}（${o.join('／')}）`).join('、')}` : null,
].filter(Boolean);
if (problems.length) throw new Error(`對照表有結構性錯誤，先修好再重跑：\n  - ${problems.join('\n  - ')}`);

const stats = JSON.parse(readFileSync(new URL('../server/council-stats.json', import.meta.url), 'utf8'));
const out = {};
const unmatched = [];
const extra = [];
const misplaced = [];
let winners = 0;
for (const c of stats.counties) {
  const term = c.terms[0]; // 最新一屆
  for (const d of term.districts) {
    const no = Number(d.no);
    const names = new Set();
    for (const x of d.list.filter((p) => p.elected)) {
      winners++;
      names.add(norm(x.name));
      const hit = sheet.get(`${c.county}|${no}|${norm(x.name)}`);
      if (hit) out[`${c.county}|${no}|${x.name}`] = hit;
      else unmatched.push(`${c.county} 第${no}選區 ${x.name}`);
    }
    // 對照表列了、但不在這一區的當選名單裡：遞補者（原當選人離職）或掛錯選區
    for (const [county, district, name, , url, , status] of rows) {
      if (county !== c.county || districtNo(district) !== no || names.has(norm(name))) continue;
      extra.push(`${c.county} 第${no}選區 ${name}（${status}）${url}`);
      // 不是 2022 的當選人卻列在這一區，就只能是遞補或補選 —— 寫「現任」代表掛錯選區或狀態沒更新
      if (!/遞補|補選/.test(status)) misplaced.push(`${c.county} 第${no}選區 ${name}（狀態寫「${status}」）`);
    }
  }
}

if (misplaced.length) throw new Error(`對照表有掛錯選區的列，先修好再重跑（不是當選人卻列在該選區，狀態又不是遞補／補選）：\n  - ${misplaced.join('\n  - ')}`);

writeFileSync(
  args.out,
  JSON.stringify(
    {
      term_year: stats.counties[0].terms[0].year,
      source: '全臺六都直轄市議員 Facebook 粉專對照表',
      // 對照表的「現任」名單與 2022 當選名單的兩個差集，讓「誰沒有粉專連結」看得見（原本只有 build log）
      unmatched,
      extra,
      links: out,
    },
    null,
    1,
  ) + '\n',
);
console.log(`當選人 ${winners}，對到粉專 ${Object.keys(out).length}，未對到 ${unmatched.length}、對照表多出 ${extra.length}`);
for (const m of unmatched) console.log('  未對到（當選人沒有粉專列）：', m);
for (const m of extra) console.log('  對照表多出（遞補者或掛錯選區）：', m);
