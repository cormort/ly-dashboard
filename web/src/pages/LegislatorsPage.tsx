import { useEffect, useMemo, useState } from 'react';
import { buildUrl } from '../api/client';
import type { CommitteesResponse, Legislator, LegislatorsResponse, MetaResponse } from '../api/types';
import { ChangesPanel } from '../components/ChangesPanel';
import { CommitteeChart } from '../components/CommitteeChart';
import { FilterBar } from '../components/FilterBar';
import { Hemicycle } from '../components/Hemicycle';
import { LegislatorGrid, type DirectoryMode } from '../components/LegislatorGrid';
import { SessionSelector } from '../components/SessionSelector';
import { useApi, type ApiResource } from '../hooks/useApi';
import type { QueryStateApi } from '../hooks/useQueryState';
import type { TrackedApi } from '../hooks/useTracked';
import { downloadCsv } from '../lib/csv';
import { deriveRegions } from '../lib/legislators';
import { latestSessionId, sessionScopeLabel } from '../lib/sessions';
import { readPreference, writePreference } from '../lib/storage';
import { ALL_SESSIONS, resetForSessionChange, resetForTermChange, type FilterState } from '../lib/urlState';

/** 名錄單次抓取上限（API 預設即 500） */
const PAGE_LIMIT = 500;

export interface LegislatorsPageProps {
  query: QueryStateApi;
  meta: ApiResource<MetaResponse>;
  tracked: TrackedApi;
  refreshToken: number;
  onOpen: (legislator: Legislator) => void;
}

