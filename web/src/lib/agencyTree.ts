/**
 * 機關的瀏覽樹：五院 → 行政院所屬一級部會 → 所屬機關。
 *
 * 為什麼不做成「355 筆的選單」：使用者的原話是「這樣會不會要滾很久」「下方列出 5 院，
 * 行政院下各一級部會，可以收合避免佔位」。搜尋解決「知道要打什麼」的情境，樹解決
 * 「我只知道它在哪個部底下」的情境（例如要找「國稅局」，從財政部進去最快）。
 *
 * 分類規則是**名稱比對**，不是猜的：
 *  - 一級部會名單寫死在 `EXECUTIVE_UNITS`（行政院組織法現況；組改後的舊名不在這裡，舊名由 server 正規化）。
 *  - 一個機關若「開頭就是某個一級部會名」→ 歸在該部會底下（`財政部北區國稅局` → 財政部）；最長前綴優先
 *    （`國家科學及技術委員會` 不能被 `國家發展委員會` 之類的短名前綴吃掉）。
 *  - 名稱以「行政院」開頭但對不到部會（`行政院主計總處`、`行政院公共工程委員會`）→ 歸「行政院（直屬）」。
 *  - 四個院只放院本身與其少數所屬（司法院／考試院／監察院），其餘歸「其他」（大學、基金、民營化事業…）。
 *  - 都對不到的進「其他」——**不要丟掉**，寧可放在最後一個分组，也不要在選單裡找不到。
 */
export const YUAN_ORDER = ['行政院', '立法院', '司法院', '考試院', '監察院', '其他'] as const;
export type YuanKey = (typeof YUAN_ORDER)[number];

/** 行政院所屬一級機關（含相當部會之委員會／總處／直屬機關） */
export const EXECUTIVE_UNITS: readonly string[] = [
  '內政部',
  '外交部',
  '國防部',
  '財政部',
  '教育部',
  '法務部',
  '經濟部',
  '交通部',
  '勞動部',
  '農業部',
  '衛生福利部',
  '環境部',
  '文化部',
  '數位發展部',
  '國家發展委員會',
  '國家科學及技術委員會',
  '大陸委員會',
  '金融監督管理委員會',
  '海洋委員會',
  '僑務委員會',
  '國軍退除役官兵輔導委員會',
  '客家委員會',
  '原住民族委員會',
  '運動部',
  '核能安全委員會',
  '公共工程委員會',
  '中央選舉委員會',
  '公平交易委員會',
  '國家通訊傳播委員會',
  '不當黨產處理委員會',
  '國家運輸安全調查委員會',
  '中央銀行',
  '國立故宮博物院',
  '中央研究院',
  '行政院主計總處',
  '行政院人事行政總處',
];

/** 其他四個院自己所屬（只列這個站真的會出現的） */
const OTHER_YUAN_UNITS: Record<string, readonly string[]> = {
  立法院: [],
  司法院: ['最高法院', '最高行政法院', '懲戒法院', '臺灣高等法院', '司法院'],
  考試院: ['考選部', '銓敘部', '公務人員保障暨培訓委員會', '公務人員退休撫卹基金管理局'],
  監察院: ['審計部', '國家人權委員會'],
};

export interface AgencyUnit {
  /** 一級部會名（或該院本身、直屬機關） */
  name: string;
  /** 這個部會本身＋所屬機關（含部會自己，已排序、已去重） */
  items: string[];
}

export interface AgencyYuan {
  yuan: YuanKey;
  /** 一級部會（可收合的第二層） */
  units: AgencyUnit[];
  /** 不屬於任何一級部會的（行政院直屬、院本身、其他） */
  loose: string[];
  /** 這個院底下總共幾個機關（＝units 全部 items ＋ loose） */
  count: number;
}

const sortZh = (a: string, b: string) => a.localeCompare(b, 'zh-Hant');

/** 一級部會的顯示順序：部 → 委員會 → 總處／其他直屬（同類再照筆畫） */
export function unitRank(name: string): number {
  if (/部$/.test(name)) return 0;
  if (/委員會$/.test(name)) return 1;
  if (/總處$|總局$|銀行$|博物院$|研究院$/.test(name)) return 2;
  return 3;
}

/** 依名稱長度由長到短，讓「最長前綴優先」自然成立 */
const byLengthDesc = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length || sortZh(a, b));

const EXEC_BY_LEN = byLengthDesc(EXECUTIVE_UNITS);
const OTHER_BY_YUAN = Object.fromEntries(
  Object.entries(OTHER_YUAN_UNITS).map(([yuan, units]) => [yuan, byLengthDesc(units)]),
) as Record<string, string[]>;

/**
 * 把機關清單分成「院 → 一級部會 → 機關」。
 * 回傳的 `count` 加總必須等於傳入的機關數（測試釘住），否則就是有機關被吃掉。
 */
export function buildAgencyTree(names: readonly string[]): AgencyYuan[] {
  const assigned = new Map<YuanKey, { units: Map<string, string[]>; loose: string[] }>();
  for (const yuan of YUAN_ORDER) assigned.set(yuan, { units: new Map(), loose: [] });

  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    // 1) 行政院所屬一級部會（最長前綴）
    const exec = EXEC_BY_LEN.find((unit) => name === unit || name.startsWith(unit));
    if (exec) {
      const bucket = assigned.get('行政院')!;
      const items = bucket.units.get(exec) ?? [];
      items.push(name);
      bucket.units.set(exec, items);
      continue;
    }
    // 2) 國立學校：主管機關是教育部（名稱不會以「教育部」開頭，不處理就會掉進「其他」187 筆裡）
    if (/^國立.*(大學|學院|科技大學|專科學校|高級中學|實驗學校)$/.test(name)) {
      const bucket = assigned.get('行政院')!;
      const items = bucket.units.get('教育部') ?? [];
      items.push(name);
      bucket.units.set('教育部', items);
      continue;
    }
    // 3) 以「行政院」開頭但不是部會 → 行政院直屬
    if (name.startsWith('行政院')) {
      assigned.get('行政院')!.loose.push(name);
      continue;
    }
    // 4) 其他四院：院本身或所屬（最長前綴）
    let placed = false;
    for (const yuan of ['立法院', '司法院', '考試院', '監察院'] as const) {
      if (name === yuan) {
        assigned.get(yuan)!.loose.push(name);
        placed = true;
        break;
      }
      const unit = OTHER_BY_YUAN[yuan].find((u) => name === u || name.startsWith(u));
      if (unit) {
        const bucket = assigned.get(yuan)!;
        const items = bucket.units.get(unit) ?? [];
        items.push(name);
        bucket.units.set(unit, items);
        placed = true;
        break;
      }
    }
    if (placed) continue;
    // 5) 其他（基金、公司、地方機關…）：不丟掉，放最後一組
    assigned.get('其他')!.loose.push(name);
  }

  return YUAN_ORDER.map((yuan) => {
    const bucket = assigned.get(yuan)!;
    const units = [...bucket.units.entries()]
      .map(([name, items]) => ({ name, items: items.sort(sortZh) }))
      // 部（14 個）先、委員會次之、總處等直屬最後，同類再照筆畫 —— 直接照名字排會把「內政部」排到
      // 「中央選舉委員會」後面，看起來像沒有分類
      .sort((a, b) => unitRank(a.name) - unitRank(b.name) || sortZh(a.name, b.name));
    const loose = bucket.loose.sort(sortZh);
    const count = units.reduce((sum, u) => sum + u.items.length, 0) + loose.length;
    return { yuan, units, loose, count };
  }).filter((group) => group.count > 0);
}
