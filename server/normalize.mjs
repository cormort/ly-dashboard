/**
 * 純函式正規化層：不碰網路、不碰資料庫，只吃立法院 API 的原始 JSON，吐出結構化資料。
 * 這一層的所有行為都由 test/normalize.test.mjs 用真實 API fixture 驗證。
 */

/** "第11屆第3會期：內政委員會" → 乾淨的委員會名稱；這是舊版壞掉的地方。 */
const SESSION_PREFIX = /^第(\d+)屆第(\d+)會期[：:]\s*/;
const SPLIT_RE = /[、,，;；\n]/;

const STANDING_COMMITTEES = new Set([
  '內政委員會',
  '外交及國防委員會',
  '經濟委員會',
  '財政委員會',
  '教育及文化委員會',
  '交通委員會',
  '司法及法制委員會',
  '社會福利及衛生環境委員會',
]);

export class DataValidationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DataValidationError';
    this.detail = detail;
  }
}

export function splitList(value) {
  return String(value ?? '')
    .split(SPLIT_RE)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseSeatLabel(label) {
  const trimmed = String(label ?? '').trim();
  const match = SESSION_PREFIX.exec(trimmed);
  if (!match) return null;
  const committee = trimmed.slice(match[0].length).trim();
  if (!committee) return null;
  return { term: Number(match[1]), seq: Number(match[2]), committee };
}

export function committeeKind(id) {
  return STANDING_COMMITTEES.has(id) ? 'standing' : 'special';
}

export function sessionId(term, seq) {
  return `${term}-${seq}`;
}

export function sessionLabel(term, seq) {
  return `第 ${term} 屆第 ${seq} 會期`;
}

/** "雲林縣第1選舉區" → "雲林縣"；"嘉義市選舉區" → "嘉義市"；不分區／原住民各成一區。76 個選區 → 25 個篩選選項。 */
export function regionOf(areaName) {
  const area = String(areaName ?? '').trim();
  if (area.startsWith('全國不分區')) return '全國不分區';
  return area.replace(/第\d+選舉區$/, '').replace(/選舉區$/, '') || '未提供';
}

/**
 * id9 的 tel／fax／addr 是「處所：值;處所：值」字串，三欄各自列舉同一組處所。
 * 依處所名稱合併成 [{ label, tel, fax, addr }]，保留出現順序。
 */
export function parseContacts({ tel, fax, addr }) {
  const offices = new Map();
  for (const [key, raw] of [['tel', tel], ['fax', fax], ['addr', addr]]) {
    for (const part of String(raw ?? '').split(/[;；]/)) {
      const text = part.trim();
      if (!text) continue;
      const cut = text.search(/[：:]/);
      const label = cut > 0 ? text.slice(0, cut).trim() : '聯絡處';
      const value = (cut > 0 ? text.slice(cut + 1) : text).trim();
      if (!value) continue;
      const office = offices.get(label) ?? { label, tel: '', fax: '', addr: '' };
      office[key] = office[key] ? `${office[key]}、${value}` : value;
      offices.set(label, office);
    }
  }
  return [...offices.values()];
}

const field = (row, ...keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

const asBool = (value) => /^(是|y|yes|1|true)$/i.test(String(value ?? '').trim());

function dataList(payload, dataset) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.dataList)) {
    throw new DataValidationError(`${dataset} 回應缺少 dataList 陣列`, { dataset });
  }
  return payload.dataList;
}

