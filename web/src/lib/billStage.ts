/**
 * 議案狀態 → 立法流程階段。資料只有「目前狀態」與最新進度日期，沒有逐階段的歷史日期，
 * 所以這裡只標出走到哪一步，不假造各階段時間。
 */
export const BILL_STAGES = ['提案', '委員會審查', '審查完畢', '院會／協商', '三讀'] as const;

export interface BillStage {
  /** 目前所在階段（0–4）；撤案等終止狀態為停下前的最後一步 */
  index: number;
  /** 撤回、退回等中止狀態 */
  stopped: boolean;
}

const STAGE_BY_STATUS: Record<string, BillStage> = {
  交付審查: { index: 1, stopped: false },
  改交其他委員會審查: { index: 1, stopped: false },
  重付審查: { index: 1, stopped: false },
  交付處理: { index: 1, stopped: false },
  排入程序: { index: 0, stopped: false },
  審查完畢: { index: 2, stopped: false },
  '審查完畢(逾審查期限)': { index: 2, stopped: false },
  排入院會: { index: 3, stopped: false },
  '排入院會(討論事項)': { index: 3, stopped: false },
  '逕付二讀(交付協商)': { index: 3, stopped: false },
  '委員會抽出逕付二讀(交付協商)': { index: 3, stopped: false },
  復議: { index: 3, stopped: false },
  三讀: { index: 4, stopped: false },
  '審查完畢(三讀)': { index: 4, stopped: false },
  照案通過: { index: 4, stopped: false },
  同意撤回: { index: 0, stopped: true },
  撤案: { index: 0, stopped: true },
  退回程序委員會: { index: 0, stopped: true },
};

/** 對不到的狀態（例如「交付查照」這類非法律案）回 null，不畫流程 */
export function billStage(status: string): BillStage | null {
  return STAGE_BY_STATUS[status] ?? null;
}

/**
 * 「已三讀」的狀態集合：總覽的統計卡與法案頁的統計列都用這一份，
 * 唯一定義處（以前兩頁各有一份 new Set，新增狀態時只會改到一邊）。
 */
export const PASSED_STATUSES: ReadonlySet<string> = new Set(['三讀', '審查完畢(三讀)', '照案通過']);
