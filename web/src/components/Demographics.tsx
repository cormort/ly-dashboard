import { useState } from 'react';
import { buildUrl } from '../api/client';
import type { DemographicsResponse, DemographicTown } from '../api/types';
import { useApi } from '../hooks/useApi';
import { partyStyle, sortParties } from '../lib/parties';
import { ErrorState, LoadingState } from './DataStates';

type XKey = 'elderly_ratio' | 'young_ratio' | 'child_ratio' | 'median_age' | 'household_size';
const X_VARS: Record<XKey, { label: string; unit: string }> = {
  elderly_ratio: { label: '65 歲以上比率', unit: '%' },
  young_ratio: { label: '20–39 歲比率', unit: '%' },
  child_ratio: { label: '0–14 歲比率', unit: '%' },
  median_age: { label: '年齡中位數', unit: '歲' },
  household_size: { label: '平均戶量', unit: '人' },
};
type ElectionKey = 'president_2024' | 'party_list_2024' | 'president_2020' | 'party_list_2020';

const share = (t: DemographicTown, e: ElectionKey, party: string) => {
  const b = t.elections[e];
  return b && b.votes[party] !== undefined ? (b.votes[party] / b.valid) * 100 : null;
};

/** 皮爾森相關係數；w 為權重（人口），省略則等權 */
function pearson(xs: number[], ys: number[], w?: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const ws = w ?? xs.map(() => 1);
  const W = ws.reduce((s, v) => s + v, 0);
  const mx = xs.reduce((s, v, i) => s + v * ws[i], 0) / W;
  const my = ys.reduce((s, v, i) => s + v * ws[i], 0) / W;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
    sxx += ws[i] * (xs[i] - mx) ** 2;
    syy += ws[i] * (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** 最小平方法迴歸線（等權） */
function fit(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const sxx = xs.reduce((s, v) => s + (v - mx) ** 2, 0);
  const slope = sxx ? xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

const strength = (r: number | null) => {
  if (r === null) return '—';
  const a = Math.abs(r);
  const word = a >= 0.7 ? '強' : a >= 0.4 ? '中度' : a >= 0.2 ? '弱' : '幾乎無';
  return a < 0.2 ? word + '相關' : `${word}${r > 0 ? '正' : '負'}相關`;
};
const fmtR = (r: number | null) => (r === null ? '—' : r.toFixed(2));

interface Point {
  t: DemographicTown;
  x: number;
  y: number;
}

function Scatter({ points, focus, color, xLabel, yLabel, onHover }: { points: Point[]; focus: string | null; color: string; xLabel: string; yLabel: string; onHover: (p: Point | null) => void }) {
  const W = 520;
  const H = 380;
  const pad = { l: 48, r: 14, t: 12, b: 40 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.floor(Math.min(...xs)), Math.ceil(Math.max(...xs))];
  const [y0, y1] = [Math.max(0, Math.floor(Math.min(...ys) / 5) * 5), Math.min(100, Math.ceil(Math.max(...ys) / 5) * 5)];
  const sx = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const maxPop = Math.max(...points.map((p) => p.t.population));
  const { slope, intercept } = fit(xs, ys);
  const xTicks = Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4);
  const yTicks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="split-scatter" role="img" aria-label={`${xLabel}對照${yLabel}的鄉鎮散佈圖，數值見下表`}>
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="trend-grid" />
          <text x={pad.l - 6} y={sy(t) + 4} className="trend-axis" textAnchor="end">
            {Math.round(t)}%
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <text key={`x${t}`} x={sx(t)} y={H - pad.b + 16} className="trend-axis" textAnchor="middle">
          {Number.isInteger(t) ? t : t.toFixed(1)}
        </text>
      ))}
      <text x={(pad.l + W - pad.r) / 2} y={H - 4} className="trend-axis" textAnchor="middle">
        {xLabel} →
      </text>
      {/* 泡泡大小＝人口；所選縣市實色，其餘淡色 */}
      {[...points]
        .sort((a, b) => b.t.population - a.t.population)
        .map((p) => {
          const on = focus === null || p.t.county === focus;
          return (
            <circle
              key={p.t.county + p.t.town}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={2 + 10 * Math.sqrt(p.t.population / maxPop)}
              fill={color}
              fillOpacity={on ? 0.45 : 0.08}
              stroke={on ? color : 'none'}
              strokeWidth="1"
              onMouseEnter={() => onHover(p)}
              onMouseLeave={() => onHover(null)}
            >
              <title>{`${p.t.county}${p.t.town}：${xLabel} ${p.x}、${yLabel} ${p.y.toFixed(2)}%`}</title>
            </circle>
          );
        })}
      <line x1={sx(x0)} y1={sy(intercept + slope * x0)} x2={sx(x1)} y2={sy(intercept + slope * x1)} stroke="var(--ink)" strokeWidth="2" strokeDasharray="6 4" />
    </svg>
  );
}

