import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, X } from 'lucide-react';

const ZOOMS = [2, 3, 4];
const LENS_W = 170;
const LENS_H = 120;

/**
 * 手機放大鏡（參考 pdfviewer_v2 的放大鏡）：點頁首的圖示開啟，手指按住頁面移動，
 * 手指上方會浮出一塊鏡片顯示放大後的內容；放開就消失。
 *
 * 做法：開啟時把 #root 複製一份（快照）放進鏡片，用 CSS transform 放大並對準手指的位置。
 * 只複製一次、之後只改 transform，所以移動很順；缺點是 canvas／iframe（例如臉書嵌入）在鏡片裡是空的。
 * 開啟期間由透明蓋板接手觸控（頁面不會捲動、也不會誤點連結），再點一次圖示或 ✕ 關閉。
 */
export function Magnifier() {
  const [on, setOn] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const lensRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const zoom = ZOOMS[zoomIndex];
  const scrollY = useRef(0);

  // 開啟時拍快照：清掉 id（避免重複）並設成 inert，鏡片裡的東西不能互動
  useEffect(() => {
    if (!on) return;
    const root = document.getElementById('root');
    const inner = innerRef.current;
    if (!root || !inner) return;
    const clone = root.cloneNode(true) as HTMLElement;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.setAttribute('inert', '');
    inner.replaceChildren(clone);
    inner.style.width = `${root.clientWidth}px`;
    scrollY.current = window.scrollY;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOn(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);

  const show = (x: number, y: number) => {
    const lens = lensRef.current;
    const inner = innerRef.current;
    if (!lens || !inner) return;
    // 鏡片放在手指上方；太靠近螢幕上緣就改放下方
    const left = Math.max(8, Math.min(window.innerWidth - LENS_W - 8, x - LENS_W / 2));
    const top = y - LENS_H - 28 >= 8 ? y - LENS_H - 28 : y + 28;
    lens.style.display = 'block';
    lens.style.left = `${left}px`;
    lens.style.top = `${top}px`;
    // 手指位置（頁面座標）要落在鏡片中心：point * zoom + translate = 鏡片尺寸 / 2
    inner.style.transform = `translate(${LENS_W / 2 - x * zoom}px, ${LENS_H / 2 - (y + scrollY.current) * zoom}px) scale(${zoom})`;
  };
  const hide = () => {
    if (lensRef.current) lensRef.current.style.display = 'none';
  };

  return (
    <>
      <button
        type="button"
        className="icon-button magnifier-toggle"
        aria-pressed={on}
        title={on ? '關閉放大鏡' : '放大鏡'}
        onClick={() => setOn((value) => !value)}
      >
        <ZoomIn aria-hidden="true" />
        <span className="sr-only">{on ? '關閉放大鏡' : '開啟放大鏡'}</span>
      </button>
      {on
        ? createPortal(
            <>
              <div
                className="magnifier-catcher"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  show(event.clientX, event.clientY);
                }}
                onPointerMove={(event) => event.buttons !== 0 && show(event.clientX, event.clientY)}
                onPointerUp={hide}
                onPointerCancel={hide}
              />
              <div className="magnifier-lens" ref={lensRef} style={{ width: LENS_W, height: LENS_H }} aria-hidden="true">
                <div className="magnifier-inner" ref={innerRef} />
              </div>
              <div className="magnifier-bar" role="group" aria-label="放大鏡">
                <span>按住頁面移動</span>
                <button type="button" onClick={() => setZoomIndex((zoomIndex + 1) % ZOOMS.length)} aria-label={`目前 ${zoom} 倍，點擊切換倍率`}>
                  {zoom}×
                </button>
                <button type="button" onClick={() => setOn(false)} aria-label="關閉放大鏡">
                  <X aria-hidden="true" />
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
