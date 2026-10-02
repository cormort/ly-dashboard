import { useState, type CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { LegislatorVotesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { partyStyle } from '../lib/parties';
import { ErrorState, LoadingState } from './DataStates';

const num = (n: number) => n.toLocaleString('zh-TW');
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

const ALL = '全部';

function PartyTag({ party }: { party: string }) {
  const style = partyStyle(party);
  return (
    <span className="party-tag" style={{ '--party': style.color } as CSSProperties}>
      {style.short}
    </span>
  );
}

/**
 * 立委得票追蹤：在職委員 2012 起每次參選區域／原住民立委的得票、名次、與對手差距、與自己上一次的增減。
 * 增減方向與上一次相反時標「轉折」。不分區委員若未曾參選區域則沒有紀錄。
 */
export function LegislatorVotes({ refreshToken, county, onOpenId }: { refreshToken: number; county: string; onOpenId: (id: string) => void }) {
  const res = useApi<LegislatorVotesResponse>(buildUrl('/legislator-votes'), { refreshToken });
  const [scope, setScope] = useState<'county' | 'all'>('county');
  const [q, setQ] = useState('');

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入立委得票…" />;
  if (!res.data) return res.phase === 'error' ? <ErrorState title="無法取得立委得票（/api/v1/legislator-votes）" error={res.error} onRetry={res.reload} /> : null;

  const keyword = q.trim();
  const items = res.data.items.filter((i) => {
    if (keyword) return i.legislator.name.includes(keyword) || (i.legislator.area_name ?? '').includes(keyword);
    return scope === 'all' || i.legislator.region === county;
  });
  const withHistory = items.filter((i) => i.history.length);

  return (
    <>
      <div className="stat-controls">
        <div className="segmented" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'county'} onClick={() => setScope('county')}>
            {county}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {ALL}委員
          </button>
        </div>
        <label className="stat-control">
          <span>搜尋委員或選區</span>
          <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="例如：王鴻薇、臺中市" />
        </label>
        <span className="muted">
          {withHistory.length} 位有參選紀錄{items.length > withHistory.length ? `（另 ${items.length - withHistory.length} 位不分區委員未曾參選區域）` : ''}
        </span>
      </div>

      {withHistory.length === 0 ? <p className="muted">此範圍沒有區域或原住民立委的參選紀錄（{county}可能只有不分區委員）。</p> : null}

      <div className="legislator-votes">
        {withHistory.map(({ legislator: l, history }) => (
          <section key={l.id} className="panel legislator-votes-card" aria-label={`${l.name}得票紀錄`}>
            <div className="sectionhead">
              <h3>
                <button type="button" className="name-button" onClick={() => onOpenId(l.id)}>
                  {l.name}
                </button>{' '}
                <PartyTag party={l.party} /> <small className="muted">{l.area_name}</small>
              </h3>
            </div>
            <div className="table-scroll">
              <table className="county-table">
                <thead>
                  <tr>
                    <th scope="col">年度</th>
                    <th scope="col">選區</th>
                    <th scope="col">政黨</th>
                    <th scope="col" className="num">得票數</th>
                    <th scope="col" className="num">得票率</th>
                    <th scope="col" className="num">與上次相比</th>
                    <th scope="col">結果</th>
                    <th scope="col" className="num">與對手差距</th>
                    <th scope="col">對手</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => {
                    const prev = history[i - 1]?.change ?? null;
                    const turn = h.change !== null && prev !== null && h.change !== 0 && prev !== 0 && Math.sign(h.change) !== Math.sign(prev);
                    return (
                      <tr key={`${h.year}-${h.district}-${h.by_election}`}>
                        <td>
                          {h.year}
                          {h.by_election ? <small className="pill">補選</small> : null}
                        </td>
                        <td>{h.district}</td>
                        <td>
                          <PartyTag party={h.party} />
                        </td>
                        <td className="num">{num(h.votes)}</td>
                        <td className="num">{h.pct.toFixed(2)}%</td>
                        <td className={`num${turn ? ' trend-turn' : ''}`}>
                          {h.change === null ? '—' : signed(h.change)}
                          {turn ? <small> 轉折</small> : null}
                        </td>
                        <td>
                          {h.elected ? '當選' : '落選'}
                          <small className="muted">
                            {' '}
                            第 {h.rank}／{h.candidates} 名{h.seats > 1 ? `，應選 ${h.seats}` : ''}
                          </small>
                        </td>
                        <td className="num">
                          {h.margin === null ? '—' : `${signed(h.margin)} 票`}
                          {h.margin_pct !== null ? <small className="muted"> {h.margin_pct > 0 ? '+' : ''}{h.margin_pct.toFixed(2)} 個百分點</small> : null}
                        </td>
                        <td>
                          {h.rival ? (
                            <>
                              {h.rival.name} <PartyTag party={h.rival.party} />
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
      <p className="muted">
        對手：當選者對照最高票落選者，落選者對照最低票當選者。資料為 2012 起歷屆大選與補選。來源：
        {res.data.sources.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener">
            {s.label}
          </a>
        ))}
      </p>
    </>
  );
}
