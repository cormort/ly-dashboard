import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * 頁面標題＋說明提示。原本標題下方的一段介紹改成收在 ⓘ 裡：滑鼠移到標題或圖示上、鍵盤聚焦、
 * 或手指點圖示（平板沒有 hover）都會顯示；再點一次、點別處或按 Esc 關閉。
 * 說明文字一直在 DOM 裡（只是看不見），讀螢幕程式透過 aria-describedby 仍然讀得到。
 */
export function PageTitle({ title, children }: { title: ReactNode; children: ReactNode }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || focus || pinned;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPinned(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pinned]);

  // 只有滑鼠才用 hover：觸控點一下會補發 mouseenter 卻不會有 mouseleave，提示會卡住關不掉
  const mouseOnly = (value: boolean) => (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') setHover(value);
  };

  return (
    <div
      ref={root}
      className="page-title"
      onPointerEnter={mouseOnly(true)}
      onPointerLeave={mouseOnly(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPinned(false);
          setHover(false);
          setFocus(false);
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
      }}
    >
      <h1>{title}</h1>
      <button
        type="button"
        className="icon-button info-button"
        aria-label="說明"
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setPinned((v) => !v)}
        // 只有鍵盤聚焦才顯示；滑鼠／觸控點擊也會讓按鈕取得焦點，若也算進去，再點一次就關不掉
        onFocus={(event) => setFocus(event.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocus(false)}
      >
        <Info aria-hidden="true" />
      </button>
      <div id={id} role="tooltip" className={open ? 'info-tip open' : 'info-tip'}>
        {children}
      </div>
    </div>
  );
}
