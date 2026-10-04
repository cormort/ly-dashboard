import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { CouncilCandidate, CouncilDistrict, CouncilResponse, CouncilTerm } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { PartyTag } from '../components/PartyTag';
import { useApi } from '../hooks/useApi';
import { useParam } from '../hooks/useParam';
import { partyStyle } from '../lib/parties';

export interface CouncilPageProps {
  refreshToken: number;
}

const num = (n: number, digits = 0) => n.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const numOrDash = (n: number | null, digits = 0) => (n === null || !Number.isFinite(n) ? '—' : num(n, digits));
const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${num(n, digits)}`;

/** 得票由高到低的名單裡「當選」不一定是前 N 名（婦女保障名額），所以結果欄自己講清楚 */
const resultText = (c: CouncilCandidate) => (c.elected ? (c.quota ? '當選（婦女保障）' : '當選') : '落選');

/**
 * 落選頭與最低票當選人的差距。`margin` 是「最低票當選 − 落選頭」，最低票當選人是婦女保障名額時
 * 會是負數（落選頭的票反而比較多），直接印「差 -534 票」看起來像資料錯了，所以換個講法。
 */
export function marginText(d: Pick<CouncilDistrict, 'first_loser'>): string {
  const loser = d.first_loser;
  if (!loser) return '';
  const head = `｜落選頭 ${loser.name}（${num(loser.votes)} 票`;
  if (loser.margin !== null && loser.margin < 0) return `${head}，比婦女保障名額當選人多 ${num(-loser.margin)} 票）`;
  return `${head}，差 ${numOrDash(loser.margin)} 票）`;
}

/** 粉專對照表的現任狀態裡，要標在姓名旁的離任原因（其餘如議長、遞補不標） */
const DEPARTED = new Set(['轉任立委', '病逝']);
const departedNote = (c: CouncilCandidate) => (c.facebook_status && DEPARTED.has(c.facebook_status) ? c.facebook_status : undefined);

/**
 * 議會名和現在不同的屆次要講清楚：桃園 2009 那一屆是升格前的「桃園縣議會」（桃園縣議員第 17 屆），
 * 但資料掛在「桃園市」底下。不講的話，頁面標題寫「桃園市議員」、內容卻是桃園縣議員的數字，
 * 看起來會像是資料錯了。
 */
export function upgradedNotes(county: string, terms: Pick<CouncilTerm, 'year' | 'label' | 'body'>[]): string[] {
  const body = `${county}議會`;
  return terms.filter((t) => t.body !== body).map((t) => `${t.year} 年投票時還沒有${body}，那一屆是${t.body}（${t.label}）。`);
}

/** 姓名連到政黨色：沿用各縣市動態的 `.region-person`（底色線代表黨籍），不另外塞標籤 */
function Person({ name, party, note, facebook }: { name: string; party: string; note?: string; facebook?: string }) {
  return (
    <span className="region-person" style={{ '--party': partyStyle(party).color } as CSSProperties}>
      {facebook ? (
        <a href={facebook} target="_blank" rel="noopener noreferrer" title={`${name} 的 Facebook 粉專`}>
          {name}
        </a>
      ) : (
        name
      )}
      {note ? <small className="muted">（{note}）</small> : null}
    </span>
  );
}

/** 席次分布長條：顏色只代表黨籍（lib/parties.ts 是唯一定義處） */
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

/** 指標卡：長字串（原住民議員的姓名可能 20 個字）要縮字級，不然卡片會被撐成三行 */
function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="stat-tile">
      <b className={value.length > 6 ? 'stat-value council-value-long' : 'stat-value'}>{value}</b>
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
        與各選舉區分開計票不同，看的是全市整體。
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
      <div className="stat-dual">
        <div>
          <h3 className="regions-title">現任落選（{c.defeated_incumbents.length}）</h3>
          {c.defeated_incumbents.length ? (
            <ul className="council-people">
              {c.defeated_incumbents.map((p) => (
                <li key={`${p.name}-${p.district}`}>
                  <Person name={p.name} party={p.party} />
                  <small className="muted">
                    {p.district}・{num(p.votes)} 票（{num(p.pct, 2)}%）
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">這一屆沒有現任議員競選連任失敗。</p>
          )}
        </div>
        <div>
          <h3 className="regions-title">{c.year} 當選但這一屆未列名候選人（{c.not_running.length}）</h3>
          {c.not_running.length ? (
            <ul className="council-people">
              {c.not_running.map((p) => (
                <li key={`${p.name}-${p.district}`}>
                  <Person name={p.name} party={p.party} />
                  <small className="muted">{p.district}</small>
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
          : '（這一屆的檔案整欄都是「非現任」，沒有可用的註記，改用上一屆的當選名單比對）。'}
        「未列名候選人」包含轉任、辭職與逝世。
      </p>
    </section>
  );
}

/* ---------- 選舉區 ---------- */

function DistrictRow({ d }: { d: CouncilDistrict }) {
  const winners = d.list.filter((c) => c.elected);
  const quota = d.list.filter((c) => c.quota);
  return (
    <details className="panel regions-details council-district">
      <summary>
        <span className="regions-title">{d.name}</span>
        <span className="muted">
          {d.area.length ? d.area.join('、') : '全市原住民選舉區'}・應選 {d.seats} 席・候選 {d.candidate_count} 人・投票率{' '}
          {num(d.turnout, 2)}%
        </span>
        {/* 當選名單是這一頁的重點，留在收合的摘要裡就能一眼掃完；底色線代表黨籍 */}
        <span className="region-people">
          {winners.map((c) => (
            <Person key={c.name} name={c.name} party={c.party} note={[c.quota ? '婦女保障' : '', departedNote(c) ?? ''].filter(Boolean).join('、') || undefined} facebook={c.facebook} />
          ))}
        </span>
      </summary>
      <div className="council-district-body">
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
                  <td>
                    {c.facebook ? (
                      <a href={c.facebook} target="_blank" rel="noopener noreferrer" title={`${c.name} 的 Facebook 粉專`}>
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                    {departedNote(c) ? <small className="muted">（{departedNote(c)}）</small> : null}
                  </td>
                  <td>
                    <PartyTag party={c.party} />
                  </td>
                  <td className="num">{num(c.votes)}</td>
                  <td className="num">{num(c.pct, 2)}%</td>
                  <td>{resultText(c)}</td>
                  <td className="num">{c.age ?? '—'}</td>
                  <td>{c.education ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quota.length ? (
          <p className="muted">
            這個選舉區有婦女保障名額當選人（{quota.map((c) => c.name).join('、')}）：保障名額讓得票數較少的女性能當選，
            因此當選者不一定都排在落選者前面，排序仍依得票數。
          </p>
        ) : null}
        <p className="muted">
          有效票 {num(d.valid)}・無效票 {num(d.invalid)}・投票數 {num(d.ballots)}・選舉區人口 {num(d.population)}
          {marginText(d)}
          {d.last_winner ? `｜最低當選票 ${d.last_winner.name}（${num(d.last_winner.votes)} 票）` : ''}
        </p>
      </div>
    </details>
  );
}

/* ---------- 頁面 ---------- */

export function CouncilPage({ refreshToken }: CouncilPageProps) {
  // 縣市與屆次是這一頁自己的檢視狀態，放在網址上（replaceState，可分享、重整後一致）：
  // 縣市留空＝用 API 的預設縣市，屆次留空＝最新一屆
  const [county, setCounty] = useParam<string>('county', '');
  const [year, setYear] = useParam<string>('year', '');
  const res = useApi<CouncilResponse>(buildUrl('/council', { county }), { refreshToken });
  // 網址帶到沒建置的縣市（404 county_not_found）：重試也還是 404，又看不到縣市切換鈕，
  // 所以退回預設縣市，並留一行說明為什麼換了
  const [missing, setMissing] = useState<string | null>(null);
  const notFound = res.phase === 'error' && res.error?.code === 'county_not_found' && county !== '';
  useEffect(() => {
    if (!notFound) return;
    setMissing(county);
    setCounty('');
  }, [notFound, county, setCounty]);
  // 換縣市時屆次一併回到最新一屆：各縣市的屆次不同（桃園沒有 2010），留著舊的 ?year= 網址會騙人
  const switchCounty = (name: string) => {
    setMissing(null);
    setYear('');
    setCounty(name);
  };

  const terms = res.data?.terms ?? [];
  const term = useMemo(() => terms.find((t) => String(t.year) === year) ?? terms[0] ?? null, [terms, year]);

  if (notFound || (res.phase === 'loading' && !res.data)) return <LoadingState label="載入議員選舉資料…" />;
  if (res.phase === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data || !term) return <EmptyState message="沒有議員選舉資料" hint="請先跑 node scripts/build-council-stats.mjs 產生資料檔。" />;

  const area = term.kinds.find((k) => k.kind === 'area') ?? null;
  const kindText = term.kinds.map((k) => `${k.label} ${k.seats}`).join('／');
  const top = term.stats.top;
  const lowest = term.stats.lowest_winner;
  // 選舉區與席次會隨人口重劃（新北市 2022 由 10 個分為 11 個、臺北市 2022 由 63 席減為 61 席），
  // 所以跨屆比較用席次與政黨，並把「有變」直接講出來（沒變就不囉嗦）
  const shape = terms.map((t) => ({ year: t.year, body: t.body, districts: t.districts.filter((d) => d.kind === 'area').length, seats: t.seats }));
  const oldest = shape.at(-1);
  const newest = shape[0];
  const redrawn = Boolean(oldest && newest && oldest.districts !== newest.districts);
  const changed = Boolean(oldest && newest && (redrawn || oldest.seats !== newest.seats));
  const notes = upgradedNotes(res.data.county, terms);

  return (
    <>
      <div className="page-head council-head">
        <h1>{res.data.county}議員</h1>
        <p className="page-lead">
          跨屆比較以「席次」與「政黨」為準，不直接比選舉區編號
          {changed
            ? `；由 ${oldest!.year} 年${oldest!.body === `${res.data.county}議會` ? '' : `（${oldest!.body}）`}的 ${oldest!.seats} 席${redrawn ? `、區域選舉區 ${oldest!.districts} 個` : ''}變成 ${newest!.year} 年的 ${newest!.seats} 席${redrawn ? `、${newest!.districts} 個` : ''}`
            : ''}
          。
        </p>
        {notes.map((text) => (
          <p className="muted" key={text}>
            {text}
          </p>
        ))}
        {missing ? <p className="muted">沒有「{missing}」的議員選舉資料（目前建置直轄市），已改看{res.data.county}。</p> : null}
        <div className="council-switches">
          {res.data.counties.length > 1 ? (
            <div className="segmented" role="group" aria-label="選擇縣市">
              {res.data.counties.map((name) => (
                <button key={name} type="button" aria-pressed={name === res.data?.county} onClick={() => switchCounty(name)}>
                  {name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="segmented" role="group" aria-label="選擇屆次">
            {terms.map((t) => (
              <button key={t.year} type="button" aria-pressed={t.year === term.year} onClick={() => setYear(String(t.year))}>
                {t.label}（{t.year}）
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="stat-row">
        <Tile value={`${term.seats} 席`} label={`${term.label}議員總席次`} hint={kindText} />
        <Tile value={num(term.stats.candidates)} label="候選人數" hint={`區域 ${num(area?.candidate_count ?? 0)} 人`} />
        <Tile value={numOrDash(area?.electorate ?? null)} label="區域選舉人數" hint="不含原住民選舉人（原住民另有選舉區）" />
        <Tile value={`${numOrDash(area?.turnout ?? null, 2)}%`} label="區域投票率" hint={`有效票 ${numOrDash(area?.valid ?? null)}`} />
        <Tile value={top ? top.name : '—'} label="最高票" hint={top ? `${top.party}・${num(top.votes)} 票・${top.district}` : undefined} />
        <Tile value={lowest ? lowest.name : '—'} label="當選最低票" hint={lowest ? `${lowest.party}・${num(lowest.votes)} 票${lowest.quota ? '（婦女保障）' : ''}` : undefined} />
      </div>

      <PartyPanel term={term} />
      <ComparePanel term={term} />

      <section className="panel" aria-label="各選舉區">
        <div className="sectionhead">
          <h2>各選舉區</h2>
          <span className="muted">
            {term.districts.length} 個選舉區・投票日 {term.date}・點開看完整得票
          </span>
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
          <span className="muted">
            資料來源{' '}
            <a href={res.data.source.url} target="_blank" rel="noreferrer">
              {res.data.source.label}
            </a>
          </span>
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
                      <button type="button" className="name-button" onClick={() => setYear(String(t.year))}>
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
    </>
  );
}
