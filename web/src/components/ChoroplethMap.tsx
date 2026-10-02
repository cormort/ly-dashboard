import { useState } from 'react';
import type { CountyItem } from '../api/types';
import { colorAt, gradient, type ScaleName } from '../lib/colorScales';

/** 縣市面量圖：顏色代表數值（連續色階），滑過或點選顯示數值；金門、連江在左上插圖框 */
export function ChoroplethMap({
  items,
  values,
  scale,
  title,
  format,
  diverging = false,
  selected,
  onSelect,
}: {
  items: CountyItem[];
  values: Map<string, number | null>;
  scale: ScaleName;
  title: string;
  format: (value: number | null) => string;
  /** 以 0 為中點的發散色階（時間差異） */
  diverging?: boolean;
  selected?: string;
  onSelect?: (county: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const nums = [...values.values()].filter((v): v is number => v !== null);
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (diverging) {
    const m = Math.max(Math.abs(min), Math.abs(max)) || 1;
    [min, max] = [-m, m];
  }
  const t = (v: number) => (max === min ? 1 : (v - min) / (max - min));
  const focus = hover ?? selected ?? null;
  return (
    <figure className="stat-map">
      <figcaption>{title}</figcaption>
      <svg viewBox="0 0 530 735" role="group" aria-label={title}>
        {/* 金門、連江的插圖框 */}
        <rect className="county-inset" x="22" y="4" width="128" height="112" rx="6" />
        <rect className="county-inset" x="3" y="166" width="66" height="54" rx="6" />
        {items.map((c) => {
          const v = values.get(c.county) ?? null;
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
        <text x="26" y="134" className="county-inset-label">連江縣</text>
        <text x="6" y="238" className="county-inset-label">金門縣</text>
      </svg>
      <p className="stat-map-hover" aria-live="polite">
        {focus ? (
          <>
            <b>{focus}</b>　{format(values.get(focus) ?? null)}
          </>
        ) : (
          <span className="muted">滑過或點選縣市看數值</span>
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