/** 立法院 id9：當屆委員基本資料 + 各會期委員會（字串內含會期前綴）。 */
export function normalizeId9(payload) {
  const rows = dataList(payload, 'id9');
  if (rows.length < 100) {
    throw new DataValidationError(`id9 委員筆數異常（${rows.length} < 100）`, { records: rows.length });
  }

  const legislators = rows.map((row) => {
    const term = Number(field(row, 'term', '屆別'));
    if (!field(row, 'name', '委員姓名') || !Number.isFinite(term)) {
      throw new DataValidationError('id9 有委員缺少 name 或 term', { row: JSON.stringify(row).slice(0, 200) });
    }
    const seats = splitList(field(row, 'committee', '委員會'))
      .map(parseSeatLabel)
      .filter((seat) => seat && seat.term === term);

    return {
      term,
      name: field(row, 'name', '委員姓名'),
      ename: field(row, 'ename'),
      sex: field(row, 'sex'),
      party: field(row, 'party', '黨籍') || '未提供',
      caucus: field(row, 'partyGroup') || field(row, 'party', '黨籍') || '未提供',
      area_name: field(row, 'areaName', '選區名稱') || '未提供',
      photo_url: field(row, 'picUrl', 'picPath'),
      degree: field(row, 'degree', '學歷'),
      experience: field(row, 'experience', '經歷'),
      onboard_date: field(row, 'onboardDate'),
      leave_flag: asBool(field(row, 'leaveFlag')),
      leave_date: field(row, 'leaveDate'),
      leave_reason: field(row, 'leaveReason'),
      contacts: parseContacts({ tel: field(row, 'tel'), fax: field(row, 'fax'), addr: field(row, 'addr') }),
      seats,
    };
  });

  return legislators;
}

/** 立法院 id14：第 4 屆至今的委員會名單（含 lgno 與召委旗標）。 */
export function normalizeId14(payload, { term } = {}) {
  const rows = dataList(payload, 'id14');
  if (rows.length < 1000) {
    throw new DataValidationError(`id14 筆數異常（${rows.length} < 1000）`, { records: rows.length });
  }
  return rows
    .map((row) => ({
      name: field(row, 'name', '委員姓名'),
      lgno: field(row, 'lgno'),
      term: Number(field(row, 'term', '屆別')),
      seq: Number(field(row, 'sessionPeriod', '會期')),
      committee: field(row, 'committee', '委員會名稱'),
      is_convener: asBool(field(row, 'isCoChairman', '是否為召集委員')),
    }))
    .filter((row) => row.name && Number.isFinite(row.term) && Number.isFinite(row.seq) && row.committee)
    .filter((row) => (term === undefined ? true : row.term === term));
}

/**
 * 把兩份資料合成一個「以屆／會期為第一公民」的資料集。
 * 任何驗證失敗都丟 DataValidationError → 呼叫端必須中止寫入（fail closed），保留舊資料。
 */
