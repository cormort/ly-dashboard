import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DataValidationError } from './normalize.mjs';

/**
 * 「會期 → 委員會席次」的人工補充表（`server/committee-seats.json`）。
 *
 * 為什麼要有這個：委員名錄（data.ly.gov.tw 的 id9／id14）在會期**剛開始**時只會給部分席次。
 * 實測 2026-10-08 第 11 屆第 6 會期：整批 113 席裡只給了交通委員會 14 席、而且一個召委都沒有，
 * 但立法院當天已經公布完整的〈常設委員會召集委員、委員一覽表〉。
 * 名錄補齊之前，就靠這個檔案把該會期補成官方公布的樣子。
 *
 * 三條規則（見 DECISIONS D256–D260）：
 *  1. **只補上游還沒補齊的會期**：該會期上游席次 ≥ 補充表席次時整段略過（上游永遠優先），
 *     所以名錄哪天補齊了，這個檔案會自己失效，不用記得回來刪。
 *  2. **只補已經存在的會期**：會期不在名錄裡就略過 —— 不拿未來的補充表去補過去的資料集
 *     （測試用的舊 fixture 沒有 11-6，就不會被影響）。
 *  3. **名字對不上就整段失敗**（`DataValidationError`）：寧可同步失敗也不要靜默漏人。
 *     名字要用名錄裡的正式寫法（例：`謝衣鳯` 不是 `謝衣鳳`、`陳秀寳` 不是 `陳秀寶`、
 *     `鄭天財Sra Kacaw` 沒有空格、`伍麗華Saidhai‧Tahovecahe` 用「‧」）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(HERE, 'committee-seats.json');

/** 讀補充表；檔案不存在＝沒有補充（回 null）。 */
export function loadSeatOverrides(path = DEFAULT_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const data = JSON.parse(raw);
  if (!data?.sessions || typeof data.sessions !== 'object') {
    throw new DataValidationError(`委員會席次補充表格式不對（缺少 sessions）：${path}`);
  }
  return data;
}

/**
 * 補充表的指紋（用實際生效的內容算，不是檔案位元組）。放進 ingest 的 combinedSha，
 * 這樣「只改補充表、來源沒動」也會重新套用（否則 applied_sha 沒變就會被當成略過）。
 */
export function seatOverridesDigest(overrides) {
  return createHash('sha256').update(JSON.stringify(overrides ?? null)).digest('hex').slice(0, 16);
}

/** dataset.stats 中和席次／成員有關的欄位，補完之後要重算 */
function refreshSeatStats(dataset) {
  const conveners = (predicate) => new Set(dataset.seats.filter(predicate).map((s) => s.legislator_id)).size;
  dataset.stats.seats = dataset.seats.length;
  dataset.stats.committees = dataset.committees.length;
  dataset.stats.memberships = dataset.memberships.length;
  dataset.stats.current_roster = dataset.memberships.filter((m) => m.session_id === dataset.currentSession).length;
  dataset.stats.conveners_current_session = conveners((s) => s.session_id === dataset.currentSession && s.is_convener);
  dataset.stats.conveners_any_session = conveners((s) => s.is_convener);
}

/**
 * 把補充表套進 buildDataset 的結果（就地修改 dataset）。
 * 回傳報告：`{ applied: [...], skipped: [...] }`，交給呼叫端寫進同步紀錄與 log。
 */
