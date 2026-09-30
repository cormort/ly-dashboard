import type { ReactNode } from 'react';
import { Database, Scale, Star, Users } from 'lucide-react';
import type { ApiResource } from '../hooks/useApi';
import type { HealthResponse, LegislatorsResponse } from '../api/types';
import { formatRelative } from '../lib/format';

export interface StatCardsProps {
  /** 該屆／會期的委員總數（未套用篩選條件） */
  roster: ApiResource<LegislatorsResponse>;
  /** 該屆／會期的召委總數 */
  convenerStat: ApiResource<LegislatorsResponse>;
  trackedCount: number;
  health: ApiResource<HealthResponse>;
  /** 目前會期顯示名稱，例如「第 11 屆第 5 會期」 */
  sessionScopeLabel: string;
}

function StatCard({
  value,
  label,
  hint,
  icon,
  tone,
}: {
  value: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  tone?: 'warning' | 'error' | 'success';
}) {
  return (
    <div className={`card${tone ? ` ${tone}` : ''}`}>
      <div>
        <b>{value}</b>
        <small>{label}</small>
        {hint ? <small className="card-hint">{hint}</small> : null}
      </div>
      <span className="card-icon">{icon}</span>
    </div>
  );
}

function countValue(resource: ApiResource<LegislatorsResponse>): { value: string; hint: string | undefined } {
  if (resource.phase === 'error') return { value: '—', hint: `讀取失敗：${resource.error?.message ?? ''}` };
  if (resource.data === null) return { value: '…', hint: '載入中' };
  return { value: String(resource.data.total), hint: undefined };
}

export function StatCards({
  roster,
  convenerStat,
  trackedCount,
  health,
  sessionScopeLabel,
}: StatCardsProps) {
  const legislators = countValue(roster);
  const conveners = countValue(convenerStat);

  const stale = health.data?.meta.stale === true;
  const syncValue =
    health.phase === 'error' ? '無法讀取' : health.data === null ? '…' : stale ? '可能非最新' : '正常';
  const syncTone = health.phase === 'error' ? 'error' : stale ? 'warning' : 'success';
  const syncHint =
    health.data?.meta.fetched_at != null
      ? `最後同步 ${formatRelative(health.data.meta.fetched_at)}`
      : health.phase === 'error'
        ? '無法連線 /api/v1/health'
        : '尚無成功同步紀錄';

  return (
    <section className="stats" aria-label="重點指標">
      <StatCard
        value={legislators.value}
        label="目前委員數"
        hint={legislators.hint ?? `範圍：${sessionScopeLabel}`}
        icon={<Users aria-hidden="true" />}
      />
      <StatCard
        value={String(trackedCount)}
        label="追蹤中"
        hint="存在此瀏覽器的 localStorage"
        icon={<Star aria-hidden="true" />}
      />
      <StatCard
        value={conveners.value}
        label="本會期召委數"
        hint={conveners.hint ?? `範圍：${sessionScopeLabel}`}
        icon={<Scale aria-hidden="true" />}
      />
      <StatCard
        value={syncValue}
        label="同步狀態"
        hint={syncHint}
        icon={<Database aria-hidden="true" />}
        tone={syncTone}
      />
    </section>
  );
}
