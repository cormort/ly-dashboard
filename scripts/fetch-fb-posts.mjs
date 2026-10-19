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
 * 貼文日期與內文怎麼來（取同一則為原則）：
 *   1. 頁面內嵌 feed JSON 的 story（`creation_time` ＋ 同一段的 `message.text` ＋ `url`）—— 首選，
 *      因為日期與內文來自同一個物件，不會互相配錯。
 *   2. 頁面上貼文連結（`a[href*="/posts/"]` 等）自己的日期；內文取同一個 href 的 DOM 文字。
 *   3. 有日期但那則拿不到內文時，開那一則的永久連結，從它自己的頁面取（同一則）。
 *   兩邊都有日期時取新的那個；同一天以 JSON 為準。
 *   最新＝日期最大者，因此置頂／精選的舊貼文不會被誤當成最新。
 *   摘要**不再**從「DOM 順序第一則訊息」取 —— 那常是精選／置頂的舊文（2026-10-15 修）。
 *   聊天側欄（Messenger）訊息泡泡的日期一律不算貼文日期（見 isPostDateCandidate）。
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
import { describeError, sheetCsvUrl } from './social-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_CSV = sheetCsvUrl();

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
    // 貼文層級輸出（posts-detail CSV）：每個粉專最多留幾則、要不要寫檔
    posts: { type: 'string', default: '5' },
    'detail-out': { type: 'string' },
    'no-detail': { type: 'boolean', default: false },
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
/** 貼文層級資料（posts-detail CSV）的摘要上限：比整理表的 60 字長，因為機關名稱常出現在貼文的後段 */
const DETAIL_SUMMARY_LIMIT = 400;

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
  // 聊天側欄（Messenger）的訊息泡泡也帶日期（「2026年10月14日 19:42，你」、「輸入，訊息已在
  // 2026年10月14日 11:01由你傳送」）。粉專頁載入時它就一起渲染，於是下面的掃描會把它當成
  // 貼文日期 —— 實測某位委員頁面上 11 個帶日期的 aria-label 有 10 個是使用者自己的聊天訊息。
  // 這裡只負責把「結構位置」記下來（在不在聊天區、在不在連結裡、完整 label），
  // 要不要採用的規則放在 Node 端的 isPostDateCandidate（可被測試釘住）。
  const inChat = (el) => Boolean(el.closest('[data-scope="messages_table"], [data-message-id], [role="log"], [aria-roledescription="訊息"]'));
  document.querySelectorAll('[aria-label]').forEach((el) => {
    const label = (el.getAttribute('aria-label') || '').trim();
    const d = abs(label);
    if (!d) return;
    const a = el.closest('a');
    const href = a ? (a.href || '').split('?')[0] : '';
    // 留言的時間戳也要排除（留言的 aria-label 同樣是「2026年10月6日 …」）
    if (a && /comment_id=/.test(a.href || '')) return;
    out.dates.push({ date: d, rel: '', href, label, chat: inChat(el), inLink: Boolean(a), ...eng(el) });
  });
  document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"]').forEach((a) => {
    const raw = a.href || '';
    // 留言也有永久連結（帶 comment_id），它的時間是「留言時間」不是「貼文時間」——一定要排除，
    // 否則一則今天的新留言會讓舊貼文看起來像今天發的。
    if (/comment_id=/.test(raw)) return;
    const txt = (a.innerText || '').trim().replace(/\\s+/g, ' ');
    const href = raw.split('?')[0].split('#')[0];
    const label = txt || (a.getAttribute('aria-label') || '').trim();
    const d = abs(txt) || abs(a.getAttribute('aria-label') || '');
    if (d) out.dates.push({ date: d, rel: '', href, label, chat: false, inLink: true, ...eng(a) });
    else if (relRx.test(txt)) out.dates.push({ date: '', rel: txt.slice(0, 20), href, label, chat: false, inLink: true, ...eng(a) });
    else if (txt.length > 25) out.texts.push({ text: txt.slice(0, 600), href });
  });
  document.querySelectorAll('[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"]').forEach((el) => {
    const t = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    if (t) out.messages.push(t.slice(0, 600));
  });
  return out;
}`;

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
 * 抓一段文字，失敗會重試。
 *
 * 2026-10-10 實例：08:00 的排程一開跑就在這一步 `fetch failed`（UND_ERR_CONNECT_TIMEOUT，
 * 見 scripts/social-source.mjs 的說明），一行就結束、整天沒有資料。連線層的暫時性錯誤
 * 不該讓整個抓取直接放棄 —— 重試比叫人隔天再看一次便宜。
 * 次數／間隔可用 LY_FB_FETCH_ATTEMPTS、LY_FB_FETCH_DELAY_MS 調整。
 */
async function fetchText(url, { label = '來源', attempts, delayMs } = {}) {
  const n = Number(attempts ?? process.env.LY_FB_FETCH_ATTEMPTS ?? 3);
  const wait = Number(delayMs ?? process.env.LY_FB_FETCH_DELAY_MS ?? 10_000);
  let last;
  for (let i = 1; i <= n; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-TW,zh;q=0.9' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      last = err;
      console.warn(`${label} 讀取失敗（第 ${i}/${n} 次）：${describeError(err)}`
        + (i < n ? `；${wait / 1000} 秒後重試` : ''));
      if (i < n) await sleep(wait);
    }
  }
  throw last;
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

/* --------------------------- 「哪一則才算貼文」與「日期要配到同一則的內文」 */

/**
 * 這個 creation_time 看起來是不是「一則貼文」：附近要有 feed story 的標記。
 * 為什麼不只看有沒有 `"creation_time"`：內嵌 HTML 裡還有別人的 JSON（聊天、廣告…），
 * 而 `CometFeedStory` 這個字串也可能出現在別的地方 → 兩者取聯集、並且限縮在 ±1200 字內。
 * （實測兩個真實頁面的 5～6 個 creation_time 全部命中；聊天區塊一個都沒有。）
 */
const STORY_CONTEXT = /"__typename":"CometFeedStory|"post_id":"/;

/**
 * 這個帶日期的元素能不能算「貼文日期」？
 *
 * 為什麼不能只看「有沒有日期」：粉專頁載入時，登入的瀏覽器設定檔會一起渲染 Messenger 聊天側欄，
 * 訊息泡泡的 aria-label 就是日期（「2026年10月14日 19:42，你」）。實測某位委員頁面上 11 個帶日期
 * 的 aria-label 裡有 10 個是使用者自己的聊天訊息，於是「最新貼文日期」變成「你最後一次聊天的日期」
 * （113 位裡 105 位中招，2026-10-15 查出）。貼文日期有兩個特徵是聊天不會有的：
 * 含「星期」，或位在貼文的永久連結（<a>）裡。
 */
export function isPostDateCandidate(entry) {
  if (!entry || !entry.date) return false;
  if (entry.chat) return false;
  const label = String(entry.label ?? '');
  if (/訊息|傳送/.test(label)) return false; // 「輸入，訊息已在…由…傳送」
  if (/\d{1,2}:\d{2}\s*[，,]\s*\S/.test(label)) return false; // 「… 11:01，你」／「… 11:01，Joyce」
  return Boolean(entry.inLink) || /星期/.test(label);
}

/** 頁面上可用的「貼文日期」候選，新→舊（聊天、留言、未來日期都不算） */
export function collectPostDates(dump) {
  return (dump?.dates ?? [])
    .filter(isPostDateCandidate)
    .map((e) => ({ ...e, ymd: toSheetDate(e.date) }))
    .filter((e) => e.ymd && saneDate(e.ymd))
    .sort((a, b) => dateKey(b.ymd) - dateKey(a.ymd));
}

/** DOM 上某個貼文連結自己的內文（同一個 href 才算同一則） */
export function textOfHref(dump, href) {
  if (!href) return '';
  const hit = (dump?.texts ?? []).find((t) => t.href === href);
  return hit ? String(hit.text ?? '') : '';
}

/**
 * 從頁面內嵌的 feed JSON 取出每一則貼文的（時間、內文、連結），新→舊。
 *
 * 為什麼需要它：DOM 的內文與日期可能屬於不同貼文 —— 頁面最上面常是「精選／置頂」的舊文，
 * 舊版做法把它的內文配上新貼文的日期，畫面就變成「昨天的日期 ＋ 一年前的舊聞」
 * （2026-10-15 使用者回報的那一則）。內嵌 JSON 裡同一個 story 物件帶著自己的 creation_time 與
 * message.text，取同一段的兩個值就不會配錯。
 *
 * 兩道界線：① 只認真的 feed story（前後 900 字內要有 CometFeedStory，聊天側欄等區塊不算）
 * ② 一則貼文的搜尋窗口＝這個 creation_time 到下一個之間，沒有內文的貼文（純圖）不會借到下一則的。
 */
export function pickLatestStory(html) {
  const text = String(html ?? '');
  const cts = [...text.matchAll(/"creation_time":(\d{9,11})/g)]
    .map((m) => ({ at: m.index, ts: Number(m[1]) }))
    // 只認真的 feed story：聊天側欄等其它區塊裡也可能有時間欄位（實測是沒有，但別靠這個假設）
    .filter(({ at, ts }) => STORY_CONTEXT.test(text.slice(Math.max(0, at - 1200), at + 1200)) && saneDate(epochToDate(ts)));
  const stories = cts.map(({ at, ts }, i) => {
    const end = i + 1 < cts.length ? cts[i + 1].at : Math.min(text.length, at + 60000);
    const win = text.slice(at, end);
    const msg = win.match(/"message":\{"text":"((?:[^"\\]|\\.)*)"/);
    const url = win.match(/"url":"(https?:\\\/\\\/www\.facebook\.com[^"]{0,200})/);
    let body = '';
    if (msg) {
      try {
        body = JSON.parse(`"${msg[1]}"`);
      } catch {
        body = '';
      }
    }
    return { ts, date: epochToDate(ts), text: cleanSummary(body, DETAIL_SUMMARY_LIMIT), url: url ? url[1].replace(/\\\//g, '/') : '' };
  });
  // 同一個 story 在 HTML 裡常出現多次 → 用「時間＋連結」去重
  const seen = new Set();
  return stories
    .filter((s) => {
      const key = `${s.ts}|${s.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.ts - a.ts);
}

