#!/usr/bin/env node
/**
 * 手機／平板的橫向溢出檢查（RWD 的守門測試）。
 *
 *   node scripts/check-rwd.mjs                          # 390px，跑全部路由
 *   node scripts/check-rwd.mjs --widths 360,390,768     # 三個寬度都跑
 *   node scripts/check-rwd.mjs --routes /,/legislators  # 只跑幾條
 *   node scripts/check-rwd.mjs --shots                  # 每個寬度都存截圖（預設只存失敗的）
 *   node scripts/check-rwd.mjs --strict                 # 連「頁首高度」也當失敗條件
 *
 * 為什麼要有這支：
 *   2026-10-07 規劃 RWD 時實測到「一個 div.header-status（white-space: nowrap、605px）讓 21 條路由裡
 *   20 條在 390px 橫向溢出 231px」—— 這種「一個元素弄壞整個站」的問題，沒有自動檢查就會再發生。
 *   驗收標準：在手機寬度下 document.documentElement.scrollWidth 必須等於 clientWidth（沒有橫向捲動）。
 *
 * 前置：本機伺服器已在跑（scripts/ly-dashboard-server.sh，預設 http://127.0.0.1:8787）。
 * 依賴：playwright-core ＋系統 Chrome（跟每日粉專抓取同一套，沒有新增依賴）。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 全部路由（與 web/src/hooks/useRoute.ts 的 PATHS 對齊；搬頁籤時這裡也要跟著改） */
export const ROUTES = [
  '/', '/my', '/activity', '/legislators', '/bills', '/budget', '/committees', '/rankings', '/compare',
  '/council', '/facebook/wall', '/facebook/council', '/counties', '/officials', '/news', '/news/all',
  '/news/agencies', '/agencies', '/funds', '/foundations', '/administrative',
];

/** 允許 1px 的次像素誤差；超過就是真的可以左右捲 */
export const OVERFLOW_TOLERANCE = 1;

/** 手機頁首高度上限（見 docs/rwd-plan.md 的驗收標準） */
export const HEADER_MAX_PX = 160;

/** 選取頁籤的文字中心允許偏離膠囊中心幾 px（中文字墨跡本身會偏 0.5px，所以留 2px） */
export const TAG_CENTER_MAX_PX = 2;

/** 這條路由溢出幾 px（0＝沒有橫向捲動） */
export function overflowOf(metrics) {
  const scroll = Number(metrics?.scrollWidth ?? 0);
  const client = Number(metrics?.clientWidth ?? 0);
  return Math.max(0, Math.round(scroll - client));
}

/** 這條路由算不算失敗（只有「真的可以左右捲」才算；頁首高度另外用 --strict 判） */
export function failures(rows, { strict = false } = {}) {
  return rows.filter(
    (r) =>
      r.overflow > OVERFLOW_TOLERANCE ||
      (r.tagOffset ?? 0) > TAG_CENTER_MAX_PX ||
      (strict && (r.headerH ?? 0) > HEADER_MAX_PX),
  );
}

/** 逐路由量測用的瀏覽器端程式：回傳溢出量、頁首高度與前三大溢出元素 */
const AUDIT = `(() => {
  const cw = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.right > cw + 2 && s.position !== 'fixed' && s.visibility !== 'hidden';
    })
    .map((el) => ({
      sel: el.tagName + (el.className ? '.' + el.className.toString().trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      w: Math.round(el.getBoundingClientRect().width),
      nowrap: getComputedStyle(el).whiteSpace === 'nowrap',
    }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 3);
  // 頁籤文字有沒有垂直置中（2026-10-08 實測：手機的觸控目標 min-height 會把頁籤撐高，
  // 文字黏在頂端 —— 上留白 5px／下留白 17px，看起來就是「選取的 tag 沒有置中」）。
  const centers = [];
  for (const a of document.querySelectorAll("header nav a[aria-current='page'], .subnav a[aria-current='page']")) {
    const box = a.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(a);
    const text = range.getBoundingClientRect();
    if (!text.height) continue;
    centers.push({
      label: a.textContent.trim().slice(0, 8),
      offset: Math.round((text.top + text.height / 2 - (box.top + box.height / 2)) * 10) / 10,
      pill: Math.round(box.height),
      line: Math.round(text.height),
    });
  }
  const worst = centers.slice().sort((x, y) => Math.abs(y.offset) - Math.abs(x.offset))[0] ?? null;
  const header = document.querySelector('header');
  return JSON.stringify({
    clientWidth: cw,
    scrollWidth: document.documentElement.scrollWidth,
    headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
    top: over,
    tagOffset: worst ? Math.abs(worst.offset) : 0,
    tagWorst: worst,
  });
})()`;

