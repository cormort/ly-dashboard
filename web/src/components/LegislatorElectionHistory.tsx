import { buildUrl } from '../api/client';
import type { LegislatorVotesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { partyStyle } from '../lib/parties';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

const num = (n: number) => n.toLocaleString('zh-TW');
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`;

/** 委員側欄：歷次參選立委（含補選）的得票、與對手差距、與上次相比；完整表格在縣市頁「立委得票」 */
/** 不是縣市的三種區域（regionOf() 的輸出；它們沒有縣市頁可連） */
const NON_COUNTY_REGIONS = new Set(['全國不分區', '平地原住民', '山地原住民']);

export function LegislatorElectionHistory({ legislatorId, region }: { legislatorId: string; region: string | null }) {
  const res = useApi<LegislatorVotesResponse>(buildUrl('/legislator-votes', { id: legislatorId }));
  if (res.phase === 'loading' && !res.data) return <LoadingState label="讀取得票紀錄…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得得票紀錄（/api/v1/legislator-votes）" error={res.error} onRetry={res.reload} />;
  const history = res.data?.items[0]?.history ?? [];
  const recalls = res.data?.items[0]?.recalls ?? [];
  if (!history.length && !recalls.length) {
    return <EmptyState message="沒有區域或原住民立委的參選紀錄" hint="2012 年起的大選與補選；不分區委員沒有個人得票。" />;
  }

  return (
    <div className="election-history">
      {recalls.length ? (
        <div className="recall-record">
          <h4>罷免紀錄</h4>
          <ul>
            {recalls.map((r) => (
              <li key={r.title}>
                <div>
                  <b>{r.vote_date}</b> 第 {r.term} 屆 {r.area}
                  {r.district ? ` ${r.district}` : ''}
                  <span className={r.passed ? 'recall-passed' : 'muted'}> {r.passed ? '罷免通過' : '罷免未通過'}</span>
                </div>
                {r.results ? (
                  <div className="election-numbers">
                    同意 {num(r.results.agree)} 票、不同意 {num(r.results.disagree)} 票
                    <span className="muted">（投票率 {r.results.turnout_pct.toFixed(2)}%）</span>
                  </div>
                ) : (
                  <div className="muted">（此案的票數未收錄）</div>
                )}
                {r.results?.read_from ? <div className="muted"><small>{r.results.read_from}</small></div> : null}
              </li>
            ))}
          </ul>
          {/* 案件清單來自中選會選舉資料庫（沒有票數）；票數另外解析自官方公告 PDF */}
          <small className="muted">
            案件：{res.data?.recalls_source?.label ?? '中選會'}・票數：中選會官方公告／結果文件（35 案都有）
          </small>
        </div>
      ) : null}
      {history.length ? (
      <ol>
        {[...history].reverse().map((h) => (
          <li key={`${h.year}-${h.district}`}>
            <div>
              <b>{h.year}</b> {h.district}
              {h.by_election ? <small className="pill">補選</small> : null}
              <span className={h.elected ? 'election-won' : 'muted'}> {h.elected ? '當選' : '落選'}</span>
            </div>
            <div className="election-numbers">
              {num(h.votes)} 票（{h.pct.toFixed(2)}%）・{partyStyle(h.party).short}
              {h.change !== null ? <span className="muted">・較上次 {signed(h.change)}</span> : null}
            </div>
            {h.rival && h.margin !== null ? (
              <div className="muted">
                {h.margin >= 0 ? '領先' : '落後'} {h.rival.name}（{partyStyle(h.rival.party).short}）{num(Math.abs(h.margin))} 票、
                {Math.abs(h.margin_pct ?? 0).toFixed(2)} 個百分點
              </div>
            ) : null}
            {h.party_list || h.president ? (
              <div className="muted">
                個人票比同黨
                {h.party_list ? ` 政黨票 ${h.party_list.over_pct > 0 ? '+' : ''}${h.party_list.over_pct.toFixed(2)}` : ''}
                {h.party_list && h.president ? '、' : ''}
                {h.president ? ` 總統票 ${h.president.over_pct > 0 ? '+' : ''}${h.president.over_pct.toFixed(2)}` : ''} 個百分點
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      ) : null}
      {/* 不分區與原住民沒有縣市：region 會是「山地原住民」這種值，
          連過去會被縣市頁的 `?? items[0]` 靜默換成第一個縣市（基隆市），
          使用者看到別人的得票表、自己的紀錄一列都沒有。所以不給連結。 */}
      {region && !NON_COUNTY_REGIONS.has(region) ? (
        <a className="muted" href={pathFor('counties', { tab: 'legislators', county: region })}>
          在縣市頁看完整得票表 →
        </a>
      ) : null}
    </div>
  );
}
