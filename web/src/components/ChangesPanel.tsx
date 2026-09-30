import { History } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { ChangesResponse } from '../api/types';
import { useApi } from '../hooks/useApi';
import { formatChangeValue, formatDateTime } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface ChangesPanelProps {
  refreshToken: number;
}

const ENTITY_LABELS: Record<string, string> = {
  legislator: '委員',
  membership: '屆期成員',
  committee_seat: '委員會席次',
};

const FIELD_LABELS: Record<string, string> = {
  is_convener: '召集委員',
  committee: '委員會',
  party: '黨籍',
  area_name: '選區',
  degree: '學歷',
  experience: '經歷',
  leave_flag: '離職狀態',
};

/**
 * 最近異動：/api/v1/changes?limit=50
 * entity_id 的格式由後端決定（例如 `11-5|內政委員會|LY-00024`），前端只顯示不解析。
 */
export function ChangesPanel({ refreshToken }: ChangesPanelProps) {
  const changes = useApi<ChangesResponse>(buildUrl('/changes', { limit: 50 }), { refreshToken });

  return (
    <section className="panel changes" aria-label="最近異動">
      <div className="sectionhead">
        <h2>
          <History aria-hidden="true" />
          最近異動
        </h2>
        <button type="button" onClick={changes.reload} disabled={changes.phase === 'loading'}>
          重新整理
        </button>
      </div>

      {changes.phase === 'loading' && !changes.data ? <LoadingState label="讀取異動紀錄…" /> : null}

      {changes.phase === 'error' ? (
        <ErrorState
          title="無法取得異動紀錄（/api/v1/changes）"
          error={changes.error}
          onRetry={changes.reload}
        />
      ) : null}

      {changes.phase === 'empty' ? (
        <EmptyState message="尚無異動紀錄" hint="同步作業偵測到欄位變更時，會在這裡列出。" />
      ) : null}

      {changes.data && changes.data.items.length > 0 ? (
        <ul className="log-list" role="list">
          {changes.data.items.map((change) => (
            <li className="log" key={change.id}>
              <span
                className={`dot ${change.field === 'is_convener' ? 'success' : 'warning'}`}
                aria-hidden="true"
              />
              <div>
                <b>
                  {ENTITY_LABELS[change.entity] ?? change.entity} ·{' '}
                  {FIELD_LABELS[change.field] ?? change.field}
                </b>
                <small>
                  <span className="old-value">{formatChangeValue(change.field, change.old_value)}</span>
                  {' → '}
                  <span className="new-value">{formatChangeValue(change.field, change.new_value)}</span>
                  {' · '}
                  {formatDateTime(change.at)}
                </small>
                <small className="muted">
                  <code>{change.entity_id}</code>
                </small>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {changes.data ? (
        <p className="muted">共 {changes.data.count} 筆（最多顯示 50 筆）。</p>
      ) : null}
    </section>
  );
}
