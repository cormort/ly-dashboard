import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { ExternalLink, MapPin, Star, X } from 'lucide-react';
import type { Legislator, SourceInfo } from '../api/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { text } from '../lib/format';
import { LegislatorBills } from './LegislatorBills';

export interface LegislatorDetailProps {
  legislator: Legislator;
  onClose: () => void;
  tracked: boolean;
  onToggleTrack: (legislator: Legislator) => void;
  source: SourceInfo | null;
  /** 會期 id → 顯示名稱（來自 /api/v1/meta） */
  sessionLabel: (sessionId: string) => string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 委員詳情側欄：Esc 可關閉、焦點留在側欄內、資料只呈現後端欄位。 */
export function LegislatorDetail({
  legislator,
  onClose,
  tracked,
  onToggleTrack,
  source,
  sessionLabel,
}: LegislatorDetailProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEscapeKey(true, onClose);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="close" onClick={onClose} aria-label="關閉委員檔案" ref={closeRef}>
          <X aria-hidden="true" />
        </button>

        <h1 id={titleId}>
          {legislator.name}
          {legislator.is_convener ? <em>本會期召委</em> : null}
        </h1>
        <p className="muted">
          {text(legislator.ename, '')}
          {legislator.ename ? ' · ' : ''}
          {text(legislator.party)}（{text(legislator.caucus)}）
        </p>
        <p className="muted">
          <MapPin aria-hidden="true" />
          {text(legislator.area_name)} · 第 {legislator.term} 屆
        </p>

        <div className="detail-actions">
          <button
            type="button"
            className={tracked ? 'primary' : undefined}
            aria-pressed={tracked}
            onClick={() => onToggleTrack(legislator)}
          >
            <Star className={tracked ? 'active' : undefined} aria-hidden="true" />
            {tracked ? '取消追蹤' : '加入追蹤'}
          </button>
        </div>

        <dl>
          <dt>本會期委員會</dt>
          <dd>
            {legislator.committees.length > 0 ? (
              <ul className="chip-list" role="list">
                {legislator.committees.map((committee) => (
                  <li key={committee.id}>
                    <span className="chip">{committee.id}</span>
                    {committee.is_convener ? <span className="chip convener">召委</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              '未提供'
            )}
          </dd>

          <dt>有紀錄的會期</dt>
          <dd>
            {legislator.sessions.length > 0 ? (
              <ul className="chip-list" role="list">
                {legislator.sessions.map((sessionId) => (
                  <li key={sessionId}>
                    <span className="chip plain">{sessionLabel(sessionId)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              '未提供'
            )}
          </dd>

          <dt>最近提案</dt>
          <dd>
            <LegislatorBills legislatorId={legislator.id} />
          </dd>

          <dt>就職日期</dt>
          <dd>{text(legislator.onboard_date)}</dd>

          <dt>聯絡方式</dt>
          <dd>
            {legislator.contacts.length > 0 ? (
              <ul className="contact-list" role="list">
                {legislator.contacts.map((office) => (
                  <li key={office.label}>
                    <b>{office.label}</b>
                    {office.tel ? (
                      <small>
                        電話：
                        {office.tel.split('、').map((tel, index) => (
                          <span key={tel}>
                            {index > 0 ? '、' : ''}
                            <a href={`tel:${tel.replace(/[^\d+#]/g, '')}`}>{tel}</a>
                          </span>
                        ))}
                      </small>
                    ) : null}
                    {office.fax ? <small>傳真：{office.fax}</small> : null}
                    {office.addr ? <small>地址：{office.addr}</small> : null}
                  </li>
                ))}
              </ul>
            ) : (
              '未提供'
            )}
          </dd>

          <dt>學歷</dt>
          <dd>{text(legislator.degree)}</dd>

          <dt>經歷</dt>
          <dd>{text(legislator.experience)}</dd>

          <dt>委員識別碼</dt>
          <dd>
            <code>{legislator.id}</code>
          </dd>

          <dt>資料來源</dt>
          <dd>
            <a href={legislator.source_url} target="_blank" rel="noreferrer noopener">
              {source?.name ?? '立法院開放資料'}
              <ExternalLink aria-hidden="true" />
            </a>
            {source ? <small className="muted">{source.license}</small> : null}
          </dd>
        </dl>
      </aside>
    </div>
  );
}
