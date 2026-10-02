import { useState } from 'react';

export interface FacetChipsProps {
  items: { name: string; count: number }[];
  /** 無障礙名稱，例如「最常出現的機關」 */
  label: string;
  onPick: (name: string) => void;
  /** 收合時顯示幾個；預設 12 */
  collapsedCount?: number;
}

/** 常見項目標籤：預設只顯示最前面幾個，其餘收在「更多」後面，避免標籤把頁面主要內容擠到畫面下方 */
export function FacetChips({ items, label, onPick, collapsedCount = 12 }: FacetChipsProps) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const hidden = items.length - collapsedCount;
  const shown = open || hidden <= 0 ? items : items.slice(0, collapsedCount);
  return (
    <div className="law-facets" aria-label={label}>
      {shown.map((f) => (
        <button key={f.name} type="button" className="chip" onClick={() => onPick(f.name)}>
          {f.name} <span className="muted">{f.count}</span>
        </button>
      ))}
      {hidden > 0 ? (
        <button type="button" className="chip facet-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '收合' : `更多 ${hidden}`}
        </button>
      ) : null}
    </div>
  );
}
