import { useEffect, useMemo, useState } from 'react';
import { buildUrl } from './api/client';
import type { HealthResponse, Legislator, LegislatorsResponse, MetaResponse, CommitteesResponse } from './api/types';
import { AppShell } from './components/AppShell';
import { ChangesPanel } from './components/ChangesPanel';
import { CommitteeChart } from './components/CommitteeChart';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FilterBar } from './components/FilterBar';
import { Header } from './components/Header';
import { LegislatorDetail } from './components/LegislatorDetail';
import { LegislatorGrid } from './components/LegislatorGrid';
import { SessionSelector } from './components/SessionSelector';
import { StatCards } from './components/StatCards';
import { SyncStatusBanner } from './components/SyncStatusBanner';
import { useApi } from './hooks/useApi';
import { useQueryState } from './hooks/useQueryState';
import { useTracked } from './hooks/useTracked';
import { deriveParties } from './lib/legislators';
import { latestSessionId, sessionLabelIndex, sessionScopeLabel } from './lib/sessions';
import { ALL_SESSIONS, resetForTermChange, type FilterState } from './lib/urlState';

/** 名錄單次抓取上限（API 預設即 500） */
const PAGE_LIMIT = 500;

export default function App() {
  const query = useQueryState();
  const { filters } = query;
  const update = query.update;
  const [refreshToken, setRefreshToken] = useState(0);
  const [selected, setSelected] = useState<Legislator | null>(null);
  const tracked = useTracked();

  /* --------------------------- 來源中繼資料 --------------------------- */

  const health = useApi<HealthResponse>(buildUrl('/health'), { refreshToken });
  const meta = useApi<MetaResponse>(buildUrl('/meta'), { refreshToken });
  const metaData = meta.data;

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

  /* ------------------------------ 資料請求 ------------------------------ */

  const queryParams = { term: effectiveTerm ?? undefined, session: effectiveSession ?? undefined };

  // 該屆／會期完整名單：提供委員總數與黨籍選項（只在後端已算好的結果上做列舉）
  const roster = useApi<LegislatorsResponse>(
    buildUrl('/legislators', { ...queryParams, limit: PAGE_LIMIT }),
    { refreshToken },
  );
  // 本會期召委總數（後端已有 convener 篩選，前端不自行統計）
  const convenerStat = useApi<LegislatorsResponse>(
    buildUrl('/legislators', { ...queryParams, convener: 1, limit: PAGE_LIMIT }),
    { refreshToken },
  );

  const hasFilters =
    filters.q.trim() !== '' || filters.party !== null || filters.committee !== null || filters.convener;

  // 有篩選條件時才另外抓一份；否則直接沿用 roster，避免重複請求
  const filtered = useApi<LegislatorsResponse>(
    hasFilters
      ? buildUrl('/legislators', {
          ...queryParams,
          q: filters.q,
          party: filters.party ?? undefined,
          committee: filters.committee ?? undefined,
          convener: filters.convener ? 1 : undefined,
          limit: PAGE_LIMIT,
        })
      : null,
    { refreshToken },
  );
  const legislatorList = hasFilters ? filtered : roster;

  const committees = useApi<CommitteesResponse>(
    buildUrl('/committees', queryParams),
    { refreshToken },
  );

  /* ------------------------------ 衍生資料 ------------------------------ */

  const parties = useMemo(() => deriveParties(roster.data?.items ?? []), [roster.data]);

  const terms = metaData?.terms ?? [];

  const scopeLabel = useMemo(
    () => sessionScopeLabel(terms, effectiveTerm, effectiveSession),
    [terms, effectiveTerm, effectiveSession],
  );

  const sessionLabel = useMemo(() => {
    const index = sessionLabelIndex(terms);
    return (sessionId: string) => index.get(sessionId) ?? sessionId;
  }, [terms]);

  const source = health.data?.meta.source ?? metaData?.meta.source ?? null;
  const fetchedAt = health.data?.meta.fetched_at ?? metaData?.meta.fetched_at ?? null;
  const stale = health.data?.meta.stale ?? metaData?.meta.stale ?? false;
  const generatedAt = health.data?.meta.generated_at ?? metaData?.meta.generated_at ?? null;

  /* ------------------------------- 事件 ------------------------------- */

  const handleTermChange = (nextTerm: number) => {
    const termInfo = metaData?.terms.find((item) => item.no === nextTerm);
    const nextSession = latestSessionId(termInfo) ?? ALL_SESSIONS;
    // 換屆次時清掉只對舊屆有意義的黨籍／委員會條件，避免跨屆條件混用
    query.set(resetForTermChange(filters, nextTerm, nextSession), 'push');
  };

  const handleReset = () => {
    update({ q: '', party: null, committee: null, convener: false }, 'push');
  };

  const refreshing = health.phase === 'loading' || meta.phase === 'loading';

  return (
    <ErrorBoundary>
      <AppShell
        header={
          <Header
            source={source}
            fetchedAt={fetchedAt}
            stale={stale}
            generatedAt={generatedAt}
            query={filters.q}
            onQueryChange={(value) => update({ q: value }, 'replace')}
            onRefresh={() => setRefreshToken((value) => value + 1)}
            refreshing={refreshing}
          />
        }
        sidebar={
          selected ? (
            <LegislatorDetail
              legislator={selected}
              onClose={() => setSelected(null)}
              tracked={tracked.isTracked(selected.id)}
              onToggleTrack={(legislator) => tracked.toggle(legislator.id)}
              source={source}
              sessionLabel={sessionLabel}
            />
          ) : null
        }
      >
        <SyncStatusBanner health={health} refreshToken={refreshToken} />

        <div className="controls">
          <SessionSelector
            meta={meta}
            term={effectiveTerm}
            session={effectiveSession}
            sessionUndetermined={metaData !== null && metaData.current.session === null && filters.session === null}
            onTermChange={handleTermChange}
            onSessionChange={(session) => update({ session }, 'push')}
          />
          <FilterBar
            filters={filters}
            parties={parties}
            committees={committees.data?.items ?? []}
            onChange={(patch) => update(patch, 'push')}
            onReset={handleReset}
            resultTotal={legislatorList.data ? legislatorList.data.total : null}
            rosterTotal={roster.data ? roster.data.total : null}
          />
        </div>

        <StatCards
          roster={roster}
          convenerStat={convenerStat}
          trackedCount={tracked.count}
          health={health}
          sessionScopeLabel={scopeLabel}
        />

        <div className="split">
          <CommitteeChart committees={committees} sessionScopeLabel={scopeLabel} />
          <ChangesPanel refreshToken={refreshToken} />
        </div>

        <LegislatorGrid
          legislators={legislatorList}
          isTracked={tracked.isTracked}
          onToggleTrack={(legislator) => tracked.toggle(legislator.id)}
          onOpen={setSelected}
          sessionScopeLabel={scopeLabel}
          hasFilters={hasFilters}
        />
      </AppShell>
    </ErrorBoundary>
  );
}
