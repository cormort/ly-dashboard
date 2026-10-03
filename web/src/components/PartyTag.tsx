import type { CSSProperties } from 'react';
import { partyStyle } from '../lib/parties';

/** 黨籍標籤：顏色只代表黨籍，全站唯一的色彩來源是 lib/parties.ts */
export function PartyTag({ party }: { party: string }) {
  const style = partyStyle(party);
  return (
    <span className="party-tag" style={{ '--party': style.color } as CSSProperties}>
      {style.short}
    </span>
  );
}
