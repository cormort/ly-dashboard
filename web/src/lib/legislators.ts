import type { Legislator } from '../api/types';

/**
 * 從名錄**列舉**黨籍選項（僅供下拉選單使用）。
 *
 * 這不是「重新聚合」：圖表與統計數字一律用後端算好的 count/total，
 * 這裡只是把後端已經回傳的字串去重，讓使用者有東西可選。
 */
export function deriveParties(items: readonly Legislator[]): string[] {
  return uniqueSorted(items.map((item) => item.party));
}

/** 選區（縣市層級）選項；同樣只列舉後端回傳的 region */
export function deriveRegions(items: readonly Legislator[]): string[] {
  return uniqueSorted(items.map((item) => item.region));
}

function uniqueSorted(values: readonly (string | null | undefined)[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}
