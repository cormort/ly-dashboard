import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommittees, fetchBillCommittees, billDetailUrl } from '../server/budget-committees.mjs';

// 這一組是從真實 API 回應（2026-10-06 抓「115年度中央政府總預算案」那 24 筆紀錄）抄下來的流程片段
const flow = (...states) => ({ 議案流程: states.map((s) => ({ 狀態: s, 日期: ['2026-04-21'], 會期: '11-05-07' })) });

test('委員會：從議案流程的「交○○委員會」抽出來', () => {
  assert.deepEqual(parseCommittees(flow('排入院會 (交內政委員會)', '復議', '交付審查(依115年4月15日黨團協商結論決定，台灣民眾黨黨團提議重付表決)')), ['內政委員會']);
  // 長名稱（社會福利及衛生環境委員會）也要抓得到——一開始的長度上限太短，這種會抓不到
  assert.deepEqual(parseCommittees(flow('排入院會 (交社會福利及衛生環境委員會)')), ['社會福利及衛生環境委員會']);
  assert.deepEqual(parseCommittees(flow('交付審查(交財政委員會)')), ['財政委員會']);
  // 去重、保留順序
  assert.deepEqual(parseCommittees(flow('排入院會 (交經濟委員會)', '交付審查(交經濟委員會)')), ['經濟委員會']);
  // 沒有委員會的流程（定期報告那種）：留空，不要瞎猜
  assert.deepEqual(parseCommittees(flow('排入院會 (定期舉行會議，邀請行政院院長、主計長、財政部部長列席報告115年度施政計畫)')), []);
  assert.deepEqual(parseCommittees(flow()), []);
  assert.deepEqual(parseCommittees(undefined), []);
});

test('委員會：抓議案詳細資料（含失敗時的行為）', async () => {
  const url = billDetailUrl('301110158311500');
  // 用 CONFIG.bills.url 的基底（https://ly.govapi.tw/v2/bills）+ 議案編號
  assert.ok(url.includes('bills/301110158311500'), url);
  const seen = [];
  const ok = async (target) => {
    seen.push(target);
    return { json: { data: { 議案狀態: '交付審查', '會議代碼:str': '第11屆第4會期第2次會議', 議案流程: [{ 狀態: '排入院會 (交教育及文化委員會)' }] } } };
  };
  const result = await fetchBillCommittees('301110158311500', { fetchImpl: ok });
  assert.deepEqual(result.committees, ['教育及文化委員會']);
  assert.equal(result.status, '交付審查');
  assert.equal(result.meeting, '第11屆第4會期第2次會議');
  assert.ok(seen[0].includes('301110158311500'));
  // 上游把資料包在 bills 陣列裡（列表端點）也要吃得下
  const wrapped = async () => ({ json: { bills: [{ 議案流程: [{ 狀態: '排入院會 (交交通委員會)' }] }] } });
  assert.deepEqual((await fetchBillCommittees('x', { fetchImpl: wrapped })).committees, ['交通委員會']);
});
