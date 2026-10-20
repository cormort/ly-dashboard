/**
 * 會議預告：立法院議事轉播（IVOD）的「會議預報」頁。
 *
 * 為什麼要另外抓：g0v meets 也有未來場次（我們的 `committee_meets` 已經存到），但
 *  - IVOD 的預報多「會議室」與「會議相關資料」連結（連到 ppg 的開會通知／議程）
 *  - 兩個來源的預告範圍其實一樣（實測都只到下週，2–7 天），因為委員會的開會通知本來就是逐週排
 *
 * 頁面是伺服器端渲染的 HTML（約 150 KB），不是 API，所以用固定的 regex 抓：
 *
 *   <div class="forecast-list">
 *     <h4><i class="icon-20-hammer"></i>內政委員會</h4>
 *     <ul>
 *       <li>
 *         <p class="info">
 *           <span class="time">2026-10-21 09:00</span>
 *           <span class="place">紅樓202會議室</span>
 *           <span class="status">會議尚未開始</span>
 *           <a href="https://ppg.ly.gov.tw/...">會議相關資料</a>
 *         </p>
 *         <p class="text" title="第11屆…（事由：…）">第11屆…（事由：…）</p>
 *
 * 抓不到就回空陣列（不要讓預告把整個同步階段弄失敗）；`parseForecastHtml` 是純函式，測試直接餵 HTML。
 */

