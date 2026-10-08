import { useState, type CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { CouncilActivityResponse, Councilor } from '../api/types';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { SearchField } from '../components/SearchField';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { useParam } from '../hooks/useParam';
import { formatDay } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { FacebookEmbed } from '../components/FacebookEmbed';

export interface CouncilActivityPageProps {
  refreshToken: number;
}

const PAGE = 30;

function FacebookRow({ c, open, onToggle }: { c: Councilor; open: boolean; onToggle: () => void }) {
  return (
    <li className="council-fb-row">
      <div className="council-fb-head">
        <span className="region-person" style={{ '--party': partyStyle(c.party).color } as CSSProperties}>
          {c.name}
        </span>
        <small className="muted">
          {c.county}
          {c.district}
          {c.count ? `・新聞 ${c.count}` : ''}
        </small>
        {c.facebook ? (
          <>
            <a href={c.facebook} target="_blank" rel="noopener noreferrer" title={`${c.name} 的 Facebook`}>
              粉專
              <ExternalLink aria-hidden="true" />
            </a>
            <button type="button" className="link-button" aria-expanded={open} onClick={onToggle}>
              {open ? '收起貼文' : '看貼文'}
            </button>
          </>
        ) : (
          <small className="muted">（沒有粉專資料）</small>
        )}
      </div>
      {c.latest_post_date ? (
        <small className="council-fb-latest">
          最新貼文 {formatDay(c.latest_post_date)}
          {c.latest_post_summary ? `：${c.latest_post_summary}` : ''}
        </small>
      ) : null}
      {open && c.facebook ? <FacebookEmbed url={c.facebook} name={c.name} /> : null}
    </li>
  );
}

/** 議員近期動態：標題提到現任議員的新聞，以及議員的 Facebook 粉專（按需載入最近貼文）。 */
export function CouncilActivityPage({ refreshToken }: CouncilActivityPageProps) {
  const [county, setCounty] = useParam<string>('county', '');
  const [councilor, setCouncilor] = useParam<string>('councilor', '');
  const [q, setQ] = useParam<string>('q', '');
  const [page, setPage] = useState(0);
  const [openFb, setOpenFb] = useState<string | null>(null);
  const res = useApi<CouncilActivityResponse>(buildUrl('/council/activity', { county, councilor, q, limit: PAGE, offset: page * PAGE }), { refreshToken });
  const data = res.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const picked = data?.councilors.find((c) => c.id === councilor) ?? null;
  // 臉書欄：選了議員就只列那一位，否則列目前縣市的議員（依新聞則數排序）
  const fbList = picked ? [picked] : (data?.councilors ?? []);
  const pickCounty = (name: string) => {
    setCouncilor('');
    setCounty(name);
    setPage(0);
    setOpenFb(null);
  };
  const pickCouncilor = (id: string) => {
    setCouncilor(id);
    setPage(0);
    setOpenFb(null);
  };

  if (res.phase === 'loading' && !data) return <LoadingState label="載入議員近期動態…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得議員近期動態（/api/v1/council/activity）" error={res.error} onRetry={res.reload} />;
  if (!data) return <EmptyState message="沒有議員資料" />;

  return (
    <>
      <h1 className="sr-only">議員近期動態</h1>
      <div className="segmented" role="group" aria-label="選擇縣市">
        <button type="button" aria-pressed={!data.county} onClick={() => pickCounty('')}>
          六都
        </button>
        {data.counties.map((name) => (
          <button key={name} type="button" aria-pressed={data.county === name} onClick={() => pickCounty(name)}>
            {name}
          </button>
        ))}
      </div>
      <div className="filters" role="search">
        <select value={councilor} aria-label="依議員篩選" onChange={(event) => pickCouncilor(event.target.value)}>
          <option value="">全部議員</option>
          {data.councilors.map((c) => (
            <option key={c.id} value={c.id}>
              {data.county ? '' : c.county}
              {c.name}（{c.district}）{c.count}
            </option>
          ))}
        </select>
        <SearchField
          value={q}
          onChange={(value) => (setQ(value.trim()), setPage(0))}
          ariaLabel="搜尋新聞標題"
          placeholder="搜尋標題關鍵字（空白分隔＝全部符合）"
        />
        <ClearFiltersButton active={Boolean(q || councilor)} onClick={() => (setQ(''), pickCouncilor(''), setPage(0))} />
      </div>

      <div className="home">
        <section className="panel" aria-label="議員新聞" id="council-news">
          <div className="sectionhead">
            <h2>{picked ? `${picked.name}的新聞` : '新聞'}</h2>
            <span className="muted">
              {data.total.toLocaleString()} 則
              {data.first_date && data.last_date ? `・資料涵蓋 ${formatDay(data.first_date)} 至 ${formatDay(data.last_date)}` : ''}
            </span>
          </div>
          {data.items.length === 0 ? (
            <EmptyState message="沒有符合的新聞" hint="換個縣市或關鍵字。新聞來自各新聞頁的資料，標題提到現任議員才列出。" />
          ) : (
            <>
              <ol className="bill-results">
                {data.items.map((a) => (
                  <li key={a.url}>
                    <a href={a.url} target="_blank" rel="noreferrer noopener" className="bill-title" title={a.title}>
                      {a.title}
                      <ExternalLink aria-hidden="true" />
                    </a>
                    <p className="bill-meta">
                      <span>{formatDay(a.published_at)}</span>
                      <span>{a.source}</span>
                      {a.councilors.map((c) => (
                        <button key={c.id} type="button" className="name-button" style={{ color: partyStyle(c.party).color }} title={`${c.county}${c.district}`} onClick={() => pickCouncilor(c.id)}>
                          {data.county ? '' : c.county.slice(0, 2)}
                          {c.name}
                        </button>
                      ))}
                    </p>
                  </li>
                ))}
              </ol>
              {pages > 1 ? (
                <nav className="pager" aria-label="分頁">
                  <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    上一頁
                  </button>
                  <span className="muted">
                    第 {page + 1} / {pages} 頁
                  </span>
                  <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                    下一頁
                  </button>
                </nav>
              ) : null}
            </>
          )}
        </section>

        <section className="panel" aria-label="議員臉書">
          <div className="sectionhead">
            <h2>臉書</h2>
            <span className="muted">{picked ? picked.name : `${data.county || '六都'} ${fbList.length} 位`}</span>
          </div>
          <p className="muted">
            點「看貼文」載入 Facebook 官方的粉專嵌入框（只對粉絲專頁有效；個人檔案請點「粉專」連結）。
            {data.social?.as_of ? `「最新貼文」來自議員臉書整理表，資料截至 ${formatDay(data.social.as_of, '—')}。` : ''}
          </p>
          {data.social?.stale ? (
            <p className="social-stale" role="note">
              議員臉書整理表已 {data.social.age_days} 天沒更新，「最新貼文」可能不是最新；請按「看貼文」看臉書上的最新貼文。
            </p>
          ) : null}
          <ul className="council-fb-list">
            {fbList.map((c) => (
              <FacebookRow key={c.id} c={c} open={openFb === c.id} onToggle={() => setOpenFb(openFb === c.id ? null : c.id)} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
