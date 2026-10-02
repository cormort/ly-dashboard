import { useMemo, useState, type CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { CountiesResponse, CountyElection, CountyElectionKey, CountyItem } from '../api/types';
import { ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { ChoroplethMap } from '../components/ChoroplethMap';
import { LegislatorVotes } from '../components/LegislatorVotes';
import { VoteTrends } from '../components/VoteTrends';
import { colorAt, type ScaleName } from '../lib/colorScales';
import { downloadCsv } from '../lib/csv';
import { partyStyle } from '../lib/parties';

export interface CountiesPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
}

/* ---------- 指標 ---------- */

type Unit = '人' | '戶' | '%' | '票' | '百分點';

interface Metric {
  key: string;
  label: string;
  unit: Unit;
  value: (c: CountyItem) => number | null;
  /** 選舉指標：所屬選舉與欄位，用來配對前後兩次（時間差異） */
  election?: CountyElectionKey;
  field?: string;
}

const ELECTIONS: CountyElectionKey[] = ['president_2024', 'president_2020', 'mayor_2022', 'mayor_2018'];
/** 時間差異：新 ← 舊 */
const PREVIOUS: Partial<Record<CountyElectionKey, CountyElectionKey>> = { president_2024: 'president_2020', mayor_2022: 'mayor_2018' };
const PARTIES = ['民主進步黨', '中國國民黨', '台灣民眾黨'];

const num = (n: number, digits = 0) => n.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const ratio = (part: number, whole: number) => (part / whole) * 100;
const isRate = (unit: Unit) => unit === '%' || unit === '百分點';
const fmt = (value: number | null, unit: Unit) =>
  value === null ? '—' : isRate(unit) ? `${num(value, 2)}${unit === '%' ? '%' : ' 個百分點'}` : `${num(value)} ${unit}`;
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : ''}${num(value, digits)}`;

function partyVotes(e: CountyElection, party: string): { votes: number; pct: number } | null {
  const list = e.candidates.filter((c) => c.party === party);
  if (!list.length) return null;
  return { votes: list.reduce((s, c) => s + c.votes, 0), pct: list.reduce((s, c) => s + c.pct, 0) };
}

/** 由資料列出所有可分析的數值指標（相當於 tw_statistic_map 的「數值欄位」） */
function buildMetrics(data: CountiesResponse): Metric[] {
  const metrics: Metric[] = [
    { key: 'population', label: '人口數', unit: '人', value: (c) => c.population },
    { key: 'households', label: '戶數', unit: '戶', value: (c) => c.households },
    { key: 'voting_age', label: '選舉年齡人口（20 歲以上）', unit: '人', value: (c) => c.voting_age },
    { key: 'voting_age_ratio', label: '選舉年齡人口比率', unit: '%', value: (c) => ratio(c.voting_age, c.population) },
    { key: 'elderly', label: '老年人口（65 歲以上）', unit: '人', value: (c) => c.elderly },
    { key: 'elderly_ratio', label: '老年人口比率', unit: '%', value: (c) => ratio(c.elderly, c.population) },
  ];
  for (const election of ELECTIONS) {
    const label = data.elections[election].label;
    const of = (c: CountyItem) => c.elections[election];
    for (const party of PARTIES) {
      if (!data.items.some((c) => partyVotes(of(c), party))) continue;
      const short = partyStyle(party).short;
      metrics.push(
        { key: `${election}.${party}.votes`, label: `${label}・${short}得票數`, unit: '票', election, field: `${party}.votes`, value: (c) => partyVotes(of(c), party)?.votes ?? null },
        { key: `${election}.${party}.pct`, label: `${label}・${short}得票率`, unit: '%', election, field: `${party}.pct`, value: (c) => partyVotes(of(c), party)?.pct ?? null },
      );
    }
    metrics.push(
      { key: `${election}.margin`, label: `${label}・第一名領先票數`, unit: '票', election, field: 'margin', value: (c) => of(c).margin },
      { key: `${election}.margin_pct`, label: `${label}・第一名領先幅度`, unit: '百分點', election, field: 'margin_pct', value: (c) => of(c).margin_pct },
    );
    if (data.items.every((c) => of(c).turnout !== null)) {
      metrics.push({ key: `${election}.turnout`, label: `${label}・投票率`, unit: '%', election, field: 'turnout', value: (c) => of(c).turnout });
    }
  }
  return metrics;
}

interface ComparePair {
  key: string;
  label: string;
  older: Metric & { election: CountyElectionKey };
  newer: Metric & { election: CountyElectionKey };
}

/** 前後兩次選舉的同一欄位配成一組 */
function buildPairs(metrics: Metric[], data: CountiesResponse): ComparePair[] {
  const pairs: ComparePair[] = [];
  for (const newer of metrics) {
    const prev = newer.election && PREVIOUS[newer.election];
    const older = prev ? metrics.find((m) => m.election === prev && m.field === newer.field) : undefined;
    if (!older?.election || !newer.election) continue;
    const from = data.elections[older.election].label;
    const to = data.elections[newer.election].label;
    pairs.push({
      key: newer.key,
      label: `${newer.label.replace(`${to}・`, '')}（${from} → ${to}）`,
      older: { ...older, election: older.election },
      newer: { ...newer, election: newer.election },
    });
  }
  return pairs;
}

/* ---------- 網址狀態 ---------- */

type Tab = 'map' | 'trend' | 'legislators' | 'dual' | 'compare' | 'ranking' | 'data';
const TABS: { key: Tab; label: string }[] = [
  { key: 'map', label: '互動地圖' },
  { key: 'trend', label: '得票趨勢' },
  { key: 'legislators', label: '立委得票' },
  { key: 'dual', label: '雙指標對比' },
  { key: 'compare', label: '時間差異' },
  { key: 'ranking', label: '排行榜' },
  { key: 'data', label: '原始資料' },
];
const SCALES: { key: ScaleName; label: string }[] = [
  { key: 'YlOrRd', label: '紅色系' },
  { key: 'Blues', label: '藍色系' },
  { key: 'Greens', label: '綠色系' },
  { key: 'Hot', label: '熱力圖' },
];
const TOP_N = ['5', '10', '15', '全部'];

/** 狀態存在 ?key=（replaceState，可分享、重整後一致） */
function useParam<T extends string>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (new URLSearchParams(window.location.search).get(key) as T | null) ?? fallback);
  const update = (next: T) => {
    setValue(next);
    const params = new URLSearchParams(window.location.search);
    params.set(key, next);
    window.history.replaceState(null, '', `/counties?${params.toString()}`);
  };
  return [value, update];
}

/* ---------- 縣市詳情（選舉表） ---------- */

function PartyTag({ party }: { party: string }) {
  const style = partyStyle(party);
  return (
    <span className="party-tag" style={{ '--party': style.color } as CSSProperties}>
      {style.short}
    </span>
  );
}

/** 一場選舉：各候選人得票、與前次同黨得票的增減、第一名與第二名的差距 */
function ElectionTable({ title, current, previous, previousLabel }: { title: string; current: CountyElection; previous: CountyElection; previousLabel: string }) {
  const [first, second] = current.candidates;
  return (
    <section className="county-election">
      <h3>{title}</h3>
      <p className="muted">
        {current.turnout !== null ? `投票率 ${num(current.turnout, 2)}%・` : ''}有效票 {num(current.valid)}
        {current.electorate !== null ? `・選舉人 ${num(current.electorate)}` : ''}
      </p>
      {second ? (
        <p className="county-margin">
          <b>{first.name}</b> 領先 <b>{second.name}</b> {num(current.margin ?? 0)} 票（{num(current.margin_pct ?? 0, 2)} 個百分點）
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="county-table">
          <thead>
            <tr>
              <th scope="col">候選人</th>
              <th scope="col">政黨</th>
              <th scope="col" className="num">得票數</th>
              <th scope="col" className="num">得票率</th>
              <th scope="col" className="num">{previousLabel}同黨得票</th>
              <th scope="col" className="num">增減</th>
            </tr>
          </thead>
          <tbody>
            {current.candidates.map((c) => {
              const prev = c.party === '無黨籍' ? null : partyVotes(previous, c.party);
              return (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>
                    <PartyTag party={c.party} />
                  </td>
                  <td className="num">{num(c.votes)}</td>
                  <td className="num">{num(c.pct, 2)}%</td>
                  <td className="num">{prev === null ? '—' : num(prev.votes)}</td>
                  <td className="num">{prev === null ? '—' : signed(c.votes - prev.votes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="county-previous">
        <summary>{previousLabel}完整結果</summary>
        <ul>
          {previous.candidates.map((c) => (
            <li key={c.name}>
              {c.name} <PartyTag party={c.party} /> {num(c.votes)} 票（{num(c.pct, 2)}%）
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function CountyDetail({ county, data, onOpenId }: { county: CountyItem; data: CountiesResponse; onOpenId: (id: string) => void }) {
  const e = data.elections;
  return (
    <section className="panel county-detail" aria-label={`${county.county}詳細資料`}>
      <h2>{county.county}</h2>
      <div className="stat-row">
        <div className="stat-tile">
          <b className="stat-value">{num(county.population)}</b>
          <span className="stat-label">人口數（{num(county.households)} 戶）</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{num(county.voting_age)}</b>
          <span className="stat-label">選舉年齡人口（20 歲以上，{num(ratio(county.voting_age, county.population), 2)}%）</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{num(county.elderly)}</b>
          <span className="stat-label">老年人口（65 歲以上，{num(ratio(county.elderly, county.population), 2)}%）</span>
        </div>
      </div>
      <div className="county-legislators">
        <h3>區域立委</h3>
        {county.legislators.length ? (
          county.legislators.map((l) => (
            <span key={l.id} className="county-legislator">
              <button type="button" className="name-button" onClick={() => onOpenId(l.id)}>
                {l.name}
              </button>
              <PartyTag party={l.party} />
              <small className="muted">{l.area_name}</small>
            </span>
          ))
        ) : (
          <span className="muted">尚無資料</span>
        )}
      </div>
      <ElectionTable
        title={`${e.president_2024.label}（${e.president_2024.date}）`}
        current={county.elections.president_2024}
        previous={county.elections.president_2020}
        previousLabel={e.president_2020.label}
      />
      <ElectionTable
        title={`${e.mayor_2022.label}（${county.county === '嘉義市' ? '2022-12-18 延期選舉' : e.mayor_2022.date}）`}
        current={county.elections.mayor_2022}
        previous={county.elections.mayor_2018}
        previousLabel={e.mayor_2018.label}
      />
    </section>
  );
}

/* ---------- 數據總覽、排行榜 ---------- */

function MetricSelect({ label, options, value, onChange }: { label: string; options: { key: string; label: string }[]; value: string; onChange: (key: string) => void }) {
  return (
    <label className="stat-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const valuesOf = (metric: Metric, items: CountyItem[]) =>
  items.map((c) => ({ county: c.county, v: metric.value(c) })).filter((r): r is { county: string; v: number } => r.v !== null);

/** 數據總覽：主要指標的全國加總（人數、票數類）、縣市平均、最高、最低 */
function Overview({ metric, items }: { metric: Metric; items: CountyItem[] }) {
  const rows = valuesOf(metric, items).sort((a, b) => b.v - a.v);
  if (!rows.length) return null;
  const sum = rows.reduce((s, r) => s + r.v, 0);
  const tiles = [
    ...(isRate(metric.unit) ? [] : [{ value: fmt(sum, metric.unit), label: `全國加總（${rows.length} 縣市）` }]),
    { value: fmt(sum / rows.length, metric.unit), label: '縣市平均' },
    { value: fmt(rows[0].v, metric.unit), label: `最高：${rows[0].county}` },
    { value: fmt(rows[rows.length - 1].v, metric.unit), label: `最低：${rows[rows.length - 1].county}` },
  ];
  return (
    <div className="stat-row stat-overview" aria-label={`數據總覽：${metric.label}`}>
      {tiles.map((t) => (
        <div key={t.label} className="stat-tile">
          <b className="stat-value">{t.value}</b>
          <span className="stat-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

function Ranking({ metric, items, top, onSelect }: { metric: Metric; items: CountyItem[]; top: string; onSelect: (county: string) => void }) {
  const rows = valuesOf(metric, items)
    .sort((a, b) => b.v - a.v)
    .slice(0, top === '全部' ? undefined : Number(top));
  const max = Math.max(...rows.map((r) => r.v)) || 1;
  const min = Math.min(...rows.map((r) => r.v));
  return (
    <ol className="stat-ranking" aria-label={`${metric.label} 排行`}>
      {rows.map((r, i) => (
        <li key={r.county}>
          <span className="muted">{i + 1}</span>
          <button type="button" className="link-button" onClick={() => onSelect(r.county)}>
            {r.county}
          </button>
          <span className="stat-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, (r.v / max) * 100)}%`, background: colorAt('Viridis', max === min ? 1 : (r.v - min) / (max - min)) }} />
          </span>
          <span className="stat-bar-value">{fmt(r.v, metric.unit)}</span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- 頁面 ---------- */

