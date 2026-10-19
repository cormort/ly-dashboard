/*
 * Facebook 嵌入框的載入排隊。
 *
 * 為什麼要排隊：粉專牆的卡片「捲進畫面」就掛一個 facebook.com 的 iframe，
 * 展開全部 112 位時一次會有好幾個第三方頁面同時載入 —— 主執行緒被 FB 的 plugin JS
 * 佔住，捲動就卡，行動網路更明顯（實測捲七個畫面就掛了 24 個 iframe、累計 7.4 秒）。
 *
 * 這裡只限制「同時載入」的數量（MAX_CONCURRENT），其餘排隊；
 * iframe onLoad 或逾時才換下一個。載入過的 iframe 不會被移除（使用者還要看）。
 */
const MAX_CONCURRENT = 3;

interface Waiter {
  start: (release: () => void) => void;
  cancelled: boolean;
}

let active = 0;
const waiters: Waiter[] = [];

function pump() {
  while (active < MAX_CONCURRENT) {
    const next = waiters.shift();
    if (!next) return;
    if (next.cancelled) continue;
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    };
    next.start(release);
  }
}

export interface EmbedSlot {
  /** 放棄排隊（已經開始的話，等於把名額還回去） */
  cancel: () => void;
}

/** 排隊要一個嵌入名額；有名額時呼叫 start(release)，載入完成（或逾時）再呼叫 release。 */
export function acquireEmbedSlot(start: (release: () => void) => void): EmbedSlot {
  const waiter: Waiter = { start, cancelled: false };
  waiters.push(waiter);
  pump();
  return {
    cancel: () => {
      waiter.cancelled = true;
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    },
  };
}

/** 測試／除錯用：目前同時載入數、排隊長度、上限 */
export function embedQueueStats() {
  return { active, queued: waiters.length, max: MAX_CONCURRENT };
}
