import { useMemo, useState } from 'react';
import { BarChart3, Cloud } from 'lucide-react';
import { buildUrl } from '../api/client';
import type { TopicItem, TopicsResponse } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useApi } from '../hooks/useApi';
import { pathFor } from '../hooks/useRoute';
import { formatDateTime } from '../lib/format';
import { partyStyle, sortParties } from '../lib/parties';

export interface TopicsPanelProps {
  refreshToken: number;
  onNavigate: (href: string) => void;
}

type WindowKey = 'all' | '90' | '30' | '7';
type VocabKey = 'law' | 'category' | 'committee';
type ViewKey = 'bars' | 'tags';

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'all', label: '本屆' },
  { key: '90', label: '90 天' },
  { key: '30', label: '30 天' },
  { key: '7', label: '7 天' },
];
const VOCAB_LABELS: Record<VocabKey, string> = {
  law: '法律名稱',
  category: '議案類別',
  committee: '委員會',
};
const TAG_LIMIT = 20;

/** 網址即狀態：?days=90&vocab=law&view=tags（可分享、重整後一致） */
function readParams(): { days: WindowKey; vocab: VocabKey; view: ViewKey } {
  const params = new URLSearchParams(window.location.search);
  const days = params.get('days');
  const vocab = params.get('vocab');
  const view = params.get('view');
  return {
    days: WINDOWS.some((w) => w.key === days) ? (days as WindowKey) : '90',
    vocab: vocab && vocab in VOCAB_LABELS ? (vocab as VocabKey) : 'law',
    view: view === 'tags' ? 'tags' : 'bars',
  };
}

