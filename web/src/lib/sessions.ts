import type { TermInfo } from '../api/types';
import { ALL_SESSIONS } from './urlState';

/**
 * 屆次／會期的純函式。這些邏輯刻意放在 lib 而不是元件裡：
 * 舊版最嚴重的缺陷（B4：跨屆資料被混在一起）就出在「屆次語意」被隱含處理，
 * 這裡把「選哪一屆的哪一個會期」變成可單獨驗證的函式。
 */

/** 取該屆 seq 最大的會期；該屆沒有會期時回 null（呼叫端再退回「全部會期」） */
export function latestSessionId(termInfo: TermInfo | undefined): string | null {
  if (!termInfo || termInfo.sessions.length === 0) return null;
  return termInfo.sessions.reduce((best, item) => (item.seq > best.seq ? item : best)).id;
}

/** 會期 id → 顯示名稱（只用 /api/v1/meta 的資料，不做任何推測） */
export function sessionLabelIndex(terms: readonly TermInfo[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const term of terms) {
    for (const session of term.sessions) index.set(session.id, session.label);
  }
  return index;
}

/** 目前範圍的人類可讀名稱，例如「第 11 屆第 5 會期」／「第 11 屆 全部會期」 */
export function sessionScopeLabel(
  terms: readonly TermInfo[],
  term: number | null,
  session: string | null,
): string {
  if (term === null) return '未指定屆次';
  if (!session || session === ALL_SESSIONS) return `第 ${term} 屆 全部會期`;
  const sessionInfo = terms.find((item) => item.no === term)?.sessions.find((item) => item.id === session);
  return sessionInfo?.label ?? `第 ${term} 屆（${session}）`;
}
