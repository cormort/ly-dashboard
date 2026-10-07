import type { CSSProperties } from 'react';
import { Download, LayoutGrid, List, MapPin, Star } from 'lucide-react';
import type { ApiResource } from '../hooks/useApi';
import type { Legislator, LegislatorsResponse } from '../api/types';
import { shortCommittee, text } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { EmptyState, ErrorState, LoadingState } from './DataStates';
import { LegislatorTable } from './LegislatorTable';
import { Portrait } from './Portrait';

export type DirectoryMode = 'cards' | 'list';

export interface LegislatorGridProps {
  legislators: ApiResource<LegislatorsResponse>;
  /** 前端再套一層的過濾（例：只看追蹤）；後端結果之上只做子集，不重算 */
  visible?: (legislator: Legislator) => boolean;
  isTracked: (id: string) => boolean;
  onToggleTrack: (legislator: Legislator) => void;
  onOpen: (legislator: Legislator) => void;
  /** 目前會期顯示名稱，用於空狀態文案 */
  sessionScopeLabel: string;
  hasFilters: boolean;
  mode: DirectoryMode;
  onModeChange: (mode: DirectoryMode) => void;
  /** 下載目前篩選結果為 CSV */
  onDownload: () => void;
}

function LegislatorCard({
  legislator,
  tracked,
  onToggleTrack,
  onOpen,
}: {
  legislator: Legislator;
  tracked: boolean;
  onToggleTrack: (legislator: Legislator) => void;
  onOpen: (legislator: Legislator) => void;
}) {
  const style = partyStyle(legislator.party);
  // 召委以小徽章標在該委員會後面，而不是「修憲・召」這種看起來像被截斷的字
  const committees =
    legislator.committees.length > 0
      ? legislator.committees.map((item, i) => (
          <span key={item.id}>
            {i > 0 ? '、' : ''}
            {shortCommittee(item.id)}
            {item.is_convener ? <span className="convener-badge">召委</span> : null}
          </span>
        ))
      : '未提供';
  const latestPost = legislator.social.map((s) => s.latest_post_date).filter(Boolean).sort().at(-1);

  return (
    <article className="member-card" style={{ '--party': style.color } as CSSProperties}>
      <div className="membertop">
        <Portrait legislator={legislator} />
        <div>
          <h3>
            {legislator.name}
            {legislator.is_convener ? <span className="convener-mark">召委</span> : null}
          </h3>
          <small className="party-line">{style.short}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-pressed={tracked}
          aria-label={tracked ? `取消追蹤 ${legislator.name}` : `追蹤 ${legislator.name}`}
          title={tracked ? '取消追蹤' : '加入追蹤'}
          onClick={() => onToggleTrack(legislator)}
        >
          <Star className={tracked ? 'active' : undefined} aria-hidden="true" />
        </button>
      </div>

      <p className="member-area">
        <MapPin aria-hidden="true" />
        {text(legislator.area_name)}
      </p>
      <p className="member-committees">{committees}</p>

      <footer>
        <span>
          提案 {legislator.bill_count}　連署 {legislator.cosign_count ?? 0}　新聞 {legislator.news_count}
          {latestPost ? `　貼文 ${latestPost.slice(5).replace('-', '/')}` : ''}
        </span>
        <button type="button" onClick={() => onOpen(legislator)}>
          查看檔案
        </button>
      </footer>
    </article>
  );
}

/** 委員名錄：卡片／列表兩種模式；資料只來自 /api/v1/legislators，空清單一律顯示空狀態（絕不補假資料）。 */
export function LegislatorGrid({
  legislators,
  visible,
  isTracked,
  onToggleTrack,
  onOpen,
  sessionScopeLabel,
  hasFilters,
  mode,
  onModeChange,
  onDownload,
}: LegislatorGridProps) {
  const head = (count?: string) => (
    <div className="sectionhead">
      <h2>立法委員名錄</h2>
      <div>
        {count ? <span className="muted">{count}</span> : null}
        {count ? (
          <button type="button" className="quiet" onClick={onDownload} title="下載目前篩選結果">
            <Download aria-hidden="true" />
            CSV
          </button>
        ) : null}
        <div className="segmented" role="group" aria-label="顯示方式">
          <button type="button" aria-pressed={mode === 'cards'} onClick={() => onModeChange('cards')}>
            <LayoutGrid aria-hidden="true" />
            卡片
          </button>
          <button type="button" aria-pressed={mode === 'list'} onClick={() => onModeChange('list')}>
            <List aria-hidden="true" />
            列表
          </button>
        </div>
      </div>
    </div>
  );

  if (legislators.phase === 'loading' && !legislators.data) {
    return (
      <section className="panel directory" aria-label="立法委員名錄">
        {head()}
        <LoadingState label="讀取委員名錄…" />
      </section>
    );
  }

  if (legislators.phase === 'error') {
    return (
      <section className="panel directory" aria-label="立法委員名錄">
        {head()}
        <ErrorState
          title="無法取得委員名錄（/api/v1/legislators）"
          error={legislators.error}
          onRetry={legislators.reload}
        />
      </section>
    );
  }

  const all = legislators.data?.items ?? [];
  const items = visible ? all.filter(visible) : all;
  const total = legislators.data?.total ?? 0;

  return (
    <section className="panel directory" aria-label="立法委員名錄">
      {head(`${items.length} / ${total} 位`)}

      {items.length === 0 ? (
        <EmptyState
          message={hasFilters ? '沒有符合條件的委員' : '此會期尚無資料'}
          hint={
            hasFilters
              ? '放寬關鍵字或按「清除條件」。'
              : `範圍：${sessionScopeLabel}。若剛完成部署，請等待後端同步完成後重新載入。`
          }
        />
      ) : mode === 'list' ? (
        <LegislatorTable items={items} isTracked={isTracked} onToggleTrack={onToggleTrack} onOpen={onOpen} />
      ) : (
        <ul className="grid" role="list">
          {items.map((legislator) => (
            <li key={legislator.id}>
              <LegislatorCard
                legislator={legislator}
                tracked={isTracked(legislator.id)}
                onToggleTrack={onToggleTrack}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ul>
      )}
      {all.length < total ? (
        <p className="muted">尚有 {total - all.length} 筆未顯示（API 回應上限 500 筆），請縮小篩選範圍。</p>
      ) : null}
      {legislators.phase === 'loading' ? <p className="muted">更新中…</p> : null}
    </section>
  );
}
