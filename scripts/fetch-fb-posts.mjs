#!/usr/bin/env node
/**
 * 每日抓取委員臉書粉專的「最新一則貼文」→ 產生可以直接貼回整理表的 CSV（或直接寫回 Google 試算表）。
 *
 *   node scripts/fetch-fb-posts.mjs                       # 讀 LY_SOCIAL_CSV（沒設就用內建試算表），輸出 posts-YYYY-MM-DD.csv
 *   node scripts/fetch-fb-posts.mjs --ids 1,2,7 --limit 5 # 只跑幾位（測試用）
 *   node scripts/fetch-fb-posts.mjs --csv 本機.csv --out /tmp/posts.csv
 *   node scripts/fetch-fb-posts.mjs --verify              # 額外輸出頁面顯示名稱與追蹤者（給 docs/fb-verification 用）
 *   node scripts/fetch-fb-posts.mjs --write-sheet --key service_account.json --gid 1325033898
 *
 * 為什麼需要真實瀏覽器：
 *   2026-10 起 Facebook 對未登入、非瀏覽器的請求一律回登入頁（curl／fetch 實測 HTTP 400 或只有
 *   泛用標題「Facebook」），粉專貼文只有「已登入的瀏覽器」看得到。所以這支腳本用 playwright-core
 *   開**獨立的 Chrome 設定檔**（預設 .cache/fb-profile，已 gitignore），第一次要人工登入一次，
 *   之後沿用同一份 cookie。headless 可跑；headful（--headful）在 FB 擋自動化時比較不容易被擋。
 *
 * 為什麼要 fail closed／不編造（docs/social-sheet-spec.md 的規則）：
 *   網站用「所有人最新貼文日期中最新的那一天」判斷整理表有沒有在更新（超過 LY_SOCIAL_STALE_DAYS
 *   會在畫面警示）。查不到就填今天會讓警示失效，所以這裡查不到一律**留空**，並在結尾回報
 *   「幾列填了日期、幾列留空」——寧可空白，也不要錯的日期。
 *
 * 貼文日期怎麼來（三層，先拿到的為準）：
 *   1. 頁面上帶 aria-label 的日期（例：「2026年10月5日 星期一下午5:42」）
 *   2. 貼文永久連結頁的日期（首頁只有相對時間「3天」時，再開那一則的永久連結）
 *   3. 頁面內嵌 JSON 的 `creation_time`（epoch；版面改到抓不到日期時的最後防線）
 *   取「最新」＝日期最大者，因此置頂的舊貼文不會被誤當成最新。
 *
 * 需要 playwright-core（不隨專案安裝，因為只有要跑這支腳本的那臺機器需要）：
 *   npm i -D playwright-core        # 用系統的 Chrome（channel: 'chrome'），不會下載瀏覽器
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHEET_ID = process.env.LY_SOCIAL_SHEET_ID ?? '11XrvNGMKZb_8rekFdGIg5VsXcV8rdJkZjyzd1I4gAMM';
const SHEET_GID = Number(process.env.LY_SOCIAL_GID ?? 1325033898);
const DEFAULT_CSV = process.env.LY_SOCIAL_CSV ?? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const { values: args } = parseArgs({
  options: {
    csv: { type: 'string' },
    out: { type: 'string' },
    ids: { type: 'string' },
    limit: { type: 'string' },
    profile: { type: 'string', default: process.env.LY_FB_PROFILE ?? join(homedir(), '.ly-dashboard', 'fb-profile') },
    'min-delay': { type: 'string', default: '4' },
    'max-delay': { type: 'string', default: '9' },
    headful: { type: 'boolean', default: false },
    login: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    'verify-out': { type: 'string' },
    'write-sheet': { type: 'boolean', default: false },
    key: { type: 'string' },
    gid: { type: 'string' },
    timeout: { type: 'string', default: '90' },
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ---------------------------------------------------------------- CSV 工具 */

/** 讀 CSV（支援引號、逗號、跳脫的雙引號；整理表的欄位都是單行文字） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ------------------------------------------------------------ 時間與摘要 */

const CJK_DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;

/** 「2026年10月5日」→「2026-10-05」；已是 YYYY-MM-DD 或 2026/10/5 也接受，其餘回 null（不猜） */
export function toSheetDate(value) {
  const s = String(value ?? '').trim();
  const cjk = s.match(CJK_DATE);
  if (cjk) return `${cjk[1]}-${String(cjk[2]).padStart(2, '0')}-${String(cjk[3]).padStart(2, '0')}`;
  const ymd = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
  return null;
}

