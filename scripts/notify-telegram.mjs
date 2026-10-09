#!/usr/bin/env node
/**
 * 送一則訊息到 Telegram（每日排程的成敗通知用）。
 *
 *   node scripts/notify-telegram.mjs "訊息內容"
 *   node scripts/notify-telegram.mjs --dry-run "訊息內容"    # 只印出來，不送出
 *
 * 為什麼是 .mjs 而不是原本的 .sh：Windows 沒有 bash 也沒有必然存在的 curl 參數習慣，
 * 而這一支是每日排程的收尾通知——排程本身（scripts/fb-daily.mjs）已經是 Node，
 * 通知沒有理由綁 shell。介面、行為、離開碼與 scripts/notify-telegram.sh 完全一致：
 *
 *   憑證放 ~/.ly-dashboard/notify.env（LY_TELEGRAM_BOT_TOKEN、LY_TELEGRAM_CHAT_ID，權限 600）。
 *   沒設定或送不出去都只印訊息、以 exit 0 結束 —— 通知本來就不該讓每日排程失敗。
 *   用 LY_NOTIFY_ENV 可以換憑證檔位置。
 *
 * 離開碼：0 = 已送出／沒有憑證（只印不送）／預演；1 = 有憑證但送出失敗；2 = 用法錯誤。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENV_FILE = join(homedir(), '.ly-dashboard', 'notify.env');

/**
 * 讀 `KEY=VALUE` 形式的設定檔（`export KEY=VALUE` 也吃；空行與 `#` 註解略過）。
 *
 * 為什麼自己寫：原本的 .sh 是 `set -a; . file; set +a`，等於把整份檔案當 shell 執行 ——
 * 那是 shell 版才有的方便與風險（檔內任何一行都是可執行程式碼）。這裡只認賦值，
 * 值可以用單／雙引號包住（去掉引號，支援 `\n` 與 `\"` 跳脫）。
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(.)/g, '$1');
    } else {
      // 未加引號時，行尾的註解不算值（`TOKEN=abc # 說明`）
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** 把可能夾帶 bot token 的字串遮掉（Telegram 的錯誤訊息會原樣回帶 token 的網址）。 */
export function redact(text) {
  return String(text ?? '').replace(/bot[0-9A-Za-z:_-]+/g, 'bot<略>');
}

/**
 * 送出一則訊息。回傳 `{ ok, detail }`；`ok=false` 時 `detail` 已經遮過憑證，可以安全印出。
 * 用 Node 內建的 fetch（Node 18+ 就有；本專案要求 22.5 以上），不需要 curl。
 */
export async function sendTelegram({ token, chatId, text, timeoutMs = 20000 }) {
  const body = new URLSearchParams({ chat_id: String(chatId), text: String(text) });
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.text();
    if (/\"ok\":true/.test(payload)) return { ok: true, detail: '' };
    return { ok: false, detail: redact(payload).slice(0, 200) };
  } catch (error) {
    return { ok: false, detail: redact(error?.message ?? error).slice(0, 200) };
  }
}

async function main(argv) {
  let dryRun = false;
  const rest = [];
  for (const arg of argv) {
    if (arg === '--dry-run' && rest.length === 0) {
      dryRun = true;
      continue;
    }
    rest.push(arg);
  }
  const message = rest[0] ?? '';
  if (!message) {
    console.error('用法: node scripts/notify-telegram.mjs [--dry-run] 訊息');
    return 2;
  }

  const envFile = process.env.LY_NOTIFY_ENV || DEFAULT_ENV_FILE;
  if (existsSync(envFile)) {
    // 跟 .sh 版一樣：檔案裡的值優先於既有環境變數
    Object.assign(process.env, parseEnvFile(readFileSync(envFile, 'utf8')));
  }

  const token = process.env.LY_TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.LY_TELEGRAM_CHAT_ID || '';

  if (dryRun || !token || !chatId) {
    if (!dryRun) console.log(`[通知] 沒有憑證（${envFile}）→ 只印不送`);
    console.log(`[通知]${dryRun ? '（預演）' : ''}\n${message}`);
    return 0;
  }

  const result = await sendTelegram({ token, chatId, text: message });
  if (result.ok) {
    console.log('[通知] 已送出');
    return 0;
  }
  console.log(`[通知] 送出失敗：${result.detail}`);
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