/** 委員查詢頁：議場席次圖（依篩選亮起）＋篩選列＋卡片／列表名錄＋委員會組成。 */
export function LegislatorsPage({ query, meta, tracked, refreshToken, onOpen }: LegislatorsPageProps) {
  const { filters, update } = query;
  const metaData = meta.data;
  const [mode, setMode] = useState<DirectoryMode>(() => (readPreference('directory-mode') === 'list' ? 'list' : 'cards'));

  // 生效中的屆次／會期：URL 有就用 URL，否則沿用 /api/v1/meta 的 current（等於後端預設）
  const effectiveTerm = filters.term ?? metaData?.current.term ?? null;
  const effectiveSession = filters.session ?? metaData?.current.session ?? null;

  // 把生效值寫回 URL（replace 模式，不污染上一頁），確保網址可分享、重整後一致
  useEffect(() => {
    if (!metaData) return;
    const patch: Partial<FilterState> = {};
    if (filters.term === null) patch.term = metaData.current.term;
    if (filters.session === null) patch.session = metaData.current.session ?? ALL_SESSIONS;
    if (Object.keys(patch).length > 0) update(patch, 'replace');
  }, [metaData, filters.term, filters.session, update]);

  const scope = { term: effectiveTerm ?? undefined, session: effectiveSession ?? undefined };

  // 該屆／會期完整名單：席次圖、選區選項、總數
  const roster = useApi<LegislatorsResponse>(buildUrl('/legislators', { ...scope, limit: PAGE_LIMIT }), { refreshToken });
  const committees = useApi<CommitteesResponse>(buildUrl('/committees', scope), { refreshToken });

  // H2 第二道防線：委員會選項是「該會期實際存在」的清單。若 URL 帶著一個不存在的委員會
  // （例如手動改網址、或分享到別的會期），不要讓它變成隱形篩選 → 0 筆，而是視為未指定。
  const committeeOptions = committees.data?.items ?? [];
  const committeeValid =
    filters.committee === null || committeeOptions.length === 0 || committeeOptions.some((c) => c.id === filters.committee);
  const effectiveCommittee = committeeValid ? filters.committee : null;
  const effectiveFilters: FilterState = committeeValid ? filters : { ...filters, committee: null };

  const hasServerFilters =
    filters.q.trim() !== '' || filters.party !== null || filters.region !== null || effectiveCommittee !== null || filters.convener;
  const hasFilters = hasServerFilters || filters.tracked;

  // 有後端條件時才另外抓一份；否則沿用 roster，避免重複請求
  const filtered = useApi<LegislatorsResponse>(
    hasServerFilters
      ? buildUrl('/legislators', {
          ...scope,
          q: filters.q,
          party: filters.party ?? undefined,
          region: filters.region ?? undefined,
          committee: effectiveCommittee ?? undefined,
          convener: filters.convener ? 1 : undefined,
          limit: PAGE_LIMIT,
        })
      : null,
    { refreshToken },
  );
  const list = hasServerFilters ? filtered : roster;

  const regions = useMemo(() => deriveRegions(roster.data?.items ?? []), [roster.data]);
  const convenerCount = useMemo(() => (roster.data ? roster.data.items.filter((l) => l.is_convener).length : null), [roster.data]);
  const visible = filters.tracked ? (l: Legislator) => tracked.isTracked(l.id) : undefined;

  // 席次圖亮起的委員：沒有任何條件時全亮
  const matching = useMemo(() => {
    if (!hasFilters || !list.data) return null;
    const items = visible ? list.data.items.filter(visible) : list.data.items;
    return new Set(items.map((l) => l.id));
  }, [hasFilters, list.data, visible]);

  const terms = metaData?.terms ?? [];
  const scopeLabel = useMemo(() => sessionScopeLabel(terms, effectiveTerm, effectiveSession), [terms, effectiveTerm, effectiveSession]);

  const handleTermChange = (nextTerm: number) => {
    const termInfo = metaData?.terms.find((item) => item.no === nextTerm);
    // 換屆次時清掉只對舊屆有意義的黨籍／委員會條件，避免跨屆條件混用
    query.set(resetForTermChange(filters, nextTerm, latestSessionId(termInfo) ?? ALL_SESSIONS), 'push');
  };

  const changeMode = (next: DirectoryMode) => {
    setMode(next);
    writePreference('directory-mode', next);
  };

  return (
    <>
      <div className="page-head">
        <h1>委員查詢</h1>
        <SessionSelector
          meta={meta}
          term={effectiveTerm}
          session={effectiveSession}
          sessionUndetermined={metaData !== null && metaData.current.session === null && filters.session === null}
          onTermChange={handleTermChange}
          onSessionChange={(session) => query.set(resetForSessionChange(filters, session), 'push')}
        />
      </div>

      <FilterBar
        filters={effectiveFilters}
        regions={regions}
        committees={committees.data?.items ?? []}
        onChange={(patch) => update(patch, 'push')}
        onReset={() => update({ q: '', party: null, region: null, committee: null, convener: false, tracked: false }, 'push')}
        convenerCount={convenerCount}
        trackedCount={tracked.count}
      />

      {/* 席次圖單獨一區：它是這一頁的視覺主角（原本與委員會組成並排，兩個圖互相搶注意力） */}
      {roster.data && roster.data.items.length > 0 ? (
        <Hemicycle
          roster={roster.data.items}
          matching={matching}
          party={filters.party}
          onPartyToggle={(party) => update({ party: filters.party === party ? null : party }, 'push')}
          onOpen={onOpen}
        />
      ) : null}

      <LegislatorGrid
        legislators={list}
        visible={visible}
        isTracked={tracked.isTracked}
        onToggleTrack={(l) => tracked.toggle(l.id)}
        onOpen={onOpen}
        sessionScopeLabel={scopeLabel}
        hasFilters={hasFilters}
        mode={mode}
        onModeChange={changeMode}
        onDownload={() => {
          const items = (list.data?.items ?? []).filter(visible ?? (() => true));
          downloadCsv(`legislators-${effectiveSession ?? 'all'}.csv`, [
            ['姓名', '黨籍', '選區', '委員會', '召委', '提案數', '新聞數', '委員識別碼'],
            ...items.map((l) => [
              l.name,
              l.party,
              l.area_name,
              l.committees.map((c) => c.id).join('、'),
              l.is_convener ? '是' : '',
              l.bill_count,
              l.news_count,
              l.id,
            ]),
          ]);
        }}
      />

      {/* 委員會組成與最近異動是補充資訊，預設收合，名錄才是這一頁的重點 */}
      <details className="panel secondary-details">
        <summary>
          <span className="regions-title">委員會組成與最近異動</span>
          <span className="muted">展開查看各委員會黨籍組成與資料變更紀錄</span>
        </summary>
        <div className="split">
          <CommitteeChart
            committees={committees}
            sessionScopeLabel={scopeLabel}
            selected={filters.committee}
            onSelect={(committee) => update({ committee }, 'push')}
          />
          <ChangesPanel refreshToken={refreshToken} />
        </div>
      </details>
    </>
  );
}
