import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applyLawAgencies, applyMojLawAgencies } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { readZipEntry } from '../server/zip.mjs';
import { agencyFromLawCategory, parseMojLaws, mojLawAgenciesUrl, mojMappingDigest, syncMojLawAgencies } from '../server/moj-law.mjs';
import { canonicalAgency } from '../server/agency-names.mjs';
import { listFunds } from '../server/queries.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const zipFixture = readFileSync(fileURLToPath(new URL('./fixtures/moj-law-sample.zip', import.meta.url)));
// 法務部每天重產檔：同樣的法條、不同的位元組（manifest 時間戳不同）
const repackedFixture = readFileSync(fileURLToPath(new URL('./fixtures/moj-law-sample-repacked.zip', import.meta.url)));
// 法條真的變了：電信管理法 通訊傳播委員會 → 數位發展部
const updatedFixture = readFileSync(fileURLToPath(new URL('./fixtures/moj-law-sample-updated.zip', import.meta.url)));
const silent = { log() {}, warn() {}, error() {} };
const zipFetch = (buffer) => async (url, options) => {
  assert.equal(url, mojLawAgenciesUrl());
  assert.equal(options.raw, true, 'ZIP 要用 raw 抓（不能當 JSON 解析）');
  return { buffer, bytes: buffer.length, status: 200, attempts: 1 };
};
/** 記錄 log 的假 logger（要斷言「有沒有說沒有更新」） */
function recording() {
  return {
    logs: [], warns: [], errors: [],
    log(m) { this.logs.push(m); },
    warn(m) { this.warns.push(m); },
    error(m) { this.errors.push(m); },
    said(re) { return this.logs.some((m) => re.test(m)); },
  };
}
/** 人工補的列：整批覆寫（DELETE + INSERT）會把它洗掉，跳過更新才留得住 */
const plant = (db) => db.prepare("INSERT INTO moj_law_agencies(law_name, agencies) VALUES('人工補的','[\"環境部\"]')").run();
const planted = (db) => db.prepare("SELECT count(*) AS n FROM moj_law_agencies WHERE law_name = '人工補的'").get().n;

test('讀 ZIP：壓縮（deflate）與未壓縮（stored）的項目都讀得出來、找不到的項目要報錯', () => {
  const chlaw = readZipEntry(zipFixture, 'ChLaw.json').toString('utf8');
  assert.equal(JSON.parse(chlaw.replace(/^\uFEFF/, '')).Laws.length, 6);
  assert.match(readZipEntry(zipFixture, 'manifest.csv').toString('utf8'), /中文法規法律資料檔/);
  assert.throws(() => readZipEntry(zipFixture, 'ChOrder.json'), /沒有 ChOrder/);
  assert.throws(() => readZipEntry(Buffer.from('這不是 ZIP'), 'ChLaw.json'), /不是 ZIP 檔/);
});

test('法規類別取主管機關：第二段是機關（不含「目」）、組改前的舊名換成現行全名', () => {
  assert.equal(agencyFromLawCategory('行政＞環境部＞氣候變遷目'), '環境部');
  assert.equal(agencyFromLawCategory('行政＞農業部＞綜合規劃目'), '農業部');
  assert.equal(agencyFromLawCategory('行政＞行政院環境保護署＞廢棄物管理目'), '環境部', '組改前舊名');
  assert.equal(agencyFromLawCategory('行政＞行政院農業委員會＞綜合規劃目'), '農業部');
  assert.equal(agencyFromLawCategory('行政＞通訊傳播委員會＞通訊傳播目'), '國家通訊傳播委員會', '簡稱換全名');
  assert.equal(agencyFromLawCategory('司法＞院本部＞刑事目'), '司法院');
  assert.equal(agencyFromLawCategory('廢止法規＞憲法'), null, '沒有機關那一段');
  assert.equal(agencyFromLawCategory(''), null);
  assert.equal(agencyFromLawCategory(undefined), null);
  // 認不得的舊名／已經裁撤沒有承接的：原樣留著（不會掛到錯的機關頁）
  assert.equal(canonicalAgency('行政院新聞局'), '行政院新聞局');
  assert.equal(canonicalAgency('內政部'), '內政部');
});

test('解析法規資料檔：法規名稱→主管機關（同名去重、沒有機關的略過）', () => {
  const laws = parseMojLaws(readZipEntry(zipFixture, 'ChLaw.json').toString('utf8'));
  assert.equal(laws.size, 5, '6 部裡扣掉「廢止法規＞憲法」那部');
  assert.deepEqual(laws.get('電信管理法'), ['國家通訊傳播委員會']);
  assert.deepEqual(laws.get('文化資產保存法'), ['文化部']);
  assert.deepEqual(laws.get('刑事訴訟法'), ['司法院']);
  assert.equal(laws.has('動員戡亂時期臨時條款'), false);
});

test('同步全國法規資料庫：整批寫進 moj_law_agencies', async () => {
  const db = openDb(':memory:');
  const log = recording();
  const result = await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: log });
  assert.equal(result.laws, 5);
  assert.equal(result.unchanged, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 5);
  assert.deepEqual(JSON.parse(db.prepare("SELECT agencies FROM moj_law_agencies WHERE law_name = '氣候變遷因應法'").get().agencies), ['環境部']);
  assert.ok(log.said(/全國法規資料庫主管機關：5 部法律/));
});

