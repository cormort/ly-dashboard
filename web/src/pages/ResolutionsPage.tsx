import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { ResolutionsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { SearchField } from '../components/SearchField';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { formatDay } from '../lib/format';

export interface ResolutionsPageProps {
  refreshToken: number;
}

const STEP = 20;
const readParam = (key: string) => new URLSearchParams(window.location.search).get(key) ?? '';

/**
 * 附帶決議（議事 › 附帶決議）：立法院開放資料 ID373。
 *
 * 三讀通過每一個法案時，委員常附帶要求主管機關辦理事項（提供資料、檢討制度、三個月內報告…），
 * 這些文字就是 `note`。對主計／審計的人來說，這是「預算決議之外另一條會盯到機關的線」。
 * 只有通過三讀的案子才有，所以資料量小（實測 673 筆）。
 */
export function ResolutionsPage({ refreshToken }: ResolutionsPageProps) {
  const [q, setQ] = useState(() => readParam('q'));
  const [term, setTerm] = useState(() => readParam('term'));
  const [limit, setLimit] = useState(STEP);
  useEffect(() => {
    const onPop = () => {
      setQ(readParam('q'));
      setTerm(readParam('term'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const change = (next: { q?: string; term?: string }) => {
    const nextQ = (next.q ?? q).trim();
    const nextTerm = next.term ?? term;
    setQ(nextQ);
    setTerm(nextTerm);
    setLimit(STEP);
    window.history.replaceState(null, '', pathFor('resolutions', { q: nextQ, term: nextTerm }));
  };

  const res = useApi<ResolutionsResponse>(buildUrl('/resolutions', { q, term, limit }), { refreshToken });
  if (res.phase === 'loading' && !res.data) return <LoadingState label="載入附帶決議…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得附帶決議（/api/v1/resolutions）" error={res.error} onRetry={res.reload} />;
  const data = res.data;
  if (!data) return <EmptyState message="沒有附帶決議資料" />;

  return (
    <>
      <h1 className="sr-only">附帶決議</h1>
      <section className="panel" aria-label="附帶決議">
        <div className="sectionhead">
          <h2>附帶決議</h2>
          <span className="muted">{data.total} 筆</span>
        </div>
        <p className="muted">
          立法院開放資料 ID373（{data.meta.resolutions_fetched_at ? `同步於 ${formatDay(data.meta.resolutions_fetched_at.slice(0, 10))}` : '尚未同步'}）。
          三讀通過時一併做成的附帶決議全文，依「屆-會期-會次」新到舊；每一筆都連到立法院的三讀條文 PDF。
        </p>

        <SearchField
          value={q}
          onChange={(value) => change({ q: value })}
          ariaLabel="搜尋附帶決議內容或法案名稱"
          placeholder="搜尋決議內容，例如：三個月內、檢討、主計總處"
        />

        {data.terms.length > 0 ? (
          <div className="wall-filter-row">
            <span className="wall-filter-label">依屆次</span>
            <button type="button" className="chip" aria-pressed={!term} onClick={() => change({ term: '' })}>
              全部
            </button>
            {data.terms.map((item) => (
              <button
                key={item.name}
                type="button"
                className="chip"
                aria-pressed={String(item.term) === term}
                onClick={() => change({ term: String(item.term ?? '') })}
              >
                {item.name} {item.count}
              </button>
            ))}
          </div>
        ) : null}

        {data.items.length === 0 ? (
          <EmptyState message="沒有符合條件的附帶決議" hint="換個關鍵字，或按「全部」看清單。" />
        ) : (
          <ul className="resolution-list" role="list">
            {data.items.map((item) => (
              <li key={item.id} className="resolution-card">
                <div className="vote-head">
                  <span className="resolution-title">{item.title || '（未標法案）'}</span>
                  <span className="muted">
                    {item.session ? `${item.session} 會期` : ''}
                    {item.item_no ? ` · 第 ${item.item_no} 項` : ''}
                    {item.docu_no ? ` · 公文號 ${item.docu_no}` : ''}
                  </span>
                </div>
                <p className="resolution-note">{item.note}</p>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" /> 三讀條文 PDF
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {data.total > data.items.length ? (
          <p className="wall-bulk">
            <button type="button" onClick={() => setLimit(limit + STEP)}>
              載入更多（已顯示 {data.items.length} / {data.total}）
            </button>
          </p>
        ) : null}
        {res.phase === 'loading' ? <p className="muted">更新中…</p> : null}
      </section>
    </>
  );
}
