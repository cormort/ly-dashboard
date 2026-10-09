/**
 * 找系統安裝的 Chrome（給需要「真瀏覽器」的驗收腳本用：PWA 驗收、PWA 圖示、每日粉專抓取）。
 *
 * 為什麼要有這一支：`gen-pwa-icons.mjs` 與 `verify-pwa.mjs` 原本把 Playwright 快取裡的
 * Chromium 路徑（`<家目錄>/Library/Caches/ms-playwright/…/Google Chrome for Testing`）寫死在程式裡 ——
 * 那是某一台 Mac 的路徑，換一台機器（更不用說 Windows）就直接找不到執行檔。
 * 這裡改成「有 CHROME_PATH 就用、沒有就照平台找常見安裝位置」，找不到才回 null 讓呼叫端給指示。
 *
 * 這一支只負責回傳路徑，不做 launch —— 呼叫端自己決定要用 executablePath 還是
 * Playwright 的 `channel: 'chrome'`（後者在兩平台都會自己找系統 Chrome，但抓不到時訊息比較難懂）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 各平台常見的 Chrome 執行檔位置（順序＝優先序）。 */
export function chromeCandidates(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      // Playwright 下載的 Chromium（本機 cache 的目錄名帶版本號，所以用掃的）
      ...macPlaywrightChromium(home),
    ];
  }
  if (platform === 'win32') {
    return [
      join(env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Playwright 預設的瀏覽器快取（Windows）
      ...winPlaywrightChromium(env, home),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

function macPlaywrightChromium(home) {
  const root = join(home, 'Library', 'Caches', 'ms-playwright');
  return safeDirs(root)
    .filter((name) => name.startsWith('chromium-'))
    .map((name) => join(root, name, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
    .concat(
      safeDirs(root)
        .filter((name) => name.startsWith('chromium-'))
        .map((name) => join(root, name, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')),
    );
}

function winPlaywrightChromium(env, home) {
  const root = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  return safeDirs(root)
    .filter((name) => name.startsWith('chromium-'))
    .map((name) => join(root, name, 'chrome-win', 'chrome.exe'));
}

function safeDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 回傳找到的 Chrome 執行檔絕對路徑，找不到就回 null。`CHROME_PATH` 永遠優先。
 * 參數只為了測試（可注入 platform／env／home），正常呼叫不用給。
 */
export function findChromePath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  for (const candidate of chromeCandidates(platform, env, home)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