export const FORECAST_URL = 'https://ivod.ly.gov.tw/Forecast';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 只處理 HTML 文字裡常見的實體，夠用就好 */
export function decodeEntities(input = '') {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

const stripTags = (html = '') => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 「第11屆第6會期內政委員會第3次全體委員會議（事由：一、…）」→ 名稱＋事由 */
export function splitTitleAndAgenda(text = '') {
  const value = String(text ?? '').trim();
  const at = value.indexOf('（事由：');
  if (at < 0) return { title: value, agenda: '' };
  const title = value.slice(0, at).trim();
  let agenda = value.slice(at + '（事由：'.length);
  if (agenda.endsWith('）')) agenda = agenda.slice(0, -1);
  return { title, agenda: agenda.trim() };
}

/**
 * 解析「會議預報」頁：回傳每一場（依 h4 的主辦單位分組）。
 * 回傳 [{ date, time, committee, place, status, title, agenda, materials_url }]
 */
export function parseForecastHtml(html = '') {
  const page = String(html ?? '');
  // 頁面有「依主辦單位」與「依日期」兩份清單（同 19 場，JS 切換顯示）。
  // 只取「依主辦單位」那一份：依日期的清單沒有逐委員會的 h4，硬解析會把整份都歸給第一個委員會。
  const start = page.indexOf('id="forecast_list_comt"');
  const end = page.indexOf('id="forecast_list_date"');
  const source = start >= 0 ? page.slice(start, end > start ? end : undefined) : page;
  const heads = [...source.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)].map((m) => ({ index: m.index ?? 0, committee: stripTags(m[1]) }));
  if (!heads.length) return [];
  const items = [];
  heads.forEach((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : source.length;
    const chunk = source.slice(head.index, end);
    for (const li of chunk.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const block = li[1];
      const stamp = /<span class="time"[^>]*>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*([0-9]{2}:[0-9]{2})?\s*</.exec(block);
      if (!stamp) continue; // 沒有時間的不是會議（例如版權列）
      const place = /<span class="place"[^>]*>([\s\S]*?)<\/span>/.exec(block);
      const status = /<span class="status"[^>]*>([\s\S]*?)<\/span>/.exec(block);
      const materials = /href="([^"]*ppg\.ly\.gov\.tw[^"]*)"/.exec(block);
      // 事由全文在 <p class="text" title="…">，沒有 title 就取標籤間的文字
      const textAttr = /<p class="text"[^>]*title="([\s\S]*?)"/.exec(block);
      const textBody = textAttr ? textAttr[1] : (/<p class="text"[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '');
      const { title, agenda } = splitTitleAndAgenda(stripTags(textBody));
      items.push({
        date: stamp[1],
        time: stamp[2] ?? '',
        committee: head.committee,
        place: place ? stripTags(place[1]) : '',
        status: status ? stripTags(status[1]) : '',
        title,
        agenda,
        materials_url: materials ? decodeEntities(materials[1]) : '',
      });
    }
  });
  // 頁面同時有「依主辦單位」與「依日期」兩份清單（JavaScript 切換），內容會重複；
  // 以「日期＋時間＋主辦單位＋會議名稱」去重
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.date}|${item.time}|${item.committee}|${item.title}|${item.place}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 未來的會議（含今天），依日期與時間排。
 * `days` 只影響回傳範圍，不影響資料庫內容（同步時整批覆寫，只留頁面上有的場次）。
 */
/**
 * 把 g0v meets 的未來場次併進來：IVOD 的預報以「委員會」為主，院會與部分公聽會不在上面，
 * 但 `committee_meets` 有（`time_range`／`location` 從 2026-10-20 起才有值）。
 * 同一場（同一天、同一個會議名稱開頭）只留 IVOD 那筆，因為它多了會議相關資料連結。
 */
export function mergePlenaryForecasts(db, items, { today = '', days = 10 } = {}) {
  const start = today || new Date().toLocaleDateString('sv-SE');
  const until = new Date(new Date(`${start}T00:00:00Z`).getTime() + Math.max(1, Number(days) || 10) * 86_400_000).toISOString().slice(0, 10);
  const existing = new Set(items.map((i) => `${i.date}|${String(i.title).slice(0, 12)}`));
  const rows = db
    .prepare('SELECT code, date, title, time_range, location, video_url FROM committee_meets WHERE date >= ? AND date <= ? ORDER BY date')
    .all(start, until);
  const extra = [];
  for (const row of rows) {
    const key = `${row.date}|${String(row.title).slice(0, 12)}`;
    if (existing.has(key)) continue;
    existing.add(key);
    // 「115/10/22 09:00-17:30」→ 時間 09:00；只有日期就留空
    const time = /(\d{1,2}:\d{2})/.exec(String(row.time_range ?? ''))?.[1] ?? '';
    extra.push({
      date: row.date,
      time,
      committee: /^院會-/.test(String(row.code ?? '')) || String(row.title).includes('院會') ? '院會' : '',
      place: row.location ?? '',
      status: '',
      title: row.title,
      agenda: '',
      materials_url: '',
      video_url: row.video_url ?? '',
      source: 'g0v',
    });
  }
  return extra;
}

/** 兩次同步之間的差異：新排定的場次（整批覆寫前後比對用） */
export function diffForecasts(before = [], after = []) {
  const key = (r) => `${r.date}|${r.time}|${r.committee}|${r.title}`;
  const seen = new Set(before.map(key));
  return after.filter((r) => !seen.has(key(r)));
}

/** 新增預告的推播文字（給 ingest 的 Telegram 通知用） */
export function newForecastText(added = [], { max = 8 } = {}) {
  if (!added.length) return '';
  const lines = [`📅 新增會議預告 ${added.length} 場`];
  for (const m of added.slice(0, max)) {
    const when = `${m.date.slice(5).replace('-', '/')} ${m.time}`.trim();
    const where = [m.committee, m.place].filter(Boolean).join('・');
    lines.push(`${when} ${where ? `｜${where}` : ''}`.trim());
    if (m.title) lines.push(`　${String(m.title).slice(0, 40)}`);
  }
  if (added.length > max) lines.push(`　…還有 ${added.length - max} 場`);
  return lines.join('\n');
}

export function listUpcomingMeetings(db, { days = 10, limit = 80, today = '' } = {}) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(today)) ? String(today) : new Date().toLocaleDateString('sv-SE');
  const until = new Date(`${start}T00:00:00Z`).getTime() + Math.max(1, Number(days) || 10) * 86_400_000;
  const untilDay = new Date(until).toISOString().slice(0, 10);
  const rows = db
    .prepare('SELECT date, time, committee, place, status, title, agenda, materials_url FROM meeting_forecasts WHERE date >= ? AND date <= ? ORDER BY date, time, committee')
    .all(start, untilDay);
  const base = rows.map((r) => ({ ...r, video_url: '', source: 'ivod' }));
  const merged = [...base, ...mergePlenaryForecasts(db, base, { today: start, days })].sort(
    (a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)),
  );
  const items = merged.slice(0, Math.max(1, Number(limit) || 80)).map((r) => ({ ...r }));
  const dates = [];
  for (const row of merged) {
    const last = dates.at(-1);
    if (last && last.date === row.date) last.count += 1;
    else dates.push({ date: row.date, count: 1 });
  }
  return { today: start, days: Math.max(1, Number(days) || 10), total: merged.length, dates, items };
}
