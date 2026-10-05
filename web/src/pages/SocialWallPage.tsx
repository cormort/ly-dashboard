import { useState, type CSSProperties } from 'react';
import { ExternalLink, MapPin } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { SocialWallItem, SocialWallResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { FacebookEmbed } from '../components/FacebookEmbed';
import { PartyTag } from '../components/PartyTag';
import { Portrait } from '../components/Portrait';
import { useApi } from '../hooks/useApi';
import { useParam } from '../hooks/useParam';
import { formatRelative, text } from '../lib/format';
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
function ChipRow({
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
 * 牆上的一張卡。嵌入框一律按需載入（FacebookEmbed 的說明）：
 * 一面牆同時開幾十個 iframe 會很慢，而且每一個都會讓瀏覽器連到 Facebook。
 * 匯出只是為了讓 render-smoke 能直接驗「沒展開時沒有 iframe」這條規則。
 */
export function WallCard({
  item,
  open,
  onToggle,
  onOpenId,
}: {
  item: SocialWallItem;
  open: boolean;
  onToggle: () => void;
  onOpenId?: (id: string) => void;
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
        <p className="council-fb-latest">
          最新貼文 <time dateTime={item.latest_post_date}>{formatRelative(item.latest_post_date)}</time>
          {item.latest_post_summary ? `：${item.latest_post_summary}` : ''}
        </p>
      ) : (
        <p className="council-fb-latest">整理表還沒有這一位的貼文日期</p>
      )}

      <footer>
        <a href={item.url} target="_blank" rel="noopener noreferrer" title={`${item.name} 的 Facebook 粉專`}>
          粉專
          <ExternalLink aria-hidden="true" />
        </a>
        <span className="wall-actions">
          {onOpenId ? (
            <button type="button" className="link-button" onClick={() => onOpenId(item.id)}>
              委員檔案
            </button>
          ) : null}
          <button type="button" className="link-button" aria-expanded={open} onClick={onToggle}>
            {open ? '收起貼文' : '看貼文'}
          </button>
        </span>
      </footer>

      {open ? <FacebookEmbed url={item.url} name={item.name} /> : null}
    </article>
  );
}

/**
 * 委員粉專牆（委員 › 粉專牆）：把在職委員的 Facebook 粉專攤成一面瀑布流。
 * 預設只顯示最近更新的 5 位；選了黨籍或縣市就展開整個粉專牆（條件寫在網址，可分享）。
 * 順序、篩選與筆數都由後端算（`/api/v1/social/wall`），前端不重算。
 */
export function SocialWallPage({ refreshToken, onOpenId }: SocialWallPageProps) {
  const [party, setParty] = useParam<string>('party', '');
  const [region, setRegion] = useParam<string>('region', '');
  // 網址參數是使用者可以隨手改的：不認識的值一律落回 compact（見 useParam 的說明）
  const [view, setView] = useParam<'compact' | 'all'>('view', 'compact', ['compact', 'all']);
  const [openFb, setOpenFb] = useState<string | null>(null);

  // 沒套條件也沒按「展開」時不送 limit，讓後端用它自己的預設值（最近更新的 5 位）
  const expanded = Boolean(party || region) || view === 'all';
  const res = useApi<SocialWallResponse>(
    buildUrl('/social/wall', { party, region, limit: expanded ? EXPANDED_LIMIT : undefined }),
    { refreshToken },
  );
  const data = res.data;

  if (res.phase === 'loading' && !data) return <LoadingState label="載入粉專牆…" />;
  if (res.phase === 'error') return <ErrorState title="無法取得粉專牆（/api/v1/social/wall）" error={res.error} onRetry={res.reload} />;
  if (!data) return <EmptyState message="沒有粉專資料" />;

  const filtered = Boolean(party || region);
  const pick = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setOpenFb(null); // 篩選後原本展開的那張卡可能已經不在牆上
  };
  const clear = () => {
    setParty('');
    setRegion('');
    setView('compact');
    setOpenFb(null);
  };

  return (
    <>
      <h1 className="sr-only">委員粉專牆</h1>

      <section className="panel" aria-label="粉專牆篩選">
        <div className="sectionhead">
          <h2>粉專牆</h2>
          <span className="muted">{filtered || view === 'all' ? `${data.items.length} / ${data.total} 位` : `最近更新的 ${data.items.length} 位`}</span>
        </div>

        <p className="muted">
          {expanded
            ? '依黨籍或縣市展開的粉專牆，新的貼文排在前面。點「看貼文」載入 Facebook 官方的粉專嵌入框（只對粉絲專頁有效，個人檔案請點「粉專」連結）。'
            : `預設只顯示最近更新的 ${data.default_limit} 位委員；選黨籍或縣市就會展開整個粉專牆。點「看貼文」載入 Facebook 官方的粉專嵌入框。`}
          {data.social.as_of ? `「最新貼文」來自委員臉書整理表，資料截至 ${data.social.as_of}。` : ''}
        </p>
        {data.social.stale ? (
          <p className="social-stale" role="note">
            委員臉書整理表已 {data.social.age_days} 天沒有新的貼文日期，「最新貼文」可能不是最新；請按「看貼文」看臉書上的最新貼文。
          </p>
        ) : null}

        <div className="wall-filters">
          <ChipRow label="依黨籍" allLabel="全部黨籍" items={data.parties} value={party} onPick={pick(setParty)} />
          <ChipRow label="依縣市" allLabel="全部縣市" items={data.regions} value={region} onPick={pick(setRegion)} />
        </div>

        {filtered || view === 'all' ? (
          <p className="wall-bulk">
            <button type="button" className="quiet" onClick={clear}>
              清除條件，只看最近更新的 {data.default_limit} 位
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
          hint="換一個黨籍或縣市，或按「清除條件」。沒有粉專資料的委員會整批不顯示（來源是委員臉書整理表）。"
        />
      ) : (
        <ul className="fb-wall" role="list">
          {data.items.map((item) => (
            <li key={item.id}>
              <WallCard
                item={item}
                open={openFb === item.id}
                onToggle={() => setOpenFb(openFb === item.id ? null : item.id)}
                onOpenId={onOpenId}
              />
            </li>
          ))}
        </ul>
      )}
      {res.phase === 'loading' ? <p className="muted">更新中…</p> : null}
    </>
  );
}
