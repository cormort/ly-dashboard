import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  FileClock,
  WifiOff,
} from 'lucide-react';
import { buildUrl } from '../api/client';
import type { ApiResource } from '../hooks/useApi';
import type { HealthResponse, SyncRun, SyncRunStatus, SyncRunsResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { datasetLabel, formatDateTime, formatRelative, SYNC_STATUS_LABELS, text } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface SyncStatusBannerProps {
  health: ApiResource<HealthResponse>;
  /** 頁面層的重新整理序號，讓展開的同步紀錄也一起重抓 */
  refreshToken: number;
}

function statusClass(status: SyncRunStatus): string {
  return status === 'success' ? 'success' : status === 'failed' ? 'error' : 'warning';
}

function RunRow({ run }: { run: SyncRun }) {
  return (
    <li className="log">
      <span className={`dot ${statusClass(run.status)}`} aria-hidden="true" />
      <div>
        <b>
          {datasetLabel(run.dataset)}：{SYNC_STATUS_LABELS[run.status] ?? run.status}
        </b>
        <small>
          {run.finished_at ? formatDateTime(run.finished_at) : '尚未結束'}
          {run.records !== null ? ` · ${run.records} 筆` : ''}
          {run.attempt > 1 ? ` · 第 ${run.attempt} 次嘗試` : ''}
          {run.duration_ms !== null ? ` · ${run.duration_ms} ms` : ''}
          {run.http_status !== null ? ` · HTTP ${run.http_status}` : ''}
        </small>
        {run.error ? <small className="log-error">錯誤：{run.error}</small> : null}
      </div>
    </li>
  );
}

/**
 * 同步狀態橫幅：/api/v1/health（＋展開時的 /api/v1/sync-runs）。
 * meta.stale === true 時必須明顯提示「可能非最新」。
 */
export function SyncStatusBanner({ health, refreshToken }: SyncStatusBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const runsUrl = expanded ? buildUrl('/sync-runs', { limit: 50 }) : null;
  const runs = useApi<SyncRunsResponse>(runsUrl, { refreshToken });

  const latestRun = useMemo(() => {
    const list = health.data?.last_runs ?? [];
    return list.length > 0 ? list[0] : null;
  }, [health.data]);

  if (health.phase === 'loading' && !health.data) {
    return (
      <section className="status loading" aria-label="同步狀態">
        <LoadingState label="讀取同步狀態…" />
      </section>
    );
  }

  if (health.phase === 'error') {
    return (
      <section className="status error" aria-label="同步狀態">
        <ErrorState
          title="無法取得同步狀態（/api/v1/health）"
          error={health.error}
          onRetry={health.reload}
        />
      </section>
    );
  }

  const meta = health.data?.meta ?? null;
  const stale = meta?.stale === true;
  const failedRun = latestRun && latestRun.status === 'failed' ? latestRun : null;
  const failed = failedRun !== null || health.data?.ok === false;
  const tone = failed ? 'error' : stale ? 'warning' : 'success';
  const headline = failedRun
    ? `最近一次同步失敗：${datasetLabel(failedRun.dataset)}`
    : failed
      ? '最近一次同步失敗'
      : stale
        ? '資料可能非最新'
        : '資料同步正常';

  return (
    <section className={`status ${tone}`} aria-label="同步狀態">
      <div className="status-icon">
        {failed ? (
          <WifiOff aria-hidden="true" />
        ) : stale ? (
          <AlertTriangle aria-hidden="true" />
        ) : (
          <CheckCircle2 aria-hidden="true" />
        )}
      </div>
      <div className="status-main">
        <b>{headline}</b>
        <small>
          最後成功同步：{formatDateTime(meta?.fetched_at ?? null, '尚無成功同步紀錄')}
          {meta?.fetched_at ? `（${formatRelative(meta.fetched_at)}）` : ''}
          {latestRun?.finished_at ? ` · 最近一次執行：${formatDateTime(latestRun.finished_at)}` : ''}
        </small>
        {failedRun?.error ? (
          <p className="sync-error" role="alert">
            <WifiOff aria-hidden="true" />
            {datasetLabel(failedRun.dataset)}：{failedRun.error}
            {failedRun.attempt ? `（嘗試 ${failedRun.attempt} 次）` : ''}
          </p>
        ) : null}
        {stale ? (
          <p className="stale-warning" role="status">
            <AlertTriangle aria-hidden="true" />
            資料截至 {formatDateTime(meta?.fetched_at ?? null)}，已超過 36 小時未成功同步，可能非最新。
          </p>
        ) : null}
        {health.data ? (
          <small className="db-counts">
            資料庫：委員 {health.data.db.legislators} 筆 · 屆期成員 {health.data.db.memberships} 筆 ·
            委員會席次 {health.data.db.committee_seats} 筆 · 異動 {health.data.db.changes} 筆
          </small>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls="sync-run-list"
      >
        <FileClock aria-hidden="true" />
        同步紀錄
        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>

      {expanded ? (
        <div className="sync-runs" id="sync-run-list">
          <h3>
            <Clock3 aria-hidden="true" />
            最近同步紀錄
          </h3>
          {runs.phase === 'loading' ? <LoadingState label="讀取同步紀錄…" /> : null}
          {runs.phase === 'error' ? (
            <ErrorState
              title="無法取得同步紀錄（/api/v1/sync-runs）"
              error={runs.error}
              onRetry={runs.reload}
            />
          ) : null}
          {runs.phase === 'empty' ? (
            <EmptyState message="尚無同步紀錄" hint="後端尚未執行任何資料集同步。" />
          ) : null}
          {runs.phase === 'ready' && runs.data ? (
            <ul className="log-list">
              {runs.data.items.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          ) : null}
          {health.data && health.data.last_runs.length > 0 && runs.phase !== 'ready' ? (
            <ul className="log-list">
              {health.data.last_runs.map((run) => (
                <RunRow key={`health-${run.dataset}-${run.id}`} run={run} />
              ))}
            </ul>
          ) : null}
          <p className="muted">使用者代理：{text(latestRun?.ua, '未記錄')}</p>
        </div>
      ) : null}
    </section>
  );
}
