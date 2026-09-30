import { useMemo, type CSSProperties } from 'react';
import type { Legislator } from '../api/types';
import { partyStyle, sortParties } from '../lib/parties';

export interface HemicycleProps {
  /** 該會期完整名單（決定席次數與黨籍分布） */
  roster: readonly Legislator[];
  /** 符合目前篩選條件的委員 id；null 代表沒有篩選（全部亮） */
  matching: ReadonlySet<string> | null;
  /** 目前選取的黨籍（圖例按鈕的按下狀態） */
  party: string | null;
  onPartyToggle: (party: string) => void;
  onOpen: (legislator: Legislator) => void;
}

interface Seat {
  x: number;
  y: number;
  angle: number;
}

const ROWS = 6;
const INNER = 0.42;

/**
 * 半圓議場席次：各排座位數與半徑成正比，座位依角度由左到右排序後依黨籍填入，
 * 同黨委員因此形成扇形區塊（與常見的議會席次圖相同，不是實際座位）。
 */
export function seatLayout(total: number): Seat[] {
  const radii = Array.from({ length: ROWS }, (_, i) => INNER + ((1 - INNER) * i) / (ROWS - 1));
  const sum = radii.reduce((a, b) => a + b, 0);
  const counts = radii.map((r) => Math.floor((total * r) / sum));
  // 捨去的餘數從最外排補回，總數精確等於 total
  for (let i = ROWS - 1, left = total - counts.reduce((a, b) => a + b, 0); left > 0; i = (i - 1 + ROWS) % ROWS, left--) counts[i] += 1;
  const seats: Seat[] = [];
  radii.forEach((r, row) => {
    const n = counts[row];
    for (let j = 0; j < n; j++) {
      const angle = n === 1 ? Math.PI / 2 : Math.PI * (1 - j / (n - 1));
      seats.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), angle });
    }
  });
  return seats.sort((a, b) => b.angle - a.angle || a.x - b.x);
}

export function Hemicycle({ roster, matching, party, onPartyToggle, onOpen }: HemicycleProps) {
  const ordered = useMemo(
    () =>
      [...roster].sort(
        (a, b) =>
          partyStyle(a.party).order - partyStyle(b.party).order ||
          Number(b.is_convener) - Number(a.is_convener) ||
          a.name.localeCompare(b.name, 'zh-Hant'),
      ),
    [roster],
  );
  const seats = useMemo(() => seatLayout(ordered.length), [ordered.length]);

  const tally = useMemo(() => {
    const map = new Map<string, { total: number; lit: number }>();
    for (const l of ordered) {
      const key = l.party ?? '未提供';
      const entry = map.get(key) ?? { total: 0, lit: 0 };
      entry.total += 1;
      if (!matching || matching.has(l.id)) entry.lit += 1;
      map.set(key, entry);
    }
    return sortParties(map.keys()).map((name) => ({ name, ...map.get(name)! }));
  }, [ordered, matching]);

  const litTotal = matching ? ordered.filter((l) => matching.has(l.id)).length : ordered.length;
  const seatR = 0.034;
  const summary = `議場席次圖：共 ${ordered.length} 席，符合條件 ${litTotal} 席。${tally
    .map((t) => `${t.name} ${t.lit}／${t.total} 席`)
    .join('；')}。`;

  return (
    <section className="hemicycle" aria-label="議場席次">
      <svg viewBox="-1.06 -1.06 2.12 1.12" role="img" aria-label={summary}>
        {ordered.map((l, i) => {
          const seat = seats[i];
          if (!seat) return null;
          const lit = !matching || matching.has(l.id);
          const style = partyStyle(l.party);
          return (
            <circle
              key={l.id}
              cx={seat.x}
              cy={-seat.y}
              r={seatR}
              fill={lit ? style.color : 'var(--seat-off)'}
              className={l.is_convener && lit ? 'seat convener' : 'seat'}
              onClick={() => onOpen(l)}
            >
              <title>{`${l.name}（${style.short}）${l.area_name ?? ''}${l.is_convener ? '・召委' : ''}`}</title>
            </circle>
          );
        })}
        <text x="0" y="-0.12" textAnchor="middle" className="hemicycle-count">
          {litTotal}
        </text>
        <text x="0" y="-0.02" textAnchor="middle" className="hemicycle-caption">
          {matching ? `符合條件／共 ${ordered.length} 席` : `席`}
        </text>
      </svg>

      <ul className="party-legend" aria-label="依黨籍篩選">
        {tally.map((t) => {
          const style = partyStyle(t.name);
          return (
            <li key={t.name}>
              <button
                type="button"
                aria-pressed={party === t.name}
                onClick={() => onPartyToggle(t.name)}
                style={{ '--party': style.color } as CSSProperties}
              >
                <span className="swatch" aria-hidden="true" />
                <span className="party-name">{t.name}</span>
                <span className="party-count">
                  {matching ? `${t.lit}／${t.total}` : t.total}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hemicycle-note muted">外圈加框為本會期召委。點席次可開啟委員檔案。</p>
    </section>
  );
}
