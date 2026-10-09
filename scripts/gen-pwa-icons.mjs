/*
 * 產生 PWA 圖示（T11）。一次性工具，產物直接 commit 進 web/public/。
 *
 *   npm run gen:pwa-icons   （需要系統 Chrome 或設定 CHROME_PATH）
 *
 * 用 Chromium 把 🐴（本站沿用的意象）與站名畫成 PNG，不抓任何外部圖。
 * 產出：icon-192.png、icon-512.png、icon-maskable-512.png、apple-touch-icon.png。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromePath } from './find-chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'web', 'public');
// 不再寫死某一台 Mac 的 Chromium 路徑（Windows 版一定找不到）；照平台找系統 Chrome，找不到就報錯。
const EXE = findChromePath();

const PAPER = '#f5f7fa'; // = styles.css --paper
const ACCENT = '#2563eb'; // = styles.css --accent

/** 一顆圖示的 HTML：bg 底、內容置中；maskable 用滿版底色 + 安全區。 */
function html({ size, bg, emojiSize, label, labelColor = '#101828' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: ${size}px; height: ${size}px; }
    .icon {
      width: ${size}px; height: ${size}px; background: ${bg};
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      font-family: 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif;
    }
    .mark { font-size: ${emojiSize}px; line-height: 1; }
    .label { margin-top: ${Math.round(size * 0.03)}px; font-size: ${label ? Math.round(size * 0.11) : 0}px;
      font-weight: 700; letter-spacing: 0.02em; color: ${labelColor}; }
  </style></head><body>
    <div class="icon"><div class="mark">🐴</div>${label ? `<div class="label">${label}</div>` : ''}</div>
  </body></html>`;
}

const ICONS = [
  // 一般圖示：淺底 + 馬（跟網站同色系）
  { file: 'icon-192.png', size: 192, bg: PAPER, emojiSize: 118 },
  // 512 帶站名（「用 🐴 與站名做一組」）
  { file: 'icon-512.png', size: 512, bg: PAPER, emojiSize: 260, label: '立委觀測站' },
  // maskable：滿版藍底，馬置中（留在中央安全區內，給系統裁切）
  { file: 'icon-maskable-512.png', size: 512, bg: ACCENT, emojiSize: 280 },
  // iOS 加到主畫面：180×180，馬
  { file: 'apple-touch-icon.png', size: 180, bg: PAPER, emojiSize: 112 },
];

async function main() {
  if (!EXE) {
    console.error('找不到 Chrome 執行檔。請安裝 Chrome，或用 CHROME_PATH 指定執行檔路徑。');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: EXE });
  for (const icon of ICONS) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
    await page.setContent(html(icon));
    const path = join(OUT, icon.file);
    await page.screenshot({ path });
    await page.close();
    console.log(`✓ ${icon.file}（${icon.size}×${icon.size}）`);
  }
  await browser.close();
}

await main();
