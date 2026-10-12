import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, iconSvg, mark, MARK_BOX } from '../scripts/gen-pwa-icons.mjs';

/**
 * PWA 圖示（T11）的產物本身也要釘住。
 * 這裡只驗「檔案／manifest／幾何」這些不需要瀏覽器就能查的東西；
 * 真正把圖畫出來、量左右對稱的那一段在 `npm run gen:pwa-icons`（會自己 red 起來）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'web', 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

/** 讀 PNG 的 IHDR（不引入影像套件）。 */
function pngSize(file) {
  const buf = readFileSync(join(PUBLIC, file));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('PWA 圖示：四顆檔案的實際像素尺寸（iOS 少了 apple-touch-icon 就不會全螢幕）', () => {
  const expected = {
    'icon-192.png': 192,
    'icon-512.png': 512,
    'icon-maskable-512.png': 512,
    'apple-touch-icon.png': 180,
  };
  assert.deepEqual(
    ICONS.map((i) => i.file).sort(),
    Object.keys(expected).sort(),
    '產生器的檔案清單要和這裡一致',
  );
  for (const [file, size] of Object.entries(expected)) {
    const got = pngSize(file);
    assert.deepEqual({ file, ...got }, { file, width: size, height: size });
  }
});

test('PWA 圖示：manifest 宣告的圖示與檔案對得上（含 maskable 的 purpose）', () => {
  const icons = manifest.icons;
  assert.equal(icons.length, 3, 'manifest 應該有 192／512／maskable 三顆');
  const bySrc = Object.fromEntries(icons.map((i) => [i.src, i]));
  for (const [src, size, purpose] of [
    ['/icon-192.png', '192x192', 'any'],
    ['/icon-512.png', '512x512', 'any'],
    ['/icon-maskable-512.png', '512x512', 'maskable'],
  ]) {
    const icon = bySrc[src];
    assert.ok(icon, `manifest 少了 ${src}`);
    assert.equal(icon.sizes, size);
    assert.equal(icon.purpose, purpose);
    assert.equal(icon.type, 'image/png');
    // 宣告的尺寸要和檔案裡的實際尺寸一致（改產生器忘了改 manifest 時會紅）
    const [w] = size.split('x');
    assert.equal(pngSize(src.slice(1)).width, Number(w));
  }
});

test('PWA 圖示：柱廊的四根柱子左右對稱（使用者 2026-10-13：「柱子沒有對稱」）', () => {
  const columns = [...mark().matchAll(/<rect x="([\d.]+)" y="230" width="([\d.]+)"/g)].map(([, x, w]) => ({
    left: Number(x),
    width: Number(w),
  }));
  assert.equal(columns.length, 4, '柱廊要有四根柱子');
  const mid = 512 / 2;
  const centers = columns.map((c) => c.left + c.width / 2);
  // 柱心到中線的偏移要兩兩成對（最左／最右、左內／右內）—— 第一個版本就是整組偏左 9px
  const offsets = centers.map((c) => c - mid).sort((a, b) => a - b);
  assert.ok(Math.abs(offsets[0] + offsets[3]) < 0.01, `最左／最右不對稱：${offsets[0]} vs ${offsets[3]}`);
  assert.ok(Math.abs(offsets[1] + offsets[2]) < 0.01, `內側兩根不對稱：${offsets[1]} vs ${offsets[2]}`);
  // 柱距一致、整組置中
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  assert.equal(new Set(gaps).size, 1, `柱子間距要一致，實際 ${gaps.join('／')}`);
  const groupMid = (columns[0].left + columns.at(-1).left + columns.at(-1).width) / 2;
  assert.equal(groupMid, mid, '整組柱廊要置中');
});

test('PWA 圖示：mark 的質量中心在畫布中線（幾何層的對稱檢查）', () => {
  assert.equal((MARK_BOX.x + MARK_BOX.x2) / 2, 512 / 2, 'mark 外框要左右對稱於中線');
  assert.ok(MARK_BOX.x > 0 && MARK_BOX.x2 < 512, 'mark 不可以超出畫布');
});

test('PWA 圖示：maskable／apple 的 mark 留在 40% 安全半徑內（圓形裁切切不到）', () => {
  const far = Math.hypot(
    Math.max(Math.abs(MARK_BOX.x - 256), Math.abs(MARK_BOX.x2 - 256)),
    Math.max(Math.abs(MARK_BOX.y - 256), Math.abs(MARK_BOX.y2 - 256)),
  );
  for (const icon of ICONS.filter((i) => i.radius === 0)) {
    assert.ok(icon.size * (far / 512) * icon.scale <= icon.size * 0.4, `${icon.file} 的 mark 超出安全圓`);
  }
});

test('PWA 圖示：不用 emoji、也不在圖示上刻站名（縮到 96px 讀不出來）', () => {
  const svg = iconSvg(ICONS[1]);
  assert.ok(!/\p{Extended_Pictographic}/u.test(svg), '圖示不該再用 emoji');
  assert.ok(!svg.includes('<text'), '圖示不該有文字');
  assert.ok(svg.includes('#2563eb') || svg.includes('#3b82f6'), '要用站上的 accent 色系');
});

test('PWA 圖示：index.html 有 apple-touch-icon（iOS 加到主畫面）', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
});
