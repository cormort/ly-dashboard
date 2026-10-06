import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDataset,
  DataValidationError,
  normalizeId14,
  parseSeatLabel,
  committeeKind,
  regionOf,
  parseContacts,
  normalizeBills,
  parseNewsRss,
  newsName,
  parseCsv,
  normalizeSocial,
  budgetTypes,
} from '../server/normalize.mjs';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const id9 = fixture('id9.json');
const id14 = fixture('id14.json');

// 這一組期望值是從真實 API 回應（2026-09-30 抓取）人工核算出來的，不是照著實作推的。
const TRUTH = {
  term: 11,
  legislators: 123,
  currentSession: '11-5',
  currentRoster: 113,
  seats: 783,
  sessions: 5,
  committees: 11,
  convenersCurrentSession: 23, // 去重後的人數（id14 該會期有 26 筆召委紀錄，有人同時擔任兩個委員會）
  convenersAnySession: 68,
};

test('parseSeatLabel 會剝掉「第N屆第M會期：」前綴', () => {
  assert.deepEqual(parseSeatLabel('第11屆第3會期：內政委員會'), { term: 11, seq: 3, committee: '內政委員會' });
  assert.deepEqual(parseSeatLabel('第4屆第1會期:財政委員會'), { term: 4, seq: 1, committee: '財政委員會' });
  assert.equal(parseSeatLabel('內政委員會'), null, '沒有會期前綴的字串不該被當成席次');
  assert.equal(parseSeatLabel('第11屆第3會期：'), null);
});

test('committeeKind 區分常設與特種委員會', () => {
  assert.equal(committeeKind('內政委員會'), 'standing');
  assert.equal(committeeKind('程序委員會'), 'special');
  assert.equal(committeeKind('修憲委員會'), 'special');
});

test('真實 fixture：buildDataset 產出與人工核算一致的資料集', () => {
  const ds = buildDataset(id9, id14, { sourceUrl: 'https://data.ly.gov.tw/' });

  assert.equal(ds.term, TRUTH.term);
  assert.equal(ds.legislators.length, TRUTH.legislators);
  assert.equal(ds.currentSession, TRUTH.currentSession);
  assert.equal(ds.sessions.length, TRUTH.sessions);
  assert.equal(ds.seats.length, TRUTH.seats);
  assert.equal(ds.committees.length, TRUTH.committees);

  const currentRoster = ds.memberships.filter((m) => m.session_id === TRUTH.currentSession);
  assert.equal(currentRoster.length, TRUTH.currentRoster, '本會期名錄應為 113 人');

  const convenerIds = (sessionId) =>
    new Set(ds.seats.filter((s) => (sessionId ? s.session_id === sessionId : true) && s.is_convener).map((s) => s.legislator_id));
  assert.equal(convenerIds(TRUTH.currentSession).size, TRUTH.convenersCurrentSession);
  assert.equal(convenerIds(null).size, TRUTH.convenersAnySession, '跨會期去重後應為 68 人，而非舊版的 84');
});

test('真實 fixture：委員會 id 全部是乾淨名稱，沒有任何會期前綴', () => {
  const ds = buildDataset(id9, id14);
  for (const committee of ds.committees) {
    assert.ok(committee.id.length > 0);
    assert.ok(!committee.id.includes('會期'), `委員會 id 不該含會期前綴：${committee.id}`);
    assert.ok(!committee.id.includes('：'), `委員會 id 不該含全形冒號：${committee.id}`);
  }
  assert.deepEqual(
    [...new Set(ds.committees.map((c) => c.id))].sort(),
    [
      '交通委員會',
      '修憲委員會',
      '內政委員會',
      '司法及法制委員會',
      '外交及國防委員會',
      '教育及文化委員會',
      '社會福利及衛生環境委員會',
      '程序委員會',
      '經濟委員會',
      '經費稽核委員會',
      '財政委員會',
    ].sort(),
  );
});

test('真實 fixture：所有席次與會期都只屬於本屆（不被 id14 的第 4–10 屆污染）', () => {
  const ds = buildDataset(id9, id14);
  for (const session of ds.sessions) assert.equal(session.term, TRUTH.term);
  for (const seat of ds.seats) assert.ok(seat.session_id.startsWith(`${TRUTH.term}-`), `席次越屆：${seat.session_id}`);
});

