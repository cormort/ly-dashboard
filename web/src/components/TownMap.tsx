import { useMemo, useState } from 'react';
import { buildUrl } from '../api/client';
import type { CountiesResponse, DemographicsResponse, DemographicTown, PopulationTrendResponse, TownMapResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import type { ScaleName } from '../lib/colorScales';
import { partyStyle, sortParties } from '../lib/parties';
import { ChoroplethMap } from './ChoroplethMap';
import { ErrorState, LoadingState } from './DataStates';

type ElectionKey = keyof DemographicTown['elections'];
type MetricKey = 'elderly_ratio' | 'young_ratio' | 'child_ratio' | 'median_age' | 'household_size' | 'population' | 'density' | 'change' | 'party';

const METRICS: Record<MetricKey, { label: string; unit: string; scale: ScaleName; diverging?: boolean }> = {
  population: { label: '人口數', unit: '人', scale: 'YlOrRd' },
  density: { label: '人口密度', unit: '人／平方公里', scale: 'YlOrRd' },
  change: { label: '人口增減率（2016 年底起）', unit: '%', scale: 'RdYlGn', diverging: true },
  elderly_ratio: { label: '65 歲以上比率', unit: '%', scale: 'YlOrRd' },
  young_ratio: { label: '20–39 歲比率', unit: '%', scale: 'Blues' },
  child_ratio: { label: '0–14 歲比率', unit: '%', scale: 'Greens' },
  median_age: { label: '年齡中位數', unit: '歲', scale: 'YlOrRd' },
  household_size: { label: '平均戶量', unit: '人', scale: 'Blues' },
  party: { label: '政黨得票率', unit: '%', scale: 'Blues' },
};

/** 由 path 字串算外框範圍，供「只看某縣市」時放大 */
function bbox(paths: string[]): string {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const d of paths) {
    for (const m of d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.06 + 2;
  return `${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${(x1 - x0 + pad * 2).toFixed(1)} ${(y1 - y0 + pad * 2).toFixed(1)}`;
}

/**
 * 鄉鎮地圖：368 個鄉鎮市區的面量圖（人口、密度、增減、年齡結構、各黨得票率），可放大到單一縣市，
 * 疊上縣市界；右側為範圍內鄉鎮排行。
 */
export function TownMap({ refreshToken, counties, county, onSelectCounty }: { refreshToken: number; counties: CountiesResponse; county: string; onSelectCounty: (county: string) => void }) {
  const map = useApi<TownMapResponse>(buildUrl('/town-map'), { refreshToken });
  const demo = useApi<DemographicsResponse>(buildUrl('/demographics'), { refreshToken });
  const trend = useApi<PopulationTrendResponse>(buildUrl('/population-trend'), { refreshToken });
  const [metric, setMetric] = useState<MetricKey>('elderly_ratio');
  const [election, setElection] = useState<ElectionKey>('party_list_2024');
  const [partyChoice, setParty] = useState('民主進步黨');
  const [scope, setScope] = useState<'all' | 'county'>('county');
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const countyViewBox = useMemo(() => (map.data ? bbox(map.data.towns.filter((t) => t.county === county).map((t) => t.path)) : undefined), [map.data, county]);

  const failed = [map, demo, trend].find((r) => r.phase === 'error');
  if (failed) return <ErrorState title="無法取得鄉鎮資料" error={failed.error} onRetry={failed.reload} />;
  if (!map.data || !demo.data || !trend.data) return <LoadingState label="載入鄉鎮地圖…" />;

  const demoData = demo.data;
  const latest = trend.data.years[trend.data.years.length - 1];
  const demoByKey = new Map(demo.data.towns.map((t) => [t.county + t.town, t]));
  const trendByKey = new Map(trend.data.towns.map((t) => [t.county + t.town, t]));
  const national: Record<string, number> = {};
  let valid = 0;
  for (const t of demo.data.towns) {
    const b = t.elections[election];
    if (!b) continue;
    valid += b.valid;
    for (const [p, v] of Object.entries(b.votes)) national[p] = (national[p] ?? 0) + v;
  }
  const parties = sortParties(Object.keys(national).filter((p) => p !== '無黨籍' && national[p] / valid >= 0.03));
  const party = parties.includes(partyChoice) ? partyChoice : parties[0];

  const valueOf = (key: string): number | null => {
    const d = demoByKey.get(key);
    const tr = trendByKey.get(key);
    if (!d || !tr) return null;
    switch (metric) {
      case 'population':
        return d.population;
      case 'density':
        return d.population / tr.size;
      case 'change':
        return ((tr.population[latest] - tr.population['2016']) / tr.population['2016']) * 100;
      case 'party': {
        const b = d.elections[election];
        return b && b.votes[party] !== undefined ? (b.votes[party] / b.valid) * 100 : null;
      }
      default:
        return d[metric];
    }
  };
  const meta = METRICS[metric];
  const label = metric === 'party' ? `${demo.data.elections[election]}・${partyStyle(party).short}得票率` : meta.label;
  const digits = meta.unit === '%' ? 2 : metric === 'household_size' ? 2 : 0;
  const format = (v: number | null) => (v === null ? '—' : `${metric === 'change' && v > 0 ? '+' : ''}${v.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${meta.unit}`);

  const shown = scope === 'county' ? map.data.towns.filter((t) => t.county === county) : map.data.towns;
  const items = shown.map((t) => ({ county: t.county + t.town, path: t.path }));
  const values = new Map(items.map((i) => [i.county, valueOf(i.county)]));
  const ranked = items
    .map((i) => ({ key: i.county, v: values.get(i.county) ?? null }))
    .filter((r): r is { key: string; v: number } => r.v !== null)
    .sort((a, b) => b.v - a.v);
  const outlines = scope === 'all' ? counties.items.map((c) => c.path) : [];

  return (
    <>
      <div className="stat-controls">
        <label className="stat-control">
          <span>指標</span>
          <select value={metric} onChange={(event) => setMetric(event.target.value as MetricKey)}>
            {(Object.keys(METRICS) as MetricKey[]).map((k) => (
              <option key={k} value={k}>
                {METRICS[k].label}
              </option>
            ))}
          </select>
        </label>
        {metric === 'party' ? (
          <>
            <label className="stat-control">
              <span>選舉</span>
              <select value={election} onChange={(event) => setElection(event.target.value as ElectionKey)}>
                {(Object.keys(demoData.elections) as ElectionKey[]).map((k) => (
                  <option key={k} value={k}>
                    {demoData.elections[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="stat-control">
              <span>政黨</span>
              <select value={party} onChange={(event) => setParty(event.target.value)}>
                {parties.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <div className="segmented" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'county'} onClick={() => setScope('county')}>
            {county}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            全國 368 鄉鎮
          </button>
        </div>
        {scope === 'county' ? (
          <label className="stat-control">
            <span>縣市</span>
            <select value={county} onChange={(event) => onSelectCounty(event.target.value)}>
              {counties.items.map((c) => (
                <option key={c.county} value={c.county}>
                  {c.county}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="county-layout town-layout">
        <section className="panel county-map-panel">
          <ChoroplethMap
            items={items}
            values={values}
            scale={meta.scale}
            diverging={meta.diverging}
            title={`${scope === 'county' ? county : '全國'}各鄉鎮市區・${label}`}
            format={format}
            selected={selected}
            onSelect={setSelected}
            viewBox={scope === 'county' ? countyViewBox : undefined}
            outlines={outlines}
            strokeWidth={scope === 'county' ? 0.5 : 0.25}
          />
        </section>
        <section className="panel">
          <h2>
            {label}排行（{ranked.length} 個鄉鎮市區）
          </h2>
          <ol className="stat-ranking town-ranking">
            {ranked.map((r, i) => (
              <li key={r.key} aria-current={r.key === selected ? 'true' : undefined}>
                <span className="muted">{i + 1}</span>
                <button type="button" className="link-button" onClick={() => setSelected(r.key)}>
                  {scope === 'county' ? r.key.slice(3) : r.key}
                </button>
                <span className="stat-bar-value">{format(r.v)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <p className="muted">
        鄉鎮市區界：
        <a href={map.data.source.url} target="_blank" rel="noreferrer noopener">
          {map.data.source.label}
        </a>
        。人口與年齡結構為 {demo.data.population_month}，得票為中選會鄉鎮市區合計；人口增減率為 2016 年底到 {latest}。
      </p>
    </>
  );
}
