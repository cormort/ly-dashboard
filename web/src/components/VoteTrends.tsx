import { useState, type CSSProperties } from 'react';
import type { CountiesResponse, TrendPoint, TrendType } from '../api/types';
import { partyStyle, sortParties } from '../lib/parties';
import { ChoroplethMap } from './ChoroplethMap';

type Measure = 'votes' | 'pct';
const NATIONAL = '全國';

const num = (n: number, digits = 0) => n.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${num(n, digits)}`;

/** 某政黨的歷次數值（得票數或得票率）；該次沒有參選為 null */
function valuesOf(points: TrendPoint[], party: string, measure: Measure): (number | null)[] {
  return points.map((p) => {
    const v = p.votes[party];
    if (v === undefined) return null;
    return measure === 'votes' ? v : (v / p.valid) * 100;
  });
}

/** 與前一次的差異 */
function diffsOf(values: (number | null)[]): (number | null)[] {
  return values.map((v, i) => (i === 0 || v === null || values[i - 1] === null ? null : v - values[i - 1]!));
}

/** 轉折：這次的增減方向與上一次相反（例如上次增加、這次減少） */
function turnsOf(diffs: (number | null)[]): boolean[] {
  return diffs.map((d, i) => {
    const prev = diffs[i - 1];
    return i > 0 && d !== null && prev !== null && prev !== undefined && d !== 0 && prev !== 0 && Math.sign(d) !== Math.sign(prev);
  });
}

function turnText(years: number[], diffs: (number | null)[], turns: boolean[]): string {
  const list = turns.flatMap((t, i) => (t ? [`${years[i]} ${diffs[i]! > 0 ? '由減轉增' : '由增轉減'}`] : []));
  return list.length ? list.join('、') : '無';
}

/** 全國＝各縣市加總 */
function nationalPoints(data: CountiesResponse, type: TrendType): TrendPoint[] {
  return data.items[0].trends[type].map((_, i) => {
    const votes: Record<string, number> = {};
    let valid = 0;
    for (const c of data.items) {
      const p = c.trends[type][i];
      valid += p.valid;
      for (const [party, v] of Object.entries(p.votes)) votes[party] = (votes[party] ?? 0) + v;
    }
    return { year: data.items[0].trends[type][i].year, valid, turnout: null, votes };
  });
}

/** 主要政黨：任一次全國得票率 ≥ 3% */
function mainParties(points: TrendPoint[]): string[] {
  const set = new Set<string>();
  for (const p of points) for (const [party, v] of Object.entries(p.votes)) if (v / p.valid >= 0.03) set.add(party);
  return sortParties(set);
}

const fmtValue = (v: number | null, measure: Measure) => (v === null ? '—' : measure === 'votes' ? num(v) : `${num(v, 2)}%`);
const fmtDiff = (d: number | null, measure: Measure) => (d === null ? '' : measure === 'votes' ? signed(d) : `${signed(d, 2)} 個百分點`);

/** 折線圖：各黨歷次得票（一個 y 軸），空心大圈標示轉折，滑過年份顯示各黨數值與增減 */
function TrendChart({ points, parties, measure, title }: { points: TrendPoint[]; parties: string[]; measure: Measure; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 280;
  const pad = { l: 64, r: 92, t: 16, b: 28 };
  const years = points.map((p) => p.year);
  const lines = parties.map((party) => {
    const values = valuesOf(points, party, measure);
    const diffs = diffsOf(values);
    return { party, values, diffs, turns: turnsOf(diffs) };
  });
  const all = lines.flatMap((l) => l.values).filter((v): v is number => v !== null);
  const max = Math.max(...all) * 1.08 || 1;
  const x = (i: number) => pad.l + (years.length === 1 ? 0 : (i / (years.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // 線尾標籤：依高度排序後至少相隔 15，避免重疊
  const labelY = new Map<string, number>();
  lines
    .map((l) => {
      const i = l.values.map((v, k) => (v === null ? -1 : k)).filter((k) => k >= 0).at(-1);
      return { party: l.party, i, y: i === undefined ? 0 : y(l.values[i]!) };
    })
    .filter((e) => e.i !== undefined)
    .sort((a, b) => a.y - b.y)
    .forEach((e, k, arr) => labelY.set(e.party, k ? Math.max(e.y, labelY.get(arr[k - 1].party)! + 15) : e.y));
  const tick = (v: number) => (measure === 'pct' ? `${Math.round(v)}%` : v >= 10000 ? `${num(v / 10000, v >= 1e6 ? 0 : 1)} 萬` : num(v));

  return (
    <figure className="trend-chart">
      <figcaption>{title}</figcaption>
      <div className="trend-legend">
        {lines.map((l) => (
          <span key={l.party} style={{ '--party': partyStyle(l.party).color } as CSSProperties}>
            <i aria-hidden="true" />
            {partyStyle(l.party).short}
          </span>
        ))}
        <span className="muted">
          <b className="trend-turn-key" aria-hidden="true" />
          轉折（增減方向改變）
        </span>
      </div>
      <div className="trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}折線圖，數值見下表`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="trend-grid" />
              <text x={pad.l - 8} y={y(t) + 4} className="trend-axis" textAnchor="end">
                {tick(t)}
              </text>
            </g>
          ))}
          {years.map((yr, i) => (
            <text key={yr} x={x(i)} y={H - 8} className="trend-axis" textAnchor="middle">
              {yr}
            </text>
          ))}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="trend-crosshair" /> : null}
          {lines.map((l) => {
            const color = partyStyle(l.party).color;
            const pts = l.values.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)));
            // 沒參選的年份斷線
            const d = pts.reduce((acc, p, i) => (p ? `${acc}${i && pts[i - 1] ? 'L' : 'M'}${p[0]} ${p[1]}` : acc), '');
            const lastIndex = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).at(-1);
            return (
              <g key={l.party}>
                <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
                {pts.map((p, i) =>
                  p ? (
                    <g key={i}>
                      {l.turns[i] ? <circle cx={p[0]} cy={p[1]} r="8" fill="none" stroke={color} strokeWidth="2" /> : null}
                      <circle cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} fill={color} stroke="var(--surface)" strokeWidth="2" />
                    </g>
                  ) : null,
                )}
                {lastIndex !== undefined ? (
                  <text x={pts[lastIndex]![0] + 12} y={labelY.get(l.party)! + 4} className="trend-label">
                    {partyStyle(l.party).short}
                  </text>
                ) : null}
              </g>
            );
          })}
          {years.map((yr, i) => (
            <rect
              key={yr}
              x={x(i) - (W - pad.l - pad.r) / Math.max(1, years.length - 1) / 2}
              y={pad.t}
              width={(W - pad.l - pad.r) / Math.max(1, years.length - 1)}
              height={H - pad.t - pad.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {hover !== null ? (
          <div className="trend-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <b>{years[hover]}</b>
            {lines.map((l) => (
              <span key={l.party}>
                <i style={{ background: partyStyle(l.party).color }} aria-hidden="true" />
                {partyStyle(l.party).short} {fmtValue(l.values[hover], measure)}
                {l.diffs[hover] !== null ? <small className="muted"> {fmtDiff(l.diffs[hover], measure)}</small> : null}
                {l.turns[hover] ? <small> 轉折</small> : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

/**
 * 得票趨勢：總統（2012–2024）、縣市長（2014–2022）、不分區政黨票（2012–2024）各黨歷次得票與增減，
 * 標出增減方向改變（轉折）的年份；地圖為所選政黨最近一次的增減率。
 */
export function VoteTrends({ data, selected, onSelect }: { data: CountiesResponse; selected: string; onSelect: (county: string) => void }) {
  const [type, setType] = useState<TrendType>('president');
  const [measure, setMeasure] = useState<Measure>('votes');
  const national = nationalPoints(data, type);
  const parties = mainParties(national);
  const [partyChoice, setParty] = useState('民主進步黨');
  const party = parties.includes(partyChoice) ? partyChoice : parties[0];
  const [scope, setScope] = useState<'county' | 'national'>('county');
  const county = data.items.find((c) => c.county === selected) ?? data.items[0];
  const years = national.map((p) => p.year);
  const label = data.trend_types[type];

  const rows = [
    { name: NATIONAL, points: national },
    ...data.items.map((c) => ({ name: c.county, points: c.trends[type] })),
  ].map((r) => {
    const values = valuesOf(r.points, party, measure);
    const diffs = diffsOf(values);
    return { ...r, values, diffs, turns: turnsOf(diffs) };
  });
  // 地圖：最近一次與前一次相比的增減率（得票率則為增減百分點）
  const latest = new Map(
    rows.slice(1).map((r) => {
      const a = r.values.at(-2) ?? null;
      const b = r.values.at(-1) ?? null;
      return [r.name, a === null || b === null ? null : measure === 'votes' ? ((b - a) / a) * 100 : b - a];
    }),
  );
  const short = partyStyle(party).short;
  const last2 = `${years.at(-2)} → ${years.at(-1)}`;

  return (
    <>
      <div className="stat-controls">
        <div className="segmented" role="group" aria-label="選舉">
          {(Object.keys(data.trend_types) as TrendType[]).map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>
              {data.trend_types[t]}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="數值">
          <button type="button" aria-pressed={measure === 'votes'} onClick={() => setMeasure('votes')}>
            得票數
          </button>
          <button type="button" aria-pressed={measure === 'pct'} onClick={() => setMeasure('pct')}>
            得票率
          </button>
        </div>
        <label className="stat-control">
          <span>政黨（表格與地圖）</span>
          <select value={party} onChange={(event) => setParty(event.target.value)}>
            {parties.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="county-layout">
        <section className="panel county-map-panel">
          <ChoroplethMap
            items={data.items}
            values={latest}
            scale="RdYlGn"
            diverging
            title={`${label}・${short}${measure === 'votes' ? '得票增減率' : '得票率增減'}（${last2}）`}
            format={(v) => (v === null ? '無可比較資料' : measure === 'votes' ? `${signed(v, 1)}%` : `${signed(v, 2)} 個百分點`)}
            selected={county.county}
            onSelect={onSelect}
          />
        </section>
        <section className="panel">
          <div className="segmented" role="group" aria-label="範圍">
            <button type="button" aria-pressed={scope === 'county'} onClick={() => setScope('county')}>
              {county.county}
            </button>
            <button type="button" aria-pressed={scope === 'national'} onClick={() => setScope('national')}>
              全國
            </button>
          </div>
          <TrendChart
            points={scope === 'national' ? national : county.trends[type]}
            parties={parties}
            measure={measure}
            title={`${scope === 'national' ? '全國' : county.county}・${label}各黨${measure === 'votes' ? '得票數' : '得票率'}`}
          />
        </section>
      </div>

      <section className="panel">
        <div className="sectionhead">
          <h2>
            {short}・{label}歷次{measure === 'votes' ? '得票數' : '得票率'}與增減
          </h2>
          <span className="muted">▲▼ 為與前一次的差異；轉折＝增減方向與上一次相反</span>
        </div>
        <div className="table-scroll">
          <table className="county-table trend-table">
            <thead>
              <tr>
                <th scope="col">縣市</th>
                {years.map((yr) => (
                  <th key={yr} scope="col" className="num">
                    {yr}
                  </th>
                ))}
                <th scope="col">轉折</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} aria-current={r.name === county.county ? 'true' : undefined} className={r.name === NATIONAL ? 'trend-total' : undefined}>
                  <td>
                    {r.name === NATIONAL ? (
                      <b>{r.name}</b>
                    ) : (
                      <button type="button" className="link-button" onClick={() => onSelect(r.name)}>
                        {r.name}
                      </button>
                    )}
                  </td>
                  {r.values.map((v, i) => (
                    <td key={years[i]} className={`num${r.turns[i] ? ' trend-turn' : ''}`}>
                      {fmtValue(v, measure)}
                      {r.diffs[i] !== null ? (
                        <small className="trend-diff">
                          {r.diffs[i]! >= 0 ? '▲' : '▼'} {fmtDiff(Math.abs(r.diffs[i]!), measure).replace(/^\+/, '')}
                        </small>
                      ) : null}
                    </td>
                  ))}
                  <td>{turnText(years, r.diffs, r.turns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
