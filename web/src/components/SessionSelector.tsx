import { CalendarClock } from 'lucide-react';
import type { ApiResource } from '../hooks/useApi';
import type { MetaResponse } from '../api/types';
import { ALL_SESSIONS } from '../lib/urlState';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface SessionSelectorProps {
  meta: ApiResource<MetaResponse>;
  /** 目前生效的屆次（URL 未指定時為 /meta 的 current.term） */
  term: number | null;
  /** 目前生效的會期：會期 id 或 all；null 表示後端無法判定 */
  session: string | null;
  /** /api/v1/meta 的 current.session 為 null，且使用者未自行指定會期 */
  sessionUndetermined?: boolean;
  onTermChange: (term: number) => void;
  onSessionChange: (session: string) => void;
}

export function SessionSelector({
  meta,
  term,
  session,
  sessionUndetermined = false,
  onTermChange,
  onSessionChange,
}: SessionSelectorProps) {
  if (meta.phase === 'loading' && !meta.data) {
    return (
      <section className="panel selector" aria-label="屆次與會期">
        <LoadingState label="讀取屆次／會期清單…" />
      </section>
    );
  }

  if (meta.phase === 'error') {
    return (
      <section className="panel selector" aria-label="屆次與會期">
        <ErrorState title="無法取得屆次清單（/api/v1/meta）" error={meta.error} onRetry={meta.reload} />
      </section>
    );
  }

  const terms = meta.data?.terms ?? [];
  if (terms.length === 0) {
    return (
      <section className="panel selector" aria-label="屆次與會期">
        <EmptyState message="後端尚無屆次資料" hint="請確認同步作業是否已成功執行。" />
      </section>
    );
  }

  const activeTerm = terms.find((item) => item.no === term) ?? terms[0];
  const sessions = activeTerm.sessions;

  return (
    <section className="panel selector" aria-label="屆次與會期">
      <div className="selector-fields">
        <label>
          <span>
            <CalendarClock aria-hidden="true" />
            屆次
          </span>
          <select
            value={String(activeTerm.no)}
            onChange={(event) => onTermChange(Number(event.target.value))}
          >
            {terms.map((item) => (
              <option key={item.no} value={item.no}>
                第 {item.no} 屆
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>會期</span>
          <select
            value={session ?? ALL_SESSIONS}
            onChange={(event) => onSessionChange(event.target.value)}
            disabled={sessions.length === 0}
          >
            <option value={ALL_SESSIONS}>全部會期</option>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sessionUndetermined ? (
        <p className="muted">
          後端無法判定本屆「有委員資料的最新會期」（<code>current.session</code> 為 null），
          目前以「全部會期」呈現，請自行選擇會期。
        </p>
      ) : null}
      {sessions.length === 0 ? (
        <p className="muted">此屆次尚無會期資料。</p>
      ) : null}
    </section>
  );
}