export function applySeatOverrides(dataset, overrides, { logger = console } = {}) {
  const report = { applied: [], skipped: [] };
  if (!overrides?.sessions) return report;

  const knownSessions = new Set(dataset.sessions.map((s) => s.id));
  const byName = new Map(dataset.legislators.map((l) => [l.name, l.id]));

  for (const [sessionId, table] of Object.entries(overrides.sessions)) {
    const current = dataset.seats.filter((s) => s.session_id === sessionId);
    const wanted = Object.entries(table).flatMap(([committeeId, entry]) =>
      entry.members.map((name) => ({ committeeId, name, is_convener: entry.conveners.includes(name) })),
    );
    if (wanted.length === 0) continue;
    if (!knownSessions.has(sessionId)) {
      report.skipped.push({ session: sessionId, reason: '名錄裡還沒有這個會期' });
      continue;
    }
    if (current.length >= wanted.length) {
      report.skipped.push({ session: sessionId, reason: `上游已有 ${current.length} 席，不少於補充表的 ${wanted.length} 席` });
      continue;
    }
    const unresolved = wanted.filter((w) => !byName.has(w.name)).map((w) => w.name);
    if (unresolved.length > 0) {
      throw new DataValidationError(
        `委員會席次補充表有對不到委員名錄的名字（${sessionId}）：${unresolved.join('、')}`,
        { sessionId, unresolved },
      );
    }

    dataset.seats = dataset.seats.filter((s) => s.session_id !== sessionId);
    const committeeIds = new Set(dataset.committees.map((c) => c.id));
    for (const w of wanted) {
      if (!committeeIds.has(w.committeeId)) {
        dataset.committees.push({ id: w.committeeId, kind: 'standing' });
        committeeIds.add(w.committeeId);
      }
      dataset.seats.push({
        session_id: sessionId,
        committee_id: w.committeeId,
        legislator_id: byName.get(w.name),
        is_convener: w.is_convener,
      });
    }
    dataset.committees.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hant'));

    // memberships 也要補：上游這個會期的「成員名單」跟席次一樣是殘缺的
    // （實測 11-6 只有交通委員會那 14 人），不補的話前端預設會期只會列出那 14 個人。
    const byId = new Map(dataset.legislators.map((l) => [l.id, l]));
    const wantedIds = new Set(wanted.map((w) => byName.get(w.name)));
    const present = new Set(dataset.memberships.filter((m) => m.session_id === sessionId).map((m) => m.legislator_id));
    let membershipsAdded = 0;
    for (const id of wantedIds) {
      if (present.has(id)) continue;
      const l = byId.get(id);
      dataset.memberships.push({
        id: `${id}|${sessionId}`,
        legislator_id: id,
        session_id: sessionId,
        term: dataset.term,
        party: l.party,
        caucus: l.caucus,
        area_name: l.area_name,
        onboard_date: l.onboard_date,
        leave_flag: l.leave_flag,
        leave_date: l.leave_date,
        leave_reason: l.leave_reason,
      });
      membershipsAdded += 1;
    }
    // 名錄只在他「任何會期都沒有紀錄」時才會給屆次層級（session_id IS NULL）的那一筆；
    // 現在他有了這個會期的席次，那筆就重複了，拿掉（跟 normalize 的規則一致）。
    const droppedTermRows = dataset.memberships.filter((m) => m.session_id === null && wantedIds.has(m.legislator_id)).length;
    dataset.memberships = dataset.memberships.filter((m) => !(m.session_id === null && wantedIds.has(m.legislator_id)));
    // 上游這個會期有、但補充表沒列到的人：留著（不憑空刪），但要在警告裡講清楚
    const upstreamOnly = [...present].filter((id) => !wantedIds.has(id)).map((id) => byId.get(id)?.name ?? id);
    if (upstreamOnly.length > 0) {
      dataset.warnings.push(`${sessionId} 有 ${upstreamOnly.length} 位委員在上游名單裡但不在補充表中（保留）：${upstreamOnly.join('、')}`);
    }

    refreshSeatStats(dataset);

    const conveners = wanted.filter((w) => w.is_convener).length;
    const committees = Object.keys(table).length;
    logger.log?.(
      `[ingest] 委員會席次：${sessionId} 用人工確認的官方一覽表補齊 ${committees} 個委員會、${wanted.length} 席、${conveners} 位召委` +
        `（上游只給了 ${current.length} 席；成員名單補 ${membershipsAdded} 人、移除屆次層級 ${droppedTermRows} 筆）`,
    );
    dataset.warnings.push(
      `${sessionId} 的委員會席次由人工確認的官方一覽表補齊（${overrides.source ?? '未註明來源'}；上游只給了 ${current.length} 席，補齊後 ${wanted.length} 席）`,
    );
    report.applied.push({ session: sessionId, committees, seats: wanted.length, conveners, upstreamSeats: current.length, membershipsAdded, droppedTermRows, upstreamOnly });
  }
  return report;
}
