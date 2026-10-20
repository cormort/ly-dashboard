/*
 * 會議預告：HTML 解析（純函式）與「未來場次」查詢。
 *
 * 為什麼要測：解析用的是 regex，頁面一改版就會安靜地抓到 0 場（`runForecastIngest` 會保留舊資料、
 * 只寫 warning），所以「有時間的才算一場」「依主辦單位那份才對」「同一場不要重複」都要釘住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import { applyMeetingForecasts } from '../server/db.mjs';
import { decodeEntities, diffForecasts, listUpcomingMeetings, newForecastText, parseForecastHtml, splitTitleAndAgenda, FORECAST_URL } from '../server/forecast.mjs';

// 拿真實頁面的片段改的（欄位、class 都一樣）：兩場，其中一場在「依日期」清單也出現一次
const HTML = `
<div id="forecast_list_comt" class="forecast-list">
  <h4><i class="icon-20-hammer"></i>內政委員會</h4>
  <ul>
    <li>
      <p class="info">
        <span class="time">2026-10-21 09:00</span>
        <span class="group"></span>
        <span class="place">紅樓202會議室</span>
        <span class="status" id="status_1" title="會議尚未開始">會議尚未開始</span>
        <a href="https://ppg.ly.gov.tw/ppg/sittings/2026101966/details?meetingDate=115%2F10%2F21" title="會議相關資料">會議相關資料</a>
      </p>
      <p class="text" title="立法院第11屆第6會期內政委員會第3次全體委員會議（事由：一、處理115年度中央政府總預算關於內政部主管預算凍結案計12案。二、邀請內政部部長列席報告。）">內政</p>
    </li>
    <li>
      <p class="info">
        <span class="time">2026-10-22 09:00</span>
        <span class="place">紅樓101會議室</span>
        <span class="status">會議尚未開始</span>
      </p>
      <p class="text" title="第11屆第6會期經濟委員會第3次全體委員會議（事由：邀請經濟部長報告&amp;備詢）">經濟</p>
    </li>
  </ul>
</div>
<div id="forecast_list_date" class="forecast-list">
  <h4>2026-10-21</h4>
  <ul>
    <li>
      <p class="info"><span class="time">2026-10-21 09:00</span><span class="place">紅樓202會議室</span></p>
      <p class="text" title="立法院第11屆第6會期內政委員會第3次全體委員會議（事由：一、處理115年度中央政府總預算關於內政部主管預算凍結案計12案。二、邀請內政部部長列席報告。）">內政</p>
    </li>
  </ul>
</div>`;

test('解析會議預報：只取「依主辦單位」那份，一場一筆、欄位齊全', () => {
  const items = parseForecastHtml(HTML);
  assert.equal(items.length, 2, '依日期那份是同資料，不要重複算');
  assert.deepEqual(items[0], {
    date: '2026-10-21',
    time: '09:00',
    committee: '內政委員會',
    place: '紅樓202會議室',
    status: '會議尚未開始',
    title: '立法院第11屆第6會期內政委員會第3次全體委員會議',
    agenda: '一、處理115年度中央政府總預算關於內政部主管預算凍結案計12案。二、邀請內政部部長列席報告。',
    materials_url: 'https://ppg.ly.gov.tw/ppg/sittings/2026101966/details?meetingDate=115%2F10%2F21',
  });
  // HTML 實體要解開（&amp; → &）
  assert.match(items[1].agenda, /經濟部長報告&備詢/);
  // 沒有 ppg 連結的場次還是要留著（materials_url 空字串）
  assert.equal(items[1].materials_url, '');
});

test('解析：頁面改版或只有版權列時回空陣列（呼叫端會保留舊資料）', () => {
  assert.deepEqual(parseForecastHtml(''), []);
  assert.deepEqual(parseForecastHtml('<div class="forecast-list"><p>沒有 h4</p></div>'), []);
  assert.deepEqual(parseForecastHtml('<h4>內政委員會</h4><ul><li><p class="info">沒有時間</p></li></ul>'), []);
});

test('會議名稱與事由：用「（事由：」切開，結尾的 ） 去掉', () => {
  assert.deepEqual(splitTitleAndAgenda('第11屆第6會期內政委員會第3次全體委員會議（事由：一、甲。二、乙。）'), {
    title: '第11屆第6會期內政委員會第3次全體委員會議',
    agenda: '一、甲。二、乙。',
  });
  assert.deepEqual(splitTitleAndAgenda('只有名稱'), { title: '只有名稱', agenda: '' });
  assert.deepEqual(splitTitleAndAgenda(''), { title: '', agenda: '' });
});

test('HTML 實體：數字、十六進位與常見名稱都解', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&#39;&#x2F;&quot;'), `'/"`);
  assert.equal(decodeEntities('不知名 &foo; 實體'), '不知名 &foo; 實體');
});

test('未來場次查詢：只回今天之後、照日期與時間排、日期彙總正確', () => {
  const db = openDb(':memory:');
  const fetchedAt = '2026-10-20T00:00:00.000Z';
  applyMeetingForecasts(
    db,
    [
      { date: '2026-10-19', time: '09:00', committee: '內政委員會', title: '過去的會議' },
      { date: '2026-10-21', time: '14:30', committee: '經濟委員會', title: '下午場' },
      { date: '2026-10-21', time: '09:00', committee: '內政委員會', title: '上午場' },
      { date: '2026-11-30', time: '09:00', committee: '財政委員會', title: '太遠了' },
    ],
    { fetchedAt },
  );
  const result = listUpcomingMeetings(db, { days: 3, today: '2026-10-20' });
  assert.equal(result.today, '2026-10-20');
  assert.equal(result.total, 2, '過去與超出範圍的都不算');
  assert.deepEqual(result.items.map((i) => i.title), ['上午場', '下午場'], '同一天照時間排');
  assert.deepEqual(result.dates, [{ date: '2026-10-21', count: 2 }]);
  assert.ok(FORECAST_URL.startsWith('https://ivod.ly.gov.tw/'));
});

test('整批覆寫前後比對：新排定的場次才算「新增」，改時間算新的一筆', () => {
  const before = [
    { date: '2026-10-21', time: '09:00', committee: '內政委員會', title: 'A' },
    { date: '2026-10-21', time: '10:00', committee: '經濟委員會', title: 'B' },
  ];
  const after = [...before, { date: '2026-10-22', time: '09:00', committee: '交通委員會', title: 'C' }];
  assert.deepEqual(diffForecasts(before, after).map((m) => m.title), ['C']);
  assert.deepEqual(diffForecasts([], after).length, 3, '第一次跑：全部都是新的（呼叫端會跳過通知）');
  assert.deepEqual(diffForecasts(before, before), []);
  // 時間改了＝場次資訊變了，也要通知
  const moved = [{ ...before[0], time: '14:00' }, before[1]];
  assert.deepEqual(diffForecasts(before, moved).map((m) => m.time), ['14:00']);
});

test('新增預告的推播文字：場次太多要截斷，最後一行說還有幾場', () => {
  const added = Array.from({ length: 10 }, (_, i) => ({
    date: '2026-10-21',
    time: '09:00',
    committee: '內政委員會',
    place: '紅樓202會議室',
    title: `第${i + 1}場`,
  }));
  const text = newForecastText(added, { max: 8 });
  assert.match(text, /新增會議預告 10 場/);
  assert.match(text, /10\/21 09:00/);
  assert.match(text, /內政委員會・紅樓202會議室/);
  assert.match(text, /還有 2 場/);
  assert.equal(newForecastText([]), '');
});