test('同一份檔案再同步一次：法條沒更新就不動資料庫', async () => {
  const db = openDb(':memory:');
  await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: silent });
  plant(db);
  const log = recording();
  const again = await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: log });
  assert.equal(again.unchanged, true);
  assert.equal(again.laws, 6, '回報的是資料表目前的列數（5 部法律 ＋ 人工補的那一列）');
  assert.equal(planted(db), 1, '跳過更新才留得住人工補的列（整批覆寫會洗掉）');
  assert.ok(log.said(/沒有更新（同一份檔案/), `要說明是「沒有更新」：${log.logs.join(' / ')}`);
  assert.equal(log.said(/全國法規資料庫主管機關：/), false, '沒有重寫就不應該報「已套用」');
});

test('他們重產檔、法條一樣（位元組不同但對照指紋相同）：也不寫資料庫', async () => {
  const db = openDb(':memory:');
  await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: silent });
  plant(db);
  const log = recording();
  const repacked = await syncMojLawAgencies(db, { fetchImpl: zipFetch(repackedFixture), logger: log });
  assert.equal(repacked.unchanged, true);
  assert.equal(planted(db), 1);
  assert.ok(log.said(/重新產檔但法條沒變/), `要說明是「法條沒變」：${log.logs.join(' / ')}`);
  // 這次把新 ZIP 也記下來了 → 再抓同一份就變成第 ① 層（連解析都省）
  const log2 = recording();
  await syncMojLawAgencies(db, { fetchImpl: zipFetch(repackedFixture), logger: log2 });
  assert.ok(log2.said(/沒有更新（同一份檔案/));
});

test('法條真的變了（改了主管機關）才整批覆寫', async () => {
  const db = openDb(':memory:');
  await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: silent });
  plant(db);
  const log = recording();
  const changed = await syncMojLawAgencies(db, { fetchImpl: zipFetch(updatedFixture), logger: log });
  assert.equal(changed.unchanged, false);
  assert.equal(planted(db), 0, '真的變了才會 DELETE + INSERT');
  assert.deepEqual(JSON.parse(db.prepare("SELECT agencies FROM moj_law_agencies WHERE law_name = '電信管理法'").get().agencies), ['數位發展部']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 5);
});

test('資料庫還是空的（換機器／重建）：就算有舊快照也要寫進去', async () => {
  const db = openDb(':memory:');
  await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: silent });
  db.exec('DELETE FROM moj_law_agencies'); // 快照與 meta 還在，但資料被清掉
  const log = recording();
  const again = await syncMojLawAgencies(db, { fetchImpl: zipFetch(zipFixture), logger: log });
  assert.equal(again.unchanged, false, '空的資料庫不能因為有快照就跳過');
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 5);
});

test('對照指紋：只看「法規名稱→機關」，與列舉順序、ZIP 位元組無關', () => {
  const a = new Map([['甲法', ['環境部']], ['乙法', ['農業部', '環境部']]]);
  const b = new Map([['乙法', ['環境部', '農業部']], ['甲法', ['環境部']]]);
  assert.equal(mojMappingDigest(a), mojMappingDigest(b));
  assert.notEqual(mojMappingDigest(a), mojMappingDigest(new Map([['甲法', ['農業部']], ['乙法', ['農業部', '環境部']]])));
  assert.equal(mojMappingDigest(parseMojLaws(readZipEntry(zipFixture, 'ChLaw.json').toString('utf8'))), mojMappingDigest(parseMojLaws(readZipEntry(repackedFixture, 'ChLaw.json').toString('utf8'))));
});

test('同步失敗時整段放棄（不清掉上一輪的對照）', async () => {
  const db = openDb(':memory:');
  applyMojLawAgencies(db, new Map([['氣候變遷因應法', ['環境部']]]));
  await assert.rejects(
    syncMojLawAgencies(db, { fetchImpl: async () => ({ buffer: Buffer.from('不是 ZIP'), bytes: 8 }), logger: silent }),
    /不是 ZIP 檔/,
  );
  // 法務部重新產檔時會鎖檔回 500（實測 2026-10-08）：fetchJson 重試完仍失敗 → 沿用上一輪
  await assert.rejects(
    syncMojLawAgencies(db, { fetchImpl: async () => { throw new Error('HTTP 500（嘗試 3 次）'); }, logger: silent }),
    /HTTP 500/,
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 1);
});

test('機關對照順序：上游有填就用上游，空的才用全國法規資料庫，都沒有才用手工補', () => {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json')), { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  const insert = db.prepare('INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const bill = (id, law) => insert.run(id, 11, 5, `「${law}部分條文修正草案」，請審議案。`, '交付審查', '法律案', '', JSON.stringify([law]), '2026-10-01', `https://l/${id}`);
  bill('M1', '氣候變遷因應法');
  bill('M2', '農業發展條例');
  bill('M3', '寵物食品安全管理法');
  applyLawAgencies(db, new Map([
    ['農業發展條例', ['農業部']],
    ['氣候變遷因應法', []],
    ['寵物食品安全管理法', []],
  ]));
  applyMojLawAgencies(db, new Map([
    ['農業發展條例', ['環境部']],
    ['氣候變遷因應法', ['環境部']],
  ]));

  const ids = (agency) => listFunds(db, { type: 'agency', fund: agency, kind: 'bill' }).items.map((i) => i.url).sort();
  assert.deepEqual(ids('環境部'), ['https://l/M1'], '上游空、全國法規資料庫有 → 用全國法規資料庫');
  assert.deepEqual(ids('農業部').sort(), ['https://l/M2', 'https://l/M3'].sort(), '上游有填就用上游（農業發展條例）；手工補的也還在（寵物食品安全管理法）');
  assert.equal(listFunds(db, { type: 'agency', fund: '農業部' }).total, 2);
});
