import { useState } from 'react';
import { FONT_SCALES, applyFontScale, loadFontScaleIndex, saveFontScaleIndex } from '../lib/fontScale';

/** 頁首的字體大小調整：A− 縮小、A＋放大，點中間的百分比回到 100%。選擇存在瀏覽器（localStorage）。 */
export function FontSizeControl() {
  const [index, setIndex] = useState(loadFontScaleIndex);

  const change = (next: number) => {
    const clamped = Math.max(0, Math.min(FONT_SCALES.length - 1, next));
    setIndex(clamped);
    applyFontScale(clamped);
    saveFontScaleIndex(clamped);
  };
  const percent = Math.round(FONT_SCALES[index] * 100);

  return (
    <span className="font-size-control" role="group" aria-label="字體大小">
      <button type="button" onClick={() => change(index - 1)} disabled={index === 0} aria-label="縮小字體" title="縮小字體">
        A−
      </button>
      <button type="button" onClick={() => change(1)} aria-label={`目前 ${percent}%，點擊回到 100%`} title="回到標準大小">
        {percent}%
      </button>
      <button type="button" onClick={() => change(index + 1)} disabled={index === FONT_SCALES.length - 1} aria-label="放大字體" title="放大字體">
        A＋
      </button>
    </span>
  );
}
