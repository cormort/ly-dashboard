/**
 * 黨籍的顯示規則。整個介面「顏色只代表黨籍」：其餘元素一律用墨色與灰階，
 * 所以這裡是唯一定義彩色的地方。顏色取台灣政治的慣用色，並加深到可當文字使用（對白底 ≥ 4.5:1）。
 */
export interface PartyStyle {
  /** 表格與席次圖圖例用的簡稱 */
  short: string;
  color: string;
  /** 席次圖由左到右的排列順序 */
  order: number;
}

const PARTIES: Record<string, PartyStyle> = {
  民主進步黨: { short: '民進黨', color: '#1E7F45', order: 0 },
  台灣民眾黨: { short: '民眾黨', color: '#137A77', order: 1 },
  無黨籍: { short: '無黨籍', color: '#6B7480', order: 2 },
  中國國民黨: { short: '國民黨', color: '#1F5AA6', order: 3 },
};

const OTHER: PartyStyle = { short: '其他', color: '#6B7480', order: 9 };

export function partyStyle(party: string | null | undefined): PartyStyle {
  const name = party?.trim() ?? '';
  return PARTIES[name] ?? { ...OTHER, short: name || OTHER.short };
}

/** 依席次圖順序排序黨籍名稱 */
export function sortParties(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => partyStyle(a).order - partyStyle(b).order || a.localeCompare(b, 'zh-Hant'));
}