const dateKey = (s) => {
  const m = String(s ?? '').match(CJK_DATE);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
};

const epochToDate = (ts) => {
  const d = new Date((Number(ts) + 8 * 3600) * 1000); // 臺灣時間
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** 摘要：單行、去掉 FB 的「查看更多」尾綴、上限 60 字（docs/social-sheet-spec.md 的建議） */
export function cleanSummary(text, limit = 60) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/……\s*查看更多\s*$/, '')
    .replace(/\.{3}\s*See more\s*$/i, '')
    .replace(/^\p{Script=Han}{1,6}\s+/, '') // 開頭若是留言者姓名（版面差異）時去掉
    .trim();
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/* --------------------------------------------------------- 頁面內擷取 JS */

const EXTRACT = `() => {
  const out = { dates: [], texts: [], messages: [], pageName: '', followers: '', login: false };
  const body = (document.body && document.body.innerText) || '';
  out.login = /登入 Facebook|Log into Facebook|Log in to Facebook/.test(body.slice(0, 4000));
  out.pageName = (document.title || '').replace(/^\\(\\d+\\)\\s*/, '').replace(/\\s*\\|\\s*Facebook$/, '').trim();
  const fl = body.match(/([\\d.,]+\\s*[萬千]?)\\s*位追蹤者/) || body.match(/([\\d.,]+\\s*[萬千]?)\\s*people follow/);
  out.followers = fl ? fl[1] : '';
  const dateRx = /(\\d{4}年\\d{1,2}月\\d{1,2}日)/;
  const relRx = /^(\\d+)\\s*(分鐘|小時|天|週|個月|年)/;
  const abs = (s) => { const m = (s || '').match(dateRx); return m ? m[1] : ''; };
  // 互動數（讚／留言）：取「這一篇貼文」互動列的數字。Facebook 的貼文與貼文底下的留言都是
  // role="article"，所以只認「容器就是這一篇」的按鈕 —— 不這樣做的話，一則被讚很多的留言
  // 會蓋掉貼文本身的數字（實測：貼文 7,311 讚、裡面一則留言 84 個心情）。
  const NUM = (t) => {
    const m = String(t || '').replace(/,/g, '').match(/(\\d+(?:\\.\\d+)?)\\s*([萬千]?)/);
    if (!m) return '';
    const n = Math.round(Number(m[1]) * (m[2] === '萬' ? 10000 : m[2] === '千' ? 1000 : 1));
    return Number.isFinite(n) ? String(n) : '';
  };
  const eng = (el) => {
    const box = el.closest('[role="article"]');
    if (!box) return { likes: '', comments: '' };
    const owned = (n) => n.closest('[role="article"]') === box;
    const btnNum = (label) => {
      const b = [...box.querySelectorAll('[role="button"]')].find((n) => owned(n) && (n.getAttribute('aria-label') || '').trim() === label);
      return b ? NUM((b.innerText || '').trim()) : '';
    };
    // 備援：aria-label 直接寫成「讚：1,429人」時取那個數字
    const al = [...box.querySelectorAll('[role="button"], span[role="toolbar"]')]
      .filter(owned).map((n) => (n.getAttribute('aria-label') || '').trim()).find((s) => /^讚[:：]/.test(s)) || '';
    const m = al.match(/讚[:：]\\s*([\\d,.]+[萬千]?)/);
    return { likes: btnNum('讚') || (m ? NUM(m[1]) : ''), comments: btnNum('留言') };
  };
  document.querySelectorAll('[aria-label]').forEach((el) => {
    const d = abs(el.getAttribute('aria-label'));
    if (!d) return;
    const a = el.closest('a');
    const href = a ? (a.href || '').split('?')[0] : '';
    // 留言的時間戳也要排除（留言的 aria-label 同樣是「2026年10月6日 …」）
    if (a && /comment_id=/.test(a.href || '')) return;
    out.dates.push({ date: d, rel: '', href, ...eng(el) });
  });
  document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"]').forEach((a) => {
    const raw = a.href || '';
    // 留言也有永久連結（帶 comment_id），它的時間是「留言時間」不是「貼文時間」——一定要排除，
    // 否則一則今天的新留言會讓舊貼文看起來像今天發的。
    if (/comment_id=/.test(raw)) return;
    const txt = (a.innerText || '').trim().replace(/\\s+/g, ' ');
    const href = raw.split('?')[0].split('#')[0];
    const d = abs(txt) || abs(a.getAttribute('aria-label') || '');
    if (d) out.dates.push({ date: d, rel: '', href, ...eng(a) });
    else if (relRx.test(txt)) out.dates.push({ date: '', rel: txt.slice(0, 20), href, ...eng(a) });
    else if (txt.length > 25) out.texts.push({ text: txt.slice(0, 600), href });
  });
  document.querySelectorAll('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]').forEach((el) => {
    const t = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    if (t) out.messages.push(t.slice(0, 600));
  });
  return out;
}`;

