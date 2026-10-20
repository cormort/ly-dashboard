import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_FILES, ICON_VERSION, ICONS, iconSvg, mark, MARK_BOX } from '../scripts/gen-pwa-icons.mjs';

/**
 * PWA 圖示（T11）的產物本身也要釘住。
 * 這裡驗「檔案／manifest／index.html／sw.js／產生器」這五處的一致性，以及不需要瀏覽器就能查的幾何；
 * 真正把圖畫出來、量左右對稱的那一段在 `npm run gen:pwa-icons`（會自己 red 起來）。
 *
 * **為什麼要釘這五處**：圖示檔名帶版本（`-v2`）是為了讓 Android 的 Chrome 察覺 manifest 有變而重建 WebAPK。
 * 只要有一處忘了跟著 +1（例如改了檔名、sw.js 的 SHELL 還指著舊檔），症狀是「手機上的圖示或離線外框壞掉」，
 * 而且只有真的在手機上才會發現。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'web', 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');

/** 讀 PNG 的 IHDR（不引入影像套件）。 */
function pngSize(file) {
  const buf = readFileSync(join(PUBLIC, file));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('PWA 圖示：檔名一律帶版本，且 web/public 不留舊版', () => {
  for (const [key, file] of Object.entries(ICON_FILES)) {
    assert.match(file, new RegExp(`-v${ICON_VERSION}\\.png$`), `${key} 的檔名要帶 -v${ICON_VERSION}`);
    assert.ok(readdirSync(PUBLIC).includes(file), `web/public 少了 ${file}`);
  }
  // 舊版（沒帶版本號、或別版）的圖示不可以留在 web/public：留著會讓人以為還在用
  const stray = readdirSync(PUBLIC).filter((f) => /^(icon-|apple-touch-icon)/.test(f) && !/-v\d+\.png$/.test(f));
  assert.deepEqual(stray, [], `web/public 有不帶版本號的舊圖示：${stray.join('、')}（改版時要一起刪掉）`);
});

test('PWA 圖示：四顆檔案的實際像素尺寸（iOS 少了 apple-touch-icon 就不會全螢幕）', () => {
  const expected = {
    [ICON_FILES['192']]: 192,
    [ICON_FILES['512']]: 512,
    [ICON_FILES.maskable]: 512,
    [ICON_FILES.apple]: 180,
  };
  assert.deepEqual(
    ICONS.map((i) => i.file).sort(),
    Object.keys(expected).sort(),
    '產生器的檔案清單要和 ICON_FILES 一致',
  );
  for (const [file, size] of Object.entries(expected)) {
    assert.deepEqual({ file, ...pngSize(file) }, { file, width: size, height: size });
  }
});

test('PWA 圖示：manifest 宣告的圖示與檔案對得上（含 maskable 的 purpose）', () => {
  const icons = manifest.icons;
  assert.equal(icons.length, 3, 'manifest 應該有 192／512／maskable 三顆');
  const bySrc = Object.fromEntries(icons.map((i) => [i.src, i]));
  for (const [file, size, purpose] of [
    [ICON_FILES['192'], '192x192', 'any'],
    [ICON_FILES['512'], '512x512', 'any'],
    [ICON_FILES.maskable, '512x512', 'maskable'],
  ]) {
    const icon = bySrc[`/${file}`];
    assert.ok(icon, `manifest 少了 /${file}`);
    assert.equal(icon.sizes, size);
    assert.equal(icon.purpose, purpose);
    assert.equal(icon.type, 'image/png');
    // 宣告的尺寸要和檔案裡的實際尺寸一致（改產生器忘了改 manifest 時會紅）
    assert.equal(pngSize(file).width, Number(size.split('x')[0]));
  }
});

test('PWA 圖示：index.html 與 sw.js 指到同一版的檔名（改版時四處都要跟著 +1）', () => {
  assert.match(indexHtml, new RegExp(`rel="apple-touch-icon" href="/${ICON_FILES.apple}"`));
  assert.match(indexHtml, new RegExp(`sizes="192x192" href="/${ICON_FILES['192']}"`));

  const shell = sw.match(/const SHELL = \[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(shell, 'sw.js 找不到 SHELL 清單');
  for (const file of Object.values(ICON_FILES)) {
    assert.ok(shell.includes(`'/${file}'`), `sw.js 的 SHELL 少了 /${file}（離線時圖示會 404）`);
  }
  // 外框資源改了就要換快取名，否則舊的 precache 不會更新
  assert.match(sw, /const CACHE = 'ly-shell-v\d+';/);
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

test('PWA 圖示：manifest 與 index.html 的 PWA 基本設定還在', () => {
  assert.equal(manifest.name, '立委輿情觀測站');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.theme_color, '#2563eb');
  assert.match(indexHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(indexHtml, /apple-mobile-web-app-capable" content="yes"/);
});

test('PWA 圖示：主畫面名稱短到不會被 iOS／Android 截字，且 manifest 與 meta 一致', () => {
  // 使用者 2026-10-20：「主桌面名稱改短。」iOS 桌面圖示大約 6 個全形字就會被截成「立委輿情觀…」，
  // 站名全名留給 manifest.name 與 <title>，主畫面只放前四個字。
  assert.ok(manifest.short_name.length <= 5, `short_name 太長（${manifest.short_name}），主畫面會被截字`);
  const apple = indexHtml.match(/apple-mobile-web-app-title" content="([^"]+)"/)?.[1];
  assert.equal(apple, manifest.short_name, 'iOS 的 apple-mobile-web-app-title 要和 manifest.short_name 一致');
  assert.ok(manifest.name.length > manifest.short_name.length, 'manifest.name 仍是全名，主畫面才用短的');
});
