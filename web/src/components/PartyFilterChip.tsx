import { X } from 'lucide-react';

/**
 * 「目前只看某個黨」的可移除膠囊。
 *
 * 為什麼要有這一顆：黨籍篩選只在席次圖圖例上切換，而圖例在名錄上方。
 * 手機點完圖例之後畫面會捲到名錄（見 lib/scroll.ts），圖例就離開視野了 ——
 * 沒有這一顆，使用者看不到「現在被篩了什麼」，也無法一眼取消（要滑回上面再點一次）。
 */
export function PartyFilterChip({ party, onClear }: { party: string; onClear: () => void }) {
  return (
    <div className="active-filter">
      <button type="button" className="chip" onClick={onClear} aria-label={`清除只看${party}`}>
        只看{party}
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
