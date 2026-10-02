import { readPreference, writePreference } from './storage';

/** 字體大小倍率：整站型級（styles.css 的 --fs-*）都乘上 --fs-scale */
export const FONT_SCALES = [0.9, 1, 1.15, 1.3, 1.5] as const;
export const DEFAULT_FONT_SCALE_INDEX = 1;
const PREF_KEY = 'font-scale';

export function loadFontScaleIndex(): number {
  const index = FONT_SCALES.findIndex((value) => String(value) === readPreference(PREF_KEY));
  return index === -1 ? DEFAULT_FONT_SCALE_INDEX : index;
}

export function applyFontScale(index: number): void {
  const value = FONT_SCALES[index] ?? FONT_SCALES[DEFAULT_FONT_SCALE_INDEX];
  document.documentElement.style.setProperty('--fs-scale', String(value));
}

export function saveFontScaleIndex(index: number): void {
  writePreference(PREF_KEY, String(FONT_SCALES[index] ?? FONT_SCALES[DEFAULT_FONT_SCALE_INDEX]));
}