const CREATION_TIME = /"creation_time":(\d{9,11})/g;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * 只用 HTTP 取得粉專頁面名稱（`<title>`／`og:title`）。
 * 這是**未登入**的請求：Facebook 對有效代稱會回人名、對失效代稱只回泛用「Facebook」，
 * 所以它很適合當驗證的第一層（113 筆約 2 分鐘，比開瀏覽器快得多）。缺點是有少數粉專
 * （實測：吳思瑤 `taipeineedyou`）未登入時一律回泛用標題，這時要靠瀏覽器那一輪的結果。
 * 登入狀態下反而不能用 `document.title`——FB 會把它設成「(3) Facebook」（通知數）。
 */
async function httpPageTitle(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-TW,zh;q=0.9' } });
    const html = await res.text();
    const og = html.match(/og:title"\s+content="([^"]*)"/i);
    const ti = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const decode = (s) => s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    const name = decode(og?.[1] || ti?.[1] || '');
    // 連續請求太快時 FB 會回 HTTP 400（標題 "Error"）——這是限流，不是粉專有問題，等幾秒重試一次
    if (name === 'Error') {
      if (attempt < 1) { await sleep(5000); return httpPageTitle(url, attempt + 1); }
      return '';
    }
    return !name || name === 'Facebook' ? '' : name;
  } catch {
    return '';
  }
}

/**
 * 日期合理性檢查：貼文日期不可能早於 2000 年，也不可能在今天之後（臺灣時間）。
 * 為什麼需要：粉專版面有時會把「內文提到的日期」或留言的時間戳也放進 aria-label，
 * 實測就抓到過「1966年12月6日」「1956年12月16日」這種明顯不是貼文發布日的值。
 * 不合理就換下一個候選，全部不合理才留空（依規格：寧可空白，不要錯的日期）。
 */
function saneDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const t = Date.parse(`${ymd}T00:00:00+08:00`);
  if (Number.isNaN(t)) return false;
  const now = Date.now() + 8 * 3600 * 1000; // 以臺灣時間的「今天」為上限
  return t >= Date.parse('2000-01-01T00:00:00+08:00') && ymd <= new Date(now).toISOString().slice(0, 10);
}

/** 把一次 evaluate 的結果整理成 { date, summary, rel }（日期最大者為最新） */
export function pickLatest(dump) {
  const texts = new Map();
  for (const t of dump.texts ?? []) if (t.href && !texts.has(t.href)) texts.set(t.href, t.text);
  // 同一個 href 在 DOM 裡常有多筆（頁面上的日期元素一筆、永久連結一筆）：互動數取「有值的那一筆」，
  // 否則會因為挑到的候選剛好沒帶數字，就當成這一篇抓不到讚數。
  const engByHref = new Map();
  for (const e of dump.dates ?? []) {
    const likes = String(e.likes ?? '');
    const comments = String(e.comments ?? '');
    if (!e.href || (!likes && !comments)) continue;
    const seen = engByHref.get(e.href) ?? { likes: '', comments: '' };
    engByHref.set(e.href, { likes: seen.likes || likes, comments: seen.comments || comments });
  }
  const posts = (dump.dates ?? []).map((e) => {
    const shared = engByHref.get(e.href ?? '') ?? { likes: '', comments: '' };
    return {
      date: e.date ?? '',
      rel: e.rel ?? '',
      href: e.href ?? '',
      text: texts.get(e.href ?? '') ?? '',
      likes: String(e.likes ?? '') || shared.likes,
      comments: String(e.comments ?? '') || shared.comments,
    };
  });
  const dated = posts.filter((p) => p.date).sort((a, b) => dateKey(b.date) - dateKey(a.date));
  const best = dated[0] ?? null;
  const rel = best?.rel || posts.find((p) => p.rel)?.rel || '';
  const messages = dump.messages ?? [];
  let summary = best ? best.text || messages[0] || '' : messages[0] || '';
  if (!summary) summary = posts.find((p) => p.text)?.text ?? '';
  return { best, summary, rel, posts, messages };
}

