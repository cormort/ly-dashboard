import { useMemo, useState, type CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { CountiesResponse, CountyElection, CountyElectionKey, CountyItem } from '../api/types';
import { ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { partyStyle } from '../lib/parties';

export interface CountiesPageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
}

type MetricKey = 'population' | 'voting_age' | 'elderly_ratio' | 'president_2024' | 'mayor_2022';

interface Metric {
  label: string;
  /** 人口類指標用灰階深淺；選舉類指標用勝選黨色，深淺代表與第二名的差距 */
  /** 選舉類指標對應的選舉 */
  election?: CountyElectionKey;
  value: (c: CountyItem) => number;
  display: (c: CountyItem) => string;
  /** 排行用的短版 */
  short: (c: CountyItem) => string;
}

const num = (n: number) => n.toLocaleString('zh-TW');
const pct = (n: number) => `${n.toFixed(2)}%`;
const ratio = (part: number, whole: number) => (part / whole) * 100;

const METRICS: Record<MetricKey, Metric> = {
  population: { label: '人口數', value: (c) => c.population, display: (c) => `${num(c.population)} 人`, short: (c) => num(c.population) },
  voting_age: { label: '選舉年齡人口', value: (c) => c.voting_age, display: (c) => `${num(c.voting_age)} 人`, short: (c) => num(c.voting_age) },
  elderly_ratio: {
    label: '老年人口比率',
    value: (c) => ratio(c.elderly, c.population),
    display: (c) => `${pct(ratio(c.elderly, c.population))}（${num(c.elderly)} 人）`,
    short: (c) => pct(ratio(c.elderly, c.population)),
  },
  president_2024: {
    label: '2024 總統',
    election: 'president_2024',
    value: (c) => c.elections.president_2024.margin_pct ?? 0,
    display: (c) => winnerText(c.elections.president_2024),
    short: (c) => winnerShort(c.elections.president_2024),
  },
  mayor_2022: {
    label: '2022 縣市長',
    election: 'mayor_2022',
    value: (c) => c.elections.mayor_2022.margin_pct ?? 0,
    display: (c) => winnerText(c.elections.mayor_2022),
    short: (c) => winnerShort(c.elections.mayor_2022),
  },
};

function winnerText(e: CountyElection): string {
  const [first] = e.candidates;
  return `${first.name}（${partyStyle(first.party).short}）領先 ${num(e.margin ?? 0)} 票、${(e.margin_pct ?? 0).toFixed(2)} 個百分點`;
}

function winnerShort(e: CountyElection): string {
  const [first] = e.candidates;
  return `${partyStyle(first.party).short} ${first.name} +${(e.margin_pct ?? 0).toFixed(2)}`;
}

/** 由網址 ?county=&metric= 還原狀態，切換時以 replaceState 寫回（可分享） */
function readParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}
function writeParams(next: Record<string, string>) {
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(next)) params.set(k, v);
  window.history.replaceState(null, '', `/counties?${params.toString()}`);
}

function CountyMap({
  items,
  metric,
  selected,
  onSelect,
}: {
  items: CountyItem[];
  metric: Metric;
  selected: string;
  onSelect: (county: string) => void;
}) {
  const values = items.map(metric.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fill = (c: CountyItem): CSSProperties => {
    const t = max === min ? 1 : (metric.value(c) - min) / (max - min);
    if (metric.election) {
      // 差距越大顏色越飽和；最少保留 30% 讓小差距的縣市也看得出黨色
      const color = partyStyle(c.elections[metric.election].candidates[0].party).color;
      return { fill: `color-mix(in srgb, ${color} ${Math.round(30 + 70 * t)}%, white)` };
    }
    return { fill: `color-mix(in srgb, var(--ink) ${Math.round(8 + 72 * t)}%, white)` };
  };
  return (
    <svg className="county-map" viewBox="0 0 530 735" role="group" aria-label={`縣市地圖：${metric.label}`}>
      {/* 金門、連江的插圖框 */}
      <rect className="county-inset" x="22" y="4" width="128" height="112" rx="6" />
      <rect className="county-inset" x="3" y="166" width="66" height="54" rx="6" />
      {items.map((c) => (
        <path
          key={c.county}
          d={c.path}
          className="county-shape"
          aria-current={c.county === selected ? 'true' : undefined}
          style={fill(c)}
          tabIndex={0}
          role="button"
          aria-label={`${c.county}：${metric.display(c)}`}
          onClick={() => onSelect(c.county)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(c.county);
            }
          }}
        >
          <title>{`${c.county}：${metric.display(c)}`}</title>
        </path>
      ))}
      <text x="26" y="134" className="county-inset-label">連江縣</text>
      <text x="6" y="238" className="county-inset-label">金門縣</text>
    </svg>
  );
}

function PartyTag({ party }: { party: string }) {
  const style = partyStyle(party);
  return (
    <span className="party-tag" style={{ '--party': style.color } as CSSProperties}>
      {style.short}
    </span>
  );
}