function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string', default: process.env.LY_RWD_BASE ?? 'http://127.0.0.1:8787' },
      widths: { type: 'string', default: process.env.LY_RWD_WIDTHS ?? '390' },
      routes: { type: 'string' },
      shots: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
    },
  });
  return {
    base: values.base.replace(/\/$/, ''),
    widths: String(values.widths).split(',').map((w) => Number(w.trim())).filter((w) => w > 0),
    routes: values.routes ? String(values.routes).split(',').map((r) => r.trim()).filter(Boolean) : ROUTES,
    shots: values.shots,
    strict: values.strict,
  };
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const shotsDir = join(ROOT, '.cache', 'rwd-shots');

  // playwright 會在 os.tmpdir() 建暫存目錄；指到專案內，免得到受管環境遇到 EPERM（同 fetch-fb-posts.mjs）
  const tmp = join(ROOT, '.cache', 'tmp');
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
  process.env.TMPDIR = tmp;

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.error('找不到 playwright-core。這支腳本需要它：\n  npm i -D playwright-core');
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const rows = [];
  try {
    for (const width of opts.widths) {
      // isMobile：讓瀏覽器照 <meta viewport> 排版（＝真的手機的行為）；
      // 內容若比裝置寬，內層會自己變寬、於是量得到橫向捲動 —— 這正是我們要抓的
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        locale: 'zh-TW',
      });
      const page = await context.newPage();
      for (const route of opts.routes) {
        let metrics = null;
        try {
          await page.goto(`${opts.base}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1500); // 等資料進來（前端打完 API 才長出內容）
          metrics = JSON.parse(await page.evaluate(AUDIT));
        } catch (error) {
          console.error(`✗ ${width}px ${route}：量不到（${String(error?.message ?? error).slice(0, 80)}）`);
          rows.push({ width, route, overflow: -1, error: true, headerH: null, top: [], tagOffset: 0, tagWorst: null });
          continue;
        }
        const overflow = overflowOf(metrics);
        const row = { width, route, overflow, headerH: metrics.headerH, top: metrics.top, tagOffset: metrics.tagOffset, tagWorst: metrics.tagWorst };
        rows.push(row);
        const offCenter = (metrics.tagOffset ?? 0) > TAG_CENTER_MAX_PX;
        const bad = overflow > OVERFLOW_TOLERANCE || offCenter;
        const tag = bad ? '✗' : '✓';
        const detail = bad
          ? `（${overflow > OVERFLOW_TOLERANCE ? `最寬：${metrics.top.map((t) => `${t.sel} ${t.w}px${t.nowrap ? ' nowrap' : ''}`).join('、')}` : ''}${
              offCenter && metrics.tagWorst
                ? `${overflow > OVERFLOW_TOLERANCE ? '；' : ''}頁籤「${metrics.tagWorst.label}」文字偏 ${metrics.tagWorst.offset}px（膠囊 ${metrics.tagWorst.pill}px／文字 ${metrics.tagWorst.line}px）`
                : ''
            }）`
          : '';
        console.log(`${tag} ${String(width).padStart(4)}px ${route.padEnd(22)} 溢出 ${String(overflow).padStart(4)}px  頁首 ${String(metrics.headerH ?? '-').padStart(4)}px  頁籤偏移 ${String(metrics.tagOffset ?? 0).padStart(4)}px ${detail}`);
        if (bad || opts.shots) {
          mkdirSync(shotsDir, { recursive: true });
          const name = `${width}${route.replace(/\//g, '_') || '_root'}.png`;
          await page.screenshot({ path: join(shotsDir, name) }).catch(() => {});
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const failed = failures(rows, { strict: opts.strict });
  console.log('');
  if (!failed.length) {
    const tallest = rows.reduce((max, r) => Math.max(max, r.headerH ?? 0), 0);
    const worstTag = rows.reduce((max, r) => Math.max(max, r.tagOffset ?? 0), 0);
    console.log(`✅ ${rows.length} 個「寬度 × 路由」組合都沒有橫向捲動、頁籤也都垂直置中（最高的頁首 ${tallest}px、頁籤最大偏移 ${worstTag}px）`);
    if (tallest > HEADER_MAX_PX && !opts.strict) {
      console.log(`ℹ️ 有頁首高於 ${HEADER_MAX_PX}px（手機希望 ≤128px）；要用它當失敗條件請加 --strict`);
    }
    return;
  }
  const overflowed = failed.filter((r) => r.error || r.overflow > OVERFLOW_TOLERANCE);
  const offCenter = failed.filter((r) => !r.error && r.overflow <= OVERFLOW_TOLERANCE && (r.tagOffset ?? 0) > TAG_CENTER_MAX_PX);
  const tooTall = failed.filter((r) => !r.error && r.overflow <= OVERFLOW_TOLERANCE && (r.tagOffset ?? 0) <= TAG_CENTER_MAX_PX);
  if (overflowed.length) console.log(`❌ ${overflowed.length} 個組合會橫向捲動：${overflowed.map((r) => `${r.width}px ${r.route}`).join('、')}`);
  if (offCenter.length)
    console.log(
      `❌ ${offCenter.length} 個組合的選取頁籤文字沒垂直置中：${offCenter
        .map((r) => `${r.width}px ${r.route}（「${r.tagWorst?.label}」偏 ${r.tagWorst?.offset}px）`)
        .join('、')}`,
    );
  if (tooTall.length) console.log(`❌ ${tooTall.length} 個組合的頁首超過 ${HEADER_MAX_PX}px（--strict）：${tooTall.map((r) => `${r.width}px ${r.route}`).join('、')}`);
  if (overflowed.some((r) => !r.error)) console.log(`截圖（失敗的組合）：${shotsDir}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