test('回歸測試：id14 中其他屆次的同名召委紀錄不得影響本屆', () => {
  const pastTermRow = {
    committee: '內政委員會',
    lgno: '09999',
    name: '丁學忠',
    term: '10',
    sessionPeriod: '1',
    isCoChairman: 'Y',
  };
  const polluted = { dataList: [...id14.dataList, pastTermRow] };
  const ds = buildDataset(id9, polluted);
  const target = ds.legislators.find((l) => l.name === '丁學忠');
  const seats = ds.seats.filter((s) => s.legislator_id === target.id);
  assert.ok(seats.length > 0);
  assert.ok(seats.every((s) => s.is_convener === false), '第 10 屆的召委紀錄不該讓本屆變成召委');
  assert.equal(normalizeId14(polluted, { term: 11 }).filter((r) => r.name === '丁學忠' && r.is_convener).length, 0);
});

test('id9 委員若在本屆委員會欄位中無任何會期，不編造會期而是留下警告', () => {
  const ds = buildDataset(id9, id14);
  const termLevel = ds.memberships.filter((m) => m.session_id === null);
  assert.equal(termLevel.length, 2, '游錫堃、李貞秀在本屆無委員會紀錄');
  assert.equal(ds.warnings.filter((w) => w.includes('無任何會期委員會紀錄')).length, 2);
  assert.ok(ds.stats.current_session === TRUTH.currentSession);
});

test('fail closed：資料形狀不對時丟 DataValidationError', () => {
  assert.throws(() => buildDataset({}, id14), DataValidationError);
  assert.throws(() => buildDataset({ dataList: id9.dataList.slice(0, 5) }, id14), DataValidationError);
  assert.throws(() => buildDataset(id9, { dataList: id14.dataList.slice(0, 10) }), DataValidationError);
  assert.throws(() => buildDataset({ dataList: id9.dataList.map((r) => ({ ...r, name: '' })) }, id14), DataValidationError);
});

test('regionOf：76 個選區收斂成縣市／不分區／原住民', () => {
  assert.equal(regionOf('雲林縣第1選舉區'), '雲林縣');
  assert.equal(regionOf('嘉義市選舉區'), '嘉義市');
  assert.equal(regionOf('全國不分區及僑居國外國民'), '全國不分區');
  assert.equal(regionOf('山地原住民選舉區'), '山地原住民');
  assert.equal(regionOf(''), '未提供');
  const current = id9.dataList.filter((r) => r.term === '11');
  assert.equal(new Set(current.map((r) => regionOf(r.areaName))).size, 25);
});

test('parseContacts：tel／fax／addr 依處所合併', () => {
  const row = id9.dataList.find((r) => r.name === '丁學忠');
  const contacts = parseContacts(row);
  assert.deepEqual(contacts.map((c) => c.label), ['國會研究室', '虎尾聯合服務處', '北港聯合服務處']);
  assert.equal(contacts[0].tel, '02-2358-8156');
  assert.equal(contacts[0].fax, '02-2358-8165');
  assert.match(contacts[0].addr, /濟南路/);
  assert.deepEqual(parseContacts({ tel: '', fax: null, addr: undefined }), []);
  assert.deepEqual(parseContacts({ tel: '02-1234-5678' }), [{ label: '聯絡處', tel: '02-1234-5678', fax: '', addr: '' }]);
});

const billsPage = fixture('bills-page.json');
const idByName = () => new Map(buildDataset(id9, id14).legislators.map((l) => [l.name, l.id]));

test('normalizeBills：真實分頁 → 議案與提案人對應，第一位是主提案人', () => {
  const { bills, sponsors, warnings } = normalizeBills([billsPage], idByName());
  assert.equal(bills.length, 300);
  const liao = idByName().get('廖偉翔');
  assert.equal(sponsors.filter((s) => s.legislator_id === liao).length, 51);
  assert.equal(sponsors.filter((s) => s.legislator_id === liao && s.is_lead).length, 16);
  assert.ok(bills.every((b) => b.id && b.name && Array.isArray(b.laws)));
  assert.ok(warnings.every((w) => !w.includes('黨團')), '黨團提案不算對不到');
});

test('normalizeBills：分頁重複以議案編號去重；筆數遠低於 total 時 fail closed', () => {
  const dup = normalizeBills([billsPage, billsPage], idByName());
  assert.equal(dup.bills.length, 300);
  const short = { ...billsPage, total: 7402 };
  assert.throws(() => normalizeBills([short], idByName()), DataValidationError);
  assert.throws(() => normalizeBills([{ total: 1 }], idByName()), DataValidationError);
});