/** 一場選舉：各候選人得票、與前次同黨得票的增減、第一名與第二名的差距 */
function ElectionTable({
  title,
  current,
  previous,
  previousLabel,
}: {
  title: string;
  current: CountyElection;
  previous: CountyElection;
  previousLabel: string;
}) {
  const prevByParty = new Map<string, number>();
  for (const c of previous.candidates) if (c.party !== '無黨籍') prevByParty.set(c.party, (prevByParty.get(c.party) ?? 0) + c.votes);
  const [first, second] = current.candidates;
  return (
    <section className="county-election">
      <h3>{title}</h3>
      <p className="muted">
        {current.turnout !== null ? `投票率 ${pct(current.turnout)}・` : ''}有效票 {num(current.valid)}
        {current.electorate !== null ? `・選舉人 ${num(current.electorate)}` : ''}
      </p>
      {second ? (
        <p className="county-margin">
          <b>{first.name}</b> 領先 <b>{second.name}</b> {num(current.margin ?? 0)} 票（{(current.margin_pct ?? 0).toFixed(2)} 個百分點）
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
              const prev = c.party === '無黨籍' ? undefined : prevByParty.get(c.party);
              const diff = prev === undefined ? null : c.votes - prev;
              return (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>
                    <PartyTag party={c.party} />
                  </td>
                  <td className="num">{num(c.votes)}</td>
                  <td className="num">{pct(c.pct)}</td>
                  <td className="num">{prev === undefined ? '—' : num(prev)}</td>
                  <td className="num">{diff === null ? '—' : `${diff > 0 ? '+' : ''}${num(diff)}`}</td>
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
              {c.name} <PartyTag party={c.party} /> {num(c.votes)} 票（{pct(c.pct)}）
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
          <span className="stat-label">選舉年齡人口（20 歲以上，{pct(ratio(county.voting_age, county.population))}）</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{num(county.elderly)}</b>
          <span className="stat-label">老年人口（65 歲以上，{pct(ratio(county.elderly, county.population))}）</span>
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

/**
 * 縣市：地圖＋指標切換（參考 tw_statistic_map 的縣市面量圖），點縣市看人口、
 * 最近一次總統與縣市長選舉結果（與前次比較、與第二名差距）以及該縣市區域立委。
 * 人口與選舉是靜態資料（scripts/build-county-stats.mjs），立委名單來自同步資料。
 */
export function CountiesPage({ refreshToken, onOpenId }: CountiesPageProps) {
  const res = useApi<CountiesResponse>(buildUrl('/counties'), { refreshToken });
  const [metricKey, setMetricKey] = useState<MetricKey>(() => {
    const raw = readParam('metric');
    return raw && raw in METRICS ? (raw as MetricKey) : 'population';
  });
  const [selected, setSelected] = useState<string>(() => readParam('county') ?? '臺北市');
  const metric = METRICS[metricKey];

  const items = res.data?.items ?? [];
  const ranked = useMemo(() => [...items].sort((a, b) => metric.value(b) - metric.value(a)), [items, metric]);
  const current = items.find((c) => c.county === selected) ?? items[0];

  const select = (county: string) => {
    setSelected(county);
    writeParams({ county });
  };

  return (
    <>
      <div className="page-head">
        <h1>縣市</h1>
        <div className="segmented county-metrics" role="group" aria-label="地圖指標">
          {(Object.keys(METRICS) as MetricKey[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={metricKey === key}
              onClick={() => {
                setMetricKey(key);
                writeParams({ metric: key });
              }}
            >
              {METRICS[key].label}
            </button>
          ))}
        </div>
      </div>
      <p className="page-lead">
        點地圖或排行選擇縣市。選舉指標以勝選政黨著色，顏色越深代表與第二名的差距越大；人口指標顏色越深數值越高。
      </p>

      {res.phase === 'loading' && !res.data ? <LoadingState label="載入縣市資料…" /> : null}
      {res.phase === 'error' && !res.data ? (
        <ErrorState title="無法取得縣市資料（/api/v1/counties）" error={res.error} onRetry={res.reload} />
      ) : null}

      {res.data && current ? (
        <>
          <div className="county-layout">
            <section className="panel county-map-panel" aria-label="縣市地圖與排行">
              <CountyMap items={items} metric={metric} selected={current.county} onSelect={select} />
              <ol className="county-ranking">
                {ranked.map((c, i) => (
                  <li key={c.county}>
                    <button type="button" aria-pressed={c.county === current.county} onClick={() => select(c.county)}>
                      <span className="muted">{i + 1}</span>
                      <b>{c.county}</b>
                      <span title={metric.display(c)}>{metric.short(c)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
            <CountyDetail county={current} data={res.data} onOpenId={onOpenId} />
          </div>
          <p className="muted">
            人口統計：{res.data.population_month}。資料來源：
            {res.data.sources.map((s, i) => (
              <span key={s.url}>
                {i ? '、' : ''}
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.label}
                </a>
              </span>
            ))}
            。「前次同黨得票」以政黨對照，無黨籍不比較。
          </p>
        </>
      ) : null}
    </>
  );
}
