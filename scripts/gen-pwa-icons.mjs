/*
 * 產生 PWA 圖示（T11）。
 *
 *   npm run gen:pwa-icons   （需要系統 Chrome 或設定 CHROME_PATH）
 *
 * 議事殿堂（見 DECISIONS.md D283）：「柱廊＋底座」這種議事廳意象在 48px 也讀得出來，
 * 又不像傳統官方徽章的鷹／盾／旗那樣帶政治符號。整顆圖示只用站上色票（--accent 系），
 * 用 Chromium 把同一份 SVG 畫成各尺寸 PNG，不抓任何外部圖、不用 emoji。
 *
 * **檔名帶版本（ICON_VERSION）**：改圖示時一定要 +1，並同步改
 * web/public/manifest.webmanifest、web/index.html、web/public/sw.js 的 SHELL（以及 sw.js 的 CACHE）。
 * 為什麼要這樣：Android 的 Chrome 只在 **manifest 有變動**時才重建 WebAPK —— 只換 PNG 內容、
 * 檔名與 manifest 都沒變的話，主畫面上的圖示會一直是舊的（iOS 更是一定要移除再重新「加到主畫面」）。
 * 這四處的一致性由 test/pwa-icons.test.mjs 釘住，改一個地方沒改其他會被測到。
 *
 * 產出：ICON_FILES 的四個檔（見下）。
 * 三種畫法（差別只在圓角與安全區）：
 *   any      → 圓角藍底（四角透明），mark 滿版
 *   maskable → 滿版藍底（不可有圓角／透明），mark 縮到安全圓內（Android 會裁成各種形狀）
 *   apple    → 滿版藍底，iOS 自己上圓角
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromePath } from './find-chrome.mjs';

/** 圖示改版就 +1（v1＝早期 emoji 佔位版、v2＝議事殿堂柱廊）。 */
export const ICON_VERSION = 2;
const v = `-v${ICON_VERSION}`;
/** 四顆圖示的檔名（唯一來源；manifest／index.html／sw.js 由測試確保一致）。 */
export const ICON_FILES = {
  '192': `icon-192${v}.png`,
  '512': `icon-512${v}.png`,
  maskable: `icon-maskable-512${v}.png`,
  apple: `apple-touch-icon${v}.png`,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'web', 'public');
// 不再寫死某一台 Mac 的 Chromium 路徑（Windows 版一定找不到）；照平台找系統 Chrome，找不到就報錯。
const EXE = findChromePath();

const ACCENT_DARK = '#1d4ed8'; // = styles.css --accent-hover
const ACCENT_LIGHT = '#3b82f6';
const MARK_LIGHT = '#dbe6ff'; // 簷部：比柱身淡一階，縮小後還看得出層次

const BASE = 512; // mark 的座標系（= icon-512 的畫布）
const CX = BASE / 2; // 所有元件都以這條中線對稱（使用者 2026-10-13 抓到柱子偏左）

/** 柱廊的四根柱子：由中線往外推，置中對稱（不要手寫 x，手寫就會歪）。 */
function columnX(width = 40, pitch = 70, count = 4) {
  const span = (count - 1) * pitch + width; // 整組寬
  const left = CX - span / 2;
  return Array.from({ length: count }, (_, i) => left + i * pitch);
}

const COLS = columnX();

/** 議事殿堂 mark（座標系 512×512）。左右鏡射對稱由 assertSymmetric() 釘住。 */
function mark() {
  return `
    <path d="M${CX} 96 L416 176 H96 Z" fill="#ffffff"/>
    <rect x="96" y="190" width="320" height="22" rx="8" fill="${MARK_LIGHT}"/>
    <g fill="#ffffff">
      ${COLS.map((x) => `<rect x="${x}" y="230" width="40" height="132" rx="10"/>`).join('\n      ')}
    </g>
    <rect x="96" y="382" width="320" height="30" rx="10" fill="#ffffff"/>`;
}

// mark 的外框（下面各元素的極值）＋最遠角到中心的距離（算 maskable 安全區用）
const MARK_BOX = {
  x: 96,
  y: 96,
  x2: 416,
  y2: 412,
};
const MARK_FAR_CORNER = Math.hypot(
  Math.max(Math.abs(MARK_BOX.x - CX), Math.abs(MARK_BOX.x2 - CX)),
  Math.max(Math.abs(MARK_BOX.y - BASE / 2), Math.abs(MARK_BOX.y2 - BASE / 2)),
);

/** 縮到「半徑 40% 的安全圓」內：Android 最狠的裁切（圓形）也切不到柱廊。 */
function maskableScale() {
  return Math.floor(((BASE * 0.4) / MARK_FAR_CORNER) * 100) / 100;
}

/**
 * 一顆圖示的 SVG。
 * @param size   畫布邊長（px）
 * @param radius 圓角；0 = 滿版（maskable／apple）
 * @param scale  mark 的縮放（滿版 1；maskable／apple 要留在安全區內）
 */
