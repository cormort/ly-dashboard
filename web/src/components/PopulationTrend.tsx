import { useState } from 'react';
import { buildUrl } from '../api/client';
import type { CountiesResponse, PopulationTrendResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { ChoroplethMap } from './ChoroplethMap';
import { ErrorState, LoadingState } from './DataStates';

type Metric = 'population' | 'elderly' | 'voting_age' | 'child';
const METRICS: Record<Metric, { label: string; ratio: boolean }> = {
  population: { label: '人口數', ratio: false },
  voting_age: { label: '20 歲以上人口', ratio: false },
  elderly: { label: '65 歲以上比率', ratio: true },
  child: { label: '0–14 歲比率', ratio: true },
};

const num = (n: number) => n.toLocaleString('zh-TW');
const signed = (n: number, d = 0) => `${n > 0 ? '+' : ''}${n.toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d })}`;
const NATIONAL = '全國';
/** 65 歲以上占 20% 即「超高齡社會」 */
const SUPER_AGED = 20;

/** 指數化折線：所選縣市與全國，以 2016-01 = 100（一個 y 軸） */
function IndexChart({ months, series }: { months: string[]; series: { name: string; values: (number | null)[]; color: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 240;
  const pad = { l: 44, r: 64, t: 12, b: 26 };
  const indexed = series.map((s) => ({ ...s, idx: s.values.map((v) => (v === null ? null : (v / s.values[0]!) * 100)) }));
  const all = indexed.flatMap((s) => s.idx).filter((v): v is number => v !== null);
  const lo = Math.floor(Math.min(...all, 100) - 1);
  const hi = Math.ceil(Math.max(...all, 100) + 1);
  const x = (i: number) => pad.l + (i / (months.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const yearTicks = months.map((m, i) => [m, i] as const).filter(([m]) => m.endsWith('-01') && Number(m.slice(0, 4)) % 2 === 0);
  return (
    <div className="trend-plot">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="人口指數（2016 年 1 月＝100）折線圖"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - rect.left) / rect.width) * W;
          setHover(Math.max(0, Math.min(months.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (months.length - 1)))));
        }}
      >
        {[lo, 100, hi].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 100 ? 'trend-crosshair' : 'trend-grid'} />
            <text x={pad.l - 6} y={y(t) + 4} className="trend-axis" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {yearTicks.map(([m, i]) => (
          <text key={m} x={x(i)} y={H - 6} className="trend-axis" textAnchor="middle">
            {m.slice(0, 4)}
          </text>
        ))}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="trend-crosshair" /> : null}
        {indexed.map((s) => (
          <g key={s.name}>
            {/* 缺月處斷線 */}
            <path d={s.idx.map((v, i) => (v === null ? '' : `${i && s.idx[i - 1] !== null ? 'L' : 'M'}${x(i)} ${y(v)}`)).join('')} fill="none" stroke={s.color} strokeWidth="2" />
            <text x={x(months.length - 1) + 6} y={y(s.idx[s.idx.length - 1] ?? 100) + 4} className="trend-label">
              {s.name}
            </text>
          </g>
        ))}
      </svg>
      {hover !== null ? (
        <div className="trend-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
          <b>{months[hover]}</b>
          {indexed.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} aria-hidden="true" />
              {s.name} {s.values[hover] === null ? '來源缺資料' : `${num(s.values[hover]!)}（${s.idx[hover]!.toFixed(1)}）`}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 人口趨勢：2016 年 1 月起每月縣市人口、每年 12 月年齡結構（20 歲以上、65 歲以上、0–14 歲），
 * 各縣市進入超高齡（65 歲以上 ≥ 20%）的年份，以及各鄉鎮的人口增減。
 */
export function PopulationTrend({ refreshToken, counties, selected, onSelect }: { refreshToken: number; counties: CountiesResponse; selected: string; onSelect: (county: string) => void }) {
  const res = useApi<PopulationTrendResponse>(buildUrl('/population-trend'), { refreshToken });
  const [metric, setMetric] = useState<Metric>('population');
  const [fromChoice, setFrom] = useState('2016');

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入人口趨勢…" />;
  if (!res.data) return res.phase === 'error' ? <ErrorState title="無法取得人口趨勢（/api/v1/population-trend）" error={res.error} onRetry={res.reload} /> : null;

  const data = res.data;
  const latest = data.years[data.years.length - 1];
  const from = data.years.includes(fromChoice) && fromChoice !== latest ? fromChoice : data.years[0];
  const fi = data.years.indexOf(from);
  const li = data.years.length - 1;
  const m = METRICS[metric];
  const value = (a: { population: number; elderly: number; voting_age: number; child: number }) =>
    metric === 'population' ? a.population : metric === 'voting_age' ? a.voting_age : (a[metric] / a.population) * 100;

  const rows = data.counties.map((c) => {
    const a = value(c.ages[fi]);
    const b = value(c.ages[li]);
    const superAged = c.ages.find((x) => (x.elderly / x.population) * 100 >= SUPER_AGED)?.year ?? null;
    return { county: c.county, a, b, diff: b - a, rate: m.ratio ? b - a : ((b - a) / a) * 100, superAged, elderlyNow: (c.ages[li].elderly / c.ages[li].population) * 100 };
  });
  const national = (i: number) => {
    const sum = { population: 0, elderly: 0, voting_age: 0, child: 0 };
    for (const c of data.counties) for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += c.ages[i][k];
    return sum;
  };
  const natA = value(national(fi));
  const natB = value(national(li));
  const current = data.counties.find((c) => c.county === selected) ?? data.counties[0];
  const nationalMonthly = data.months.map((_, i) => (data.counties[0].monthly[i] === null ? null : data.counties.reduce((s, c) => s + c.monthly[i]!, 0)));
  const fmtVal = (v: number) => (m.ratio ? `${v.toFixed(2)}%` : num(Math.round(v)));
  const fmtChange = (r: number) => (m.ratio ? `${signed(r, 2)} 個百分點` : `${signed(r, 1)}%`);

  // 鄉鎮：起點年 → 最新的人口增減率
  const towns = data.towns
    .filter((t) => t.population[from] && t.population[latest])
    .map((t) => ({ ...t, rate: ((t.population[latest] - t.population[from]) / t.population[from]) * 100, density: t.population[latest] / t.size }));
  const scoped = towns.filter((t) => t.county === current.county).sort((a, b) => b.rate - a.rate);
  const nationalTop = [...towns].sort((a, b) => b.rate - a.rate);

  return (
    <>
      <div className="stat-controls">
        <div className="segmented" role="group" aria-label="指標">
          {(Object.keys(METRICS) as Metric[]).map((k) => (
            <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)}>
              {METRICS[k].label}
            </button>
          ))}
        </div>
        <label className="stat-control">
          <span>起始年（12 月）</span>
          <select value={from} onChange={(event) => setFrom(event.target.value)}>
            {data.years.slice(0, -1).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stat-row stat-overview">
        <div className="stat-tile">
          <b className="stat-value">{fmtVal(natB)}</b>
          <span className="stat-label">
            全國{m.label}（{latest}）
          </span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{m.ratio ? fmtChange(natB - natA) : signed(Math.round(natB - natA))}</b>
          <span className="stat-label">
            與 {from} 年底相比{m.ratio ? '' : `（${fmtChange(((natB - natA) / natA) * 100)}）`}
          </span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{rows.filter((r) => (m.ratio ? r.diff > 0 : r.diff < 0)).length}／22</b>
          <span className="stat-label">{m.ratio ? '比率上升' : '人口減少'}的縣市</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{rows.filter((r) => r.superAged).length}／22</b>
          <span className="stat-label">已進入超高齡（65 歲以上 ≥ 20%）的縣市</span>
        </div>
      </div>

      <div className="county-layout">
        <section className="panel county-map-panel">
          <ChoroplethMap
            items={counties.items}
            values={new Map(rows.map((r) => [r.county, r.rate]))}
            scale="RdYlGn"
            diverging
            title={`${m.label}變化（${from} → ${latest}）`}
            format={(v) => (v === null ? '—' : fmtChange(v))}
            selected={current.county}
            onSelect={onSelect}
          />
        </section>
        <section className="panel">
          <h2>{current.county}與全國：每月人口指數（2016 年 1 月＝100）</h2>
          <IndexChart
            months={data.months}
            series={[
              { name: current.county, values: current.monthly, color: 'var(--accent)' },
              { name: NATIONAL, values: nationalMonthly, color: 'var(--muted)' },
            ]}
          />
          <h3>
            {current.county}各鄉鎮市區人口增減（{from} → {latest}）
          </h3>
          <div className="table-scroll split-table">
            <table className="county-table">
              <thead>
                <tr>
                  <th scope="col">鄉鎮市區</th>
                  <th scope="col" className="num">{from}</th>
                  <th scope="col" className="num">{latest}</th>
                  <th scope="col" className="num">增減率</th>
                  <th scope="col" className="num">人口密度（每平方公里）</th>
                </tr>
              </thead>
              <tbody>
                {scoped.map((t) => (
                  <tr key={t.town}>
                    <td>{t.town}</td>
                    <td className="num">{num(t.population[from])}</td>
                    <td className="num">{num(t.population[latest])}</td>
                    <td className="num">{signed(t.rate, 1)}%</td>
                    <td className="num">{num(Math.round(t.density))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="sectionhead">
          <h2>
            各縣市{m.label}（{from} → {latest}）
          </h2>
        </div>
        <div className="table-scroll">
          <table className="county-table">
            <thead>
              <tr>
                <th scope="col">縣市</th>
                <th scope="col" className="num">{from}</th>
                <th scope="col" className="num">{latest}</th>
                <th scope="col" className="num">變化</th>
                <th scope="col" className="num">65 歲以上（{latest}）</th>
                <th scope="col">進入超高齡</th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => b.rate - a.rate)
                .map((r) => (
                  <tr key={r.county} aria-current={r.county === current.county ? 'true' : undefined}>
                    <td>
                      <button type="button" className="link-button" onClick={() => onSelect(r.county)}>
                        {r.county}
                      </button>
                    </td>
                    <td className="num">{fmtVal(r.a)}</td>
                    <td className="num">{fmtVal(r.b)}</td>
                    <td className="num">{fmtChange(r.rate)}</td>
                    <td className="num">{r.elderlyNow.toFixed(2)}%</td>
                    <td>{r.superAged ? (r.superAged === data.years[0] ? `${r.superAged} 年以前` : r.superAged) : '尚未'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>
          全國人口增減最多的鄉鎮市區（{from} → {latest}）
        </h2>
        <div className="stat-dual">
          {[
            { title: '成長最多', list: nationalTop.slice(0, 10) },
            { title: '減少最多', list: nationalTop.slice(-10).reverse() },
          ].map(({ title, list }) => (
            <div key={title}>
              <h3>{title}</h3>
              <ol className="plain-list town-change">
                {list.map((t) => (
                  <li key={t.county + t.town}>
                    <button type="button" className="link-button" onClick={() => onSelect(t.county)}>
                      {t.county}
                      {t.town}
                    </button>
                    <span>{signed(t.rate, 1)}%</span>
                    <small className="muted">
                      {num(t.population[from])} → {num(t.population[latest])}
                    </small>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
      <p className="muted">
        每月人口為各鄉鎮市區戶籍人口加總（2023 年 9 月來源缺資料，圖上斷線）；年齡結構取每年 12 月（最新為 {latest}）。來源：
        {data.sources.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener">
            {s.label}
          </a>
        ))}
      </p>
    </>
  );
}
