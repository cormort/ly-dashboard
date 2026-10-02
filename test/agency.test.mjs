import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { getAgencyHome, listAgencies } from '../server/queries.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

function seeded() {
  const db = openDb(':memory:');
  applyDataset(db, buildDataset(fixture('id9.json'), fixture('id14.json')), { fetchedAt: '2026-09-30T09:00:00.000Z', sourceUrl: 'https://data.ly.gov.tw/' });
  const [a, b] = db.prepare('SELECT id, name FROM legislators WHERE leave_flag = 0 ORDER BY id LIMIT 2').all();
  const fetched = '2026-09-30T00:00:00.000Z';
  const news = db.prepare('INSERT INTO news(legislator_id, url, title, source, published_at, fetched_at) VALUES(?,?,?,?,?,?)');
  // 同一則新聞掛在兩位委員底下 → 只算一則
  news.run(a.id, 'https://n/1', '財政部說明稅制改革', '甲報', '2026-09-29T08:00:00.000Z', fetched);
  news.run(b.id, 'https://n/1', '財政部說明稅制改革', '甲報', '2026-09-29T08:00:00.000Z', fetched);
  news.run(a.id, 'https://n/2', '今天天氣很好', '乙報', '2026-09-29T09:00:00.000Z', fetched);
  const topic = db.prepare('INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES(?,?,?,?,?,?)');
  topic.run('entities', 'https://e/1', '財政部公布最新財政收支', '丙報', '2026-09-30T08:00:00.000Z', fetched);
  topic.run('official:莊翠雲', 'https://o/1', '莊翠雲談財政紀律', '丁報', '2026-09-28T08:00:00.000Z', fetched);
  db.prepare('INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)').run('B1', 11, 5, '總預算', '115年度中央政府總預算案', '交付審查', '財政部', 115, '2026-09-20', 'https://b/1');
  db.prepare('INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)').run('L1', 11, 5, '財政部提案修正所得稅法', '三讀', '法律案', '財政部', '[]', '2026-09-10', 'https://l/1');
  db.prepare('INSERT INTO bill_sponsors(bill_id, legislator_id, is_lead) VALUES(?,?,1)').run('L1', b.id);
  db.prepare('INSERT INTO committee_meetings(id, date, committee, joint, name, content, speakers) VALUES(?,?,?,?,?,?,?)').run(1, '2026-09-25', '財政委員會', '無', '財政委員會第5次會議', '邀請財政部部長列席報告', JSON.stringify([{ name: a.name, id: a.id }]));
  db.prepare('INSERT INTO committee_meetings(id, date, committee, joint, name, content, speakers) VALUES(?,?,?,?,?,?,?)').run(2, '2026-09-26', '教育及文化委員會', '無', '教育會議', '教育部報告', '[]');
  db.prepare('INSERT INTO committee_meets(code, date, title, committees, video_url, attachments) VALUES(?,?,?,?,?,?)').run('M1', '2026-09-25', '財政委員會第5次會議', '[]', null, JSON.stringify([{ kind: 'reply', title: '財政部書面答復', url: 'https://r/1' }, { kind: 'attachment', title: '議程', url: 'https://r/2' }]));
  return { db, a, b };
}

test('機關清單含機關代碼表＋首長名單裡的機關（行政院不在機關清單也要有），並附現任首長', () => {
  const list = listAgencies();
  const names = list.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, '不重複');
  assert.ok(names.includes('財政部') && names.includes('行政院') && names.includes('公共工程委員會'));
  assert.ok(list.find((x) => x.name === '財政部').heads.some((h) => h.name === '莊翠雲'), '財政部首長是莊翠雲');
  assert.deepEqual(list.find((x) => x.name === '教育部').heads.map((h) => h.title).slice(0, 1), ['部長']);
});

test('沒給或不認得的機關：agency 為 null，仍回機關清單供選單使用', () => {
  const { db } = seeded();
  for (const name of [undefined, '', '不存在的機關']) {
    const r = getAgencyHome(db, { name });
    assert.equal(r.agency, null);
    assert.ok(r.agencies.length > 100);
    assert.equal(r.kinds, undefined);
  }
});

test('我的機關：各來源只含提到該機關者、新聞同一網址只算一則、最新在前', () => {
  const { db } = seeded();
  const r = getAgencyHome(db, { name: '財政部' });
  assert.equal(r.agency.name, '財政部');
  assert.equal(r.kinds.news.total, 2, '兩位委員掛同一則 + entities 一則 = 2 則，天氣那則不算');
  assert.deepEqual(r.kinds.news.items.map((i) => i.url), ['https://e/1', 'https://n/1'], '最新在前');
  assert.equal(r.kinds.budget.total, 1, '預算審議看提案單位');
  assert.equal(r.kinds.bill.total, 1);
  assert.equal(r.kinds.report.total, 0);
  assert.equal(r.official_news.total, 1, '首長新聞來自 official:<首長>');
  assert.equal(r.official_news.items[0].head, '莊翠雲');
});

test('我的機關：近期議程、機關書面回覆只收提到該機關者', () => {
  const { db } = seeded();
  const r = getAgencyHome(db, { name: '財政部' });
  assert.equal(r.meetings.total, 1, '教育會議不算');
  assert.deepEqual(r.meetings.items[0].committees, ['財政委員會']);
  assert.equal(r.replies.total, 1, '只收 kind=reply 且標題含機關者');
  assert.equal(r.replies.items[0].url, 'https://r/1');
  assert.equal(getAgencyHome(db, { name: '教育部' }).meetings.total, 1);
});

test('我的機關：誰在關注＝新聞／提案掛名＋會議發言，依次數排序', () => {
  const { db, a, b } = seeded();
  const r = getAgencyHome(db, { name: '財政部' });
  const count = (id) => r.watchers.find((w) => w.id === id)?.count;
  // a：新聞 1 + 會議發言 1 = 2；b：新聞 1 + 提案 1 = 2
  assert.equal(count(a.id), 2);
  assert.equal(count(b.id), 2);
  assert.ok(r.watchers.every((w, i, arr) => i === 0 || arr[i - 1].count >= w.count));
});

test('簡稱也算提到（央行→中央銀行）；per 夾在 1..20', () => {
  const { db } = seeded();
  db.prepare('INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES(?,?,?,?,?,?)').run('entities', 'https://e/2', '央行宣布升息', '甲報', '2026-09-30T08:00:00.000Z', '2026-09-30T00:00:00.000Z');
  assert.equal(getAgencyHome(db, { name: '中央銀行' }).kinds.news.total, 1);
  assert.equal(getAgencyHome(db, { name: '財政部', per: 999 }).kinds.news.items.length, 2);
  assert.equal(getAgencyHome(db, { name: '財政部', per: 1 }).kinds.news.items.length, 1);
});