export function buildDataset(id9Payload, id14Payload, { sourceUrl = '' } = {}) {
  const id9 = normalizeId9(id9Payload);
  const term = Math.max(...id9.map((r) => r.term));
  const currentRows = id9.filter((r) => r.term === term);
  const id14 = normalizeId14(id14Payload, { term });

  if (id14.length < 100) {
    throw new DataValidationError(`id14 第 ${term} 屆筆數異常（${id14.length} < 100）`, { term, records: id14.length });
  }

  // 立院正式識別碼：優先用 id14 的 lgno（同名同屆），否則退回 ename，最後才是姓名。
  const lgnoByName = new Map();
  for (const row of id14) if (row.lgno && !lgnoByName.has(row.name)) lgnoByName.set(row.name, row.lgno);
  const usedIds = new Set();
  const makeId = (row) => {
    const base = lgnoByName.get(row.name) || (row.ename ? `LY-${row.ename}` : `LY-${row.name}`);
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  const convenerKey = (name, seq, committee) => `${name}|${seq}|${committee}`;
  const convenerSet = new Set(id14.filter((r) => r.is_convener).map((r) => convenerKey(r.name, r.seq, r.committee)));

  const sessions = new Map();
  const committees = new Map();
  const legislators = [];
  const memberships = [];
  const seats = [];
  const warnings = [];
  const seenSeat = new Set();

  for (const row of currentRows) {
    const id = makeId(row);
    legislators.push({
      id,
      name: row.name,
      ename: row.ename,
      sex: row.sex,
      party: row.party,
      caucus: row.caucus,
      area_name: row.area_name,
      photo_url: row.photo_url,
      degree: row.degree,
      experience: row.experience,
      onboard_date: row.onboard_date,
      leave_flag: row.leave_flag,
      leave_date: row.leave_date,
      leave_reason: row.leave_reason,
      contacts: row.contacts,
      source_url: sourceUrl,
    });

    const seqs = new Set(row.seats.map((s) => s.seq));
    for (const seat of row.seats) {
      const sid = sessionId(term, seat.seq);
      if (!sessions.has(sid)) sessions.set(sid, { id: sid, term, seq: seat.seq, label: sessionLabel(term, seat.seq) });
      if (!committees.has(seat.committee)) {
        committees.set(seat.committee, { id: seat.committee, kind: committeeKind(seat.committee) });
      }
      const key = `${sid}|${seat.committee}|${id}`;
      if (seenSeat.has(key)) continue;
      seenSeat.add(key);
      seats.push({
        session_id: sid,
        committee_id: seat.committee,
        legislator_id: id,
        is_convener: convenerSet.has(convenerKey(row.name, seat.seq, seat.committee)),
      });
    }

    if (seqs.size === 0) {
      // 本屆在 id9 委員會欄位中沒有任何會期紀錄（皆為已離職者）：
      // 不編造會期，改以「屆次層級」成員身分保留，只出現在 session=all 檢視。
      memberships.push({
        id: `${id}|${term}|term`,
        legislator_id: id,
        session_id: null,
        term,
        party: row.party,
        caucus: row.caucus,
        area_name: row.area_name,
        onboard_date: row.onboard_date,
        leave_flag: row.leave_flag,
        leave_date: row.leave_date,
        leave_reason: row.leave_reason,
      });
      warnings.push(`${row.name} 在本屆無任何會期委員會紀錄（${row.leave_reason || '已離職'}），僅出現於全屆次檢視`);
      continue;
    }

    for (const seq of [...seqs].sort((a, b) => a - b)) {
      const sid = sessionId(term, seq);
      memberships.push({
        id: `${id}|${sid}`,
        legislator_id: id,
        session_id: sid,
        term,
        party: row.party,
        caucus: row.caucus,
        area_name: row.area_name,
        onboard_date: row.onboard_date,
        leave_flag: row.leave_flag,
        leave_date: row.leave_date,
        leave_reason: row.leave_reason,
      });
    }
  }

  // 交叉檢查：id9 與 id14 對「本屆席次」的數量應該一致，不一致要留下警告（不中止）。
  const id14Seats = new Set(id14.map((r) => `${r.seq}|${r.committee}|${r.name}`));
  // CR-5: O(1) name lookup（取代舊版 .find() 的 O(n²) 掃描）
  const nameById = new Map(legislators.map((l) => [l.id, l.name]));
  const id9Seats = new Set(seats.map((s) => {
    const name = nameById.get(s.legislator_id);
    return `${s.session_id.split('-')[1]}|${s.committee_id}|${name}`;
  }));
  const onlyId9 = [...id9Seats].filter((k) => !id14Seats.has(k));
  const onlyId14 = [...id14Seats].filter((k) => !id9Seats.has(k));
  if (onlyId9.length || onlyId14.length) {
    warnings.push(
      `id9/id14 席次交叉檢查不一致：僅 id9 ${onlyId9.length} 筆、僅 id14 ${onlyId14.length} 筆`,
    );
  }

  if (seats.length < 100) {
    throw new DataValidationError(`本屆委員會席次異常（${seats.length} < 100）`, { seats: seats.length, term });
  }

  const sessionList = [...sessions.values()].sort((a, b) => a.seq - b.seq);
  const currentSession = sessionList.at(-1)?.id ?? null;
  const currentRoster = memberships.filter((m) => m.session_id === currentSession).length;

  return {
    term,
    sessions: sessionList,
    currentSession,
    committees: [...committees.values()].sort((a, b) => a.id.localeCompare(b.id, 'zh-Hant')),
    legislators,
    memberships,
    seats,
    warnings,
    stats: {
      legislators: legislators.length,
      memberships: memberships.length,
      seats: seats.length,
      committees: committees.size,
      sessions: sessionList.length,
      current_session: currentSession,
      current_roster: currentRoster,
      conveners_current_session: new Set(
        seats.filter((s) => s.session_id === currentSession && s.is_convener).map((s) => s.legislator_id),
      ).size,
      conveners_any_session: new Set(seats.filter((s) => s.is_convener).map((s) => s.legislator_id)).size,
    },
  };
}