function iconSvg({ size, radius, scale }) {
  const u = size / BASE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${ACCENT_LIGHT}"/>
        <stop offset="1" stop-color="${ACCENT_DARK}"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
    <g transform="translate(${size / 2} ${size / 2}) scale(${(u * scale).toFixed(4)}) translate(${-BASE / 2} ${-BASE / 2})">
      ${mark()}
    </g>
  </svg>`;
}

const ICONS = [
  // any：圓角藍底，四角透明
  { file: ICON_FILES['192'], size: 192, radius: Math.round(192 * 0.2266), scale: 1 },
  // any：512 與 192 同一份構圖（不帶站名 —— 主畫面上縮到 96px 時字一定讀不出來）
  { file: ICON_FILES['512'], size: 512, radius: Math.round(512 * 0.2266), scale: 1 },
  // maskable：滿版藍底 + 安全區內
  { file: ICON_FILES.maskable, size: 512, radius: 0, scale: maskableScale() },
  // iOS 加到主畫面：滿版（iOS 自己上圓角），180×180
  { file: ICON_FILES.apple, size: 180, radius: 0, scale: maskableScale() },
];

/** 讀 PNG 的 IHDR 拿實際尺寸（確認 Chrome 真的吐對大小，不是只看 exit code）。 */
function pngSize(path) {
  const buf = readFileSync(path);
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) throw new Error(`${path} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 量左右對稱性：把圖示畫進 canvas，取「白色 mark」的質量中心與左右邊界。
 * 主線斷言是 centroid／bbox（使用者 2026-10-13 抓到的「柱子沒有對稱」＝質量中心偏左 9px）；
 * 逐點鏡射比對只當參考值 —— Chrome 的 SVG 光柵化本身就有約半像素的方向性偏差
 * （頂點那一列實測 x=255 覆蓋 201、x=256 只有 146），拿它當門檻會誤判。
 */
export async function symmetryReport(page, size) {
  return page.evaluate(async (size) => {
    const xml = new XMLSerializer().serializeToString(document.querySelector('svg'));
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    // 白色 mark（背景藍的 r 只有 59，不會被算進來）；權重用 r 當覆蓋率
    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = size;
    let maxX = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (data[i] > 150) {
          const w = data[i];
          weight += w;
          sumX += w * (x + 0.5);
          sumY += w * (y + 0.5);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    // 逐點鏡射（取前後一欄最接近的值，容納半像素偏差）
    let mirrorDiff = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        let best = 255;
        for (const dx of [-1, 0, 1]) {
          const nx = size - 1 - x + dx;
          if (nx < 0 || nx >= size) continue;
          const j = (y * size + nx) * 4;
          let diff = 0;
          for (let k = 0; k < 4; k++) diff = Math.max(diff, Math.abs(data[i + k] - data[j + k]));
          if (diff < best) best = diff;
        }
        if (best > mirrorDiff) mirrorDiff = best;
      }
    }
    return {
      centroidX: sumX / weight,
      centroidY: sumY / weight,
      leftGap: minX, // 左邊界到畫布左緣
      rightGap: size - 1 - maxX, // 右邊界到畫布右緣
      mirrorDiff,
    };
  }, size);
}

async function assertSymmetric(page, size) {
  const r = await symmetryReport(page, size);
  const center = size / 2;
  const off = Math.abs(r.centroidX - center);
  const gapDiff = Math.abs(r.leftGap - r.rightGap);
  if (off > 1 || gapDiff > 1) {
    throw new Error(
      `${size}px 圖示左右不對稱：質量中心 x=${r.centroidX.toFixed(2)}（應為 ${center}，偏 ${(r.centroidX - center).toFixed(2)}）、` +
        `左緣留白 ${r.leftGap}／右緣留白 ${r.rightGap}（差 ${gapDiff}）`,
    );
  }
  return r;
}



async function main() {
  if (!EXE) {
    console.error('找不到 Chrome 執行檔。請安裝 Chrome，或用 CHROME_PATH 指定執行檔路徑。');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  console.log(`柱子 x：${COLS.join('、')}（柱心 ${COLS.map((x) => x + 20).join('、')}，中線 ${CX}）`);
  console.log(`mark 最遠角 ${MARK_FAR_CORNER.toFixed(1)}／安全半徑 ${BASE * 0.4} → maskable 縮放 ${maskableScale()}`);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: EXE });
  for (const icon of ICONS) {
    const page = await browser.newPage({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
      omitBackground: true, // 圓角外的四角要透明，不能是白色
    });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(icon)}</body></html>`,
    );
    const path = join(OUT, icon.file);
    await page.screenshot({ path, omitBackground: true });
    const got = pngSize(path);
    if (got.width !== icon.size || got.height !== icon.size) {
      throw new Error(`${icon.file} 尺寸不對：得到 ${got.width}×${got.height}，預期 ${icon.size}×${icon.size}`);
    }
    const sym = await assertSymmetric(page, icon.size);
    await page.close();
    console.log(
      `✓ ${icon.file}（${got.width}×${got.height}，質量中心 x=${sym.centroidX.toFixed(2)}` +
        `、左右留白 ${sym.leftGap}／${sym.rightGap}、鏡射參考色差 ${sym.mirrorDiff}）`,
    );
  }
  await browser.close();
}

export { ICONS, iconSvg, mark, maskableScale, MARK_BOX };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
