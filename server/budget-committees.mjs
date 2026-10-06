import { CONFIG } from './config.mjs';
import { fetchJson } from './fetch-ly.mjs';

/**
 * 每筆預算議案紀錄「交哪個委員會」。
 *
 * 為什麼需要：同一個預算案在 g0v 的資料裡會有多筆議案紀錄（實測「115年度中央政府總預算案」有 **24 筆**），
 * 差別就在**交付到不同委員會審查**——經濟委員會、交通委員會（3 筆）、司法及法制委員會（2 筆）…。
 * 議案**列表** API 沒有「議案流程」這一欄（只有屆／議案編號／會議代碼／名稱／狀態／類別／會期），
 * 所以要看委員會就得逐筆打 `/bill/{id}`。
 *
 * 委員會出現在流程狀態字串裡：`排入院會 (交內政委員會)`、`交付審查(交財政委員會)`…。
 * 抽不到就留空（例如「定期舉行會議，邀請行政院院長…列席報告」那種沒有委員會的流程）。
 */

/** 議案詳細資料網址（g0v LYAPI v2） */
export const billDetailUrl = (id) => `${CONFIG.bills.url}/${encodeURIComponent(id)}`;

/**
 * 從議案詳細資料抽出委員會清單（去重、保留出現順序）。
 * 只認「交○○委員會」這種寫法；長度限制是為了不要把整句流程敘述當成委員會名稱。
 */
export function parseCommittees(bill) {
  const flow = bill?.['議案流程'] ?? [];
  const out = [];
  for (const step of flow) {
    const text = String(step?.['狀態'] ?? '');
    const match = /交([^（）()，。；;：:]{2,20}?委員會)/.exec(text);
    if (match && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

/** 抓一筆議案的委員會（附狀態與會議，方便除錯與顯示） */
export async function fetchBillCommittees(id, { fetchImpl = fetchJson } = {}) {
  const { json } = await fetchImpl(billDetailUrl(id), { ua: CONFIG.userAgent });
  const bill = json?.data ?? (Array.isArray(json?.bills) ? json.bills[0] : json);
  return {
    committees: parseCommittees(bill),
    status: bill?.['議案狀態'] ?? null,
    meeting: bill?.['會議代碼:str'] ?? null,
  };
}