/**
 * 縣市統計地圖：依 tw_statistic_map（app.py）的功能重做——數據總覽、互動地圖（指標、配色）、
 * 雙指標對比、時間差異（變化率）、排行榜、原始資料與 CSV 匯出；點縣市可看選舉細節與區域立委。
 * 人口與選舉是靜態資料（scripts/build-county-stats.mjs），立委名單來自同步資料。
 */
export function CountiesPage({ refreshToken, onOpenId }: CountiesPageProps) {
  const res = useApi<CountiesResponse>(buildUrl('/counties'), { refreshToken });
  const [tab, setTab] = useParam<Tab>('tab', 'map');
  const [metricKey, setMetricKey] = useParam<string>('metric', 'population');
  const [metric2Key, setMetric2Key] = useParam<string>('metric2', 'elderly_ratio');
  const [pairKey, setPairKey] = useParam<string>('pair', 'president_2024.民主進步黨.votes');
  const [scale, setScale] = useParam<ScaleName>('scale', 'YlOrRd');
  const [top, setTop] = useParam<string>('top', '10');
  const [selected, setSelected] = useParam<string>('county', '臺北市');

  const metrics = useMemo(() => (res.data ? buildMetrics(res.data) : []), [res.data]);
  const pairs = useMemo(() => (res.data ? buildPairs(metrics, res.data) : []), [metrics, res.data]);

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入縣市資料…" />;
  if (!res.data) {
    return res.phase === 'error' ? <ErrorState title="無法取得縣市資料（/api/v1/counties）" error={res.error} onRetry={res.reload} /> : null;
  }

  const data = res.data;
  const items = data.items;
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];
  const metric2 = metrics.find((m) => m.key === metric2Key) ?? metrics[1];
  const pair = pairs.find((p) => p.key === pairKey) ?? pairs[0];
  const current = items.find((c) => c.county === selected) ?? items[0];
  const mapValues = (m: Metric) => new Map(items.map((c) => [c.county, m.value(c)]));
  const formatOf = (m: Metric) => (v: number | null) => fmt(v, m.unit);

  // 時間差異：變化率 =（新 − 舊）÷ 舊
  const compareRows = items.map((c) => {
    const a = pair.older.value(c);
    const b = pair.newer.value(c);
    return { county: c.county, a, b, diff: a === null || b === null ? null : b - a, rate: a === null || b === null || a === 0 ? null : ((b - a) / a) * 100 };
  });
  const rateFormat = (v: number | null) => (v === null ? '無可比較資料' : `${signed(v, 1)}%`);

  const exportCsv = () =>
    downloadCsv(`縣市統計_${data.population_month}.csv`, [
      ['縣市', ...metrics.map((m) => `${m.label}（${m.unit}）`)],
      ...items.map((c) => [
        c.county,
        ...metrics.map((m) => {
          const v = m.value(c);
          return v === null ? '' : isRate(m.unit) ? v.toFixed(2) : v;
        }),
      ]),
    ]);
  const tableMetrics = metrics.slice(0, 6).includes(metric) ? metrics.slice(0, 6) : [...metrics.slice(0, 6), metric];

  return (
    <>
      <div className="page-head">
        <h1>縣市統計地圖</h1>
      </div>
      <p className="page-lead">
        22 縣市的人口（{data.population_month}）與選舉指標（2024／2020 總統、2022／2018 縣市長）。點地圖上的縣市可看選舉細節與區域立委；
        「得票趨勢」追蹤 2012 起歷次得票與轉折，「立委得票」追蹤每位委員歷次參選得票。
      </p>

      <div className="stat-controls">
        <MetricSelect label="主要分析指標" options={metrics} value={metric.key} onChange={setMetricKey} />
      </div>
      <Overview metric={metric} items={items} />

      <div className="segmented stat-tabs" role="group" aria-label="分析方式">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'map' ? (
        <div className="county-layout">
          <section className="panel county-map-panel">
            <div className="segmented stat-scales" role="group" aria-label="地圖配色">
              {SCALES.map((s) => (
                <button key={s.key} type="button" aria-pressed={scale === s.key} onClick={() => setScale(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <ChoroplethMap items={items} values={mapValues(metric)} scale={scale} format={formatOf(metric)} title={`${metric.label} - 地理分布圖`} selected={current.county} onSelect={setSelected} />
          </section>
          <CountyDetail county={current} data={data} onOpenId={onOpenId} />
        </div>
      ) : null}

      {tab === 'trend' ? <VoteTrends data={data} selected={current.county} onSelect={setSelected} /> : null}

      {tab === 'legislators' ? <LegislatorVotes refreshToken={refreshToken} county={current.county} onOpenId={onOpenId} /> : null}

      {tab === 'dual' ? (
        <>
          <div className="stat-controls">
            <MetricSelect label="第二個分析指標" options={metrics} value={metric2.key} onChange={setMetric2Key} />
          </div>
          <div className="stat-dual">
            <section className="panel">
              <ChoroplethMap items={items} values={mapValues(metric)} scale="Blues" format={formatOf(metric)} title={metric.label} selected={current.county} onSelect={setSelected} />
            </section>
            <section className="panel">
              <ChoroplethMap items={items} values={mapValues(metric2)} scale="OrRd" format={formatOf(metric2)} title={metric2.label} selected={current.county} onSelect={setSelected} />
            </section>
          </div>
        </>
      ) : null}

      {tab === 'compare' ? (
        <>
          <div className="stat-controls">
            <MetricSelect label="比較指標（前次 → 最近一次）" options={pairs} value={pair.key} onChange={setPairKey} />
          </div>
          <div className="county-layout">
            <section className="panel county-map-panel">
              <ChoroplethMap
                items={items}
                values={new Map(compareRows.map((r) => [r.county, r.rate]))}
                scale="RdYlGn"
                diverging
                format={rateFormat}
                title={`${pair.label} 變化率`}
                selected={current.county}
                onSelect={setSelected}
              />
            </section>
            <section className="panel">
              <div className="table-scroll">
                <table className="county-table">
                  <thead>
                    <tr>
                      <th scope="col">縣市</th>
                      <th scope="col" className="num">{data.elections[pair.older.election].label}</th>
                      <th scope="col" className="num">{data.elections[pair.newer.election].label}</th>
                      <th scope="col" className="num">差異</th>
                      <th scope="col" className="num">變化率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...compareRows]
                      .sort((x, y) => (y.rate ?? -Infinity) - (x.rate ?? -Infinity))
                      .map((r) => (
                        <tr key={r.county} aria-current={r.county === current.county ? 'true' : undefined}>
                          <td>
                            <button type="button" className="link-button" onClick={() => setSelected(r.county)}>
                              {r.county}
                            </button>
                          </td>
                          <td className="num">{fmt(r.a, pair.older.unit)}</td>
                          <td className="num">{fmt(r.b, pair.newer.unit)}</td>
                          <td className="num">{r.diff === null ? '—' : signed(r.diff, isRate(pair.newer.unit) ? 2 : 0)}</td>
                          <td className="num">{r.rate === null ? '—' : `${signed(r.rate, 1)}%`}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      ) : null}

      {tab === 'ranking' ? (
        <section className="panel">
          <div className="sectionhead">
            <h2>
              {metric.label}・{top === '全部' ? '全部縣市' : `前 ${top} 名`}
            </h2>
            <div className="segmented" role="group" aria-label="顯示名次數">
              {TOP_N.map((n) => (
                <button key={n} type="button" aria-pressed={top === n} onClick={() => setTop(n)}>
                  {n === '全部' ? '全部' : `前 ${n}`}
                </button>
              ))}
            </div>
          </div>
          <Ranking
            metric={metric}
            items={items}
            top={top}
            onSelect={(county) => {
              setSelected(county);
              setTab('map');
            }}
          />
        </section>
      ) : null}

      {tab === 'data' ? (
        <section className="panel">
          <div className="sectionhead">
            <h2>原始資料</h2>
            <button type="button" onClick={exportCsv}>
              匯出全部指標 CSV（{metrics.length} 欄）
            </button>
          </div>
          <div className="table-scroll">
            <table className="county-table">
              <thead>
                <tr>
                  <th scope="col">縣市</th>
                  {tableMetrics.map((m) => (
                    <th key={m.key} scope="col" className="num">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.county}>
                    <td>{c.county}</td>
                    {tableMetrics.map((m) => (
                      <td key={m.key} className="num">
                        {fmt(m.value(c), m.unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="muted">
        資料來源：
        {data.sources.map((s, i) => (
          <span key={s.url}>
            {i ? '、' : ''}
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              {s.label}
            </a>
          </span>
        ))}
        。統計地圖的顏色代表數值；選舉表中的顏色代表黨籍。「前次同黨得票」以政黨對照，無黨籍不比較。
      </p>
    </>
  );
}
