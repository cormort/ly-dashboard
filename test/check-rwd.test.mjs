import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, OVERFLOW_TOLERANCE, HEADER_MAX_PX, overflowOf, failures } from '../scripts/check-rwd.mjs';

/**
 * 這支測試只驗「純函式」的部分（路由清單、溢出量、失敗判定）——
 * 真正量 DOM 的那一段要跑 `npm run check:rwd`（需要本機伺服器與 Chrome）。
 */
test('check-rwd：路由清單要涵蓋所有頁面，而且都是合法路徑', () => {
  assert.ok(ROUTES.length >= 20, '路由清單太少，可能漏了新頁面');
  assert.ok(ROUTES.every((r) => r.startsWith('/')), '路由一律以 / 開頭');
  assert.equal(new Set(ROUTES).size, ROUTES.length, '不可以有重複');
  for (const must of ['/', '/legislators', '/council', '/facebook/wall', '/counties']) {
    assert.ok(ROUTES.includes(must), `清單要有 ${must}`);
  }
});

test('check-rwd：溢出量＝scrollWidth − clientWidth，不會是負數', () => {
  assert.equal(overflowOf({ scrollWidth: 621, clientWidth: 390 }), 231);
  assert.equal(overflowOf({ scrollWidth: 390, clientWidth: 390 }), 0);
  assert.equal(overflowOf({ scrollWidth: 388, clientWidth: 390 }), 0, '比視窗窄不是溢出');
  assert.equal(overflowOf({}), 0, '量不到時不要當成溢出（另外用 error 標記）');
});

test('check-rwd：1px 以內的次像素誤差不算失敗，超過就算', () => {
  const rows = [
    { width: 390, route: '/', overflow: 0, headerH: 179 },
    { width: 390, route: '/legislators', overflow: OVERFLOW_TOLERANCE, headerH: 179 },
    { width: 390, route: '/council', overflow: OVERFLOW_TOLERANCE + 1, headerH: 179 },
  ];
  assert.deepEqual(
    failures(rows).map((r) => r.route),
    ['/council'],
  );
});

test('check-rwd：--strict 才會把「頁首太高」算失敗（手機希望 ≤128，現況 179）', () => {
  const rows = [{ width: 390, route: '/', overflow: 0, headerH: HEADER_MAX_PX + 1 }];
  assert.deepEqual(failures(rows), [], '預設只看橫向溢出');
  assert.deepEqual(
    failures(rows, { strict: true }).map((r) => r.route),
    ['/'],
    '--strict 時頁首過高要算失敗',
  );
});