/* ------------------------------------------------------------- 抓一輪資料 */

async function collect(rows, opts) {
  // playwright 會在 os.tmpdir() 建 playwright-artifacts-*；有些受管環境（例如 DSH 的檔案沙箱）
  // 只允許寫專案目錄，系統 Temp 會回 EPERM。這裡把這個行程的 TEMP 指到 .cache/tmp（已 gitignore），
  // 不影響其他程式，也讓腳本在沙箱與一般環境都能跑。
  const tmp = resolve(ROOT, '.cache/tmp');
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
  process.env.TMPDIR = tmp;

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error(
      '找不到 playwright-core。這支腳本需要它才能開已登入的瀏覽器：\n  npm i -D playwright-core',
    );
  }
  if (!existsSync(opts.profile)) mkdirSync(opts.profile, { recursive: true });

  const browser = await chromium.launchPersistentContext(opts.profile, {
    channel: 'chrome', // 用系統安裝的 Chrome，playwright-core 不會下載瀏覽器
    headless: !opts.headful,
    locale: 'zh-TW',
    viewport: { width: 1440, height: 1200 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = browser.pages()[0] ?? (await browser.newPage());

  // 先開一次 facebook.com 確認登入狀態。未登入時 Facebook 對部分粉專只回泛用頁面
  // （實測：113 位裡約 1 位完全看不到，其餘頁面名稱可見但貼文內容不完整），
  // 所以「沒登入」不中斷，但一定要講清楚，否則會誤以為是粉專的問題。
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
  await page.waitForTimeout(4000);
  const warm = await page.evaluate(`(${EXTRACT})()`);
  const loggedIn = !warm.login;
  console.log(loggedIn
    ? `已登入 Facebook（設定檔：${opts.profile}）`
    : `⚠️ 這個設定檔沒登入 Facebook，部分粉專會抓不到內容。先跑一次：\n    node scripts/fetch-fb-posts.mjs --login --profile "${opts.profile}"`);

  const results = [];
  let loginLost = false;

  for (const [i, row] of rows.entries()) {
    const rec = {
      編號: row['編號'] ?? '',
      姓名: row['姓名'] ?? '',
      政黨: row['政黨'] ?? '',
      '選區/類別': row['選區/類別'] ?? '',
      臉書專頁名稱: row['臉書專頁名稱'] ?? '',
      最新貼文日期: '',
      最新貼文主題摘要: '',
      最新貼文讚數: '',
      最新貼文留言數: '',
      貼文或粉專連結: row['貼文或粉專連結'] ?? '',
      Threads連結: row['Threads連結'] ?? '',
      'Threads最新貼文日期': row['Threads最新貼文日期'] ?? '',
      'Threads最新貼文主題摘要': row['Threads最新貼文主題摘要'] ?? '',
      _status: '',
      _pageName: '',
      _httpName: '',
      _followers: '',
    };
    const url = (row['貼文或粉專連結'] ?? '').trim();
    if (!/^https:\/\/(www\.|m\.)?facebook\.com\//.test(url)) {
      rec._status = url ? '非臉書網址（略過）' : '沒有粉專網址';
      results.push(rec);
      console.log(`[${i + 1}/${rows.length}] ${rec.編號} ${rec.姓名} — ${rec._status}`);
      continue;
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
      await page.waitForTimeout(7000);
      // 往下捲一下再回到頂端：Facebook 有時只先渲染到舊貼文，捲動會把最上面的新貼文補進 DOM
      await page.evaluate('window.scrollBy(0, 1200)');
      await page.waitForTimeout(1500);
      await page.evaluate('window.scrollTo(0, 0)');
      await page.waitForTimeout(1200);
      const dump = await page.evaluate(`(${EXTRACT})()`);
      if (dump.login) {
        loginLost = true;
        rec._status = '登入失效（請在 --profile 的設定檔重新登入）';
      } else {
        rec._pageName = dump.pageName;
        rec._followers = dump.followers;
        if (opts.verify) {
          await sleep(1200 + Math.random() * 1500); // 別讓 HTTP 標題檢查把 FB 打到限流
          rec._httpName = await httpPageTitle(url);
        }
        const { best, summary, rel } = pickLatest(dump);
        // 兩個來源都算，取「比較新的那一個」：
        //   - 頁面上的貼文日期（已排除留言）
        //   - 頁面內嵌 JSON 的 creation_time（版面改到抓不到日期時的最後防線）
        // 只取其中一個都會錯：DOM 可能只渲染到舊貼文，creation_time 可能是置頂或分享來源的時間。
        // 每個候選都要通過 saneDate（見上），不合理的就換下一個。
        const stamps = [...(await page.content()).matchAll(CREATION_TIME)].map((m) => Number(m[1]));
        const candidates = [
          ...pickLatest(dump).posts.filter((p) => p.date).map((p) => p.date),
          ...(stamps.length ? [epochToDate(Math.max(...stamps))] : []),
        ]
          .map((d) => toSheetDate(d))
          .filter((d) => d && saneDate(d))
          .sort((a, b) => (a < b ? 1 : -1));
        let date = candidates[0] ?? '';
        let source = date ? '網頁日期' : '';
        // 讚／留言只跟著「DOM 上挑到的那一篇」。日期若來自內嵌 JSON（creation_time）或永久連結頁，
        // 就不能拿這個 DOM 的數字 —— 那會變成把 A 篇的讚數掛在 B 篇的日期上。
        let eng = { likes: '', comments: '' };
        if (date && toSheetDate(best?.date ?? '') === date) eng = { likes: best.likes, comments: best.comments };
        // 備援：開那一則貼文的永久連結（首頁只給相對時間時，從貼文頁拿日期）
        if (!date) {
          const href = best?.href || (dump.dates ?? []).find((d) => d.href)?.href;
          if (href) {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000);
            const second = pickLatest(await page.evaluate(`(${EXTRACT})()`));
            const secondDate = toSheetDate(second.best?.date ?? '');
            if (secondDate && saneDate(secondDate)) {
              date = secondDate;
              source = '貼文永久連結';
              eng = { likes: second.best?.likes ?? '', comments: second.best?.comments ?? '' };
            }
            if (!summary) summary = second.summary;
          }
        }
        rec.最新貼文日期 = toSheetDate(date) ?? '';
        rec._source = source;
        rec.最新貼文主題摘要 = cleanSummary(summary);
        rec.最新貼文讚數 = String(eng.likes ?? '');
        rec.最新貼文留言數 = String(eng.comments ?? '');
        if (rec.最新貼文日期) rec._status = 'OK';
        else if (rec.最新貼文主題摘要) rec._status = rel ? `只有相對時間（${rel}）` : '有內容但沒有日期';
        else rec._status = '看不到貼文（留空）';
        // 什麼都沒拿到時，多半只是頁面還沒渲染完（批次的第一頁最常見）：重載一次再試一次
        if (!rec.最新貼文日期 && !rec.最新貼文主題摘要) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
          await page.waitForTimeout(10000);
          const again = pickLatest(await page.evaluate(`(${EXTRACT})()`));
          const stamps2 = [...(await page.content()).matchAll(CREATION_TIME)].map((m) => Number(m[1]));
          const retryCandidates = [
            ...again.posts.filter((p) => p.date).map((p) => toSheetDate(p.date)),
            ...(stamps2.length ? [epochToDate(Math.max(...stamps2))] : []),
          ].filter((d) => d && saneDate(d)).sort((a, b) => (a < b ? 1 : -1));
          rec.最新貼文日期 = retryCandidates[0] ?? '';
          rec.最新貼文主題摘要 = cleanSummary(again.summary);
          if (rec.最新貼文日期 && toSheetDate(again.best?.date ?? '') === rec.最新貼文日期) {
            rec.最新貼文讚數 = String(again.best?.likes ?? '');
            rec.最新貼文留言數 = String(again.best?.comments ?? '');
          }
          if (rec.最新貼文日期) rec._status = 'OK（重載後取得）';
          else if (rec.最新貼文主題摘要) rec._status = '有內容但沒有日期（重載後）';
        }
      }
    } catch (err) {
      rec._status = `錯誤：${err.name}：${String(err.message ?? '').slice(0, 80)}`;
    }
    results.push(rec);
    console.log(
      `[${i + 1}/${rows.length}] ${rec.編號} ${rec.姓名} ${rec._status} ${rec.最新貼文日期} ${
        rec.最新貼文讚數 || rec.最新貼文留言數 ? `讚 ${rec.最新貼文讚數 || '—'}／留言 ${rec.最新貼文留言數 || '—'} ` : ''
      }${rec.最新貼文主題摘要.slice(0, 30)}`,
    );
    await sleep(opts.minDelay + Math.random() * Math.max(0.1, opts.maxDelay - opts.minDelay));
  }
  await browser.close();
  return { results, loginLost };
}

