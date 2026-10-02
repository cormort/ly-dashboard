import { useState } from 'react';
import { buildUrl } from '../api/client';
import type { SplitTicketResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { partyStyle, sortParties } from '../lib/parties';
import { ErrorState, LoadingState } from './DataStates';

const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`);
const gap = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}`);

type SortKey = 'district' | 'cand' | 'pres' | 'list' | 'cand_pres' | 'cand_list' | 'pres_list';
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'cand', label: '區域立委' },
  { key: 'pres', label: '總統' },
  { key: 'list', label: '政黨票' },
  { key: 'cand_pres', label: '區域−總統' },
  { key: 'cand_list', label: '區域−政黨' },
  { key: 'pres_list', label: '總統−政黨' },
];

interface Row {
  county: string;
  district: string;
  name: string | null;
  elected: boolean;
  cand: number | null;
  pres: number | null;
  list: number | null;
  cand_pres: number | null;
  cand_list: number | null;
  pres_list: number | null;
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

/** 散佈圖：x＝同黨總統得票率，y＝區域立委得票率；對角線上方＝立委跑贏總統 */
function Scatter({ rows, county, color, onHover }: { rows: Row[]; county: string | null; color: string; onHover: (r: Row | null) => void }) {
  const pts = rows.filter((r) => r.cand !== null && r.pres !== null);
  const W = 420;
  const H = 360;
  const pad = { l: 44, r: 12, t: 12, b: 36 };
  const max = Math.min(100, Math.ceil((Math.max(...pts.flatMap((r) => [r.cand!, r.pres!]), 10) + 5) / 10) * 10);
  const x = (v: number) => pad.l + (v / max) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ticks = Array.from({ length: max / 10 + 1 }, (_, i) => i * 10).filter((t) => t % (max > 60 ? 20 : 10) === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="split-scatter" role="img" aria-label="各選區區域立委得票率對照同黨總統得票率，數值見下表">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(0)} x2={x(max)} y1={y(t)} y2={y(t)} className="trend-grid" />
          <text x={pad.l - 6} y={y(t) + 4} className="trend-axis" textAnchor="end">
            {t}%
          </text>
          <text x={x(t)} y={H - pad.b + 16} className="trend-axis" textAnchor="middle">
            {t}%
          </text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} className="trend-crosshair" />
      <text x={x(max) - 4} y={y(max) + 14} className="trend-axis" textAnchor="end">
        立委＝總統
      </text>
      <text x={(x(0) + x(max)) / 2} y={H - 4} className="trend-axis" textAnchor="middle">
        同黨總統得票率 →
      </text>
      <text x={12} y={(y(0) + y(max)) / 2} className="trend-axis" textAnchor="middle" transform={`rotate(-90 12 ${(y(0) + y(max)) / 2})`}>
        區域立委得票率 →
      </text>
      {/* 其他縣市先畫、淡色；所選縣市後畫、實色 */}
      {[...pts].sort((a, b) => Number(a.county === county) - Number(b.county === county)).map((r) => {
        const focus = county === null || r.county === county;
        return (
          <circle
            key={r.district}
            cx={x(r.pres!)}
            cy={y(r.cand!)}
            r={focus ? 6 : 4.5}
            fill={r.elected ? color : 'var(--surface)'}
            stroke={color}
            strokeWidth="2"
            opacity={focus ? 1 : 0.35}
            onMouseEnter={() => onHover(r)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${r.district} ${r.name}：立委 ${pct(r.cand)}、總統 ${pct(r.pres)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * 分裂投票：同一天投票的區域立委、總統、不分區政黨票，比較同一政黨在各立委選區的三種得票率。
 * 區域−總統 > 0：選民投給該黨立委、但總統票流向他黨（或立委個人吸票）。
 */
export function SplitTicket({ refreshToken, county }: { refreshToken: number; county: string }) {
  const [year, setYear] = useState<number | null>(null);
  const res = useApi<SplitTicketResponse>(buildUrl('/split-ticket', { year: year ?? undefined }), { refreshToken });
  const [partyChoice, setParty] = useState('民主進步黨');
  const [scope, setScope] = useState<'all' | 'county'>('all');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cand_pres', desc: true });
  const [hover, setHover] = useState<Row | null>(null);

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入分裂投票資料…" />;
  if (!res.data) return res.phase === 'error' ? <ErrorState title="無法取得分裂投票（/api/v1/split-ticket）" error={res.error} onRetry={res.reload} /> : null;

  const data = res.data;
  // 該年有推區域立委、也有總統或政黨票的政黨
  const parties = sortParties(new Set(data.items.flatMap((d) => d.candidates.map((c) => c.party)).filter((p) => p !== '無黨籍' && data.items.some((d) => d.president.votes[p] || d.party_list.votes[p]))));
  const party = parties.includes(partyChoice) ? partyChoice : parties[0];
  const color = partyStyle(party).color;

  const all: Row[] = data.items.map((d) => {
    const cand = d.candidates.filter((c) => c.party === party).sort((a, b) => b.votes - a.votes)[0];
    const share = (b: { valid: number; votes: Record<string, number> }) => (b.votes[party] === undefined ? null : (b.votes[party] / b.valid) * 100);
    const c = cand ? cand.pct : null;
    const p = share(d.president);
    const l = share(d.party_list);
    return { county: d.county, district: d.district, name: cand?.name ?? null, elected: Boolean(cand?.elected), cand: c, pres: p, list: l, cand_pres: diff(c, p), cand_list: diff(c, l), pres_list: diff(p, l) };
  });
  const rows = (scope === 'county' ? all.filter((r) => r.county === county) : all).sort((a, b) => {
    if (sort.key === 'district') return a.district.localeCompare(b.district, 'zh-Hant');
    const x = a[sort.key];
    const y = b[sort.key];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (sort.desc ? -1 : 1) * (x - y);
  });
  const withCand = rows.filter((r) => r.cand_pres !== null);
  const ahead = withCand.filter((r) => r.cand_pres! > 0).length;
  const avg = (key: 'cand_pres' | 'cand_list' | 'pres_list') => {
    const v = rows.map((r) => r[key]).filter((n): n is number => n !== null);
    return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
  };
  const short = partyStyle(party).short;

  return (
    <>
      <div className="stat-controls">
        <div className="segmented" role="group" aria-label="年份">
          {data.years.map((yr) => (
            <button key={yr} type="button" aria-pressed={data.year === yr} onClick={() => setYear(yr)}>
              {yr}
            </button>
          ))}
        </div>
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
        <div className="segmented" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            全部選區
          </button>
          <button type="button" aria-pressed={scope === 'county'} onClick={() => setScope('county')}>
            {county}
          </button>
        </div>
      </div>

      <div className="stat-row stat-overview">
        <div className="stat-tile">
          <b className="stat-value">
            {ahead}／{withCand.length}
          </b>
          <span className="stat-label">{short}立委得票率高於同黨總統的選區</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{gap(avg('cand_pres'))}</b>
          <span className="stat-label">平均 區域−總統（百分點）</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{gap(avg('cand_list'))}</b>
          <span className="stat-label">平均 區域−政黨票</span>
        </div>
        <div className="stat-tile">
          <b className="stat-value">{gap(avg('pres_list'))}</b>
          <span className="stat-label">平均 總統−政黨票</span>
        </div>
      </div>

      <div className="county-layout">
        <section className="panel">
          <h2>
            {data.year}・{short}：立委對照總統
          </h2>
          <p className="muted">
            每點一個立委選區；實心＝當選、空心＝落選。對角線上方＝立委得票率高於同黨總統{scope === 'county' ? `（${county}以實色標示）` : '（滑過點時同縣市以實色標示）'}。
          </p>
          <Scatter rows={all} county={scope === 'county' ? county : hover?.county ?? null} color={color} onHover={setHover} />
          <p className="stat-map-hover" aria-live="polite">
            {hover ? (
              <>
                <b>{hover.district}</b> {hover.name}：立委 {pct(hover.cand)}、總統 {pct(hover.pres)}、政黨票 {pct(hover.list)}
              </>
            ) : (
              <span className="muted">滑過點看選區</span>
            )}
          </p>
        </section>
        <section className="panel">
          <p className="muted">
            同一天、同一選區，{short}在三種選票的得票率與差距（百分點）。區域−總統為正：選民投{short}立委但總統投別黨，或立委個人吸票；
            總統−政黨為正：總統候選人拉抬超過政黨本身。沒有推區域立委的選區只比總統與政黨票。
          </p>
          <div className="table-scroll split-table">
            <table className="county-table">
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" className="link-button" onClick={() => setSort({ key: 'district', desc: false })}>
                      選區
                    </button>
                  </th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className="num" aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" className="link-button" onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}>
                        {c.label}
                        {sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.district} aria-current={hover?.district === r.district ? 'true' : undefined}>
                    <td>{r.district}</td>
                    <td className="num">
                      {r.name ? (
                        <>
                          {r.name}
                          {r.elected ? '＊' : ''} {pct(r.cand)}
                        </>
                      ) : (
                        <span className="muted">未推</span>
                      )}
                    </td>
                    <td className="num">{pct(r.pres)}</td>
                    <td className="num">{pct(r.list)}</td>
                    <td className="num">{gap(r.cand_pres)}</td>
                    <td className="num">{gap(r.cand_list)}</td>
                    <td className="num">{gap(r.pres_list)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">＊當選。總統與政黨票為同選區各投開票所加總（2020 有 2 所對不到選區）。</p>
        </section>
      </div>
    </>
  );
}