/**
 * 人口結構 × 得票：以 368 個鄉鎮市區為單位，看年齡結構（2026-08 人口）與 2020／2024 各黨得票率的關聯。
 * 這是區域層級的相關，不能推論個人投票行為（生態謬誤）；人口時間點晚於選舉。
 */
export function Demographics({ refreshToken, county }: { refreshToken: number; county: string }) {
  const res = useApi<DemographicsResponse>(buildUrl('/demographics'), { refreshToken });
  const [xKey, setX] = useState<XKey>('elderly_ratio');
  const [election, setElection] = useState<ElectionKey>('party_list_2024');
  const [partyChoice, setParty] = useState('民主進步黨');
  const [scope, setScope] = useState<'all' | 'county'>('all');
  const [hover, setHover] = useState<Point | null>(null);

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入鄉鎮人口與得票…" />;
  if (!res.data) return res.phase === 'error' ? <ErrorState title="無法取得人口與得票（/api/v1/demographics）" error={res.error} onRetry={res.reload} /> : null;

  const data = res.data;
  const towns = scope === 'county' ? data.towns.filter((t) => t.county === county) : data.towns;
  // 主要政黨：該次全國得票率 ≥ 3%
  const national: Record<string, number> = {};
  let valid = 0;
  for (const t of data.towns) {
    const b = t.elections[election];
    if (!b) continue;
    valid += b.valid;
    for (const [p, v] of Object.entries(b.votes)) national[p] = (national[p] ?? 0) + v;
  }
  const parties = sortParties(Object.keys(national).filter((p) => p !== '無黨籍' && national[p] / valid >= 0.03));
  const party = parties.includes(partyChoice) ? partyChoice : parties[0];
  const color = partyStyle(party).color;
  const x = X_VARS[xKey];

  const pointsFor = (key: XKey, p: string): Point[] =>
    towns.flatMap((t) => {
      const y = share(t, election, p);
      return y === null ? [] : [{ t, x: t[key], y }];
    });
  const points = pointsFor(xKey, party);
  const r = pearson(points.map((p) => p.x), points.map((p) => p.y));
  const rw = pearson(points.map((p) => p.x), points.map((p) => p.y), points.map((p) => p.t.population));
  const { slope } = points.length > 2 ? fit(points.map((p) => p.x), points.map((p) => p.y)) : { slope: 0 };
  const yLabel = `${partyStyle(party).short}得票率`;

  return (
    <>
      <div className="stat-controls">
        <label className="stat-control">
          <span>人口結構（X）</span>
          <select value={xKey} onChange={(event) => setX(event.target.value as XKey)}>
            {(Object.keys(X_VARS) as XKey[]).map((k) => (
              <option key={k} value={k}>
                {X_VARS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="stat-control">
          <span>選舉</span>
          <select value={election} onChange={(event) => setElection(event.target.value as ElectionKey)}>
            {(Object.keys(data.elections) as ElectionKey[]).map((k) => (
              <option key={k} value={k}>
                {data.elections[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="stat-control">
          <span>政黨（Y）</span>
          <select value={party} onChange={(event) => setParty(event.target.value)}>
            {parties.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            全國 368 鄉鎮
          </button>
          <button type="button" aria-pressed={scope === 'county'} onClick={() => setScope('county')}>
            {county}
          </button>
        </div>
      </div>

      <div className="stat-row stat-overview">
        <div className="stat-tile">
          <b className="stat-value">{fmtR(r)}</b>
          <span className="stat-label">相關係數 r（鄉鎮等權）・{strength(r)}</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{fmtR(rw)}</b>
          <span className="stat-label">相關係數（依人口加權）・{strength(rw)}</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">
            {slope > 0 ? '+' : ''}
            {slope.toFixed(2)}
          </b>
          <span className="stat-label">
            迴歸斜率：{x.label}每增加 1 {x.unit}，{yLabel}變動的百分點
          </span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{points.length}</b>
          <span className="stat-label">鄉鎮市區數</span>
        </div>
      </div>

      <div className="county-layout">
        <section className="panel">
          <h2>
            {x.label} × {data.elections[election]}・{yLabel}
          </h2>
          <p className="muted">每個泡泡是一個鄉鎮市區，大小＝人口；虛線為迴歸線。{scope === 'county' ? '' : '滑過泡泡時同縣市以實色標示。'}</p>
          <Scatter points={points} focus={scope === 'county' ? null : hover?.t.county ?? null} color={color} xLabel={`${x.label}（${x.unit}）`} yLabel={yLabel} onHover={setHover} />
          <p className="stat-map-hover" aria-live="polite">
            {hover ? (
              <>
                <b>
                  {hover.t.county}
                  {hover.t.town}
                </b>{' '}
                人口 {hover.t.population.toLocaleString('zh-TW')}・{x.label} {hover.x}
                {x.unit}・{yLabel} {hover.y.toFixed(2)}%
              </>
            ) : (
              <span className="muted">滑過泡泡看鄉鎮</span>
            )}
          </p>
        </section>
        <section className="panel">
          <h2>相關係數一覽（{data.elections[election]}）</h2>
          <p className="muted">r 介於 −1 與 1；|r| ≥ 0.4 視為中度以上相關。括號內為依人口加權。</p>
          <div className="table-scroll">
            <table className="county-table">
              <thead>
                <tr>
                  <th scope="col">人口結構</th>
                  {parties.map((p) => (
                    <th key={p} scope="col" className="num">
                      {partyStyle(p).short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(X_VARS) as XKey[]).map((k) => (
                  <tr key={k} aria-current={k === xKey ? 'true' : undefined}>
                    <th scope="row">
                      <button type="button" className="link-button" onClick={() => setX(k)}>
                        {X_VARS[k].label}
                      </button>
                    </th>
                    {parties.map((p) => {
                      const pts = pointsFor(k, p);
                      const xs = pts.map((q) => q.x);
                      const ys = pts.map((q) => q.y);
                      const v = pearson(xs, ys);
                      const vw = pearson(xs, ys, pts.map((q) => q.t.population));
                      return (
                        <td key={p} className={`num${v !== null && Math.abs(v) >= 0.4 ? ' corr-strong' : ''}`} title={strength(v)}>
                          <button type="button" className="link-button" onClick={() => (setX(k), setParty(p))}>
                            {fmtR(v)}
                          </button>
                          <small className="muted"> ({fmtR(vw)})</small>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>鄉鎮明細（依{yLabel}排序）</h3>
          <div className="table-scroll split-table">
            <table className="county-table">
              <thead>
                <tr>
                  <th scope="col">鄉鎮市區</th>
                  <th scope="col" className="num">人口</th>
                  <th scope="col" className="num">{x.label}</th>
                  <th scope="col" className="num">{yLabel}</th>
                </tr>
              </thead>
              <tbody>
                {[...points]
                  .sort((a, b) => b.y - a.y)
                  .map((p) => (
                    <tr key={p.t.county + p.t.town} aria-current={hover?.t === p.t ? 'true' : undefined}>
                      <td>
                        {p.t.county}
                        {p.t.town}
                      </td>
                      <td className="num">{p.t.population.toLocaleString('zh-TW')}</td>
                      <td className="num">
                        {p.x}
                        {x.unit}
                      </td>
                      <td className="num">{p.y.toFixed(2)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <p className="muted">
        區域層級的相關，不代表個人投票行為（生態謬誤），也不代表因果；人口為 {data.population_month}，晚於選舉時間。山地原住民鄉等特殊地區可能形成離群值。
      </p>
    </>
  );
}
