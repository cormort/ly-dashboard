import { useState } from 'react';
import { ChevronRight, MapPin, Star, Users } from 'lucide-react';
import type { ApiResource } from '../hooks/useApi';
import type { Legislator, LegislatorsResponse } from '../api/types';
import { text } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface LegislatorGridProps {
  legislators: ApiResource<LegislatorsResponse>;
  isTracked: (id: string) => boolean;
  onToggleTrack: (legislator: Legislator) => void;
  onOpen: (legislator: Legislator) => void;
  /** 目前會期顯示名稱，用於空狀態文案 */
  sessionScopeLabel: string;
  hasFilters: boolean;
}

function Avatar({ legislator }: { legislator: Legislator }) {
  const [broken, setBroken] = useState(false);
  const photo = legislator.photo_url?.trim() ?? '';

  if (photo === '' || broken) {
    return (
      <div className="avatar" aria-hidden="true">
        {legislator.name.slice(-2)}
      </div>
    );
  }
  return (
    <img
      src={photo}
      alt={`${legislator.name} 委員照片`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
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
  const committeeText =
    legislator.committees.length > 0
      ? legislator.committees.map((item) => item.id).join('、')
      : '未提供';

  return (
    <article>
      <div className="membertop">
        <Avatar legislator={legislator} />
        <div>
          <h3>
            {legislator.name}
            {legislator.is_convener ? <em>召委</em> : null}
          </h3>
          <small>
            {text(legislator.party)} · {committeeText}
          </small>
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

      <p>
        <MapPin aria-hidden="true" />
        {text(legislator.area_name)}
      </p>

      <footer>
        <span>
          第 {legislator.term} 屆
          {legislator.sessions.length > 0 ? ` · ${legislator.sessions.length} 個會期有紀錄` : ''}
        </span>
        <button type="button" onClick={() => onOpen(legislator)}>
          查看檔案
          <ChevronRight aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}

/** 委員卡片格；資料只來自 /api/v1/legislators，空清單一律顯示空狀態（絕不補假資料）。 */
export function LegislatorGrid({
  legislators,
  isTracked,
  onToggleTrack,
  onOpen,
  sessionScopeLabel,
  hasFilters,
}: LegislatorGridProps) {
  if (legislators.phase === 'loading' && !legislators.data) {
    return (
      <section className="panel directory" aria-label="立法委員名錄">
        <div className="sectionhead">
          <h2>立法委員名錄</h2>
        </div>
        <LoadingState label="讀取委員名錄…" />
      </section>
    );
  }

  if (legislators.phase === 'error') {
    return (
      <section className="panel directory" aria-label="立法委員名錄">
        <div className="sectionhead">
          <h2>立法委員名錄</h2>
        </div>
        <ErrorState
          title="無法取得委員名錄（/api/v1/legislators）"
          error={legislators.error}
          onRetry={legislators.reload}
        />
      </section>
    );
  }

  const items = legislators.data?.items ?? [];
  const total = legislators.data?.total ?? 0;

  return (
    <section className="panel directory" aria-label="立法委員名錄">
      <div className="sectionhead">
        <h2>立法委員名錄</h2>
        <span>
          {legislators.data?.meta.source.name ? `${legislators.data.meta.source.name} · ` : ''}
          {items.length} / {total} 筆
        </span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          message={hasFilters ? '沒有符合條件的委員' : '此會期尚無資料'}
          hint={
            hasFilters
              ? '試著放寬關鍵字或清除篩選條件。'
              : `範圍：${sessionScopeLabel}。若剛完成部署，請等待後端同步完成後重新載入。`
          }
        />
      ) : (
        <>
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
          {items.length < total ? (
            <p className="muted">
              <Users aria-hidden="true" /> 尚有 {total - items.length} 筆未顯示（目前 API
              回應筆數上限 500 筆），請縮小篩選範圍。
            </p>
          ) : null}
          {legislators.phase === 'loading' ? <p className="muted">更新中…</p> : null}
        </>
      )}
    </section>
  );
}
