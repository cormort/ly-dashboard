import { useState } from 'react';
import { buildUrl } from '../api/client';
import type { LegislatorVotesResponse, PartyShare } from '../api/types';
import { useApi } from '../hooks/useApi';
import { ErrorState, LoadingState } from './DataStates';
import { PartyTag } from './PartyTag';

const num = (n: number) => n.toLocaleString('zh-TW');
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

const ALL = '全部';
const pt = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;

type Basis = 'party_list' | 'president';
const BASIS: Record<Basis, string> = { party_list: '同黨政黨票', president: '同黨總統票' };

/** 個人票對照政黨票的一格：政黨得票率，以及個人比它多幾個百分點 */
function ShareCell({ share }: { share: PartyShare | null }) {
  if (!share) return <td className="num">—</td>;
  return (
    <td className="num">
      {share.pct.toFixed(2)}%<small className="trend-diff">個人 {pt(share.over_pct)}</small>
    </td>
  );
}

/**
 * 個人票對照政黨票：最近一次大選，委員得票率減去同選區同黨的不分區政黨票（或總統票）得票率。
 * 正值＝個人比黨強，負值＝靠黨拉抬。長條以 0 為中心。
 */
function PersonalVsParty({ items, year, onOpenId }: { items: LegislatorVotesResponse['items']; year: number; onOpenId: (id: string) => void }) {
  const [basis, setBasis] = useState<Basis>('party_list');
  // 只比最近一次大選（本屆），避免拿多年前、不同黨籍的參選紀錄來比
  const rows = items
    .map((i) => ({ l: i.legislator, h: i.history.find((h) => h.year === year && !h.by_election && h[basis]) }))
    .filter((r): r is { l: typeof r.l; h: NonNullable<typeof r.h> } => Boolean(r.h))
    .sort((a, b) => b.h[basis]!.over_pct - a.h[basis]!.over_pct);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => Math.abs(r.h[basis]!.over_pct)), 1);
  const avg = rows.reduce((s, r) => s + r.h[basis]!.over_pct, 0) / rows.length;
  return (
    <section className="panel">
      <div className="sectionhead">
        <h2>個人票對照政黨票</h2>
        <div className="segmented" role="group" aria-label="對照基準">
          {(Object.keys(BASIS) as Basis[]).map((b) => (
            <button key={b} type="button" aria-pressed={basis === b} onClick={() => setBasis(b)}>
              {BASIS[b]}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        {year} 年區域立委得票率，減去同選區{BASIS[basis]}的得票率；正值代表個人比黨強。此範圍平均 {pt(avg)} 個百分點，可當比較基準
        （政黨票分散給許多小黨，區域候選人通常高於政黨票）。
        {basis === 'president' ? '2024 總統為三強競爭（民眾黨約 26%），沒有民眾黨對手的選區差距會偏大，建議以政黨票為主。' : '政黨票不受候選人人數影響，較適合跨選區比較。'}
      </p>
      <ol className="pvp-list">
        {rows.map(({ l, h }) => {
          const share = h[basis]!;
          const w = (Math.abs(share.over_pct) / max) * 50;
          return (
            <li key={l.id}>
              <button type="button" className="link-button" onClick={() => onOpenId(l.id)}>
                {l.name}
              </button>
              <PartyTag party={h.party} />
              <span className="pvp-bar" aria-hidden="true">
                <i style={share.over_pct >= 0 ? { left: '50%', width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }} />
              </span>
              <span className="pvp-value">
                {pt(share.over_pct)} 個百分點
                <small className="muted">
                  {h.year} {h.district}・個人 {h.pct.toFixed(2)}% vs {share.pct.toFixed(2)}%（{share.over >= 0 ? '多' : '少'} {num(Math.abs(share.over))} 票）
                </small>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
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

      <PersonalVsParty items={withHistory} year={res.data.years[res.data.years.length - 1]} onOpenId={onOpenId} />

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
                    <th scope="col" className="num">同黨政黨票</th>
                    <th scope="col" className="num">同黨總統票</th>
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
                        <ShareCell share={h.party_list} />
                        <ShareCell share={h.president} />
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
        對手：當選者對照最高票落選者，落選者對照最低票當選者。資料為 2012 起歷屆大選與補選。同黨政黨票／總統票為同一天、同選區各投開票所加總（補選沒有）。來源：
        {res.data.sources.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener">
            {s.label}
          </a>
        ))}
      </p>
    </>
  );
}
