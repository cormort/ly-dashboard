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

test('「邀請機關專案報告／業務報告」不是預算審查的一關', () => {
  // 使用者 2026-10-19：「邀請專案報告不在預算審查的一般程序」。整場只有報告與質詢、沒有審查字樣 → briefing
  assert.equal(
    budgetReviewStage({
      committee: '財政委員會',
      name: '立法院第11屆第2會期財政委員會第19次全體委員會議',
      content:
        '邀請行政院秘書長、行政院主計總處主計長、財政部部長就「因財劃法修正，114年度總預算須重編」進行專題報告，並備質詢。',
    }),
    'briefing',
  );
  assert.equal(
    budgetReviewStage({ committee: '交通委員會', name: '交通委員會全體委員會議', content: '邀請國家通訊傳播委員會代理主任委員列席報告業務概況，並備質詢。' }),
    'briefing',
  );
  // 同一場「先邀請報告、再審查預算」還是委員會審查（那一關真的有審），但清單要標「含專案報告」
  assert.equal(
    budgetReviewStage({
      committee: '經濟委員會',
      name: '經濟委員會第5次全體委員會議',
      content: '一、邀請經濟部部長就「當前供水情勢」進行報告，並備質詢。二、審查113年度中央政府總預算案附屬單位預算營業部分關於經濟部主管。',
    }),
    'committee',
  );
  // 「審查」只出現在引號裡的專題名稱 → 仍然不是審查（2025/12/24、2026/01/05 兩場專題報告就是這樣被算進委員會審查）
  assert.equal(
    budgetReviewStage({
      committee: '財政委員會',
      name: '立法院第11屆第4會期財政委員會第10次全體委員會議',
      content:
        '邀請行政院主計總處主計長、財政部部長就「115年度中央政府總預算案至今尚未審查，近3000億元之新興、新增計畫將無法推動，對國家整體發展之影響」進行專題報告，並備質詢。',
    }),
    'briefing',
  );
  // 引號外真的有「審查」→ 委員會審查
  assert.equal(
    budgetReviewStage({
      committee: '財政委員會',
      name: '立法院第11屆第4會期財政委員會第11次全體委員會議',
      content:
        '一、邀請財政部部長就「馬鈴薯輸入之邊境管制」進行專題報告，並備質詢。二、審查中華民國115年度中央政府總預算案有關主計總處暨審計部部分。（僅詢答）',
    }),
    'committee',
  );
  // 立法院資料夾 CJK 相容表意字（「年」U+FA8E、「度」U+FA01）：看起來一樣，但 regex 比對不到
  // U+F98E＝「年」的相容表意字、U+FA01＝「度」的相容表意字（立法院 LIS 匯出的字就是這兩個）
  const compat = { committee: '財政委員會', name: '立法院第11屆第5會期財政委員會第20次全體委員會議', content: '一、彙總整理提出「中華民國115\uF98E\uFA01中央政府總預算案審查總報告草案」提報院會案。' };
  assert.deepEqual(budgetYearsOf(compat), [115], '相容表意字的「115年度」也要認得出來是哪一年度');
  assert.equal(budgetReviewStage(compat), 'summary');

  // 財政委員會「彙總整理提出審查總報告」是獨立一階（LIS 程序裡的一步）
  assert.equal(
    budgetReviewStage({
      committee: '財政委員會',
      name: '立法院第11屆第5會期財政委員會第20次全體委員會議',
      content: '一、彙總整理提出「中華民國115年度中央政府總預算案審查總報告（公務預算部分）草案」提報院會案。二、審查本院委員擬具「會計師法部分條文修正草案」案。',
    }),
    'summary',
  );
  // 協商／凍結案處理即使提到專案報告，仍照原本的階段走
  assert.equal(
    budgetReviewStage({ committee: '朝野黨團協商', name: '立法院黨團協商', content: '研商總預算案及專案報告事宜。' }),
    'negotiation',
  );
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
