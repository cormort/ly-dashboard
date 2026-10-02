import { useEffect, useState, type CSSProperties } from 'react';
import { buildUrl } from '../api/client';
import type { CompareResponse, LegislatorsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Portrait } from '../components/Portrait';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { shortCommittee } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { ALL_SESSIONS } from '../lib/urlState';

export interface ComparePageProps {
  refreshToken: number;
  onOpenId: (id: string) => void;
  /** 站內連結要攔截，否則整個文件重載、SPA 狀態會掉 */
  onNavigate: (href: string) => void;
}

const readIds = () => (new URLSearchParams(window.location.search).get('ids') ?? '').split(',').filter(Boolean).slice(0, 2);

/** 兩位委員並排比較：提案、主提案、三讀、新聞、委員會、常涉法律，以及共同提案。條件寫在網址可分享。 */
export function ComparePage({ refreshToken, onOpenId, onNavigate }: ComparePageProps) {
  const [ids, setIds] = useState<string[]>(readIds);
  useEffect(() => {
    const onPop = () => setIds(readIds());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 全屆名單：已離職委員也有本屆提案可比（例如從法案頁點進來的提案人）
  const roster = useApi<LegislatorsResponse>(buildUrl('/legislators', { session: ALL_SESSIONS, limit: 500 }), { refreshToken });
  const compare = useApi<CompareResponse>(ids.length ? buildUrl('/compare', { ids: ids.join(',') }) : null, { refreshToken });

  const pick = (slot: number, id: string) => {
    const next = [...ids];
    next[slot] = id;
    const clean = next.filter(Boolean);
    setIds(clean);
    window.history.replaceState(null, '', pathFor('compare', { ids: clean.join(',') }));
  };

  const options = roster.data?.items ?? [];
  const items = compare.data?.items ?? [];
  const rows: { label: string; value: (i: (typeof items)[number]) => number }[] = [
    { label: '本屆提案（含連署）', value: (i) => i.bills },
    { label: '主提案', value: (i) => i.lead_bills },
    { label: '已三讀', value: (i) => i.passed_bills },
    { label: '近 30 天新聞', value: (i) => i.news_30d },
  ];
  // 選舉列：數值越大越好者標示領先；不分區委員沒有個人得票，顯示「—」
  const num = (n: number) => n.toLocaleString('zh-TW');
  const pt = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)} 個百分點`;
  const electionRows: { label: string; value: (i: (typeof items)[number]) => number | null; show: (i: (typeof items)[number]) => string }[] = [
    { label: '得票數', value: (i) => i.election?.votes ?? null, show: (i) => num(i.election!.votes) },
    { label: '得票率', value: (i) => i.election?.pct ?? null, show: (i) => `${i.election!.pct.toFixed(2)}%` },
    {
      label: '領先對手',
      value: (i) => i.election?.margin_pct ?? null,
      show: (i) => `${pt(i.election!.margin_pct!)}${i.election!.rival ? `（${i.election!.rival.name}，${num(i.election!.margin!)} 票）` : ''}`,
    },
    { label: '個人票比同黨政黨票', value: (i) => i.election?.party_list_over_pct ?? null, show: (i) => pt(i.election!.party_list_over_pct!) },
    { label: '個人票比同黨總統票', value: (i) => i.election?.president_over_pct ?? null, show: (i) => pt(i.election!.president_over_pct!) },
    { label: '與上次參選相比', value: (i) => i.election?.change ?? null, show: (i) => `${i.election!.change! > 0 ? '+' : ''}${num(i.election!.change!)} 票` },
  ];

  return (
    <>
      <div className="page-head">
        <h1>委員比較</h1>
        <p className="muted">選兩位委員，並排看提案、新聞、選舉得票與委員會，以及彼此一起提過幾件案。</p>
      </div>

      <div className="filters compare-pickers" role="group" aria-label="選擇比較的委員">
        {[0, 1].map((slot) => (
          <label key={slot}>
            <span className="sr-only">第 {slot + 1} 位委員</span>
            <select value={ids[slot] ?? ''} onChange={(event) => pick(slot, event.target.value)}>
              <option value="">選擇委員…</option>
              {options.map((l) => (
                <option key={l.id} value={l.id} disabled={ids.includes(l.id) && ids[slot] !== l.id}>
                  {l.name}（{partyStyle(l.party).short}・{l.region ?? ''}{l.former ? '・已離職' : ''}）
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {ids.length === 0 ? <EmptyState message="還沒選委員" hint="從上方選單選兩位委員，或在委員檔案按「比較」。" /> : null}
      {ids.length > 0 && compare.phase === 'loading' && !compare.data ? <LoadingState label="比較中…" /> : null}
      {compare.phase === 'error' ? <ErrorState title="無法取得比較資料（/api/v1/compare）" error={compare.error} onRetry={compare.reload} /> : null}

      {items.length > 0 ? (
        <section className="panel compare" aria-label="比較結果">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">項目</span>
                </th>
                {items.map((i) => (
                  <th key={i.legislator.id} scope="col" style={{ '--party': partyStyle(i.legislator.party).color } as CSSProperties}>
                    <div className="compare-who">
                      <Portrait legislator={i.legislator} />
                      <div>
                        <button type="button" className="name-button" onClick={() => onOpenId(i.legislator.id)}>
                          {i.legislator.name}
                        </button>
                        <small>
                          {partyStyle(i.legislator.party).short}・{i.legislator.region}
                          {i.legislator.former ? '・已離職' : ''}
                        </small>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const best = Math.max(...items.map(row.value));
                return (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {items.map((i) => (
                      <td key={i.legislator.id} className={items.length > 1 && row.value(i) === best && best > 0 ? 'lead' : undefined}>
                        {row.value(i)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr>
                <th scope="row">當選選舉</th>
                {items.map((i) => (
                  <td key={i.legislator.id}>
                    {i.election ? `${i.election.year}${i.election.by_election ? ' 補選' : ''} ${i.election.district}` : <span className="muted">不分區（無個人得票）</span>}
                  </td>
                ))}
              </tr>
              {electionRows.map((row) => {
                const values = items.map(row.value).filter((v): v is number => v !== null);
                const best = values.length > 1 ? Math.max(...values) : null;
                return (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {items.map((i) => {
                      const v = row.value(i);
                      return (
                        <td key={i.legislator.id} className={v !== null && v === best ? 'lead' : undefined}>
                          {v === null ? '—' : row.show(i)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <th scope="row">本會期委員會</th>
                {items.map((i) => (
                  <td key={i.legislator.id}>
                    {i.committees.length ? i.committees.map((c) => shortCommittee(c.id) + (c.is_convener ? '（召委）' : '')).join('、') : '—'}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">新聞主要媒體</th>
                {items.map((i) => (
                  <td key={i.legislator.id}>
                    <ul className="plain-list">
                      {i.top_sources.map((s) => (
                        <li key={s.name}>
                          {s.name} <span className="muted">{s.count}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">最常涉及的法律</th>
                {items.map((i) => (
                  <td key={i.legislator.id}>
                    <ul className="plain-list">
                      {i.top_laws.map((law) => (
                        <li key={law.name}>
                          <a
                            href={pathFor('bills', { law: law.name })}
                            onClick={(event) => {
                              event.preventDefault();
                              onNavigate(pathFor('bills', { law: law.name }));
                            }}
                          >{law.name}</a> <span className="muted">{law.count}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {items.length === 2 && compare.data ? (
            <p className="compare-shared">
              兩人一起列名的提案 <b>{compare.data.shared.bills}</b> 件
              {compare.data.shared.committees.length ? `；同在 ${compare.data.shared.committees.map(shortCommittee).join('、')}` : '；本會期沒有同一個委員會'}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
