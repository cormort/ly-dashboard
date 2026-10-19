/*
 * 預算審查歷程的純函式測試：階段分類、年度偵測、審查單位（主管機關與基金）。
 * 只驗「從會議文字判斷」這一段；資料庫查詢另外用 curl 驗（見 DECISIONS）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetEvidenceSentence, budgetReportSentence, budgetReviewStage, budgetReviewUnits, budgetYearGroup, budgetYearsOf, reportsBudgetInPlenary } from '../server/queries.mjs';

test('預算審查階段：協商／聯席／公聽會／院會／委員會', () => {
  assert.equal(budgetReviewStage({ committee: '朝野黨團協商', name: '立法院黨團協商' }), 'negotiation');
  assert.equal(budgetReviewStage({ committee: '朝野黨團協商(台灣民眾黨黨團)', name: '立法院朝野黨團協商' }), 'negotiation');
  assert.equal(budgetReviewStage({ committee: '交通、教育及文化委員會', name: '第11屆第6會期交通、教育及文化委員會第1次聯席會議' }), 'joint');
  assert.equal(budgetReviewStage({ committee: '財政委員會', name: '財政委員會公聽會' }), 'hearing');
  assert.equal(budgetReviewStage({ committee: '全院委員會', name: '全院委員會會議' }), 'plenary');
  assert.equal(budgetReviewStage({ committee: '財政委員會', name: '立法院第11屆第6會期財政委員會第3次全體委員會議' }), 'committee');
  // 解凍案是「法定預算之後」的執行事項，不算預算審議（使用者 2026-10-19）
  assert.equal(
    budgetReviewStage({ committee: '財政委員會', name: '財政委員會第2次全體委員會議', content: '處理中華民國115年度中央政府總預算決議，有關財政部主管預算凍結書面報告案 43 案。' }),
    'unfreeze',
  );
  assert.equal(budgetReviewStage({ committee: '教育及文化委員會', name: '教育及文化委員會第4次全體委員會議', content: '解凍案審查' }), 'unfreeze');
  // 混合場：「審查或處理…預算凍結案」的那個「審查」是在審凍結案，不是審預算 → 一樣是 unfreeze
  assert.equal(
    budgetReviewStage({
      committee: '內政委員會',
      name: '內政委員會第7次全體委員會議',
      content: '審查或處理113年度中央政府總預算案有關大陸委員會預算凍結案計5案。',
    }),
    'unfreeze',
  );
  // 但同一場的另一句真的在審今年度總預算案（2026-06-17 交通委員會）→ 仍算委員會審查
  assert.equal(
    budgetReviewStage(
      {
        committee: '交通委員會',
        name: '交通委員會第14次全體委員會議',
        content:
          '一、處理114年度中央政府總預算附屬單位預算營業部分關於交通部主管國營臺灣鐵路股份有限公司預算凍結案計6案。' +
          '二、繼續審查115年度中央政府總預算案關於國家運輸安全調查委員會單位預算。',
      },
      115,
    ),
    'committee',
  );
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
  // 院會報告並備質詢：只有「列席報告『今年度中央政府總預算案』編製經過並備質詢」那一句才算
  const budgetReportText =
    '一、討論事項：本院國民黨黨團，建請院會作成決議：「針對開放印度移工來台…」是否有當？請公決案等4案。（4月17日）' +
    '二、對行政院院長提出施政方針及施政報告繼續質詢。（4月17日）' +
    '三、行政院院長、主計長、財政部部長列席報告「115年度中央政府總預算案」編製經過並備質詢（含志願役軍人加薪及警消人員退休金等預算編製處理情形併予報告）。（4月21日）';
  assert.equal(reportsBudgetInPlenary({ date: '2026-04-21', content: budgetReportText }, 115, '2026-04-17'), true, '句尾註明（4月21日）→ 只有 04-21 那天算院會報告');
  assert.equal(reportsBudgetInPlenary({ date: '2026-04-17', content: budgetReportText }, 115, '2026-04-17'), false, '同一場的前一天不算（那天在質詢別的案子）');
  // 沒有註明日期 → 取這場會議最早的一天（2024-11-01／11-05 的第7次會議）
  const noStamp = '一、行政院院長、主計長、財政部部長列席報告「114年度中央政府總預算案」及「中央政府前瞻基礎建設計畫第5期特別預算案」編製經過並備質詢。';
  assert.equal(reportsBudgetInPlenary({ date: '2024-11-01', content: noStamp }, 114, '2024-11-01'), true, '同句同時報告總預算與特別預算 → 算');
  assert.equal(reportsBudgetInPlenary({ date: '2024-11-05', content: noStamp }, 114, '2024-11-01'), false, '沒有日期註記時只算最早一天');
  // 追加預算是另一本預算，不算當年度總預算的報告（2024-11-15 實測誤收）
  assert.equal(
    reportsBudgetInPlenary(
      { date: '2024-11-15', content: '二、行政院院長、主計長、財政部部長及相關部會首長列席報告「113年度中央政府總預算案追加預算案」編製經過並備質詢。' },
      113,
      '2024-11-15',
    ),
    false,
  );
  // 別的年度 → 不算
  assert.equal(reportsBudgetInPlenary({ date: '2026-04-21', content: budgetReportText }, 114, '2026-04-21'), false);

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

test('認定依據：挑出「為什麼算這一關」的那一句（畫面不必 mouseover 整個議程）', () => {
  // 2026-04-21 院會：預算報告寫在第三點，前兩點是別的事（使用者 2026-10-19 反映要 hover 才看得到）
  const text =
    '一、討論事項：本院國民黨黨團，建請院會作成決議：「針對開放印度移工來台…」是否有當？請公決案等4案。（4月17日）' +
    '二、對行政院院長提出施政方針及施政報告繼續質詢。（4月17日）' +
    '三、行政院院長、主計長、財政部部長列席報告「115年度中央政府總預算案」編製經過並備質詢（含志願役軍人加薪及警消人員退休金等預算編製處理情形併予報告）。（4月21日）';
  const sentence = budgetReportSentence({ date: '2026-04-21', content: text }, 115, '2026-04-17');
  assert.ok(sentence && sentence.includes('編製經過'), '要挑到「編製經過」那一句');
  assert.ok(sentence.startsWith('三、'), '而且要是第三點那一句，不是前面兩點');
  assert.equal(budgetReportSentence({ date: '2026-04-17', content: text }, 115, '2026-04-17'), null, '不是報告日就沒有依據');

  // 委員會：優先挑含「審查」的那一句，而不是前面邀請報告那一句
  const committeeText =
    '一、邀請財政部部長就「馬鈴薯輸入之邊境管制」進行專題報告，並備質詢。二、審查中華民國115年度中央政府總預算案有關主計總處暨審計部部分。';
  assert.ok(budgetEvidenceSentence(committeeText, 115, 'committee').startsWith('二、審查'));
  assert.equal(budgetEvidenceSentence('邀請國家通訊傳播委員會列席報告業務概況，並備質詢。', 115, 'committee'), null, '沒講到總預算就沒有依據');
});

test('認定依據：報告那一句不會被別的場次借去當依據', () => {
  // 2026-04-17 是同一場會議的前一天（那天在質詢別的案子），議程裡雖然有「（4月21日）…編製經過」那句，
  // 也不能拿它當「04-17 這場算院會」的依據（使用者 2026-10-19 看到 04/17 那列出現報告那句）。
  const text =
    '一、討論事項：本院台灣民眾黨黨團，針對「115年度中央政府總預算案」院會所作之決定提出復議。是否有當？請公決案。（4月17日）' +
    '二、對行政院院長提出施政方針及施政報告繼續質詢。（4月17日）' +
    '三、行政院院長、主計長、財政部部長列席報告「115年度中央政府總預算案」編製經過並備質詢。（4月21日）';
  const evidence = budgetEvidenceSentence(text, 115, 'plenary');
  assert.ok(evidence && !evidence.includes('編製經過'), '不能拿報告那句當別場次的依據');
  assert.ok(evidence.includes('115年度中央政府總預算'), '還是要挑到講今年度總預算的那一句');
});

test('年度分組：沒年度的特別預算歸「跨年度」，不是「年度不明」', () => {
  // 特別預算是期間的概念（前瞻第5期 114–118 年度、花蓮馬太鞍溪災後重建…），案由常常不寫年度
  assert.equal(budgetYearGroup({ fiscal_year: 115, types: ['general'] }), '115');
  assert.equal(budgetYearGroup({ fiscal_year: '', types: ['special'] }), 'special');
  assert.equal(budgetYearGroup({ fiscal_year: null, types: ['special'] }), 'special');
  assert.equal(budgetYearGroup({ fiscal_year: '', types: ['general'] }), 'unknown');
  assert.equal(budgetYearGroup({ fiscal_year: '', types: [] }), 'unknown');
  // 有寫年度的特別預算照年份走（例：保衛國家安全特別預算 115 年度）
  assert.equal(budgetYearGroup({ fiscal_year: 115, types: ['special'] }), '115');
});
