#!/usr/bin/env node
/**
 * 把「已經登入 Facebook 的瀏覽器」的 cookies 匯入 ly-dashboard 的 playwright 設定檔。
 *
 * 為什麼需要：`scripts/fetch-fb-posts.mjs --login` 要開**有畫面**的瀏覽器讓人工登入一次。
 * 伺服器（無螢幕／只能遠端）跑不到那一步時，可以改走這條：先把任何一個已登入 Facebook 的
 * 瀏覽器的 cookies 匯出成 JSON，再倒進排程用的設定檔，之後 `--login` 就不必再跑。
 *
 * 取得 cookies（ego-browser 之類有 CDP 的瀏覽器，在已登入 facebook.com 的分頁上）：
 *   const ck = await page.cdp('Network.getCookies', { urls: ['https://www.facebook.com'] });
 *   fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(ck.cookies));
 * 瀏覽器擴充套件（EditThisCookie／Cookie-Editor 的 JSON 匯出）也可以，欄位名稱相同。
 *
 *   node scripts/import-fb-cookies.mjs --from /tmp/fb-cookies.json
 *   node scripts/import-fb-cookies.mjs --from dump.json --profile ~/.ly-dashboard/fb-profile
 *
 * 只印筆數與 cookie 名稱，**不印任何值**（這些等同帳號憑證）。匯入後會當場開一次
 * facebook.com 驗「腳本會不會判定為已登入」，並以 exit 0／1 回報。
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const USAGE = `用法：node scripts/import-fb-cookies.mjs --from <cookies.json> [--profile <dir>]`;

function parseArgs(argv) {
  const out = {
    from: '/tmp/fb-cookies.json',
    profile: process.env.LY_FB_PROFILE || path.join(os.homedir(), '.ly-dashboard', 'fb-profile'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`不認得的參數：${a}\n${USAGE}`);
      process.exit(3);
    }
  }
  return out;
}

/** CDP／擴充套件的 sameSite 寫法（含 no_restriction）統一成 playwright 認的三種 */
function normalizeSameSite(value) {
  const s = String(value ?? '').toLowerCase();
  if (s === 'none' || s === 'no_restriction') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return undefined;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('找不到 playwright-core。這支腳本需要它才能寫入設定檔：\n  npm i -D playwright-core');
  process.exit(3);
}

const args = parseArgs(process.argv.slice(2));

let raw;
try {
  raw = JSON.parse(await readFile(args.from, 'utf8'));
} catch (error) {
  console.error(`讀不到 cookies 檔（${args.from}）：${error.message}`);
  process.exit(3);
}
if (!Array.isArray(raw) || raw.length === 0) {
  console.error(`${args.from} 不是非空的 cookie 陣列`);
  process.exit(3);
}

const cookies = raw
  .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && c.domain)
  .map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    // 工作階段的 cookie（expires -1）在 Chrome 重開時可能被丟掉；這裡不當它是永久，
    // 但要能活過下一次排程，所以負值一律當「工作階段」交給 playwright。
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    ...(normalizeSameSite(c.sameSite) ? { sameSite: normalizeSameSite(c.sameSite) } : {}),
  }));

console.log(`來源：${args.from}（${raw.length} 筆，可用 ${cookies.length} 筆）`);
console.log(`cookie 名稱：${cookies.map((c) => c.name).join(', ')}`);
if (!cookies.some((c) => c.name === 'c_user')) {
  console.warn('⚠️ 沒有 c_user：這份 dump 看起來不是已登入的 Facebook cookies，先確認來源分頁已登入。');
}

const ctx = await chromium.launchPersistentContext(args.profile, {
  channel: 'chrome',
  headless: true,
  locale: 'zh-TW',
});
await ctx.addCookies(cookies);

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
for (let i = 0; i < 20; i += 1) {
  if (/^\(\d+\)\s*Facebook/.test(await page.title())) break;
  await page.waitForTimeout(1000);
}
const title = await page.title();
const body = await page.evaluate(() => document.body.innerText.slice(0, 4000));
const loginWall = /登入 Facebook|Log into Facebook|Log in to Facebook/.test(body);
const stored = await ctx.cookies('https://www.facebook.com');
await ctx.close();

console.log(`設定檔：${args.profile}`);
console.log(`匯入後 cookies：${stored.length}｜c_user：${stored.some((c) => c.name === 'c_user')}`);
console.log(`頁面標題：${title}｜腳本判定的登入牆：${loginWall}`);
if (loginWall) {
  console.error('❌ 仍被判定為未登入：確認來源分頁真的登入 Facebook，或改用 --login 手動登入一次。');
  process.exit(1);
}
console.log('✅ 完成：這個設定檔會被 fetch-fb-posts.mjs 判定為已登入。');
