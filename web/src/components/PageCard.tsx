import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * 第二層頁籤的卡片（手機）。
 *
 * 結構與委員檔案相同（`.overlay` ＋ `aside` ＋ 右上角 X ＋ Esc／點外面關閉），
 * 只是內容換成「整頁」。差別有兩點，都是為了「頁籤留在上面」：
 *   1. 卡片從**次級導覽下面**開始（開 card 時量它的高度），所以那一條頁籤還看得到、
 *      也還能直接點別格換卡片內容（純 CSS 做不到這件事：高度隨字級與寬度變動）。
 *   2. `z-index` 比委員檔案低一級：在卡片裡點委員時，委員檔案要疊在上面，關掉再回到這一張。
 */
export function PageCard({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscapeKey(true, onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 卡片要從哪一條線開始：量次級導覽的高度（量不到就用 CSS 的預設值）
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const row = document.querySelector('.subnav-row');
    if (row) setTop(Math.round(row.getBoundingClientRect().bottom));
  }, []);

  return (
    <div
      className="overlay page-card"
      onClick={onClose}
      style={top === null ? undefined : { top: `${top}px` }}
    >
      <aside role="dialog" aria-modal="true" aria-label={`${title}（在卡片中開啟）`} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-button close" onClick={onClose} aria-label={`關閉${title}`} ref={closeRef}>
          <X aria-hidden="true" />
        </button>
        <h2 className="page-card-title">{title}</h2>
        {children}
      </aside>
    </div>
  );
}