function writeParams(next: { days: WindowKey; vocab: VocabKey; view: ViewKey }) {
  const params = new URLSearchParams(window.location.search);
  params.set('days', next.days);
  params.set('vocab', next.vocab);
  params.set('view', next.view);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

/** 依件數分成三段字級：前三分之一大、中三分之一中、其餘小（固定規則，不是隨機散佈） */
export function tagTier(index: number, total: number): 'lg' | 'md' | 'sm' {
  const third = Math.max(1, Math.ceil(total / 3));
  if (index < third) return 'lg';
  if (index < third * 2) return 'md';
  return 'sm';
}

/** 增減只在「有可比的前一期」時顯示（本屆累計、或前期早於資料起點時不顯示） */
function deltaLabel(item: TopicItem, comparable: boolean): string | null {
  if (!comparable) return null;
  if (item.previous_count === 0 && item.count === 0) return null;
  if (item.delta === 0) return '與前一期相同';
  return item.delta > 0 ? `較前一期 +${item.delta}` : `較前一期 ${item.delta}`;
}

function PartyBar({ parties }: { parties: Record<string, number> }) {
  const names = sortParties(Object.keys(parties));
  if (names.length === 0) return null;
  return (
    <span className="bar" aria-label={`主提案黨籍：${names.map((p) => `${partyStyle(p).short} ${parties[p]}`).join('、')}`}>
      {names.map((p) => (
        <span key={p} style={{ flexGrow: parties[p], background: partyStyle(p).color }} />
      ))}
    </span>
  );
}

function BarsView({ items, unit, comparable, onNavigate }: { items: TopicItem[]; unit: string; comparable: boolean; onNavigate: (href: string) => void }) {
  return (
    <ol className="topic-list">
      {items.map((topic, index) => {
        const delta = deltaLabel(topic, comparable);
        return (
          <li key={topic.name}>
            <a
              href={pathFor('bills', { law: topic.name })}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(pathFor('bills', { law: topic.name }));
              }}
            >
              <span className="topic-rank">{index + 1}</span>
              <span className="topic-name">{topic.name}</span>
              <span className="topic-count">
                {topic.count} {unit}
                {topic.recent_count ? <em className="topic-recent">近 7 天 {topic.recent_count}</em> : null}
                {delta ? <em className={topic.delta > 0 ? 'topic-delta up' : 'topic-delta'}>{delta}</em> : null}
              </span>
              <PartyBar parties={topic.parties} />
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 標籤檢視（文字雲的形，但沒有它的缺點）：
 * 用受控詞彙（法律名稱／議案類別／委員會），件數排序固定、不隨機散佈，
 * 每個標籤都有 title 提示與一份螢幕閱讀器可讀的清單。
 */
function TagsView({ items, unit, comparable, onNavigate }: { items: TopicItem[]; unit: string; comparable: boolean; onNavigate: (href: string) => void }) {
  return (
    <>
      <div className="tag-cloud">
        {items.map((topic, index) => {
          const tier = tagTier(index, items.length);
          const parties = sortParties(Object.keys(topic.parties));
          const tooltip = [
            `${topic.count} ${unit}`,
            topic.recent_count ? `近 7 天 ${topic.recent_count} ${unit}` : null,
            deltaLabel(topic, comparable),
            topic.passed ? `三讀 ${topic.passed}` : null,
            parties.length ? `主提案：${parties.map((p) => `${partyStyle(p).short} ${topic.parties[p]}`).join('、')}` : null,
            topic.latest_date ? `最新進度 ${topic.latest_date}` : null,
          ]
            .filter(Boolean)
            .join('・');
          return (
            <a
              key={topic.name}
              className={`tag tag-${tier}`}
              href={pathFor('bills', { law: topic.name })}
              title={tooltip}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(pathFor('bills', { law: topic.name }));
              }}
            >
              {topic.name}
              <span className="tag-count">{topic.count}</span>
            </a>
          );
        })}
      </div>
      {/* 螢幕閱讀器用：標籤雲本身沒有順序感，這裡提供一份可讀的清單 */}
      <ul className="sr-only" aria-label={`${unit}數排序的清單`}>
        {items.map((topic) => (
          <li key={topic.name}>
            {topic.name}：{topic.count} {unit}
            {deltaLabel(topic, comparable) ? `，${deltaLabel(topic, comparable)}` : ''}
            {topic.recent_count ? `，近 7 天 ${topic.recent_count} ${unit}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * 熱門議題：支援 本屆／90／30／7 天區間、三種受控詞彙、長條與標籤兩種檢視。
 * 排序、件數、增減、黨籍分布全部由後端算好（前端不重算）。
 */
export function TopicsPanel({ refreshToken, onNavigate }: TopicsPanelProps) {
  const [state, setState] = useState(readParams);
  const daysParam = state.days === 'all' ? 'all' : state.days;
  const topics = useApi<TopicsResponse>(
    buildUrl('/topics', { days: daysParam, limit: TAG_LIMIT, vocab: state.vocab }),
    { refreshToken },
  );

  const update = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch };
    setState(next);
    writeParams(next);
  };

  const data = topics.data;
  const meta = data?.vocabularies.find((v) => v.id === data.vocab);
  const unit = meta?.unit ?? '件';

  // 詞彙本身太集中（例：議案類別 99% 是法律案）時要說清楚，不要假裝是熱門分布
  const skew = useMemo(() => {
    if (!data || data.items.length === 0 || !data.distinct) return null;
    const top = data.items[0];
    const share = top.count / Math.max(1, data.items.reduce((sum, i) => sum + i.count, 0));
    if (data.distinct < TAG_LIMIT) return `此詞彙在期間內只有 ${data.distinct} 種，清單已全部列出`;
    if (share > 0.5) return `高度集中：${top.name} 佔 ${Math.round(share * 100)}%`;
    return null;
  }, [data]);

  const emptyMessage =
    state.days === '7' ? '近 7 天沒有提案進度' : state.days === '30' ? '近 30 天沒有提案進度' : '這個期間沒有提案進度';

  return (
    <section className="panel topics-panel" aria-label="熱門議題">
      <div className="sectionhead topics-head">
        <div>
          <h2>熱門議題</h2>
          {data ? (
            <p className="topic-note muted">
              依{meta?.label ?? '法律名稱'}分組（{meta?.note ?? ''}）；資料截至 {data.data_to}
              {data.window.from
                ? `，期間 ${data.window.from} 起${data.comparable ? '，並與前一期比較' : '（前期資料不完整，不顯示增減）'}`
                : '（本屆累計，不顯示增減）'}
              。
            </p>
          ) : null}
        </div>

        <div className="topics-controls">
          <div className="segmented" role="group" aria-label="統計區間">
            {WINDOWS.map((w) => (
              <button key={w.key} type="button" aria-pressed={state.days === w.key} onClick={() => update({ days: w.key })}>
                {w.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="詞彙">
            {(Object.keys(VOCAB_LABELS) as VocabKey[]).map((key) => (
              <button key={key} type="button" aria-pressed={state.vocab === key} onClick={() => update({ vocab: key })}>
                {VOCAB_LABELS[key]}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="檢視方式">
            <button type="button" aria-pressed={state.view === 'bars'} onClick={() => update({ view: 'bars' })}>
              <BarChart3 size={14} aria-hidden="true" /> 長條
            </button>
            <button type="button" aria-pressed={state.view === 'tags'} onClick={() => update({ view: 'tags' })}>
              <Cloud size={14} aria-hidden="true" /> 標籤
            </button>
          </div>
        </div>
      </div>

      {topics.phase === 'loading' && !data ? <LoadingState label="讀取議題…" /> : null}
      {topics.phase === 'error' ? (
        <ErrorState title="無法取得議題（/api/v1/topics）" error={topics.error} onRetry={topics.reload} />
      ) : null}
      {data && data.items.length === 0 ? <EmptyState message={emptyMessage} hint="換一個區間，或確認議案資料是否已同步。" /> : null}

      {data && data.items.length > 0 ? (
        <>
          {skew ? <p className="topic-skew muted">{skew}</p> : null}
          {state.view === 'tags' ? (
            <TagsView items={data.items} unit={unit} comparable={data.comparable} onNavigate={onNavigate} />
          ) : (
            <BarsView items={data.items} unit={unit} comparable={data.comparable} onNavigate={onNavigate} />
          )}
          <p className="topic-foot muted">
            共 {data.distinct} 種{meta?.label ?? ''}，列出前 {data.items.length} 名
            {data.items[0]?.latest_date ? `・最新進度 ${data.items[0].latest_date}` : ''}
            <span className="topic-updated">（資料更新：{formatDateTime(data.meta.fetched_at, '尚未同步')}）</span>
          </p>
        </>
      ) : null}
    </section>
  );
}