test('parseNewsRss：真實 Google News RSS，去掉來源尾綴、只留標題含姓名者', () => {
  const xml = readFileSync(fileURLToPath(new URL('./fixtures/news-rss.xml', import.meta.url)), 'utf8');
  const items = parseNewsRss(xml, { name: '丁學忠' });
  assert.ok(items.length > 0 && items.length <= 30);
  assert.ok(items.every((n) => n.title.includes('丁學忠') && !n.title.endsWith(` - ${n.source}`)));
  assert.ok(items.every((n) => n.url.startsWith('https://') && !Number.isNaN(Date.parse(n.published_at))));
  assert.equal(parseNewsRss(xml, { name: '不存在的人' }).length, 0);
  assert.throws(() => parseNewsRss('<html>blocked</html>', { name: 'x' }), DataValidationError);
});

test('parseNewsRss：媒體自己的 RSS 沒有 <source>，用呼叫端給的媒體名；CDATA 標題要解開', () => {
  const xml = '<rss version="2.0"><channel><item><title><![CDATA[丁學忠質詢 &amp; 追問]]></title><link>https://cna.example/1</link><pubDate>Tue, 29 Sep 2026 08:00:00 GMT</pubDate></item></channel></rss>';
  assert.deepEqual(parseNewsRss(xml, { name: '丁學忠', source: '中央社' }), [
    { title: '丁學忠質詢 & 追問', source: '中央社', url: 'https://cna.example/1', published_at: '2026-09-29T08:00:00.000Z', summary: '' },
  ]);
  assert.equal(parseNewsRss(xml, { name: '丁學忠' })[0].source, '', '沒給媒體名時維持空字串（Google 新聞的行為不變）');
  // 摘要（全部新聞的關鍵字搜尋用）：RSS 的 description 常是 HTML，要去標籤、解實體、壓成一行
  const withSummary = '<rss version="2.0"><channel><item><title>丁學忠質詢</title><link>https://cna.example/2</link><pubDate>Tue, 29 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>立法院今天\n  審查<b>國防預算</b>&nbsp;。</p>]]></description></item></channel></rss>';
  assert.equal(parseNewsRss(withSummary, { name: '丁學忠' })[0].summary, '立法院今天 審查 國防預算 。');
});

