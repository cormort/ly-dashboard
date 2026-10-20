import { getAgencyHome, listActivity, listBills, listBudget, listBudgetReports, listCommitteeActivity, listNews, listNewsArticles, listRankings, listRegions } from './queries.mjs';
import { listUpcomingMeetings } from './forecast.mjs';

/**
 * 預熱：伺服器啟動後、每次資料寫入後，在背景把「總覽頁打開時的查詢」先跑一遍。
 *
 * 為什麼：有些查詢第一次很貴（例如 allNewsGroups 要讀三張新聞表合併，算完才快取），SQLite 的頁也要先讀進 OS 快取。
 * 在 GCE e2-micro（共用核心＋標準永久磁碟）上，重啟後第一次打開總覽，11 支請求排在單執行緒後面，
 * 前端 15 秒逾時又自動重試、越積越多，整頁「讀取中」好幾分鐘；熱了之後全部加起來約 2.5 秒（實測）。
 * 讓伺服器自己先付掉這筆成本，第一個使用者就不必等。
 *
 * 參數與 web/src/pages/DashboardPage.tsx 的 useApi 一致（預設機關＝MyAgencyPage 的 DEFAULT_AGENCY）。
 */
export const WARMUP_QUERIES = [
  ['activity', (db) => listActivity(db, { limit: 4 })],
  ['news', (db) => listNews(db, { limit: 8 })],
  ['news/articles', (db) => listNewsArticles(db, { scope: 'officials', limit: 5 })],
  ['bills', (db) => listBills(db, { limit: 3 })],
  ['bills 三讀', (db) => listBills(db, { status: '三讀', limit: 3 })],
  ['budget', (db) => listBudget(db, { limit: 3 })],
  ['budget/reports', (db) => listBudgetReports(db, { limit: 3 })],
  ['rankings', (db) => listRankings(db, { type: 'all', days: 30, limit: 3 })],
  ['committee-activity', (db) => listCommitteeActivity(db, { limit: 3 })],
  ['regions', (db) => listRegions(db, { per: 2 })],
  ['meetings/upcoming', (db) => listUpcomingMeetings(db, { days: 10, limit: 1 })],
  ['agency', (db) => getAgencyHome(db, { name: '行政院主計總處' })],
];

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 依序跑完清單；每一支之前讓出事件迴圈，真的使用者請求可以插隊，不會被整批預熱卡住。
 * 單支失敗只記 log、繼續下一支（預熱是加速，不是功能，不能讓它把伺服器弄倒）。
 */
export async function warmUp(db, { logger = console, queries = WARMUP_QUERIES, yieldFn = nextTick } = {}) {
  const started = Date.now();
  let ok = 0;
  for (const [label, run] of queries) {
    await yieldFn();
    try {
      run(db);
      ok += 1;
    } catch (error) {
      logger.warn(`[warmup] ${label} 失敗：${error?.message ?? error}`);
    }
  }
  logger.log(`[warmup] 完成 ${ok}/${queries.length}，${Date.now() - started} ms`);
  return { ok, total: queries.length };
}
