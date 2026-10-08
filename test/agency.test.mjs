import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, applyDataset, applyLawAgencies, applyMojLawAgencies } from '../server/db.mjs';
import { buildDataset } from '../server/normalize.mjs';
import { getAgencyHome, listAgencies, listCommitteeActivity } from '../server/queries.mjs';

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

test('行政院主計總處：認得簡稱「主計總處」，並保留主計總處專頁的專屬新聞來源', () => {
  const { db } = seeded();
  const fetched = '2026-09-30T00:00:00.000Z';
  const topic = db.prepare('INSERT INTO topic_news(topic, url, title, source, published_at, fetched_at) VALUES(?,?,?,?,?,?)');
  topic.run('dgbas', 'https://d/1', '主計總處公布最新經濟成長率預測', '甲報', '2026-09-30T08:00:00.000Z', fetched); // 只有 dgbas 專屬查詢會抓到
  topic.run('dgbas', 'https://d/2', '高雄市主計處說明市府預算', '乙報', '2026-09-30T09:00:00.000Z', fetched); // 地方主計處：不算
  db.prepare('INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)').run('B2', 11, 5, '總預算', '115年度中央政府總預算案', '交付審查', '行政院主計總處', 115, '2026-09-21', 'https://b/2');
  const r = getAgencyHome(db, { name: '行政院主計總處' });
  assert.deepEqual(r.kinds.news.items.map((i) => i.url), ['https://d/1'], '專屬主計新聞進來、地方主計處不算');
  assert.equal(r.kinds.budget.total, 1, '提案單位是全名也算');
  assert.ok(r.agency.heads.some((h) => h.title === '主計長'), '現任主計長');
  // 其他機關不受影響：主計總處專屬新聞不會跑進財政部
  assert.equal(getAgencyHome(db, { name: '財政部' }).kinds.news.items.some((i) => i.url === 'https://d/1'), false);
});

test('委員會關鍵字 q：空白分隔、任一符合；會議比對名稱與議程、回覆與紀錄比對標題；委員會件數跟著關鍵字', () => {
  const { db } = seeded();
  // 簡稱不是全名的子字串（央行 ≠ 中央銀行），所以要能「任一符合」
  db.prepare('INSERT INTO committee_meetings(id, date, committee, joint, name, content, speakers) VALUES(?,?,?,?,?,?,?)').run(3, '2026-09-27', '財政委員會', '無', '財政委員會第6次會議', '邀請央行總裁報告', '[]');
  const all = listCommitteeActivity(db, {});
  assert.equal(all.meetings.total, 3);
  const one = listCommitteeActivity(db, { q: '財政部' });
  assert.deepEqual(one.meetings.items.map((m) => m.name), ['財政委員會第5次會議'], '議程內容提到才算');
  assert.equal(one.replies.total, 1, '回覆比對標題');
  const either = listCommitteeActivity(db, { q: ' 財政部  央行 ' });
  assert.equal(either.meetings.total, 2, '任一關鍵字符合即列出，多餘空白不影響');
  assert.deepEqual(either.committees, [{ name: '財政委員會', count: 2 }], '委員會件數只算符合關鍵字的');
  assert.deepEqual(either.meetings.period, all.meetings.period, '資料期間仍是全部資料的起訖');
  assert.equal(listCommitteeActivity(db, { q: '財政部', committee: '教育及文化委員會' }).meetings.total, 0, '與委員會條件同時成立');
  assert.equal(listCommitteeActivity(db, { q: '   ' }).meetings.total, 3, '空白關鍵字等於不篩');
});

test('誰在關注的件數可以點開：?watch= 回那一位的組成（分來源件數＋連回原始資料的網址）', () => {
  const { db, a, b } = seeded();
  const w = getAgencyHome(db, { name: '財政部', watch: a.id }).watcher;
  assert.equal(w.id, a.id);
  assert.equal(w.name, a.name);
  assert.equal(w.count, 2, '與清單上的次數一致');
  assert.equal(w.kinds.news.total, 1);
  assert.deepEqual(w.kinds.news.items.map((i) => i.url), ['https://n/1'], '新聞帶著來源網址');
  assert.equal(w.kinds.bill.total, 0, '沒有掛名的提案');
  assert.equal(w.meetings.total, 1, '在這場會議登記發言');
  assert.deepEqual(w.meetings.items.map((m) => m.name), ['財政委員會第5次會議']);
  assert.equal(
    ['news', 'post', 'bill', 'budget', 'report'].reduce((sum, k) => sum + w.kinds[k].total, 0) + w.meetings.total,
    w.count,
    '分來源加總＝清單上的次數',
  );
  assert.equal(w.kinds.news.items[0].agencies, undefined, '對照用的中介欄位不外流');

  const wb = getAgencyHome(db, { name: '財政部', watch: b.id }).watcher;
  assert.equal(wb.count, 2);
  assert.deepEqual(wb.kinds.bill.items.map((i) => i.url), ['https://l/1'], '提案連回立法院議案頁');

  assert.equal(getAgencyHome(db, { name: '財政部', watch: '不存在的委員' }).watcher, null, '認不得的 id 不編造');
  assert.equal(getAgencyHome(db, { name: '財政部' }).watcher, null, '沒指定就沒有明細');
  assert.equal(getAgencyHome(db, { name: '教育部', watch: a.id }).watcher, null, '不是這個機關的關注者就沒有');
});

