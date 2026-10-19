import { useEffect, type RefObject } from 'react';

/**
 * 瀑布流排版：CSS Grid 逐列填滿（閱讀順序＝由左到右、由上到下），卡片高度不一致
 * 時靠 JS 量高度設 `grid-row-end` 的 span 補齊。
 *
 * 為什麼不用 CSS multi-column（原本的做法）：multi-column 是「由上往下填滿第一欄
 * 才換第二欄」，87 張卡片時最新的 29 位全擠在最左那一欄 —— 看起來像「最左一欄才是
 * 最新的」。Grid 逐列填，第 1 列就是最新那幾位，往下才是舊的。
 *
 * 用法：
 *   const ref = useRef<HTMLUListElement>(null);
 *   useMasonry(ref, { deps: [items.length] });
 *   <ul className="fb-wall" ref={ref}>…</ul>
 *
 * CSS 端要配合：`display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));`
 * 加 `grid-auto-rows: 8px`（＝這裡的 rowUnit），gap 由 CSS 決定、這裡會自己量。
 *
 * @param containerRef grid 容器的 ref
 * @param options.rowUnit grid-auto-rows 的 px 值（要和 CSS 寫的一致，預設 8）
 * @param options.deps    內容／篩選改變時重新量測
 */
export function useMasonry(
  containerRef: RefObject<HTMLElement | null>,
  { rowUnit = 8, deps = [] as unknown[] }: { rowUnit?: number; deps?: unknown[] } = {},
) {
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;

    const children = () => [...root.children] as HTMLElement[];
    let frame = 0;

    /** 一輪量測：先把 span 歸零（否則只會愈長愈長），再依實際高度設回去 */
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rowGap = Number.parseFloat(getComputedStyle(root).rowGap) || 0;
        // 每一列實際佔用的高度＝grid-auto-rows ＋ row-gap，所以 span 要用同一個單位算
        const unit = rowUnit + rowGap;
        for (const el of children()) {
          el.style.gridRowEnd = 'auto';
          const height = el.getBoundingClientRect().height;
          el.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + rowGap) / unit))}`;
        }
      });
    };

    // 卡片高度會自己變：視窗縮放（欄數改變）、字型載入、使用者展開內容
    const observer = new ResizeObserver(layout);
    for (const el of children()) observer.observe(el);
    window.addEventListener('resize', layout);
    layout();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', layout);
    };
  }, [containerRef, rowUnit, ...deps]);
}