/**
 * 挑出最新一則貼文，**日期與內文一定來自同一則**。
 * 回傳 { date, summary, postUrl, source, likes, comments, domTop, story }
 *
 * 兩邊都有日期時取新的那個；同一天以 JSON 為準（它帶著同一則的內文）。摘要來源只有兩個：
 * ① JSON 那一則自己的 message.text ② DOM 同一個 href 的內文。都拿不到就留空 ——
 * 不再用「DOM 順序第一則訊息」當摘要（那正是精選舊文混進來的路徑）。
 * 讚／留言只在「同一個連結」時才掛上去。
 */
export function chooseLatestPost({ dump, html }) {
  const domPosts = collectPostDates(dump);
  const domTop = domPosts[0] ?? null;
  const story = pickLatestStory(html)[0] ?? null;
  const domDate = domTop ? domTop.ymd : '';
  const jsonDate = story ? story.date : '';
  if (!domDate && !jsonDate) {
    return { date: '', summary: '', postUrl: '', source: '', likes: '', comments: '', domTop, story, domPosts };
  }
  const useJson = Boolean(jsonDate) && (!domDate || dateKey(jsonDate) >= dateKey(domDate));
  const out = useJson
    ? { date: jsonDate, summary: story.text, postUrl: story.url, source: '內嵌 JSON（日期與內文同一則）' }
    : { date: domDate, summary: textOfHref(dump, domTop.href), postUrl: domTop.href, source: '頁面日期' };
  const samePost = Boolean(domTop && out.postUrl && domTop.href === out.postUrl);
  return { ...out, likes: samePost ? domTop.likes : '', comments: samePost ? domTop.comments : '', domTop, story, domPosts };
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
      // 貼文層級的資料（一列一則）。整理表只放「最新一則」，這裡把同一頁抓到的其他貼文也留下來：
      // 「機關」頁要把委員貼文歸到機關，只比對最新一則的 60 字摘要幾乎比對不到（實測全站只有 1 筆命中）。
      _posts: [],
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
        const { rel } = { rel: (dump.dates ?? []).find((d) => d.rel)?.rel ?? '' };
        // 日期與內文一律取「同一則」：內嵌 JSON 的 story（自己帶著 creation_time 與 message.text）
        // 優先，其次才是 DOM 上貼文連結自己的日期與內文。摘要不再從「DOM 順序第一則訊息」來 ——
        // 那是頁面最上面的精選／置頂舊文，配上新貼文的日期就是「昨天的日期 ＋ 一年前的舊聞」。
        const pageHtml = await page.content();
        const chosen = chooseLatestPost({ dump, html: pageHtml });
        let date = chosen.date;
        let summary = chosen.summary;
        let source = chosen.source;
        let eng = { likes: chosen.likes, comments: chosen.comments };
        // 有日期但那則拿不到內文（純圖貼文、或文字不在 JSON 裡）：開那一則的永久連結，
        // 從它自己的頁面同時拿日期、內文與互動數（同一則，不會配錯）。拿不到就留空。
        if (date && !summary && chosen.postUrl) {
          await page.goto(chosen.postUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
          await page.waitForTimeout(5000);
          const single = chooseLatestPost({ dump: await page.evaluate(`(${EXTRACT})()`), html: await page.content() });
          if (single.summary) {
            summary = single.summary;
            source = `${source}＋永久連結`;
          }
          if (single.likes || single.comments) eng = { likes: single.likes, comments: single.comments };
        }
        rec.最新貼文日期 = toSheetDate(date) ?? '';
        rec._source = source;
        rec.最新貼文主題摘要 = cleanSummary(summary);
        rec.最新貼文讚數 = String(eng.likes ?? '');
        rec.最新貼文留言數 = String(eng.comments ?? '');
        if (rec.最新貼文日期) rec._status = 'OK';
        else if (rec.最新貼文主題摘要) rec._status = rel ? `只有相對時間（${rel}）` : '有內容但沒有日期';
        else rec._status = '看不到貼文（留空）';

        // 貼文層級資料（一列一則）：「機關」頁要把委員貼文歸到機關，只比對整理表那 60 字摘要幾乎比對不到
        // （實測全站只有 1 筆命中）。最新一則用上面算出來的真日期；其他貼文只有文字 ——
        // FB 的 DOM 只給「3小時」這種相對時間，而內嵌 JSON 的 creation_time 我們只對得上「最新那一則」
        // （窗口法，見 pickLatestStory），其餘寧可留空日期，也不猜（見 docs/social-sheet-spec.md 的「不要編造」原則）。
        const detailBase = {
          編號: rec.編號,
          姓名: rec.姓名,
          政黨: rec.政黨,
          '選區/類別': rec['選區/類別'],
          臉書專頁名稱: rec.臉書專頁名稱,
          平台: 'facebook',
        };
        const buildDetail = () => {
          const seenSummaries = new Set();
          return [
          ...(rec.最新貼文日期 && summary
            ? [
                {
                  ...detailBase,
                  貼文日期: rec.最新貼文日期,
                  摘要: cleanSummary(summary, DETAIL_SUMMARY_LIMIT),
                  讚數: String(eng.likes ?? ''),
                  留言數: String(eng.comments ?? ''),
                  貼文連結: chosen.postUrl || url,
                },
              ]
            : []),
          ...(dump.messages ?? [])
            .slice(0, (opts.posts ?? 5) + 1)
            .filter((m) => cleanSummary(m, DETAIL_SUMMARY_LIMIT).length >= 20) // 濾掉「活力·進步·台北」這種看板文字
            .map((m) => ({
            ...detailBase,
            貼文日期: '',
            摘要: cleanSummary(m, DETAIL_SUMMARY_LIMIT),
            讚數: '',
            留言數: '',
            貼文連結: url,
          })),
        ]
          .filter((p) => p.摘要)
          .filter((p) => {
            if (seenSummaries.has(p.摘要)) return false;
            seenSummaries.add(p.摘要);
            return true;
          })
          .slice(0, opts.posts ?? 5);
        };
        rec._posts = buildDetail();
        // 什麼都沒拿到時，多半只是頁面還沒渲染完（批次的第一頁最常見）：重載一次再試一次
        if (!rec.最新貼文日期 && !rec.最新貼文主題摘要) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeout * 1000 });
          await page.waitForTimeout(10000);
          const retry = chooseLatestPost({ dump: await page.evaluate(`(${EXTRACT})()`), html: await page.content() });
          rec.最新貼文日期 = retry.date;
          rec.最新貼文主題摘要 = cleanSummary(retry.summary);
          if (retry.likes || retry.comments) {
            rec.最新貼文讚數 = String(retry.likes);
            rec.最新貼文留言數 = String(retry.comments);
          }
          if (rec.最新貼文日期) rec._status = 'OK（重載後取得）';
          else if (rec.最新貼文主題摘要) rec._status = '有內容但沒有日期（重載後）';
          rec._posts = buildDetail(); // 重載後的值才是最終值
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
  const text = /^https?:/.test(source)
    ? await fetchText(source, { label: '整理表 CSV' })
    : readFileSync(source, 'utf8');
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
    posts: num(args.posts, 5),
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = args.out ?? resolve(ROOT, '.cache', `posts-${stamp}.csv`);
  // 欄位順序＝整理表的欄位順序（新增的欄位接在最後，人工要貼回試算表時不會錯位）。
  // 「最新貼文讚數／留言數」是 2026-10-07 新增的欄位（見 docs/social-sheet-spec.md）。
  const sheetCols = ['編號', '姓名', '政黨', '選區/類別', '臉書專頁名稱', '最新貼文日期', '最新貼文主題摘要', '貼文或粉專連結', 'Threads連結', 'Threads最新貼文日期', 'Threads最新貼文主題摘要', '最新貼文讚數', '最新貼文留言數'];
  writeFileSync(outPath, `${sheetCols.join(',')}\n${results.map((r) => sheetCols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
  console.log(`寫出 ${outPath}`);

  // 貼文層級的輸出（一列一則貼文）：整理表只收「最新一則」，這裡把同一頁的其他貼文也留下來，
  // 供「機關」頁把委員貼文歸到機關（只比對最新一則的 60 字摘要幾乎比對不到）。
  if (!args['no-detail']) {
    const detailRows = results.flatMap((r) => r._posts ?? []);
    const detailPath = args['detail-out'] ?? resolve(ROOT, '.cache', `posts-detail-${stamp}.csv`);
    const detailCols = ['編號', '姓名', '政黨', '選區/類別', '臉書專頁名稱', '平台', '貼文日期', '摘要', '讚數', '留言數', '貼文連結'];
    writeFileSync(
      detailPath,
      `${detailCols.join(',')}\n${detailRows.map((p) => detailCols.map((c) => csvCell(p[c])).join(',')).join('\n')}\n`,
    );
    console.log(`寫出 ${detailPath}（${detailRows.length} 則貼文、${new Set(detailRows.map((p) => p.編號)).size} 位委員）`);
  }

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
  main().catch((err) => { console.error(describeError(err)); process.exit(1); });
}
