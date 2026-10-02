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
      <section className="selector" aria-label="屆次與會期">
        <LoadingState label="讀取屆次／會期清單…" />
      </section>
    );
  }

  if (meta.phase === 'error') {
    return (
      <section className="selector" aria-label="屆次與會期">
        <ErrorState title="無法取得屆次清單（/api/v1/meta）" error={meta.error} onRetry={meta.reload} />
      </section>
    );
  }

  const terms = meta.data?.terms ?? [];
  if (terms.length === 0) {
    return (
      <section className="selector" aria-label="屆次與會期">
        <EmptyState message="後端尚無屆次資料" hint="請確認同步作業是否已成功執行。" />
      </section>
    );
  }

  // URL 可以帶任意 term／session（可分享、可手改，換屆後舊連結就是這種情況）。
  // 不在清單裡的值一定要留在選單上：否則 select 會顯示清單第一項、資料卻是另一個東西，
  // 而且使用者沒辦法從 UI 切回去（值已等於唯一選項，選它不會觸發 change）。
  const knownTerm = terms.find((item) => item.no === term) ?? null;
  const activeTerm = knownTerm ?? terms[0];
  const unknownTerm = term !== null && !knownTerm;
  const sessions = unknownTerm ? [] : activeTerm.sessions;
  const unknownSession = session !== null && session !== ALL_SESSIONS && !sessions.some((item) => item.id === session);

  return (
    <section className="selector" aria-label="屆次與會期">
      <div className="selector-fields">
        <label>
          <span>
            <CalendarClock aria-hidden="true" />
            屆次
          </span>
          <select
            value={unknownTerm ? String(term) : String(activeTerm.no)}
            onChange={(event) => onTermChange(Number(event.target.value))}
          >
            {unknownTerm ? <option value={term}>第 {term} 屆（無資料）</option> : null}
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
            {unknownSession ? <option value={session}>{session}（無資料）</option> : null}
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
