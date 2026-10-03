import { useMemo, useState } from 'react';
import { buildUrl } from '../api/client';
import type { CouncilDistrict, CouncilResponse, CouncilTerm } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { PartyTag } from '../components/PartyTag';
import { useApi } from '../hooks/useApi';
import { useQueryState } from '../hooks/useQueryState';
import { partyStyle } from '../lib/parties';

export interface CouncilPageProps {
  refreshToken: number;
}

const num = (n: number, digits = 0) => n.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const numOrDash = (n: number | null, digits = 0) => (n === null || !Number.isFinite(n) ? '—' : num(n, digits));
const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${num(n, digits)}`;

/** 名單裡的「黨籍 姓名（票數）」單一格；沒有票數時只顯示黨籍與姓名（例如「上屆當選但沒參選」） */
function Person({ name, party, votes, pct, mark }: { name: string; party: string; votes?: number; pct?: number; mark?: string }) {
  const detail = [votes === undefined ? null : `${num(votes)} 票（${num(pct ?? 0, 2)}%）`, mark ?? null].filter(Boolean).join('・');
  return (
    <span className="council-person">
      <PartyTag party={party} />
      <b>{name}</b>
      {detail ? <small className="muted">{detail}</small> : null}
    </span>
  );
}

/** 席次分布長條：顏色只代表黨籍 */
function SeatBar({ parties, total }: { parties: { party: string; seats: number }[]; total: number }) {
  return (
    <div className="bar" role="img" aria-label={parties.filter((p) => p.seats > 0).map((p) => `${p.party} ${p.seats} 席`).join('、')}>
      {parties
        .filter((p) => p.seats > 0)
        .map((p) => (
          <span key={p.party} style={{ background: partyStyle(p.party).color, flexGrow: p.seats }} title={`${p.party} ${p.seats}／${total} 席`} />
        ))}
    </div>
  );
}

/** 指標卡：數字＋說明 */
function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  // 原住民議員的姓名可能長到 20 個字（漢名＋族語名），用 22px 會把卡片撐成三行
  const long = value.length > 6;
  return (
    <div className="stat-tile">
      <b className={long ? 'stat-value stat-value-long' : 'stat-value'}>{value}</b>
      <span className="stat-label">{label}</span>
      {hint ? <small className="muted">{hint}</small> : null}
    </div>
  );
}

/* ---------- 政黨 ---------- */

function PartyPanel({ term }: { term: CouncilTerm }) {
  const rows = term.parties.filter((p) => p.seats > 0 || p.pct >= 1);
  return (
    <section className="panel" aria-label="政黨席次與得票">
      <div className="sectionhead">
        <h2>政黨席次與得票</h2>
        <span className="muted">
          {term.seats} 席・有效票 {num(term.valid)}
        </span>
      </div>
      <SeatBar parties={term.parties} total={term.seats} />
      <div className="table-wrap">
        <table className="roster">
          <thead>
            <tr>
              <th scope="col">政黨</th>
              <th scope="col" className="num">席次</th>
              <th scope="col" className="num">席次率</th>
              <th scope="col" className="num">得票數</th>
              <th scope="col" className="num">得票率</th>
              <th scope="col" className="num">超額代表（席次率−得票率）</th>
              <th scope="col" className="num">候選人數</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              // 正數＝用比得票率更少的票拿到更多席次（制度紅利），負數＝票多席少
              const over = p.seat_pct - p.pct;
              return (
                <tr key={p.party}>
                  <td>
                    <PartyTag party={p.party} />
                  </td>
                  <td className="num">{p.seats}</td>
                  <td className="num">{num(p.seat_pct, 2)}%</td>
                  <td className="num">{num(p.votes)}</td>
                  <td className="num">{num(p.pct, 2)}%</td>
                  <td className="num">{signed(over, 2)} 個百分點</td>
                  <td className="num">{p.candidates}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        超額代表＝席次率減得票率。正數代表這個政黨用較少的票拿到較多席次。得票率以全部有效票（含原住民選舉區）為分母，
        與各選區分開計票不同，看的是全市整體。
      </p>
    </section>
  );
}

/* ---------- 與上屆比較 ---------- */

function ComparePanel({ term }: { term: CouncilTerm }) {
  const c = term.compare;
  if (!c) return null;
  const changed = c.parties.filter((p) => p.seats > 0 || p.prev_seats > 0);
  return (
    <section className="panel" aria-label={`與${c.label}比較`}>
      <div className="sectionhead">
        <h2>
          與{c.label}（{c.year}）比較
        </h2>
        <span className="muted">
          連任 {c.re_elected} 人・新任 {c.freshmen} 人・現任落選 {c.defeated_incumbents.length} 人・上屆當選本屆未參選{' '}
          {c.not_running.length} 人
        </span>
      </div>
      <div className="table-wrap">
        <table className="roster">
          <thead>
            <tr>
              <th scope="col">政黨</th>
              <th scope="col" className="num">{c.year} 席次</th>
              <th scope="col" className="num">{term.year} 席次</th>
              <th scope="col" className="num">增減</th>
              <th scope="col" className="num">{term.year} 得票率</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((p) => (
              <tr key={p.party}>
                <td>
                  <PartyTag party={p.party} />
                </td>
                <td className="num">{p.prev_seats}</td>
                <td className="num">{p.seats}</td>
                <td className="num">{p.delta === 0 ? '—' : signed(p.delta)}</td>
                <td className="num">{num(p.pct, 2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="council-columns">
        <div>
          <h3>現任落選（{c.defeated_incumbents.length}）</h3>
          {c.defeated_incumbents.length ? (
            <ul className="plain-list">
              {c.defeated_incumbents.map((d) => (
                <li key={`${d.name}-${d.district}`}>
                  <Person name={d.name} party={d.party} votes={d.votes} pct={d.pct} mark={d.district} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">這一屆沒有現任議員競選連任失敗。</p>
          )}
        </div>
        <div>
          <h3>
            {c.year} 當選但這一屆未列名候選人（{c.not_running.length}）
          </h3>
          {c.not_running.length ? (
            <ul className="plain-list">
              {c.not_running.map((d) => (
                <li key={`${d.name}-${d.district}`}>
                  <Person name={d.name} party={d.party} mark={d.district} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">上一屆的當選人這一屆全部都有參選。</p>
          )}
        </div>
      </div>
      <p className="muted">
        「連任／新任」採中選會的「現任」欄位
        {c.incumbent_source === 'cec'
          ? `；其中 ${c.incumbent_mismatch.length} 人與「上一屆當選名單」比對不同（多為遞補、補選或換選區）。`
          : '（這一屆的檔案沒有這個欄位，改用上一屆的當選名單比對）。'}
        「未列名候選人」包含轉任、辭職與逝世。
      </p>
    </section>
  );
}

/* ---------- 選區 ---------- */

function DistrictRow({ d }: { d: CouncilDistrict }) {
  const winners = d.list.filter((c) => c.elected);
  return (
    <details className="council-district">
      <summary>
        <b>{d.name}</b>
        <span className="muted">{d.area.length ? d.area.join('、') : '全市原住民選舉區'}</span>
        <span className="council-seats">
          應選 {d.seats} 席・候選 {d.candidate_count} 人・選舉人數 {num(d.electorate)}・投票率 {num(d.turnout, 2)}%
        </span>
        <span className="council-winners">
          {winners.map((c) => (
            <span key={c.name} className="council-winner">
              <PartyTag party={c.party} />
              {c.name}
              {c.quota ? <small className="muted">（婦女保障）</small> : null}
            </span>
          ))}
        </span>
      </summary>
      <div className="table-wrap">
        <table className="roster">
          <thead>
            <tr>
              <th scope="col" className="num">名次</th>
              <th scope="col" className="num">號次</th>
              <th scope="col">姓名</th>
              <th scope="col">政黨</th>
              <th scope="col" className="num">得票數</th>
              <th scope="col" className="num">得票率</th>
              <th scope="col">結果</th>
              <th scope="col" className="num">年齡</th>
              <th scope="col">學歷</th>
            </tr>
          </thead>
          <tbody>
            {d.list.map((c, i) => (
              <tr key={c.no} className={c.elected ? 'council-elected' : undefined}>
                <td className="num">{i + 1}</td>
                <td className="num">{c.no}</td>
                <td>{c.name}</td>
                <td>
                  <PartyTag party={c.party} />
                </td>
                <td className="num">{num(c.votes)}</td>
                <td className="num">{num(c.pct, 2)}%</td>
                <td>{c.elected ? (c.quota ? '當選（婦女保障）' : '當選') : '落選'}</td>
                <td className="num">{c.age ?? '—'}</td>
                <td>{c.education ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.list.some((c) => c.quota) ? (
        <p className="muted">
          這個選舉區有婦女保障名額當選人（{d.list.filter((c) => c.quota).map((c) => c.name).join('、')}）：
          保障名額讓得票數較少的女性能當選，因此當選者不一定都排在落選者前面，排序仍依得票數。
        </p>
      ) : null}
      <p className="muted">
        有效票 {num(d.valid)}・無效票 {num(d.invalid)}・投票數 {num(d.ballots)}・選舉區人口 {num(d.population)}
        {d.first_loser ? `｜落選頭 ${d.first_loser.name}（${num(d.first_loser.votes)} 票，差 ${numOrDash(d.first_loser.margin)} 票）` : ''}
        {d.last_winner ? `｜最低當選票 ${d.last_winner.name}（${num(d.last_winner.votes)} 票）` : ''}
      </p>
    </details>
  );
}

/* ---------- 頁面 ---------- */

export function CouncilPage({ refreshToken }: CouncilPageProps) {
  // 縣市放在網址上（沿用全站的篩選條件序列化），所以切換縣市可以分享、也可以按上一頁
  const query = useQueryState();
  const county = query.filters.county;
  const res = useApi<CouncilResponse>(buildUrl('/council', { county }), { refreshToken });
  const [year, setYear] = useState<number | null>(null);

  const terms = res.data?.terms ?? [];
  const term = useMemo(() => terms.find((t) => t.year === year) ?? terms[0] ?? null, [terms, year]);

  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入議員選舉資料…" />;
  if (res.phase === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data || !term) return <EmptyState message="沒有議員選舉資料" hint="請先跑 node scripts/build-council-stats.mjs 產生資料檔。" />;

  const area = term.kinds.find((k) => k.kind === 'area') ?? null;
  const kindText = term.kinds.map((k) => `${k.label} ${k.seats}`).join('／');
  const top = term.stats.top;
  const lowest = term.stats.lowest_winner;
  // 選舉區會隨人口重劃（新北市 2022 由 10 個分為 11 個、臺北市 2022 由 63 席減為 61 席），
  // 所以跨屆比較用席次與政黨，並把「選舉區有變」直接講出來
  const areaCounts = terms.map((t) => ({ year: t.year, n: t.districts.filter((d) => d.kind === 'area').length, seats: t.seats }));
  const oldest = areaCounts.at(-1);
  const newest = areaCounts[0];
  const redrawn = Boolean(oldest && newest && oldest.n !== newest.n);
  // 席次或選舉區有變才多寫這句；兩者都沒變（例如新北市四屆都是 66 席、11 個區域選舉區）就不囉嗦
  const shape =
    oldest && newest && (redrawn || oldest.seats !== newest.seats)
      ? ` —— 席次與選舉區會隨人口變動重劃（${res.data.county}：${oldest.year} 年 ${oldest.seats} 席${redrawn ? `、區域選舉區 ${oldest.n} 個` : ''} → ${newest.year} 年 ${newest.seats} 席${redrawn ? `、${newest.n} 個` : ''}）`
      : '';

  return (
    <div className="council">
      <div className="page-head">
        <h1>{res.data.county}議員</h1>
        <p className="page-lead">
          直轄市議員選舉結果。跨屆比較以「席次」與「政黨」為準，不直接比選舉區編號{shape}。
        </p>
      </div>

      <div className="council-controls">
        <div className="council-switches">
          {res.data.counties.length > 1 ? (
            <div className="segmented" role="group" aria-label="選擇縣市">
              {res.data.counties.map((name) => (
                <button key={name} type="button" aria-pressed={name === res.data?.county} onClick={() => query.update({ county: name })}>
                  {name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="segmented" role="group" aria-label="選擇屆次">
            {terms.map((t) => (
              <button key={t.year} type="button" aria-pressed={t.year === term.year} onClick={() => setYear(t.year)}>
                {t.label}（{t.year}）
              </button>
            ))}
          </div>
        </div>
        <span className="muted">
          投票日 {term.date}・資料來源{' '}
          <a href={res.data.source.url} target="_blank" rel="noreferrer">
            {res.data.source.label}
          </a>
        </span>
      </div>

      <div className="stat-row">
        <Tile value={`${term.seats} 席`} label={`${term.label}議員總席次`} hint={kindText} />
        <Tile value={num(term.stats.candidates)} label="候選人數" hint={`區域 ${num(area?.candidate_count ?? 0)} 人`} />
        <Tile
          value={numOrDash(area?.electorate ?? null)}
          label="區域選舉人數"
          hint="不含原住民選舉人（原住民另有選舉區）"
        />
        <Tile value={`${numOrDash(area?.turnout ?? null, 2)}%`} label="區域投票率" hint={`有效票 ${numOrDash(area?.valid ?? null)}`} />
        <Tile
          value={top ? top.name : '—'}
          label="最高票"
          hint={top ? `${top.party}・${num(top.votes)} 票・${top.district}` : undefined}
        />
        <Tile
          value={lowest ? lowest.name : '—'}
          label="當選最低票"
          hint={lowest ? `${lowest.party}・${num(lowest.votes)} 票` : undefined}
        />
      </div>

      <PartyPanel term={term} />
      <ComparePanel term={term} />

      <section className="panel" aria-label="各選舉區">
        <div className="sectionhead">
          <h2>各選舉區</h2>
          <span className="muted">{term.districts.length} 個選舉區・點開看完整得票</span>
        </div>
        <div className="council-districts">
          {term.districts.map((d) => (
            <DistrictRow key={`${d.kind}-${d.no}`} d={d} />
          ))}
        </div>
      </section>

      <section className="panel" aria-label="歷屆">
        <div className="sectionhead">
          <h2>歷屆（{terms.map((t) => t.year).join('／')}）</h2>
        </div>
        <div className="table-wrap">
          <table className="roster">
            <thead>
              <tr>
                <th scope="col">屆次</th>
                <th scope="col">投票日</th>
                <th scope="col" className="num">席次</th>
                <th scope="col" className="num">候選人數</th>
                <th scope="col" className="num">區域選舉人數</th>
                <th scope="col" className="num">區域投票率</th>
                <th scope="col">席次最多政黨</th>
              </tr>
            </thead>
            <tbody>
              {terms.map((t) => {
                const a = t.kinds.find((k) => k.kind === 'area') ?? null;
                const first = t.parties.find((p) => p.seats > 0) ?? null;
                return (
                  <tr key={t.year} className={t.year === term.year ? 'council-elected' : undefined}>
                    <td>
                      <button type="button" className="name-button" onClick={() => setYear(t.year)}>
                        {t.label}
                      </button>
                    </td>
                    <td>{t.date}</td>
                    <td className="num">{t.seats}</td>
                    <td className="num">{t.stats.candidates}</td>
                    <td className="num">{numOrDash(a?.electorate ?? null)}</td>
                    <td className="num">{numOrDash(a?.turnout ?? null, 2)}%</td>
                    <td>
                      {first ? (
                        <>
                          <PartyTag party={first.party} /> {first.seats} 席（{num(first.pct, 2)}%）
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

      <p className="muted">
        {res.data.note}資料檔在 <code>server/council-stats.json</code>，由 <code>scripts/build-council-stats.mjs</code> 產生。
        {res.data.warnings.length ? `注意：${res.data.warnings.join('；')}` : ''}
      </p>
    </div>
  );
}
