import { Portrait } from './Portrait';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ExternalLink, GitCompareArrows, MapPin, Star, X } from 'lucide-react';
import type { Legislator, SocialFreshness, SourceInfo } from '../api/types';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { text } from '../lib/format';
import { partyStyle } from '../lib/parties';
import { LegislatorBills } from './LegislatorBills';
import { LegislatorCosponsors } from './LegislatorCosponsors';
import { LegislatorElectionHistory } from './LegislatorElectionHistory';
import { LegislatorNews } from './LegislatorNews';
import { FacebookEmbed } from './FacebookEmbed';

export interface LegislatorDetailProps {
  legislator: Legislator;
  onClose: () => void;
  tracked: boolean;
  onToggleTrack: (legislator: Legislator) => void;
  source: SourceInfo | null;
  /** 會期 id → 顯示名稱（來自 /api/v1/meta） */
  sessionLabel: (sessionId: string) => string;
  /** 開另一位委員的檔案（共同提案人） */
  onOpenId: (id: string) => void;
  onCompare: (legislator: Legislator) => void;
  /** 社群整理表的新鮮度（/health），用來標「資料截至」與過期提醒；沒有就不標 */
  socialFreshness?: SocialFreshness | null;
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
  onOpenId,
  onCompare,
  socialFreshness = null,
}: LegislatorDetailProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  // 正在看貼文的臉書帳號（一次只開一個嵌入框）
  const [openPosts, setOpenPosts] = useState<string | null>(null);

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

  const style = partyStyle(legislator.party);

  return (
    <div className="overlay" onClick={onClose}>
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        style={{ '--party': style.color } as CSSProperties}
      >
        <button type="button" className="icon-button close" onClick={onClose} aria-label="關閉委員檔案" ref={closeRef}>
          <X aria-hidden="true" />
        </button>

        <div className="detail-head">
          <Portrait key={legislator.id} legislator={legislator} />
          <div>
            <h1 id={titleId}>
              {legislator.name}
              {legislator.is_convener ? <span className="convener-mark">本會期召委</span> : null}
            </h1>
            <p className="muted">
              <span style={{ color: style.color }}>{text(legislator.party)}</span>
              {legislator.caucus && legislator.caucus !== legislator.party ? `（${legislator.caucus}黨團）` : ''}
              {legislator.ename ? `　${legislator.ename}` : ''}
            </p>
            <p className="muted">
              <MapPin aria-hidden="true" />
              {text(legislator.area_name)}・第 {legislator.term} 屆
            </p>
            <button
              type="button"
              className={tracked ? 'primary' : undefined}
              aria-pressed={tracked}
              onClick={() => onToggleTrack(legislator)}
            >
              <Star className={tracked ? 'active' : undefined} aria-hidden="true" />
              {tracked ? '取消追蹤' : '加入追蹤'}
            </button>{' '}
            <button type="button" onClick={() => onCompare(legislator)}>
              <GitCompareArrows aria-hidden="true" />
              比較
            </button>
          </div>
        </div>

        <section className="detail-section">
          <h2>委員會與會期</h2>
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
            <dt>就職日期</dt>
            <dd>{text(legislator.onboard_date)}</dd>
          </dl>
        </section>

        <section className="detail-section">
          <h2>社群</h2>
          {legislator.social.length > 0 ? (
            <ul className="contact-list" role="list">
              {legislator.social.map((account) => (
                <li key={account.url}>
                  <a href={account.url} target="_blank" rel="noreferrer noopener">
                    {account.platform === 'facebook' ? '臉書' : 'Threads'}：{account.name || account.url}
                    <ExternalLink aria-hidden="true" />
                  </a>
                  {account.latest_post_date ? (
                    <small>
                      最新貼文 {account.latest_post_date}
                      {account.latest_post_summary ? `：${account.latest_post_summary}` : ''}
                      {/* 整理表是人工維護的：標出資料截至哪天，太久沒更新就提醒（最新的請看下面的嵌入貼文） */}
                      {socialFreshness?.as_of ? <span className="muted">（整理表資料截至 {socialFreshness.as_of}）</span> : null}
                    </small>
                  ) : null}
                  {account.platform === 'facebook' && socialFreshness?.stale ? (
                    <small className="social-stale" role="note">
                      整理表已 {socialFreshness.age_days} 天沒更新，上面的日期可能不是最新；請按「看貼文」看臉書上的最新貼文。
                    </small>
                  ) : null}
                  {/* 臉書可以直接看最近的貼文（官方嵌入框，點了才載入）；Threads 沒有官方嵌入框 */}
                  {account.platform === 'facebook' ? (
                    <button type="button" className="link-button" aria-expanded={openPosts === account.url} onClick={() => setOpenPosts(openPosts === account.url ? null : account.url)}>
                      {openPosts === account.url ? '收起貼文' : '看貼文'}
                    </button>
                  ) : null}
                  {account.platform === 'facebook' && openPosts === account.url ? <FacebookEmbed url={account.url} name={legislator.name} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">未提供</p>
          )}
        </section>

        <section className="detail-section">
          <h2>近期新聞</h2>
          <LegislatorNews legislatorId={legislator.id} />
        </section>

        <section className="detail-section">
          <h2>最近提案</h2>
          <LegislatorBills legislatorId={legislator.id} />
        </section>

        <section className="detail-section">
          <h2>聯絡方式</h2>
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
            <p className="muted">未提供</p>
          )}
        </section>

        <section className="detail-section">
          <h2>學經歷</h2>
          <dl>
            <dt>學歷</dt>
            <dd>{text(legislator.degree)}</dd>
            <dt>經歷</dt>
            <dd>{text(legislator.experience)}</dd>
          </dl>
        </section>

        <section className="detail-section">
          <h2>歷次得票</h2>
          <LegislatorElectionHistory legislatorId={legislator.id} region={legislator.region} />
        </section>

        <section className="detail-section">
          <h2>最常一起提案</h2>
          <LegislatorCosponsors legislatorId={legislator.id} onOpenId={onOpenId} />
        </section>

        <section className="detail-section">
          <h2>資料</h2>
          <dl>
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
        </section>
      </aside>
    </div>
  );
}
