import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applyLawAgencies, applyMojLawAgencies } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { readZipEntry } from '../server/zip.mjs';
import { agencyFromLawCategory, parseMojLaws, mojLawAgenciesUrl, syncMojLawAgencies } from '../server/moj-law.mjs';
import { canonicalAgency } from '../server/agency-names.mjs';
import { listFunds } from '../server/queries.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const zipFixture = readFileSync(fileURLToPath(new URL('./fixtures/moj-law-sample.zip', import.meta.url)));
const silent = { log() {}, warn() {}, error() {} };

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

test('同步全國法規資料庫：整批寫進 moj_law_agencies（重跑時覆寫）', async () => {
  const db = openDb(':memory:');
  const fetchImpl = async (url, options) => {
    assert.equal(url, mojLawAgenciesUrl());
    assert.equal(options.raw, true, 'ZIP 要用 raw 抓（不能當 JSON 解析）');
    return { buffer: zipFixture, bytes: zipFixture.length, status: 200, attempts: 1 };
  };
  const result = await syncMojLawAgencies(db, { fetchImpl, logger: silent });
  assert.equal(result.laws, 5);
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 5);
  assert.deepEqual(JSON.parse(db.prepare("SELECT agencies FROM moj_law_agencies WHERE law_name = '氣候變遷因應法'").get().agencies), ['環境部']);
  await syncMojLawAgencies(db, { fetchImpl, logger: silent });
  assert.equal(db.prepare('SELECT count(*) AS n FROM moj_law_agencies').get().n, 5, '重跑不會長出重複的列');
});

test('同步失敗時整段放棄（不清掉上一輪的對照）', async () => {
  const db = openDb(':memory:');
  applyMojLawAgencies(db, new Map([['氣候變遷因應法', ['環境部']]]));
  await assert.rejects(
    syncMojLawAgencies(db, { fetchImpl: async () => ({ buffer: Buffer.from('不是 ZIP'), bytes: 8 }), logger: silent }),
    /不是 ZIP 檔/,
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
