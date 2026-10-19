import { useRef, type CSSProperties } from 'react';
import { ExternalLink, MapPin, MessageCircle, ThumbsUp } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { SocialWallItem, SocialWallResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { PartyTag } from '../components/PartyTag';
import { Portrait } from '../components/Portrait';
import { useApi } from '../hooks/useApi';
import { useMasonry } from '../hooks/useMasonry';
import { useParam } from '../hooks/useParam';
import { formatDay, formatPostStamp, text } from '../lib/format';
import { partyStyle } from '../lib/parties';

export interface SocialWallPageProps {
  refreshToken: number;
  /** 點「委員檔案」時開側欄；沒給就只顯示粉專內容 */
  onOpenId?: (id: string) => void;
}

/**
 * 展開時一次要幾筆。委員只有 113 位，所以「展開」就是整面牆一次取回，
 * 不做無限捲動：資料量小、使用者要的是「一眼看完同一黨／同一縣市的人」。
 */
const EXPANDED_LIMIT = 500;

/** 一列標籤：第一個是「全部」，其餘是 facet 的選項與筆數（aria-pressed 表示目前選了哪一個） */
export function ChipRow({
  label,
  allLabel,
  items,
  value,
  onPick,
}: {
  label: string;
  allLabel: string;
  items: { name: string; count: number }[];
  value: string;
  onPick: (name: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="wall-filter-row">
      <span className="wall-filter-label">{label}</span>
      <div className="law-facets" role="group" aria-label={label}>
        <button type="button" className="chip" aria-pressed={!value} onClick={() => onPick('')}>
          {allLabel}
        </button>
        {items.map((f) => (
          <button key={f.name} type="button" className="chip" aria-pressed={value === f.name} onClick={() => onPick(f.name)}>
            {f.name} <span className="muted">{f.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 牆上的一張卡：**只顯示整理表裡的最新貼文（文字）與互動數**，不載入 Facebook 嵌入框。
 * 一面牆幾十個 facebook.com iframe 會讓頁面明顯變慢（實測：展開全部 112 位、捲幾個畫面
 * 就同時載入 24 個、累計 7.4 秒）。想看完整貼文或照片，點卡片下方的「粉專」到 Facebook。
 */
export function WallCard({
  item,
  onOpenId,
  showLatest = true,
}: {
  item: SocialWallItem;
  onOpenId?: (id: string) => void;
  /** 伺服器沒有最新貼文資料（LY_FB_SCRAPE=0）時為 false：沒有日期就什麼都不寫，而不是說「整理表還沒有」 */
  showLatest?: boolean;
}) {
  return (
    <article className="member-card wall-card" style={{ '--party': partyStyle(item.party).color } as CSSProperties}>
      <div className="membertop">
        <Portrait legislator={{ name: item.name, photo_url: item.photo_url }} />
        <div>
          <h3>{item.name}</h3>
          <PartyTag party={item.party} />
        </div>
      </div>

      <p className="member-area">
        <MapPin aria-hidden="true" />
        {text(item.area_name)}
      </p>
      <p className="wall-page">粉專：{text(item.page_name, '（整理表未填名稱）')}</p>

      {item.latest_post_date ? (
        <>
          <p className="council-fb-latest">
            最新更新時間為 <time dateTime={item.latest_post_date}>{formatPostStamp(item.latest_post_date)}</time>
          </p>
          {item.latest_post_summary ? (
            <p className="council-fb-latest wall-post-text">
              <time dateTime={item.latest_post_date}>{formatPostStamp(item.latest_post_date)}</time>：{item.latest_post_summary}
            </p>
          ) : null}
          {item.latest_post_likes !== null || item.latest_post_comments !== null ? (
            <p className="wall-engagement">
              {item.latest_post_likes !== null ? (
                <span title={`最新一則貼文的讚數（${item.latest_post_likes}）`}>
                  <ThumbsUp aria-hidden="true" />
                  {item.latest_post_likes.toLocaleString('en-US')}
                </span>
              ) : null}
              {item.latest_post_comments !== null ? (
                <span title={`最新一則貼文的留言數（${item.latest_post_comments}）`}>
                  <MessageCircle aria-hidden="true" />
                  {item.latest_post_comments.toLocaleString('en-US')}
                </span>
              ) : null}
              <span className="muted">最新一則貼文</span>
            </p>
          ) : null}
        </>
      ) : showLatest ? (
        <p className="council-fb-latest">整理表還沒有這一位的貼文日期</p>
      ) : null}

      <footer>
        <a href={item.url} target="_blank" rel="noopener noreferrer" title={`${item.name} 的 Facebook 粉專（另開新分頁）`}>
          粉專
          <ExternalLink aria-hidden="true" />
        </a>
        <span className="wall-actions">
          {onOpenId ? (
            <button type="button" className="link-button" onClick={() => onOpenId(item.id)}>
              委員檔案
            </button>
          ) : null}
        </span>
      </footer>
    </article>
  );
}

/**
 * 委員粉專牆（委員 › 粉專牆）：把在職委員的 Facebook 粉專攤成一面瀑布流。
 * 預設只顯示「本日及昨日」有更新貼文的委員（人數依當天更新量而定）；選了黨籍或縣市就展開整個粉專牆（條件寫在網址，可分享）。
 * 順序、篩選與筆數都由後端算（`/api/v1/social/wall`），前端不重算。
 */
export function SocialWallPage({ refreshToken, onOpenId }: SocialWallPageProps) {
  const [party, setParty] = useParam<string>('party', '');
  const [region, setRegion] = useParam<string>('region', '');
  // 委員會：後端只認目前會期的常設委員會，聽不懂的名稱會回空字串（前端就跟著不顯示條件）
  const [committee, setCommittee] = useParam<string>('committee', '');
  // 網址參數是使用者可以隨手改的：不認識的值一律落回 compact（見 useParam 的說明）
  const [view, setView] = useParam<'compact' | 'all'>('view', 'compact', ['compact', 'all']);

  // 沒套條件也沒按「展開」時不送 limit，讓後端回「本日及昨日」有更新貼文的委員
  const expanded = Boolean(party || region || committee) || view === 'all';
  const res = useApi<SocialWallResponse>(
    buildUrl('/social/wall', { party, region, committee, limit: expanded ? EXPANDED_LIMIT : undefined }),
    { refreshToken },
  );
  const data = res.data;
  // LY_FB_SCRAPE=0 的伺服器不給最新貼文（欄位全空），卡片就不要寫「還沒有貼文日期」
  const hasLatest = data?.latest_post_enabled !== false;
  // 瀑布流靠 Grid ＋ JS 撐高度；卡片數量／篩選／展開變了要重量（最新的一定在最上面）
  const wallRef = useRef<HTMLUListElement>(null);
  useMasonry(wallRef, { rowUnit: 8, deps: [data?.items.length ?? 0, party, region, committee, view] });

  if (res.phase === 'loading' && !data) return <LoadingState label="載入粉專牆…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得粉專牆（/api/v1/social/wall）" error={res.error} onRetry={res.reload} />;
  if (!data) return <EmptyState message="沒有粉專資料" />;

  const filtered = Boolean(party || region || committee);
  // 篩選／展開會讓卡片整批換掉（key 不同＝各自重新掛載），卡片自己的展開狀態也跟著重來
  const pick = (setter: (value: string) => void) => (value: string) => setter(value);
  const clear = () => {
    setParty('');
    setRegion('');
    setCommittee('');
    setView('compact');
  };

  return (
    <>
      <h1 className="sr-only">委員粉專牆</h1>

      <section className="panel" aria-label="粉專牆篩選">
        <div className="sectionhead">
          <h2>粉專牆</h2>
          <span className="muted">
            {filtered || view === 'all'
              ? `${data.items.length} / ${data.total} 位`
              : data.window_fallback
                ? `本日及昨日沒更新，顯示最近 ${data.items.length} 位`
                : data.window_capped
                  ? `本日及昨日有更新 ${data.window_total} 位，先列前 ${data.items.length} 位`
                  : `本日及昨日有更新 ${data.items.length} 位`}
          </span>
        </div>

        <p className="muted">
          {expanded
            ? '依黨籍、縣市或委員會展開的粉專牆，新的貼文排在前面。卡片顯示整理表裡的最新貼文（文字、讚數、留言數）；要看完整貼文或照片請點「粉專」到 Facebook。'
            : `預設只顯示「本日及昨日」有更新貼文的委員（依整理表的最新貼文日期，從 ${formatDay(data.window_from, '—')} 起算${data.window_fallback ? '；這兩天沒有人更新，先列出最近更新的幾位' : `，最多先列 ${data.window_cap} 位`}）；選黨籍、縣市或委員會就會展開整個粉專牆。卡片顯示最新貼文摘要，不載入 Facebook 嵌入框。`}
          {data.social.as_of ? `「最新貼文」來自委員臉書整理表，資料截至 ${formatDay(data.social.as_of, '—')}。` : ''}
        </p>
        {data.social.stale ? (
          <p className="social-stale" role="note">
            委員臉書整理表已 {data.social.age_days} 天沒有新的貼文日期，「最新貼文」可能不是最新；點卡片下方的「粉專」可以到 Facebook 看最新內容。
          </p>
        ) : null}

        <div className="wall-filters">
          <ChipRow label="依黨籍" allLabel="全部黨籍" items={data.parties} value={party} onPick={pick(setParty)} />
          <ChipRow label="依縣市" allLabel="全部縣市" items={data.regions} value={region} onPick={pick(setRegion)} />
          <ChipRow
            label={data.committee_session ? `依委員會（${data.committee_session} 會期）` : '依委員會'}
            allLabel="全部委員會"
            items={data.committees}
            value={committee}
            onPick={pick(setCommittee)}
          />
        </div>

        {filtered || view === 'all' ? (
          <p className="wall-bulk">
            <button type="button" className="quiet" onClick={clear}>
              清除條件，只看本日及昨日有更新的
            </button>
          </p>
        ) : data.total > data.items.length ? (
          <p className="wall-bulk">
            <button type="button" onClick={() => setView('all')}>
              展開全部 {data.total} 位粉專
            </button>
          </p>
        ) : null}
      </section>

      {data.items.length === 0 ? (
        <EmptyState
          message="沒有符合條件的粉專"
          hint="換一個黨籍、縣市或委員會，或按「清除條件」。沒有粉專資料的委員不會出現（來源是委員臉書整理表）。"
        />
      ) : (
        <ul className="fb-wall" role="list" ref={wallRef}>
          {data.items.map((item) => (
            <li key={item.id}>
              <WallCard item={item} onOpenId={onOpenId} showLatest={hasLatest} />
            </li>
          ))}
        </ul>
      )}
      {res.phase === 'loading' ? <p className="muted">更新中…</p> : null}
    </>
  );
}