test('我的機關：誰在關注的「看更多」與明細的件數一致（同一組比對）', () => {
  const { db, a } = seeded();
  const home = getAgencyHome(db, { name: '財政部', watch: a.id });
  const w = home.watcher;
  assert.equal(
    home.watchers.find((x) => x.id === a.id).count,
    w.kinds.news.total + w.meetings.total,
    '清單上的次數＝明細裡各來源的加總',
  );
});

test('機關清單也從法律的主管機關來：司法院、考試院、監察院、總統府不是行政院所屬也要有', () => {
  const { db } = seeded();
  assert.equal(listAgencies(db).some((a) => a.name === '司法院'), false, '還沒有法律對照時不會冒出來');
  applyLawAgencies(db, new Map([['刑事訴訟法', ['司法院']], ['審計法', ['監察院']]]));
  applyMojLawAgencies(db, new Map([['刑事訴訟法', ['司法院']], ['總統府組織法', ['總統府']]]));
  const list = listAgencies(db);
  for (const name of ['司法院', '監察院', '總統府']) assert.ok(list.some((a) => a.name === name), `${name} 要在清單裡`);
  assert.deepEqual(list.find((a) => a.name === '司法院').heads, [], '沒有首長名單就沒有首長，不會編造');

  // 舊寫法（上次同步留下來的簡稱）讀取時也要正規化；已廢止的機關不進選單
  applyLawAgencies(db, new Map([['電信管理法', ['通訊傳播委員會']], ['國民大會組織法', ['國民大會']], ['主計法', ['主計總處']]]));
  const names = listAgencies(db).map((a) => a.name);
  assert.ok(names.includes('國家通訊傳播委員會') && names.includes('行政院主計總處'), '簡稱在讀取時換成全名');
  assert.equal(names.includes('通訊傳播委員會') || names.includes('主計總處') || names.includes('國民大會'), false, '舊名／簡稱／已廢止的機關不留重複項');
});

test('我的機關：預算審議沒有日期時，年度大的在前（與報告／議事同一套排序）', () => {
  const { db } = seeded();
  const ins = db.prepare('INSERT INTO budget_bills(id, term, session, category, name, status, proposer, fiscal_year, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)');
  ins.run('B3', 11, 5, '總預算', '113年度中央政府總預算案', '交付審查', '財政部', 113, '', 'https://b/3');
  ins.run('B4', 11, 5, '總預算', '116年度中央政府總預算案', '交付審查', '財政部', 116, '', 'https://b/4');
  const titles = getAgencyHome(db, { name: '財政部', per: 20 }).kinds.budget.items.map((i) => i.title);
  assert.deepEqual(
    titles,
    ['116年度中央政府總預算案', '113年度中央政府總預算案', '115年度中央政府總預算案'],
    '沒有日期的兩筆依年度降冪；有日期的（115 年度，2026-09-20）排在後面',
  );
});

test('司法院這種機關頁真的用得到：修刑事訴訟法的提案會算進來', () => {
  const { db } = seeded();
  db.prepare('INSERT INTO bills(id, term, session, name, status, category, proposer_text, laws, latest_date, url) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'J1', 11, 5, '「刑事訴訟法部分條文修正草案」，請審議案。', '交付審查', '法律案', '', JSON.stringify(['刑事訴訟法']), '2026-10-01', 'https://l/j1',
  );
  applyMojLawAgencies(db, new Map([['刑事訴訟法', ['司法院']]]));
  const r = getAgencyHome(db, { name: '司法院' });
  assert.equal(r.agency.name, '司法院');
  assert.equal(r.kinds.bill.total, 1, '標題沒有機關名，靠法律的主管機關對上');
  assert.deepEqual(r.kinds.bill.items.map((i) => i.url), ['https://l/j1']);
});

test('我的機關的「看更多」：以機關全名＋簡稱查委員會頁，件數與我的機關一致', () => {
  const { db } = seeded();
  db.prepare('INSERT INTO committee_meetings(id, date, committee, joint, name, content, speakers) VALUES(?,?,?,?,?,?,?)').run(3, '2026-09-27', '財政委員會', '無', '財政委員會第6次會議', '邀請央行總裁報告', '[]');
  for (const name of ['財政部', '中央銀行']) {
    const home = getAgencyHome(db, { name });
    const more = listCommitteeActivity(db, { q: home.agency.terms.join(' ') });
    assert.equal(more.meetings.total, home.meetings.total, `${name} 議程件數一致`);
    assert.equal(more.replies.total, home.replies.total, `${name} 回覆件數一致`);
  }
  assert.equal(getAgencyHome(db, { name: '中央銀行' }).meetings.total, 1, '簡稱「央行」也對得到');
});
