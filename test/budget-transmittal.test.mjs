/*
 * 「這筆是不是只是送來備查」的判準（使用者 2026-10-19：「總員額運用狀況。。。專案報告不是預算審議進度」）。
 *
 * 背景：g0v 把「函送…專案報告／進度報告，請查照案」也歸在「中央政府總預算案」，
 * 於是它們會出現在「預算審議最新進度」最上面（日期最新），看起來像預算是這件在審。
 * 實際上「請查照」＝送來備查，沒有進審查程序。
 *
 * 但**不能**用 `agencyReportPattern` 當判準：那條連「函送…委員會…審查報告，請併審查總報告討論案」
 * 也會排掉（14 筆），那些是審查流程的一部分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetIsTransmittal } from '../server/queries.mjs';

test('備查公文：專案報告／進度報告／審查日程表都算「不是預算審議進度」', () => {
  assert.equal(budgetIsTransmittal('函送「中央政府總員額運用狀況專案報告」，請查照案。'), true);
  assert.equal(
    budgetIsTransmittal('函送「提升海巡韌性及強化國安與資通環境計畫」114年第4季辦理進度書面報告，請查照案。'),
    true,
  );
  assert.equal(
    budgetIsTransmittal(
      '函送中華民國115年度中央政府總預算案（含附屬單位預算及綜計表－營業及非營業部分）審查日程暨審查分配表，請查照案。',
    ),
    true,
  );
});

test('預算案本身與「審查報告併案討論」不算備查', () => {
  assert.equal(budgetIsTransmittal('「116年度中央政府總預算案（含附屬單位預算及綜計表－營業及非營業部分）」案。'), false);
  assert.equal(budgetIsTransmittal('「115年度中央政府總預算追加預算案」案。'), false);
  // 這是審查流程的一部分（要討論），不是備查
  assert.equal(
    budgetIsTransmittal(
      '函送經濟委員會115年度附屬單位預算審查報告，請併「中華民國115年度中央政府總預算案附屬單位預算營業及非營業部分審查總報告」討論案。',
    ),
    false,
  );
  assert.equal(budgetIsTransmittal(''), false);
  assert.equal(budgetIsTransmittal(undefined), false);
});
