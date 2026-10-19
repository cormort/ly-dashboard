import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { FundKind, FundsResponse, FundType } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { InfoTip } from '../components/InfoTip';
import { RouteLink } from '../components/RouteLink';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { formatDay } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface FundsPageProps {
  type: FundType;
  refreshToken: number;
  onOpenId: (id: string) => void;
  /** 站內導覽（連到「我的機關」用）；沒給就不顯示該連結 */
  onNavigate?: (href: string) => void;
}

const KIND_LABEL: Record<FundKind, string> = {
  news: '新聞',
  post: '臉書',
  bill: '委員提案',
  budget: '預算審議',
  submitted: '機關檢送報告',
  report: '預算中心報告',
};
const PAGE = 30;
const slash = (d: string) => d.replaceAll('-', '/');

interface Filters {
  fund: string;
  kind: string;
}

const readFilters = (): Filters => {
  const p = new URLSearchParams(window.location.search);
  return { fund: p.get('fund') ?? '', kind: p.get('kind') ?? '' };
};

const COPY = {
  fund: { title: '基金', route: 'funds' },
  agency: { title: '機關', route: 'agencies' },
  foundation: { title: '財團法人', route: 'foundations' },
  administrative: { title: '行政法人', route: 'administrative' },
  dgbas: { title: '行政院主計總處', route: 'dgbas' },
} as const;

/** 基金、機關、財團法人、行政法人四頁共用：總覽各來源中提到該類的項目（關鍵字見 server/fund-config.json） */
export function FundsPage({ type, refreshToken, onOpenId, onNavigate }: FundsPageProps) {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [page, setPage] = useState(0);
  // 機關搜尋框裡正在打的字；完全符合某個名稱才變成篩選條件
  const [draft, setDraft] = useState(filters.fund);
  useEffect(() => {
    const onPop = () => {
      const next = readFilters();
      setFilters(next);
      setDraft(next.fund);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const change = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setDraft(next.fund);
    setPage(0);
    window.history.replaceState(null, '', pathFor(COPY[type].route, { ...next }));
  };
  const goto = (p: number) => {
    setPage(p);
    document.getElementById('fund-results')?.scrollIntoView({ block: 'start' });
  };

  const res = useApi<FundsResponse>(buildUrl('/funds', { type, ...filters, limit: PAGE, offset: page * PAGE }), { refreshToken });
  const data = res.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const allCount = data ? Object.values(data.kinds).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <h1 className="sr-only">{COPY[type].title}</h1>

      {type === 'agency' && filters.fund && onNavigate ? (
        <p className="muted cross-link">
          想看這個機關的整體摘要（近期會議、書面回覆、誰在關注、首長新聞）？
          <RouteLink href={pathFor('my', { agency: filters.fund })} onNavigate={onNavigate}>
            在「我的機關」查看{filters.fund}
          </RouteLink>
        </p>
      ) : null}

      {/* 篩選收進清單卡片（2026-10-19）：來源＝卡片頂端的底線分頁、機關＝可搜尋的下拉（原生 datalist）。
          原本三條橫列（頁籤／來源／機關 chips）疊在一起，看不出哪個在篩這張清單 */}
      <section className="panel" aria-label="相關項目" id="fund-results">
        <div className="sectionhead">
          <h2>
            相關項目 {data ? <span className="muted">{data.total.toLocaleString()} 件</span> : null}
          </h2>
          {data ? (
            <InfoTip label="各來源資料期間">
              <b>資料期間</b>
              {(Object.keys(KIND_LABEL) as FundKind[]).map((k) =>
                data.periods[k] ? (
                  <span key={k} className="info-line">
                    {KIND_LABEL[k]}：{slash(data.periods[k]!.from)}–{slash(data.periods[k]!.to)}
                  </span>
                ) : null,
              )}
            </InfoTip>
          ) : null}
          <label className="fund-picker">
            <span className="sr-only">{COPY[type].title}</span>
            <input
              list="fund-options"
              value={draft}
              placeholder={`全部${COPY[type].title}（輸入搜尋）`}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                if (data?.funds.some((f) => f.name === value)) change({ fund: value });
              }}
            />
            <datalist id="fund-options">
              {(data?.funds ?? []).map((f) => (
                <option key={f.name} value={f.name}>
                  {f.count} 件
                </option>
              ))}
            </datalist>
            {filters.fund || draft ? (
              <button type="button" className="icon-button" onClick={() => change({ fund: '' })} aria-label={`取消${COPY[type].title}條件：${filters.fund}`}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </label>
        </div>
        <div className="card-tabs" role="group" aria-label="來源">
          <button type="button" aria-pressed={!filters.kind} onClick={() => change({ kind: '' })}>
            全部 <span className="muted">{data ? allCount.toLocaleString() : ''}</span>
          </button>
          {(Object.keys(KIND_LABEL) as FundKind[]).map((k) => (
            <button key={k} type="button" aria-pressed={filters.kind === k} onClick={() => change({ kind: k })}>
              {KIND_LABEL[k]} <span className="muted">{data ? data.kinds[k].toLocaleString() : ''}</span>
            </button>
          ))}
        </div>
        {res.phase === 'loading' && !data ? <LoadingState label="讀取中…" /> : null}
        {res.phase === 'error' ? <ErrorState title={`無法取得${COPY[type].title}（/api/v1/funds）`} error={res.error} onRetry={res.reload} /> : null}
        {data && data.items.length === 0 ? <EmptyState message="沒有符合的項目" hint={`換個來源，或清除${COPY[type].title}條件。`} /> : null}
        {data && data.items.length > 0 ? (
          <>
            <ol className="bill-results">
              {data.items.map((item) => (
                <li key={`${item.kind}-${item.url}-${item.legislator?.id ?? ''}-${item.title}`}>
                  <a href={item.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={item.title}>
                    {item.title}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <p className="bill-meta">
                    <span className="fund-kind">{KIND_LABEL[item.kind]}</span>
                    {item.funds.map((f) => (
                      <button key={f} type="button" className="link-button" onClick={() => change({ fund: f })} title={item.attend_only?.includes(f) ? '審查這個議案的會議邀請該機關列席（不一定是主管機關）' : undefined}>
                        {f}
                        {item.attend_only?.includes(f) ? '（列席）' : ''}
                      </button>
                    ))}
                    {item.status ? <span className="status-tag">{item.status}</span> : null}
                    {/* 上游對本會期的預算議案常常沒有日期（實測 199 筆全無）；留白會像壞掉 */}
                    {item.date ? <span>{formatDay(item.date)}</span> : <span className="muted">尚無進度日期</span>}
                    {item.legislator ? (
                      <button
                        type="button"
                        className="name-button"
                        style={{ color: partyStyle(item.legislator.party).color }}
                        onClick={() => onOpenId(item.legislator!.id)}
                      >
                        {item.legislator.name}
                      </button>
                    ) : null}
                    {item.source ? <span>{item.source}</span> : null}
                  </p>
                </li>
              ))}
            </ol>
            {pages > 1 ? (
              <nav className="pager" aria-label="分頁">
                <button type="button" disabled={page === 0} onClick={() => goto(page - 1)}>
                  上一頁
                </button>
                <span className="muted">
                  第 {page + 1} / {pages} 頁
                </span>
                <button type="button" disabled={page + 1 >= pages} onClick={() => goto(page + 1)}>
                  下一頁
                </button>
              </nav>
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}
