import { useState, type CSSProperties } from 'react';
import { colorAt, gradient, type ScaleName } from '../lib/colorScales';

/**
 * 面量圖：顏色代表數值（連續色階），滑過或點選顯示數值；金門、連江在左上插圖框。
 * items 的 county 是區塊的鍵與顯示名稱（縣市圖為縣市名，鄉鎮圖為「縣市＋鄉鎮」）。
 */
export function ChoroplethMap({
  items,
  values,
  scale,
  title,
  format,
  diverging = false,
  selected,
  onSelect,
  viewBox = '0 0 530 735',
  outlines = [],
  strokeWidth = 0.8,
}: {
  items: { county: string; path: string }[];
  values: Map<string, number | null>;
  scale: ScaleName;
  title: string;
  format: (value: number | null) => string;
  /** 以 0 為中點的發散色階（時間差異） */
  diverging?: boolean;
  selected?: string;
  onSelect?: (county: string) => void;
  /** 只看某縣市時放大到該範圍 */
  viewBox?: string;
  /** 疊在上方、不上色的外框（例如鄉鎮圖上的縣市界） */
  outlines?: string[];
  strokeWidth?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // 只採計「有限的數字」：undefined（Map 沒有這個鍵、或資料檔少了欄位）與 NaN（除以 0、
  // 基期缺值）都會讓 Math.min/Math.max 變成 NaN，色階算出來是 NaN，而 NaN 進到 CSS fill
  // 會被瀏覽器直接忽略 —— 整張圖沒有顏色，且不會有任何錯誤訊息。
  const nums = [...values.values()].filter((v): v is number => Number.isFinite(v));
  let min = nums.length ? Math.min(...nums) : 0;
  let max = nums.length ? Math.max(...nums) : 0;
  if (diverging) {
    const m = Math.max(Math.abs(min), Math.abs(max)) || 1;
    [min, max] = [-m, m];
  }
  const t = (v: number) => (max === min ? 1 : (v - min) / (max - min));
  const focus = hover ?? selected ?? null;
  return (
    <figure className="stat-map">
      <figcaption>{title}</figcaption>
      <svg viewBox={viewBox} role="group" aria-label={title} style={{ '--map-stroke': strokeWidth } as CSSProperties}>
        {/* 金門、連江的插圖框 */}
        <rect className="county-inset" x="22" y="4" width="128" height="112" rx="6" />
        <rect className="county-inset" x="3" y="166" width="66" height="54" rx="6" />
        {items.map((c) => {
          const raw = values.get(c.county);
          const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
          const label = `${c.county}：${format(v)}`;
          return (
            <path
              key={c.county}
              d={c.path}
              className="county-shape"
              aria-current={c.county === selected ? 'true' : undefined}
              style={{ fill: v === null ? 'var(--seat-off)' : colorAt(scale, t(v)) }}
              tabIndex={0}
              role="button"
              aria-label={label}
              onMouseEnter={() => setHover(c.county)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(c.county)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect?.(c.county)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect?.(c.county);
                }
              }}
            >
              <title>{label}</title>
            </path>
          );
        })}
        {outlines.map((d, i) => (
          <path key={i} d={d} className="map-outline" />
        ))}
        <text x="26" y="134" className="county-inset-label">連江縣</text>
        <text x="6" y="238" className="county-inset-label">金門縣</text>
      </svg>
      <p className="stat-map-hover" aria-live="polite">
        {focus ? (
          <>
            <b>{focus}</b>　{format(values.get(focus) ?? null)}
          </>
        ) : (
          <span className="muted">滑過或點選地圖看數值</span>
        )}
      </p>
      {nums.length ? (
        <div className="stat-legend">
          <span>{format(min)}</span>
          <i style={{ background: gradient(scale) }} aria-hidden="true" />
          <span>{format(max)}</span>
        </div>
      ) : null}
    </figure>
  );
}