test('parseNewsRss：Atom（公視只有這種格式）—— <entry>／link href／<updated> 都要收', () => {
  // 公視 newsfeed.xml 的實際結構：feed 層有一個 rel="self" 的 link，entry 的 link 是自閉合標籤
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-TW">
  <id>https://news.pts.org.tw/xml/newsfeed.xml</id>
  <link href="https://news.pts.org.tw/xml/newsfeed.xml" rel="self"></link>
  <title><![CDATA[公視新聞網]]></title>
  <updated>2026-10-03T20:20:57+08:00</updated>
  <entry>
    <title><![CDATA[丁學忠質詢國防預算 &amp; 追問]]></title>
    <link rel="alternate" href="https://news.pts.org.tw/article/829822" />
    <id>https://news.pts.org.tw/article/829822</id>
    <summary type="html"><![CDATA[內文不是標題，不該被當成項目]]></summary>
    <updated>2026-10-03T20:20:57+08:00</updated>
  </entry>
  <entry>
    <title>黃捷提案修法</title>
    <link href="https://news.pts.org.tw/article/829821" />
    <published>2026-10-03T11:47:29.000Z</published>
    <updated>2026-10-03T19:47:29+08:00</updated>
  </entry>
</feed>`;
  assert.deepEqual(parseNewsRss(xml, { name: '丁學忠', source: '公視新聞' }), [
    { title: '丁學忠質詢國防預算 & 追問', source: '公視新聞', url: 'https://news.pts.org.tw/article/829822', published_at: '2026-10-03T12:20:57.000Z', summary: '內文不是標題，不該被當成項目' },
  ]);
  // 沒有 rel 的 link 也收；<published> 優先於 <updated>
  assert.deepEqual(parseNewsRss(xml, { name: '黃捷', source: '公視新聞' }), [
    { title: '黃捷提案修法', source: '公視新聞', url: 'https://news.pts.org.tw/article/829821', published_at: '2026-10-03T11:47:29.000Z', summary: '' },
  ]);
  // 空的 Atom 是合法來源（只是這輪沒新聞），不可以當成「不是 RSS」丟錯
  assert.deepEqual(parseNewsRss('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>', { name: '丁學忠' }), []);
  assert.throws(() => parseNewsRss('<feedish>', { name: 'x' }), DataValidationError);
});

test('newsName：族語名只留漢名、異體字換成媒體常用字', () => {
  assert.equal(newsName('伍麗華Saidhai‧Tahovecahe'), '伍麗華');
  assert.equal(newsName('鄭天財Sra Kacaw'), '鄭天財');
  assert.equal(newsName('陳秀寳'), '陳秀寶');
  assert.equal(newsName('丁學忠'), '丁學忠');
  const current = id9.dataList.filter((r) => r.term === '11');
  assert.ok(current.every((r) => newsName(r.name).length >= 2), '每位委員都要有可搜尋的漢名');
});

const socialCsv = readFileSync(fileURLToPath(new URL('./fixtures/social.csv', import.meta.url)), 'utf8');
const idByNewsName = () => new Map(buildDataset(id9, id14).legislators.filter((l) => !l.leave_flag).map((l) => [newsName(l.name), l.id]));

test('parseCsv：引號、跳脫引號、欄位內逗號與換行、BOM、CRLF', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\n"multi\nline",2\n'), [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
    ['multi\nline', '2'],
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('normalizeSocial：真實整理表 113 位全數對應到在職委員', () => {
  const { accounts, warnings } = normalizeSocial(socialCsv, idByNewsName());
  assert.equal(accounts.length, 113);
  assert.deepEqual(warnings, []);
  assert.equal(new Set(accounts.map((a) => a.legislator_id)).size, 113);
  assert.ok(accounts.every((a) => a.platform === 'facebook' && a.url.startsWith('https://www.facebook.com/')));
  assert.ok(accounts.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.latest_post_date) && a.latest_post_summary));
});

test('normalizeSocial：欄位改名、筆數過少、姓名大量對不到時 fail closed', () => {
  assert.throws(() => normalizeSocial(socialCsv.replace('貼文或粉專連結', '連結'), idByNewsName()), DataValidationError);
  const [head, ...lines] = socialCsv.split('\n');
  assert.throws(() => normalizeSocial([head, ...lines.slice(0, 10)].join('\n'), idByNewsName()), DataValidationError);
  assert.throws(() => normalizeSocial(socialCsv, new Map()), DataValidationError);
});

test('預算類型：要有年度、要是預算案本身（決議函件與報告不算）', () => {
  // 名稱、期望、這筆是不是「議案本身」那一類（預設 true）
  const cases = [
    // 真正的預算案／決算議案
    ['「115年度中央政府總預算案（含附屬單位預算及綜計表－營業及非營業部分）」案。', ['general', 'subsidiary']],
    ['「114年度中央政府總預算追加預算案」案。', ['supplementary']],
    ['報告審查行政院函請審議「114年度中央政府總預算追加預算案」案。', ['supplementary']],
    ['報告審查行政院函請審議「115年度中央政府保衛國家安全及強化不對稱戰力計畫採購特別預算案」案。', ['special']],
    ['報告審查行政院函請審議「中央政府前瞻基礎建設計畫第5期特別預算案（114年度）」案。', ['special']],
    ['「中華民國113年度中央政府總決算暨附屬單位決算及綜計表審核報告」、「中央政府前瞻基礎建設計畫第4期特別決算審核報告」案。', ['general', 'subsidiary', 'special']],
    // 沒有年度 → 不算（使用者要求）
    ['中央政府前瞻基礎建設計畫第5期特別預算案', []],
    // 回覆決議的函件、附件、報告 → 不是預算案本身
    ['函，為114年度中央政府總預算決議，檢送前瞻第4期特別預算「地方創生」之執行情形書面報告，請查照案。', []],
    ['函，為113年度中央政府總預算附屬單位預算決議，檢送運動發展基金新增決議第6項書面報告，請查照案。', []],
    ['函，為114年度中央政府總預算追加預算決議，檢送撥補公務人員退休撫卹基金情形書面報告，請查照案。', []],
    ['函送內政委員會115年度附屬單位預算審查報告，請併「中華民國115年度中央政府總預算案附屬單位預算營業及非營業部分審查總報告」討論案。', []],
    ['「112年度中央政府總預算第二預備金動支數額表」案。', []],
    ['函送「中華民國115年度中央政府總預算案內政部暨所屬單位預算勘誤表」，請查照案。', []],
    ['函送財團法人海華文教基金會113年度決算書案。', []],
  ];
  for (const [name, expected] of cases) assert.deepEqual(budgetTypes(name), expected, name.slice(0, 34));
  // 類別不是「議案本身」（決議案／定期報告）→ 一律不給類型，就算名稱看起來像預算案
  assert.deepEqual(budgetTypes('「115年度中央政府總預算案」案。', { billCategory: false }), []);
});
