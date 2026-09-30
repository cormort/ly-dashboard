/**
 * 純函式正規化層：不碰網路、不碰資料庫，只吃立法院 API 的原始 JSON，吐出結構化資料。
 * 這一層的所有行為都由 test/normalize.test.mjs 用真實 API fixture 驗證。
 */

/**
 * 正規化版本。改變 normalize*.mjs 的行為時**一定要 +1**：
 * ingest 用 `版本:來源 sha256` 判斷要不要重寫資料庫，否則「原始資料沒變、但解析邏輯變了」
 * 時新規則不會生效（實測踩過：把 photo_url 升級成 https 後仍顯示 http）。
 */
export const NORMALIZER_VERSION = 2;

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

/**
 * 立院照片是 `http://www.ly.gov.tw//Images/...`（http + 雙斜線）。
 * https 實測可取得同一張圖（200 image/jpeg），升級避免 HTTPS 部署時被瀏覽器當 mixed content 擋掉。
 */
export function normalizePhotoUrl(url) {
  if (!url) return '';
  return url.replace(/^http:\/\//, 'https://').replace(/([^:])\/\//g, '$1/');
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
      photo_url: normalizePhotoUrl(field(row, 'picUrl', 'picPath')),
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

/**
 * g0v ly.govapi.tw 的議案分頁 → bills + bill_sponsors。
 * 提案人陣列第一位視為主提案人；姓名對不到本屆委員的只計數警告，不編造委員。
 * 分頁依「最新進度日期」排序，抓取期間資料可能移動 → 以議案編號去重，並要求筆數接近 total。
 */
export function normalizeBills(pages, legislatorIdByName) {
  if (!Array.isArray(pages) || pages.length === 0) throw new DataValidationError('bills 沒有任何分頁');
  const total = Number(pages[0]?.total);
  const bills = new Map();
  for (const page of pages) {
    if (!page || !Array.isArray(page.bills)) throw new DataValidationError('bills 分頁缺少 bills 陣列');
    for (const row of page.bills) {
      const id = field(row, '議案編號');
      if (!id || bills.has(id)) continue;
      bills.set(id, row);
    }
  }
  if (!Number.isFinite(total) || bills.size < total * 0.95) {
    throw new DataValidationError(`bills 筆數異常（取得 ${bills.size}，API total ${total}）`, { got: bills.size, total });
  }

  const unmatched = new Set();
  const sponsors = [];
  const items = [...bills.values()].map((row) => {
    const id = field(row, '議案編號');
    const names = Array.isArray(row['提案人']) ? row['提案人'].map((n) => String(n).trim()).filter(Boolean) : [];
    names.forEach((name, index) => {
      const legislatorId = legislatorIdByName.get(name);
      // 黨團提案是正常情況（提案人是黨團而非個人），不算對不到
      if (!legislatorId) return void (name.endsWith('黨團') || unmatched.add(name));
      sponsors.push({ bill_id: id, legislator_id: legislatorId, is_lead: index === 0 });
    });
    return {
      id,
      term: Number(field(row, '屆')) || null,
      session: Number(field(row, '會期')) || null,
      name: field(row, '議案名稱'),
      status: field(row, '議案狀態'),
      category: field(row, '議案類別'),
      proposer_text: field(row, '提案單位/提案委員'),
      laws: Array.isArray(row['法律編號:str']) ? row['法律編號:str'].map(String) : [],
      latest_date: field(row, '最新進度日期'),
      url: field(row, 'url'),
    };
  });
  const warnings = unmatched.size ? [`議案提案人有 ${unmatched.size} 個姓名對不到本屆委員：${[...unmatched].slice(0, 5).join('、')}`] : [];
  return { bills: items, sponsors, warnings, total };
}

/**
 * 預算類議案：總預算案、法人預算、預算決議書面報告。沒有提案委員（提案單位是機關或委員會），
 * 只取顯示需要的欄位，並從名稱抽出預算年度（「115年度」→ 115）。驗證規則與委員提案相同。
 */
export function normalizeBudget(pages, expectedTotal = pages?.[0]?.total) {
  if (!Array.isArray(pages) || pages.length === 0) throw new DataValidationError('budget 沒有任何分頁');
  const total = Number(expectedTotal);
  const rows = new Map();
  for (const page of pages) {
    if (!page || !Array.isArray(page.bills)) throw new DataValidationError('budget 分頁缺少 bills 陣列');
    for (const row of page.bills) {
      const id = field(row, '議案編號');
      if (id && !rows.has(id)) rows.set(id, row);
    }
  }
  if (!Number.isFinite(total) || total === 0 || rows.size < total * 0.95) {
    throw new DataValidationError(`budget 筆數異常（取得 ${rows.size}，API total ${total}）`, { got: rows.size, total });
  }
  return [...rows.values()].map((row) => {
    const name = field(row, '議案名稱');
    return {
      id: field(row, '議案編號'),
      term: Number(field(row, '屆')) || null,
      session: Number(field(row, '會期')) || null,
      category: field(row, '議案類別'),
      name,
      status: field(row, '議案狀態'),
      proposer: field(row, '提案單位/提案委員'),
      fiscal_year: Number(/(\d{2,3})\s*年度/.exec(name)?.[1]) || null,
      latest_date: field(row, '最新進度日期'),
      url: field(row, 'url'),
    };
  });
}

/**
 * 預算類型（可複選）：general 總預算、subsidiary 附屬單位預算、special 特別預算（含對應的決算）、
 * supplementary 追加（減）預算。
 * 只看「決議／檢送」之前的主旨：「為114年度中央政府總預算決議，檢送…特別預算…書面報告」
 * 屬於總預算決議，後面提到的特別預算只是報告內容。
 * 「總預算（案）附屬單位預算」是總預算裡的附屬單位部分、「總預算追加預算」是追加的部分，都不另算總預算；
 * 「總預算案（含附屬單位預算…）」「總決算暨附屬單位決算」則兩者都算。
 * 對不到任何類型（法人預算書、補捐助彙總表、宣導執行表等）回空陣列。
 */
export function budgetTypes(name) {
  const head = String(name ?? '').split(/決議|檢送/)[0];
  const types = [];
  if (/總(預|決)算(?!案?(附屬單位|追加))/.test(head)) types.push('general');
  if (/附屬單位/.test(head)) types.push('subsidiary');
  if (/特別(預|決)算/.test(head)) types.push('special');
  if (/追加減?(預|決)算/.test(head)) types.push('supplementary');
  return types;
}

/** 民國日期「113/03/07」或「1130307」→ ISO「2024-03-07」；格式不符回 null */
export function rocDate(value) {
  const m = /^(\d{2,3})\/?(\d{2})\/?(\d{2})$/.exec(String(value ?? '').trim());
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

/**
 * 預算中心研究成果：`{ 類型: API 回應 }` → 報告列表。回應是 XML 轉 JSON 的形狀
 * （`BudgetCenterResearch.Category.Report`，只有一筆時不是陣列）。
 */
export function normalizeBudgetReports(responses) {
  const reports = [];
  for (const [type, json] of Object.entries(responses)) {
    const category = json?.BudgetCenterResearch?.Category;
    if (!category) throw new DataValidationError(`預算中心「${type}」回應缺少 Category`);
    const list = category.Report == null ? [] : [].concat(category.Report);
    if (list.length !== Number(category['@RecordCount'] ?? list.length)) {
      throw new DataValidationError(`預算中心「${type}」筆數不符（${list.length}／${category['@RecordCount']}）`);
    }
    for (const r of list) {
      reports.push({
        no: String(r['@ReportNo'] ?? '').trim(),
        type,
        title: String(r.Title ?? '').trim(),
        author: String(r['@Author'] ?? '').trim(),
        completed: String(r['@CompletionDate'] ?? '').slice(0, 10) || null,
        url: r.FilePath || null,
      });
    }
  }
  const items = reports.filter((r) => r.no && r.title);
  if (items.length === 0) throw new DataValidationError('預算中心沒有任何報告');
  return items;
}

/**
 * 委員會登記發言名單（ID223）：姓名以「;」分隔，對到本屆委員 id；對不到的保留姓名並回報。
 */
export function normalizeMeetings(json, legislatorIdByName) {
  const rows = Array.isArray(json?.dataList) ? json.dataList : null;
  if (!rows) throw new DataValidationError('ID223 回應缺少 dataList');
  if (rows.length === 0) throw new DataValidationError('ID223 沒有任何會議');
  // 族語名的分隔符號各系統不一（「‧」「·」或空白），比對時一律去掉
  const key = (name) => String(name).replace(/[\s‧·・．.]/g, '');
  const idByKey = new Map([...legislatorIdByName].map(([name, id]) => [key(name), id]));
  const unmatched = new Set();
  const meetings = rows.map((m) => ({
    date: rocDate(m.smeetingDate),
    committee: String(m.meetingTypeName ?? '').trim(),
    joint: m.jointCommittee && m.jointCommittee !== '無' ? String(m.jointCommittee).trim() : null,
    name: String(m.meetingName ?? '').trim(),
    content: String(m.meetingContent ?? '').trim(),
    speakers: String(m.legislatorNameList ?? '')
      .split(';')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => {
        const id = idByKey.get(key(name)) ?? null;
        if (!id) unmatched.add(name);
        return { name, id };
      }),
  }));
  const warnings = unmatched.size ? [`發言名單有 ${unmatched.size} 個姓名對不到委員：${[...unmatched].slice(0, 5).join('、')}`] : [];
  return { meetings, warnings };
}

const STANDING = ['社會福利及衛生環境', '外交及國防', '教育及文化', '司法及法制', '內政', '經濟', '財政', '交通'];

/**
 * 會議名稱開頭（到第一個「委員會」為止）提到的委員會全名；聯席會議會有多個。
 * 常設委員會以外（程序、全院、紀律、調查委員會…）取開頭整段；沒有委員會開頭（如「一、繼續審查…」）回傳空陣列。
 */
export function committeesOf(text) {
  const head = String(text ?? '').replace(/^委員會紀錄/, '').match(/^(.{0,40}?)委員會/)?.[1] ?? '';
  const standing = STANDING.filter((n) => head.includes(n)).map((n) => `${n}委員會`);
  if (standing.length) return standing;
  // 其餘只收短名稱（程序、全院、調查委員會…），避免把「繼續審查…輔導委員會」這類議程文字當成委員會
  const other = head.replace(/^朝野黨團協商\(?/, '').replace(/^立法院/, '');
  return other.length <= 24 && other && !/[，、。()（）\d]|審查/.test(other) ? [`${other}委員會`] : [];
}

/** g0v 公報議程 → 委員會會議紀錄；只留 `category`（委員會紀錄），連結取公報網、處理後 HTML、完整 PDF */
export function normalizeCommitteeRecords(pages, category) {
  const records = [];
  for (const page of pages) {
    const list = page?.gazetteagendas;
    if (!Array.isArray(list)) throw new DataValidationError('公報議程回應缺少 gazetteagendas');
    for (const a of list) {
      if (Number(a['類別代碼']) !== category) continue;
      const title = String(a['案由'] ?? '').trim();
      const id = String(a['公報議程編號'] ?? '').trim();
      if (!id || !title) continue;
      records.push({
        id,
        date: [].concat(a['會議日期'] ?? []).filter(Boolean).sort().at(-1) ?? null,
        committees: committeesOf(title),
        title,
        gazette_url: a['公報網網址'] || null,
        html_url: [].concat(a['處理後公報網址'] ?? []).find((u) => u?.type === 'html')?.url ?? null,
        pdf_url: a['公報完整PDF網址'] || null,
      });
    }
  }
  if (records.length === 0) throw new DataValidationError('公報議程沒有任何委員會紀錄');
  return records;
}

/**
 * g0v 會議（meets）→ 委員會會議的附件與影片。議事網資料可能分多天，附件依連結去重；
 * `kind` 為 `reply`（機關回覆：部會對委員質詢的書面答復）或 `attachment`（通知單、議事日程、書面報告…）。
 */
export function normalizeCommitteeMeets(pages) {
  const meets = [];
  for (const page of pages) {
    const list = page?.meets;
    if (!Array.isArray(list)) throw new DataValidationError('meets 回應缺少 meets');
    for (const m of list) {
      const code = String(m['會議代碼'] ?? '').trim();
      const days = [].concat(m['議事網資料'] ?? []);
      const title = String(days[0]?.['標題'] ?? m['會議標題'] ?? '').trim();
      if (!code || !title) continue;
      const attachments = new Map();
      for (const d of days)
        for (const a of [].concat(d?.['附件'] ?? []))
          if (a?.['連結'] && !attachments.has(a['連結']))
            attachments.set(a['連結'], { kind: a['種類'] === '機關回覆' ? 'reply' : 'attachment', title: String(a['標題'] ?? '').trim(), url: a['連結'] });
      meets.push({
        code,
        date: [].concat(m['日期'] ?? []).filter(Boolean).sort().at(-1) ?? null,
        title,
        committees: [].concat(m['委員會代號:str'] ?? []).filter(Boolean).length ? [].concat(m['委員會代號:str']).filter(Boolean) : committeesOf(title),
        video_url: days.flatMap((d) => [].concat(d?.['連結'] ?? [])).find((l) => l?.['類型'] === 'video')?.['連結'] ?? null,
        attachments: [...attachments.values()],
      });
    }
  }
  if (meets.length === 0) throw new DataValidationError('meets 沒有任何委員會會議');
  return meets;
}

/** 媒體常用字與立院登記字不同的異體字；遇到新案例再補 */
const NAME_VARIANTS = { 寳: '寶' };

/**
 * 新聞搜尋用的姓名：只取開頭的漢字（「伍麗華Saidhai‧Tahovecahe」→「伍麗華」），再換成媒體常用字。
 * 立院登記名含族語名時，新聞標題幾乎只寫漢名。
 */
export function newsName(name) {
  const han = /^[\u3400-\u9fff\uf900-\ufaff]+/.exec(String(name ?? '').trim())?.[0] ?? String(name ?? '').trim();
  return [...han].map((ch) => NAME_VARIANTS[ch] ?? ch).join('');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeXml = (value) =>
  String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? m;
      return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    })
    .trim();
const tag = (xml, name) => decodeXml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '');

/**
 * Google News RSS → 新聞項目。只保留**標題含委員姓名**的項目：搜尋會命中內文順帶一提的，
 * 標題有名字才算「關於這位委員」，也順便擋掉大部分同名誤判。
 * ponytail: 正規表示式解析 RSS（格式固定、零相依）；來源換成任意 XML 時再換解析器。
 */
export function parseNewsRss(xml, { name }) {
  if (!/<rss[\s>]/.test(String(xml))) throw new DataValidationError('新聞回應不是 RSS');
  const items = [];
  for (const [, body] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const source = tag(body, 'source');
    let title = tag(body, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const url = tag(body, 'link');
    const published = new Date(tag(body, 'pubDate'));
    if (!title.includes(name) || !url || Number.isNaN(published.getTime())) continue;
    items.push({ title, source, url, published_at: published.toISOString() });
  }
  return items;
}

/** RFC 4180 CSV（含引號、跳脫引號、欄位內換行）。ponytail: 資料來源只有這一份試算表，不引入 CSV 套件。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const SOCIAL_COLUMNS = { name: '姓名', pageName: '臉書專頁名稱', latestDate: '最新貼文日期', summary: '最新貼文主題摘要', url: '貼文或粉專連結' };

/**
 * 社群帳號整理表 → [{ legislator_id, platform, page_name, url, latest_post_date, latest_post_summary }]。
 * 以漢名（newsName）對應委員；對不到比例過高或欄位改名時 fail closed。
 */
export function normalizeSocial(csvText, legislatorIdByNewsName) {
  const [header = [], ...rows] = parseCsv(csvText);
  const col = Object.fromEntries(Object.entries(SOCIAL_COLUMNS).map(([key, label]) => [key, header.findIndex((h) => h.trim() === label)]));
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([key]) => SOCIAL_COLUMNS[key]);
  if (missing.length) throw new DataValidationError(`社群整理表缺少欄位：${missing.join('、')}`);
  if (rows.length < 100) throw new DataValidationError(`社群整理表筆數異常（${rows.length} < 100）`);

  const accounts = [];
  const unmatched = [];
  for (const row of rows) {
    const name = (row[col.name] ?? '').trim();
    const url = (row[col.url] ?? '').trim();
    const legislatorId = legislatorIdByNewsName.get(newsName(name));
    if (!legislatorId) {
      unmatched.push(name);
      continue;
    }
    if (!/^https:\/\/(www\.|m\.)?facebook\.com\//.test(url)) continue; // 只收臉書網址，擋掉空白與誤貼
    const date = (row[col.latestDate] ?? '').trim();
    accounts.push({
      legislator_id: legislatorId,
      platform: 'facebook',
      page_name: (row[col.pageName] ?? '').trim(),
      url,
      latest_post_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      latest_post_summary: (row[col.summary] ?? '').trim(),
    });
  }
  if (unmatched.length > rows.length * 0.1) {
    throw new DataValidationError(`社群整理表有 ${unmatched.length} 個姓名對不到委員：${unmatched.slice(0, 5).join('、')}`);
  }
  const warnings = unmatched.length ? [`社群整理表有 ${unmatched.length} 個姓名對不到委員：${unmatched.join('、')}`] : [];
  return { accounts, warnings };
}
