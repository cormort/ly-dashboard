import type { CSSProperties } from 'react';
import { ExternalLink } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { RegionsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { pathFor, type Route } from '../hooks/useRoute';
import { useCountiesEnabled } from '../lib/features';
import { formatDay } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { ErrorState, LoadingState } from './DataStates';
import { RouteLink } from './RouteLink';

const KIND_LABEL = { post: '臉書', news: '新聞', bill: '提案' } as const;
const link = (route: Route, params?: Record<string, string>) => pathFor(route, params);

function Who({ id, name, party, onOpenId }: { id: string; name: string; party: string; onOpenId: (id: string) => void }) {
  return (
    <button type="button" className="name-button" style={{ color: partyStyle(party).color }} onClick={() => onOpenId(id)}>
      {name}
    </button>
  );
}

/**
 * 各縣市（選區）委員的最新動態：每個縣市一張卡（委員、人口與選舉概況、最新兩則動態）。
 * 2026-10-19 從總覽底部搬到「委員 › 最近動態」的「依縣市」檢視：總覽資訊太多，這塊收在最底下沒人看得到。
 * 只在畫出來時才抓 /regions。
 */
export function RegionCards({ refreshToken, onOpenId, onNavigate }: { refreshToken: number; onOpenId: (id: string) => void; onNavigate: (href: string) => void }) {
  const countiesEnabled = useCountiesEnabled();
  const regions = useApi<RegionsResponse>(buildUrl('/regions', { per: 2 }), { refreshToken });
  const data = regions.data;
  if (regions.phase === 'loading' && !data) return <LoadingState label="讀取各縣市…" />;
  if (regions.phase === 'error') return <ErrorState title="無法取得各縣市（/api/v1/regions）" error={regions.error} onRetry={regions.reload} />;
  if (!data) return null;
  return (
    <div className="region-grid">
      {data.items.map((r) => (
        <article key={r.region} className="panel region-card">
          <div className="sectionhead">
            <h3>
              <RouteLink
                href={link('legislators', { region: r.region })}
                onNavigate={onNavigate}
              >
                {r.region}
              </RouteLink>
            </h3>
            <span className="muted">
              {r.legislators.length} 位{r.news_7d ? `・近 7 天新聞 ${r.news_7d}` : ''}
            </span>
          </div>
          {r.stats ? (
            <div className="region-stats">
              <p>
                人口 {r.stats.population.toLocaleString('zh-TW')}・65 歲以上 {r.stats.elderly_ratio.toFixed(1)}%
              </p>
              <p>
                {(
                  [
                    ['2024 總統', r.stats.president_2024],
                    ['2022 縣市長', r.stats.mayor_2022],
                  ] as const
                ).map(([label, w]) => (
                  <span key={label} className="region-winner">
                    {label}：{w.name}
                    <span className="party-tag" style={{ '--party': partyStyle(w.party).color } as CSSProperties}>
                      {partyStyle(w.party).short}
                    </span>
                    <span className="muted">{w.pct.toFixed(1)}%</span>
                  </span>
                ))}
              </p>
              {countiesEnabled ? (
                <RouteLink
                  href={link('counties', { county: r.region })}
                  onNavigate={onNavigate}
                >
                  縣市統計 →
                </RouteLink>
              ) : null}
            </div>
          ) : null}
          <p className="region-people">
            {r.legislators.map((l) => (
              <span key={l.id} className="region-person" style={{ '--party': partyStyle(l.party).color } as CSSProperties}>
                <Who {...l} onOpenId={onOpenId} />
              </span>
            ))}
          </p>
          {r.latest.length ? (
            <ul className="dash-list">
              {r.latest.map((x) => (
                <li key={`${x.kind}-${x.legislator.id}-${x.url}`}>
                  <span className="kind">{KIND_LABEL[x.kind]}</span>
                  <a href={x.url} target="_blank" rel="noreferrer noopener" className="clamp-2">
                    <b>{x.legislator.name}</b>　{x.text}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  <time>{formatDay(x.date)}</time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">暫無動態</p>
          )}
        </article>
      ))}
    </div>
  );
}
