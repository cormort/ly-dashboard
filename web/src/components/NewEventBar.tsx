import { EVENT_KIND_LABEL, eventLabel, type SiteEvent } from '../hooks/useNewEvents';

/**
 * 新事件跑馬燈。
 *
 * 設計取捨：
 *  - **貼在內容區最上面、不是浮在畫面右上角**：內網同事常常是「開著一頁在看」，浮動視窗會蓋住表格；
 *    一行高的東西插在內容前面，捲動時看得到、也不會遮資料。
 *  - **一定要能關**：跑馬燈很吵，看過就該消失（關掉只影響自己這台裝置；游標早就前進了，不會再跳出來）。
 *  - **`prefers-reduced-motion` 就不滾**：改成靜態、可橫向滑的清單。前庭功能敏感的人不少，
 *    一直有東西在跑是會暈的。
 *  - 無縫滾動靠「同一份內容再放一次」＋ `translateX(-50%)`（純 CSS，不用 JS 量寬度）。
 *    重複那一份給 `aria-hidden` 並把連結移出 Tab 順序，鍵盤不會走到兩次。
 *  - 每筆都是連結（會議 → 委員會頁；法案／預算 → 該案），點擊直接跳，不用先關提示。
 */
export function NewEventBar({ items, hidden = 0, onDismiss }: { items: SiteEvent[]; hidden?: number; onDismiss: () => void }) {
  if (!items.length) return null;
  const kinds = [...new Set(items.map((e) => EVENT_KIND_LABEL[e.kind] ?? '新事件'))];
  const row = (dup: boolean) => (
    <ul className={`event-bar-track${dup ? ' event-bar-dup' : ''}`} aria-hidden={dup ? true : undefined}>
      {items.map((e) => (
        <li key={`${dup ? 'dup-' : ''}${e.id}`}>
          <a href={e.url || '#'} title={eventLabel(e)} tabIndex={dup ? -1 : undefined}>
            <span className="event-bar-kind">{EVENT_KIND_LABEL[e.kind] ?? '新事件'}</span>
            <span className="event-bar-title">{e.title || e.ref}</span>
          </a>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="event-bar" role="status" aria-live="polite">
      <p className="event-bar-head">
        <b>🆕 {kinds.join('・')}</b>
        <span>{hidden > 0 ? `顯示 ${items.length} 筆・另有 ${hidden} 筆` : `共 ${items.length} 筆`}</span>
        <button type="button" className="event-bar-close" onClick={onDismiss} aria-label="關閉新事件提示">
          ✕
        </button>
      </p>
      <div className="event-bar-viewport">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
