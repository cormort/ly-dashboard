/*
 * 預算審查歷程的純函式測試：階段分類、年度偵測、審查單位（主管機關與基金）。
 * 只驗「從會議文字判斷」這一段；資料庫查詢另外用 curl 驗（見 DECISIONS）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetReviewStage, budgetReviewUnits, budgetYearsOf } from '../server/queries.mjs';

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

test('審查單位：使用者給的退輔會那一場（公務預算＋附屬單位基金、僅詢答）', () => {
  // 這是立法院議事內容摘要的真實句型，兩個部會（退輔會）＋兩檔基金
  const units = budgetReviewUnits({
    content:
      '一、審查115年度中央政府總預算案關於國軍退除役官兵輔導委員會主管收支部分。（僅詢答）' +
      '二、審查115年度中央政府總預算案附屬單位預算關於國軍退除役官兵輔導委員會主管非營業基金：（僅詢答）' +
      '（一）國軍退除役官兵安置基金。（二）榮民醫療作業基金。（4月22日及23日二天一次會）',
  });
  assert.deepEqual(units.agencies, ['國軍退除役官兵輔導委員會']);
  assert.deepEqual(units.funds, ['國軍退除役官兵安置基金', '榮民醫療作業基金']);
  assert.equal(units.subsidiary, true);
  assert.equal(units.qa_only, true);
});

test('審查單位：一場會議審好幾個部會，基金前面的「類別」不算基金', () => {
  const units = budgetReviewUnits({
    content:
      '一、審查114年度中央政府總預算案關於國防部主管收支公開及機密部分（不含國家安全局部分)。（僅詢答）' +
      '二、審查114年度中央政府總預算案附屬單位預算關於國防部主管非營業基金：（僅詢答）' +
      '（一）作業基金：1、國軍生產及服務作業基金。2、國軍老舊眷村改建基金。' +
      '（二）資本計畫基金－國軍營舍及設施改建基金。',
  });
  assert.deepEqual(units.agencies, ['國防部']);
  // 「作業基金」「資本計畫基金」是類別，要取後面的正式名稱
  assert.deepEqual(units.funds, ['國軍生產及服務作業基金', '國軍老舊眷村改建基金', '國軍營舍及設施改建基金']);
  assert.equal(units.qa_only, true);
});

test('審查單位：「及所屬」視為同一個機關；沒有句型就不要硬猜', () => {
  const withAffiliation = budgetReviewUnits({ content: '審查115年度中央政府總預算案關於考試院及所屬主管收支部分。' });
  assert.deepEqual(withAffiliation.agencies, ['考試院']);
  assert.equal(withAffiliation.subsidiary, false);
  assert.equal(withAffiliation.qa_only, false);

  const talkOnly = budgetReviewUnits({
    content: '就「115年度中央政府總預算案至今尚未審查，近3000億元之新興、新增計畫將無法推動」進行專題報告，並備質詢。',
  });
  assert.deepEqual(talkOnly.agencies, []);
  assert.deepEqual(talkOnly.funds, []);
  assert.deepEqual(budgetReviewUnits(), { agencies: [], funds: [], subsidiary: false, qa_only: false });
});

test('審查單位：基金名稱去掉編號與「有關／年度」這類開頭', () => {
  const units = budgetReviewUnits({
    content: '審查115年度中央政府總預算案附屬單位預算關於財政部主管非營業基金：（一）有關財政部主管債務基金－中央政府債務基金。（二）學產基金。',
  });
  assert.deepEqual(units.agencies, ['財政部']);
  assert.deepEqual(units.funds, ['中央政府債務基金', '學產基金']);
});
