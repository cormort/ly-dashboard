import { CONFIG } from './config.mjs';

/**
 * 從**立法院議事暨公報資訊網（ppg.ly.gov.tw）**的議案頁補「最新進度日期」。
 *
 * 為什麼需要：g0v 的 LYAPI（我們抓議案與預算的來源）在 `議案流程[].日期` 這一欄，對本會期的
 * 預算議案常常是空的（實測 2026-10-06：本會期 199 筆預算議案全部沒有日期，包含
 * 「115年度中央政府總預算追加預算案」）。查它的 `BillParser.php` 就知道原因：它從議案頁
 * 「審議進度」區塊裡 class 含 `card-text` 的段落抓「○○年○○月○○日」，但「排入院會」那幾列
 * 的日期在頁面上是**連結**（院會連結與 ivod 影片連結），不在 `card-text` 裡 → 它留空。
 *
 * 同一頁的官方資料就有日期（例如 `排入院會 → 院會 11-06-02 → 115年10月02日`），所以我們自己抓。
 * 這一頁是伺服器端渲染，用一般 GET 就有完整 HTML（實測 47KB，不需要瀏覽器）。
 */

/** 議案頁網址（官方議事暨公報資訊網） */
export const ppgBillUrl = (billNo) => `https://ppg.ly.gov.tw/ppg/bills/${encodeURIComponent(billNo)}/details`;

const TWO_DIGIT = (n) => String(n).padStart(2, '0');

/**
 * 民國年日期 → ISO。`115/10/02` → `2026-10-02`。
 * 只接受合理範圍（第 7 屆 2008 年之後、且不超過兩年後），避免抓到頁面模板值或錯字。
 */
export function rocToIso(rocYear, month, day) {
  const y = Number(rocYear) + 1911;
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 立法院資料最早到第 7 屆（2008）；超過兩年後的也擋掉（模板值與錯字）
  if (y < 2008 || y > new Date().getFullYear() + 2) return null;
  return `${y}-${TWO_DIGIT(m)}-${TWO_DIGIT(d)}`;
}

/** `20261002`（ivod 的 Querydate） → `2026-10-02` */
export function queryDateToIso(value) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value));
  if (!m) return null;
  return rocToIso(Number(m[1]) - 1911, m[2], m[3]);
}

/**
 * 解析議案頁的「審議進度」區塊。
 *
 * 回傳每一次進度：`{ status, meeting, chamber, dates: [ISO…] }`
 * - `status`：例如「排入院會」「三讀」
 * - `meeting`／`chamber`：`院會 11-06-02` 這種會議代碼與院會/委員會
 * - `dates`：那一次進度在頁面上列出的日期（可能多個，例如同一狀態排了好幾次院會）
 *
 * 注意：頁面裡有 HTML 註解與 Thymeleaf 模板（`100年12月12日` 是樣板值），必須先移除，
 * 否則會抓到 2011 年的假日期。
 */
export function parseProgress(html) {
  const start = html.indexOf('id="section-3"');
  if (start === -1) return [];
  let section = html.slice(start);
  section = section.replace(/<!--[\s\S]*?-->/g, ' ').replace(/th:[a-z]+="[^"]*"/g, ' ');

  return section
    // 一筆進度＝一個 <dt>（狀態）＋<dd>（會議與日期）；頁面裡只有一個 <dl>，所以用 <dt 切
    .split(/<dt[\s>]/)
    .slice(1)
    .map((card) => {
      const statusMatch = card.match(/class="[^"]*Detail-SkedGroup-Sp[^"]*"[^>]*>\s*([^<]{1,20}?)\s*</);
      const meeting = card.match(/meetingLink\?id=([^"'&]+)/);
      let code = null;
      let place = null;
      let date = null;
      if (meeting) {
        const [rawCode, rawDate, rawChamber] = decodeURIComponent(meeting[1]).split(';');
        code = rawCode || null;
        place = rawChamber || null;
        if (rawDate) {
          const parts = rawDate.split('/');
          if (parts.length === 3) date = rocToIso(parts[0], parts[1], parts[2]);
        }
      }
      const dates = new Set();
      if (date) dates.add(date);
      for (const m of card.matchAll(/Querydate=(\d{8})/g)) {
        const iso = queryDateToIso(m[1]);
        if (iso) dates.add(iso);
      }
      return {
        status: statusMatch ? statusMatch[1] : null,
        meeting: code,
        chamber: place,
        dates: [...dates].sort(),
      };
    })
    .filter((entry) => entry.status || entry.dates.length);
}

/**
 * 取「最新進度日期」：所有進度日期裡**已經發生**（不超過今天）的最新一個。
 * 全部都在未來（議事日程先排好、院會還沒開）時退回最早的那一個，避免留空。
 */
export function latestProgressDate(entries, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const all = [...new Set(entries.flatMap((entry) => entry.dates))].sort();
  if (all.length === 0) return null;
  const past = all.filter((date) => date <= today);
  return past.length > 0 ? past[past.length - 1] : all[0];
}

/** 抓一筆議案的進度日期；抓不到回 null（呼叫端保留空白，不亂填） */
export async function fetchBillProgress(billNo, { fetchImpl, now = new Date() } = {}) {
  const { text } = await fetchImpl(ppgBillUrl(billNo), { ua: CONFIG.userAgent, text: true });
  const entries = parseProgress(text);
  return { billNo, date: latestProgressDate(entries, now), entries: entries.length, status: entries.at(-1)?.status ?? null };
}
