/*
 * 預算審查歷程的純函式測試：階段分類、年度偵測。
 * 只驗「從會議文字判斷」這一段；資料庫查詢另外用 curl 驗（見 DECISIONS）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetReviewStage, budgetYearsOf } from '../server/queries.mjs';

test('預算審查階段：協商／聯席／公聽會／院會／委員會', () => {
  assert.equal(budgetReviewStage({ committee: '朝野黨團協商', name: '立法院黨團協商' }), 'negotiation');
  assert.equal(budgetReviewStage({ committee: '朝野黨團協商(台灣民眾黨黨團)', name: '立法院朝野黨團協商' }), 'negotiation');
  assert.equal(budgetReviewStage({ committee: '交通、教育及文化委員會', name: '第11屆第6會期交通、教育及文化委員會第1次聯席會議' }), 'joint');
  assert.equal(budgetReviewStage({ committee: '財政委員會', name: '財政委員會公聽會' }), 'hearing');
  assert.equal(budgetReviewStage({ committee: '全院委員會', name: '全院委員會會議' }), 'plenary');
  assert.equal(budgetReviewStage({ committee: '財政委員會', name: '立法院第11屆第6會期財政委員會第3次全體委員會議' }), 'committee');
  // 預算通過後的「處理總預算決議／凍結案」不是審查，另標一階
  assert.equal(budgetReviewStage({ committee: '財政委員會', name: '財政委員會第2次全體委員會議', content: '處理中華民國115年度中央政府總預算決議，有關財政部主管預算凍結書面報告案 43 案。' }), 'resolution');
  assert.equal(budgetReviewStage({ committee: '教育及文化委員會', name: '教育及文化委員會第4次全體委員會議', content: '解凍案審查' }), 'resolution');
  // 缺欄位不要炸
  assert.equal(budgetReviewStage(), 'committee');
});

test('預算年度：一場會議可以同時屬於多個年度', () => {
  const both = budgetYearsOf({
    name: '立法院朝野黨團協商',
    content: '一、研商「中華民國114年度中央政府總預算案附屬單位預算」。二、研商「115年度中央政府總預算案」。',
  });
  assert.deepEqual(both, [114, 115]);

  assert.deepEqual(budgetYearsOf({ content: '繼續研商「中華民國115年度中央政府總預算案」（公務預算部分）' }), [115]);
  assert.deepEqual(budgetYearsOf({ content: '總預算案（115 年度）追加減預算' }), [115], '年度寫在總預算後面也要認得');
  assert.deepEqual(budgetYearsOf({ content: '115年度決算審核報告' }), [], '不是總預算就不要算進來');
  assert.deepEqual(budgetYearsOf({ content: '' }), []);
  assert.deepEqual(budgetYearsOf(), []);
  // 重複提到同一年度只算一次
  assert.deepEqual(budgetYearsOf({ content: '115年度中央政府總預算案；115年度中央政府總預算案附屬單位預算' }), [115]);
});