/* ------------------------------------------------- 寫回 Google 試算表（選用） */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 服務帳號 JSON → access token（只用到 node:crypto 與 fetch，不裝 googleapis） */
async function serviceToken(keyPath, scope = 'https://www.googleapis.com/auth/spreadsheets') {
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`取得 access token 失敗（${res.status}）：${await res.text()}`);
  return (await res.json()).access_token;
}

async function writeSheet({ keyPath, gid, results, dryRun = false }) {
  const token = await serviceToken(keyPath);
  const api = async (path, init = {}) => {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Sheets API ${path} 失敗（${res.status}）：${await res.text()}`);
    return res.json();
  };
  const meta = await api('?fields=sheets(properties(sheetId,title))');
  const sheet = meta.sheets.find((s) => s.properties.sheetId === gid);
  if (!sheet) throw new Error(`找不到 gid=${gid} 的分頁`);
  const title = sheet.properties.title;
  const values = (await api(`/values/${encodeURIComponent(`'${title}'!A1:Z200`)}`)).values ?? [];
  const rowOf = new Map();
  values.slice(1).forEach((r, i) => {
    const no = String(r[0] ?? '').trim();
    if (no) rowOf.set(no, i + 2);
  });
  // 互動數（讚／留言）是後加的欄位：表上有才寫。沒有的話只寫日期與摘要 —— 不自己插入欄位，
  // 這裡是人工維護的整理表（補欄位是 apps-script/Code.js 那條路在做的事，2026-10-07 的決定）。
  const header = (values[0] ?? []).map((v) => String(v ?? '').trim());
  const colOf = (label) => header.findIndex((h) => h === label);
  const likesCol = colOf('最新貼文讚數');
  const commentsCol = colOf('最新貼文留言數');
  const letter = (index) => {
    let s = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  const data = [];
  const skipped = [];
  let rowCount = 0;
  for (const [no, row] of rowOf) {
    const rec = results.find((r) => String(r.編號).trim() === no);
    if (!rec) { skipped.push(`${no} 沒有抓取結果`); continue; }
    if (!rec.最新貼文日期 && !rec.最新貼文主題摘要) { skipped.push(`${no} ${rec.姓名}（${rec._status}）`); continue; }
    data.push({ range: `'${title}'!F${row}:G${row}`, values: [[rec.最新貼文日期, rec.最新貼文主題摘要]] });
    if (likesCol >= 0) data.push({ range: `'${title}'!${letter(likesCol)}${row}`, values: [[rec.最新貼文讚數 ?? '']] });
    if (commentsCol >= 0) data.push({ range: `'${title}'!${letter(commentsCol)}${row}`, values: [[rec.最新貼文留言數 ?? '']] });
    rowCount++;
  }
  console.log(`工作表「${title}」：要寫 ${rowCount} 列，略過 ${skipped.length} 列`);
  for (const s of skipped.slice(0, 10)) console.log('  略過：', s);
  if (dryRun) { console.log('（--dry-run：沒有真的寫入）'); return; }
  if (!data.length) { console.log('沒有可寫入的資料'); return; }
  const out = await api('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  console.log(`已寫入 ${out.totalUpdatedCells} 個儲存格`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  // --login：開一個有畫面的瀏覽器讓你手動登入一次，登入狀態存進 --profile 的設定檔，之後就不用再登入。
  if (args.login) {
    const { chromium } = await import('playwright-core').catch(() => {
      throw new Error('找不到 playwright-core，先安裝：npm i -D playwright-core');
    });
    if (!existsSync(args.profile)) mkdirSync(args.profile, { recursive: true });
    const ctx = await chromium.launchPersistentContext(args.profile, {
      channel: 'chrome', headless: false, locale: 'zh-TW',
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
    console.log(`請在這個視窗登入 Facebook。設定檔：${args.profile}`);
    console.log('登入完成後會自動偵測（最多等 10 分鐘）…');
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(5000);
      const state = await page.evaluate(`(${EXTRACT})()`).catch(() => ({ login: true }));
      if (!state.login && !/\/login/.test(page.url())) {
        console.log('✅ 偵測到已登入，設定檔已儲存。');
        break;
      }
    }
    await ctx.close();
    return;
  }

  const source = args.csv ?? DEFAULT_CSV;
  const text = /^https?:/.test(source) ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const [header, ...body] = parseCsv(text);
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  if (!('姓名' in col) || !('貼文或粉專連結' in col)) {
    throw new Error(`整理表缺少必要欄位（姓名／貼文或粉專連結）：${header.join(',')}`);
  }
  let rows = body.map((r) => Object.fromEntries(Object.entries(col).map(([k, i]) => [k, (r[i] ?? '').trim()])));
  if (args.ids) {
    const want = new Set(args.ids.split(',').map((s) => s.trim()));
    rows = rows.filter((r) => want.has(String(r['編號']).trim()));
  }
  if (args.limit) rows = rows.slice(0, num(args.limit, rows.length));

  console.log(`來源：${source}`);
  console.log(`共 ${rows.length} 列，開始抓取（每位間隔 ${args['min-delay']}–${args['max-delay']} 秒）`);
  const { results, loginLost } = await collect(rows, {
    profile: args.profile,
    headful: args.headful,
    verify: args.verify,
    minDelay: num(args['min-delay'], 4),
    maxDelay: num(args['max-delay'], 9),
    timeout: num(args.timeout, 90),
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = args.out ?? resolve(ROOT, '.cache', `posts-${stamp}.csv`);
  // 欄位順序＝整理表的欄位順序（新增的欄位接在最後，人工要貼回試算表時不會錯位）。
  // 「最新貼文讚數／留言數」是 2026-10-07 新增的欄位（見 docs/social-sheet-spec.md）。
  const sheetCols = ['編號', '姓名', '政黨', '選區/類別', '臉書專頁名稱', '最新貼文日期', '最新貼文主題摘要', '貼文或粉專連結', 'Threads連結', 'Threads最新貼文日期', 'Threads最新貼文主題摘要', '最新貼文讚數', '最新貼文留言數'];
  writeFileSync(outPath, `${sheetCols.join(',')}\n${results.map((r) => sheetCols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
  console.log(`寫出 ${outPath}`);

  if (args.verify) {
    const verifyPath = args['verify-out'] ?? resolve(ROOT, `docs/fb-verification-${stamp}.csv`);
    const vCols = ['委員', '黨籍', '表單頁名', '頁面顯示名稱', '結果', '說明', '追蹤者', '網址'];
    const lines = results.map((r) => {
      // 頁面顯示名稱：以未登入的 HTTP 標題為主（登入時 document.title 是「(3) Facebook」），
      // HTTP 拿不到時才用瀏覽器那一輪的標題。
      const shown = r._httpName || (r._pageName !== 'Facebook' ? r._pageName : '') || '';
      const hit = shown && r.姓名 && shown.replace(/\s/g, '').includes(r.姓名.replace(/\s/g, ''));
      return [
        r.姓名, r.政黨, r.臉書專頁名稱, shown,
        r._status.startsWith('登入失效') ? '⚠️ 未登入'
          : hit ? '✅ 名稱相符' : shown ? '❌ 名稱不符' : '⚠️ 拿不到頁面名稱',
        r._status, r._followers, r.貼文或粉專連結,
      ].map(csvCell).join(',');
    });
    writeFileSync(verifyPath, `${vCols.join(',')}\n${lines.join('\n')}\n`);
    console.log(`寫出 ${verifyPath}`);
  }

  if (args['write-sheet']) {
    if (!args.key) throw new Error('--write-sheet 需要 --key <service_account.json>');
    await writeSheet({ keyPath: args.key, gid: num(args.gid, SHEET_GID), results });
  }

  const filled = results.filter((r) => r.最新貼文日期).length;
  const blank = results.length - filled;
  const withCounts = results.filter((r) => r.最新貼文日期 && (r.最新貼文讚數 !== '' || r.最新貼文留言數 !== '')).length;
  console.log(`完成：${filled} 列有日期（其中 ${withCounts} 列有讚數或留言數）、${blank} 列留空${loginLost ? '（有登入失效，請重新登入設定檔）' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fetch-fb-posts.mjs')) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
