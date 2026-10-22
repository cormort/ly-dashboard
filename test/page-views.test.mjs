/*
 * 使用者行為統計（server/page-views.mjs）：只驗「記錄 → 每日統計 → 文字」這條純邏輯。
 *
 * 為什麼要這些測試：這張表是隱私敏感的東西（存了 cookie 的 HMAC），
 * 「統計數字對不對」「會不會把登入算成瀏覽」「時區切日對不對」都要有斷言，
 * 不然日報會安靜地講錯話（例：昨天 0 次瀏覽，其實是切錯日）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.mjs';
import {
  busiestHours,
  classifyUa,
  dailyPageViews,
  ensurePageViewTable,
  localDay,
  pageViewsText,
  previousDay,
  prunePageViews,
  recordPageView,
  viewerHash,
} from '../server/page-views.mjs';

const at = (day, hour, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`).getTime();

const fresh = () => {
  const db = openDb(':memory:');
  ensurePageViewTable(db);
  return db;
};

test('裝置分類：手機／電腦／機器人，分不出來的算 unknown', () => {
  assert.equal(classifyUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'mobile');
  assert.equal(classifyUa('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'mobile');
  assert.equal(classifyUa('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'mobile');
  assert.equal(classifyUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
  assert.equal(classifyUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
  assert.equal(classifyUa('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'bot');
  assert.equal(classifyUa('curl/8.4.0'), 'bot');
  assert.equal(classifyUa(''), 'unknown');
  assert.equal(classifyUa(undefined), 'unknown');
});

test('識別碼：同一張 cookie 同一個碼、換 secret 就不同、沒有 cookie 是空字串', () => {
  assert.equal(viewerHash('cookie-a', 'secret-1'), viewerHash('cookie-a', 'secret-1'));
  assert.notEqual(viewerHash('cookie-a', 'secret-1'), viewerHash('cookie-b', 'secret-1'));
  assert.notEqual(viewerHash('cookie-a', 'secret-1'), viewerHash('cookie-a', 'secret-2'));
  assert.equal(viewerHash('', 'secret-1'), '');
  assert.equal(viewerHash('cookie-a', ''), '');
  assert.match(viewerHash('cookie-a', 'secret-1'), /^[0-9a-f]{8}$/);
});

test('每日統計：瀏覽次數、登入者數、熱門頁與裝置分開算', () => {
  const db = fresh();
  // 10/19 台北時間：同一張 cookie 看兩頁 → 1 位登入者、2 次瀏覽
  recordPageView(db, { path: '/', sessionHash: 'aaaa1111', ua: 'desktop', ts: at('2026-10-19', 9, 10) });
  recordPageView(db, { path: '/budget', sessionHash: 'aaaa1111', ua: 'desktop', ts: at('2026-10-19', 9, 20) });
  // 沒登入的（手機）
  recordPageView(db, { path: '/budget', sessionHash: '', ua: 'mobile', ts: at('2026-10-19', 21, 5) });
  // 登入成功要另計，不能算成一次瀏覽
  recordPageView(db, { path: '/login', kind: 'login', sessionHash: 'bbbb2222', ua: 'mobile', ts: at('2026-10-19', 8, 0) });
  // 別天的不能算進來
  recordPageView(db, { path: '/news', sessionHash: 'cccc3333', ua: 'desktop', ts: at('2026-10-18', 12, 0) });

  const day = dailyPageViews(db, { date: '2026-10-19' });
  assert.equal(day.pv, 3, '瀏覽 3 次（登入那筆不算瀏覽）');
  assert.equal(day.visitors, 1, '只有一張 cookie 有瀏覽');
  assert.equal(day.anonymous, 1);
  assert.equal(day.logins, 1);
  assert.equal(day.loginVisitors, 1);
  assert.deepEqual(day.ua, { mobile: 1, desktop: 2, bot: 0, unknown: 0 });
  assert.equal(day.paths[0].path, '/budget', '熱門頁依次數排');
  assert.equal(day.paths[0].views, 2);
  assert.equal(day.paths[0].visitors, 1);
  assert.equal(day.paths[0].label, '預算審議');
  assert.equal(day.paths.find((p) => p.path === '/').label, '總覽');
  assert.equal(day.hourly[9], 2);
  assert.equal(day.hourly[21], 1);
  assert.equal(day.hourly[8], 0, '登入不算瀏覽時段');
  // 「最早／最晚」只算真人瀏覽（登入那筆不算），所以是 09:10+08:00 ＝ UTC 01:10
  assert.ok(day.first.startsWith('2026-10-19T01'), `最早從 09:10+08:00 開始（UTC 01:10），實際 ${day.first}`);
  assert.equal(day.human, 3, '真人頁面 3 次（這天沒有機器人）');
  assert.equal(day.bot, 0);
});

test('切日看當地時區：台北時間 00:30 算當天，不算前一天', () => {
  const db = fresh();
  // 2026-10-19 00:30 +08:00 = 10-18 16:30 UTC，若用 UTC 切日會記到 10-18
  recordPageView(db, { path: '/', ts: at('2026-10-19', 0, 30) });
  assert.equal(localDay(at('2026-10-19', 0, 30)), '2026-10-19');
  assert.equal(dailyPageViews(db, { date: '2026-10-19' }).pv, 1);
  assert.equal(dailyPageViews(db, { date: '2026-10-18' }).pv, 0);
  assert.equal(previousDay(at('2026-10-19', 0, 30)), '2026-10-18');
});

test('日報文字：沒有資料要講「沒有人開站」，有資料要帶到熱門頁與裝置', () => {
  const empty = dailyPageViews(fresh(), { date: '2026-10-17' });
  assert.match(pageViewsText(empty), /沒有人開站/);

  const db = fresh();
  recordPageView(db, { path: '/budget', sessionHash: 'aaaa1111', ua: 'mobile', ts: at('2026-10-19', 10, 0) });
  recordPageView(db, { path: '/budget', sessionHash: 'bbbb2222', ua: 'desktop', ts: at('2026-10-19', 10, 30) });
  recordPageView(db, { path: '/', kind: 'login', sessionHash: 'cccc3333', ua: 'desktop', ts: at('2026-10-19', 9, 0) });
  const text = pageViewsText(dailyPageViews(db, { date: '2026-10-19' }));
  assert.match(text, /2026-10-19/);
  // 全站共用一組帳號 → 日報講「裝置」不是「人」（同一人換裝置會算兩台）
  assert.match(text, /瀏覽 2 次・2 台裝置/);
  assert.match(text, /登入 1 次/);
  assert.match(text, /熱門：預算審議 2/);
  assert.match(text, /手機 1/);
  assert.match(text, /最忙：09–11 時/);
});

test('最忙時段：以 3 小時為一格，取最高的一格', () => {
  // 12–14 這一格：13 時 5 次 + 14 時 2 次 = 7（同一格要加起來，不是取單一小時）
  const summary = { hourly: Array.from({ length: 24 }, (_, h) => (h === 13 ? 5 : h === 14 ? 2 : h === 8 ? 3 : 0)) };
  assert.deepEqual(busiestHours(summary), [{ from: 12, to: 14, views: 7 }]);
  assert.deepEqual(busiestHours({ hourly: Array(24).fill(0) }), []);
});

test('清理：超過保留天數的舊資料會刪掉，新的留著', () => {
  const db = fresh();
  recordPageView(db, { path: '/old', ts: at('2025-01-01', 12, 0) });
  recordPageView(db, { path: '/new', ts: at('2026-10-19', 12, 0) });
  const removed = prunePageViews(db, { keepDays: 400, now: at('2026-10-20', 8, 0) });
  assert.equal(removed, 1);
  assert.equal(dailyPageViews(db, { date: '2026-10-19' }).pv, 1);
  assert.equal(dailyPageViews(db, { date: '2025-01-01' }).pv, 0);
});

test('只接受認識的 kind（打錯字要炸，不要安靜寫進統計）', () => {
  const db = fresh();
  assert.throws(() => recordPageView(db, { path: '/', kind: 'pageview' }), /未知的 kind/);
  assert.equal(dailyPageViews(db, { date: localDay() }).pv, 0);
});


test('機器人與真人分開算：pv 含機器人，但熱門頁／時段／未登入只看真人', () => {
  const db = fresh();
  // 真人：1 台裝置看 2 頁，另有 1 次未登入
  recordPageView(db, { path: '/', sessionHash: 'aaaa1111', ua: 'mobile', ts: at('2026-10-21', 9, 10) });
  recordPageView(db, { path: '/budget', sessionHash: 'aaaa1111', ua: 'mobile', ts: at('2026-10-21', 9, 20) });
  recordPageView(db, { path: '/', sessionHash: '', ua: 'mobile', ts: at('2026-10-21', 9, 30) });
  // 機器人：早上 8 點灌 5 次（沒有 cookie —— 舊算法會算成「未登入 5 次」）
  for (let i = 0; i < 5; i += 1) {
    recordPageView(db, { path: '/my', sessionHash: '', ua: 'bot', ts: at('2026-10-21', 8, 10 + i) });
  }
  const day = dailyPageViews(db, { date: '2026-10-21' });
  assert.equal(day.pv, 8, 'pv 仍是全部（含機器人）');
  assert.equal(day.human, 3);
  assert.equal(day.bot, 5);
  assert.equal(day.anonymous, 1, '未登入只算真人（不是 6）');
  assert.equal(day.visitors, 1);
  assert.equal(day.paths.find((p) => p.path === '/my'), undefined, '機器人看的頁不進熱門頁');
  assert.equal(day.hourly[8], 0, '最忙時段不能是機器人灌出來的 8 點');
  assert.equal(day.hourly[9], 3);
  const text = pageViewsText(day);
  assert.match(text, /真人瀏覽 3 次・1 台裝置（另有機器人 5 次，不計入）/);
  assert.match(text, /其中未登入 1 次/);
  assert.ok(!text.includes('未登入 6'), '不能把機器人算成未登入');
});

test('只有機器人的那天：講清楚是機器人，不要寫成「沒有人開站」', () => {
  const db = fresh();
  recordPageView(db, { path: '/', sessionHash: '', ua: 'bot', ts: at('2026-10-22', 10, 0) });
  const day = dailyPageViews(db, { date: '2026-10-22' });
  assert.equal(day.human, 0);
  assert.equal(day.bot, 1);
  assert.match(pageViewsText(day), /只有機器人來（1 次/);
});
