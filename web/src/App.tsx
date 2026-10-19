import { useEffect, useState } from 'react';
import { buildUrl } from './api/client';
import type { HealthResponse, Legislator, LegislatorsResponse, MetaResponse, SyncSourcesResponse } from './api/types';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header, navLabelOf } from './components/Header';
import { PageCard } from './components/PageCard';
import { LegislatorDetail } from './components/LegislatorDetail';
import { legislatorDetailUrl } from './lib/legislators';
import { SyncStatusBanner } from './components/SyncStatusBanner';
import { OfflineNotice } from './components/OfflineNotice';
import { useApi } from './hooks/useApi';
import { useReconnectRefresh } from './hooks/useReconnectRefresh';
import { useQueryState } from './hooks/useQueryState';
import { useSync } from './hooks/useSync';
import { syncRunningText } from './lib/format';
import { EmptyState } from './components/DataStates';
import { pathFor, useRoute } from './hooks/useRoute';
import { CountiesEnabledContext } from './lib/features';
import type { Route } from './hooks/useRoute';
import { useTracked } from './hooks/useTracked';
import { sessionLabelIndex } from './lib/sessions';
import { BillsPage } from './pages/BillsPage';
import { VotesPage } from './pages/VotesPage';
import { ResolutionsPage } from './pages/ResolutionsPage';
import { BudgetPage } from './pages/BudgetPage';
import { CommitteesPage } from './pages/CommitteesPage';
import { CountiesPage } from './pages/CountiesPage';
import { CouncilPage } from './pages/CouncilPage';
import { CouncilActivityPage } from './pages/CouncilActivityPage';
import { DashboardPage } from './pages/DashboardPage';
import { FundsPage } from './pages/FundsPage';

const FUND_TYPE = { funds: 'fund', agencies: 'agency', foundations: 'foundation', administrative: 'administrative', dgbas: 'dgbas' } as const;
import { ComparePage } from './pages/ComparePage';
import { NewsPage } from './pages/NewsPage';
import { HomePage } from './pages/HomePage';
import { LegislatorsPage } from './pages/LegislatorsPage';
import { MyAgencyPage } from './pages/MyAgencyPage';
import { RankingsPage } from './pages/RankingsPage';
import { SocialWallPage } from './pages/SocialWallPage';

/**
 * 只有 id 時（首頁動態、法案提案人、排行榜）先抓完整資料再開檔案。
 *
 * H1：這裡必須帶 `session=all`。名錄預設只回「本會期在職」委員，而已離職委員仍會出現在
 * 法案提案人與排行榜裡；不帶 session 會查到空結果，使用者的體驗就是「點了沒反應」。
 * 查不到時也不能靜默關閉，要讓使用者知道發生什麼事。
 */
function DetailById({ id, onLoaded, onMissing }: { id: string; onLoaded: (l: Legislator) => void; onMissing: (id: string) => void }) {
  const res = useApi<LegislatorsResponse>(legislatorDetailUrl(id));
  useEffect(() => {
    const found = res.data?.items[0];
    if (found) onLoaded(found);
    else if (res.phase === 'empty' || res.phase === 'error') onMissing(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在請求結果變動時觸發
  }, [res.phase, res.data, id]);
  return null;
}

export default function App() {
  const { route, navigate } = useRoute();
  const query = useQueryState();
  const [refreshToken, setRefreshToken] = useState(0);
  const [selected, setSelected] = useState<Legislator | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  // 手機：第二層頁籤的卡片（存的是「卡片裡開哪一頁」）；關掉就回到原本那一頁
  const [cardRoute, setCardRoute] = useState<Route | null>(null);
  // 同步範圍（下拉選單）：預設「全部」；每次開頁都回到全部，不記得上次選什麼
  const [syncScope, setSyncScope] = useState('all');
  const tracked = useTracked();

  const sync = useSync(() => setRefreshToken((value) => value + 1));

  const health = useApi<HealthResponse>(buildUrl('/health'), { refreshToken });
  const meta = useApi<MetaResponse>(buildUrl('/meta'), { refreshToken });
  // 同步範圍與各來源上次同步時間（下拉選單用）；同步結束後 refreshToken 會讓它重抓
  const syncSources = useApi<SyncSourcesResponse>(buildUrl('/sync-sources'), { refreshToken });

  // 連不上時自動重抓（退避排程＋恢復網路／切回前景立刻試）。手機沒開 Tailscale 的情況，
  // 使用者把 Tailscale 打開之後畫面會自己恢復，不必手動重新整理。
  useReconnectRefresh({
    active: health.phase === 'error' || meta.phase === 'error' || syncSources.phase === 'error',
    onRefresh: () => setRefreshToken((value) => value + 1),
  });
  const scopeLabelOf = (id: string | null) => syncSources.data?.scopes.find((scope) => scope.id === id)?.label ?? null;

  const source = health.data?.meta.source ?? meta.data?.meta.source ?? null;
  const fetchedAt = health.data?.meta.fetched_at ?? meta.data?.meta.fetched_at ?? null;
  // 遠端（Linux VM）那條線的頁面用 useCountiesEnabled() 讀這個值；跟下面的 hiddenRoutes 同一個來源
  const countiesEnabled = health.data?.counties_enabled !== false;
  const stale = health.data?.meta.stale ?? meta.data?.meta.stale ?? false;
  const failed = health.phase === 'error' || health.data?.last_runs[0]?.status === 'failed' || health.data?.ok === false;
  const labels = sessionLabelIndex(meta.data?.terms ?? []);
  const sessionLabel = (sessionId: string) => labels.get(sessionId) ?? sessionId;

  // 頁首搜尋一律查委員：不在委員頁時帶著關鍵字切過去
  const onQueryChange = (value: string) => {
    if (route === 'legislators') query.update({ q: value }, 'replace');
    else navigate(pathFor('legislators', { q: value.trim() }));
  };

  // 卡片開著時，如果底下的頁面換了（例如在卡片裡點了連結），卡片就關掉：
  // 不然會變成「卡片顯示 A、底下其實是 B」，關掉卡片時使用者會嚇一跳。
  useEffect(() => {
    if (cardRoute) setCardRoute(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 route 變動時關卡片
  }, [route]);

  /**
   * 依路由畫出對應頁面。抽成函式是因為現在有兩個地方要畫同一頁：
   * 主要內容區，以及手機的「第二層頁籤卡片」（見 PageCard）。
   */
  // 這個入口不提供的頁：公開站收掉縣市地圖與議員（伺服器用 X-Ly-Public 判斷並寫在 /health）
  const hiddenRoutes: Route[] = [];
  if (health.data?.counties_enabled === false) hiddenRoutes.push('counties');
  if (health.data?.council_enabled === false) hiddenRoutes.push('council', 'councilactivity');
  const hiddenTitle = (target: Route) =>
    target === 'counties' ? '縣市地圖' : target === 'council' ? '議員' : '議員近期動態';

  const renderPage = (target: Route) => {
    if (hiddenRoutes.includes(target)) {
      return (
        <EmptyState
          message={`這個網站沒有提供「${hiddenTitle(target)}」`}
          hint="需要完整版請開內網／Tailscale 的位址，或洽維護者。"
        />
      );
    }
    return (
    <>
      {target === 'home' ? <HomePage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} tracked={tracked} /> : null}
      {target === 'legislators' ? (
        <LegislatorsPage query={query} meta={meta} tracked={tracked} refreshToken={refreshToken} onOpen={setSelected} />
      ) : null}
      {target === 'socialwall' ? <SocialWallPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'bills' ? <BillsPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'votes' ? <VotesPage refreshToken={refreshToken} /> : null}
      {target === 'resolutions' ? <ResolutionsPage refreshToken={refreshToken} /> : null}
      {target === 'dashboard' ? <DashboardPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target === 'budget' ? <BudgetPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target in FUND_TYPE ? (
        <FundsPage key={target} type={FUND_TYPE[target as keyof typeof FUND_TYPE]} refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} />
      ) : null}
      {target === 'counties' ? <CountiesPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target === 'my' ? <MyAgencyPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target === 'council' ? <CouncilPage refreshToken={refreshToken} onNavigate={navigate} /> : null}
      {target === 'councilactivity' ? <CouncilActivityPage refreshToken={refreshToken} onNavigate={navigate} /> : null}
      {target === 'committees' ? <CommitteesPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'news' ? <NewsPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'agencynews' ? <NewsPage scope="agencies" refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'allnews' ? <NewsPage scope="all" refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target === 'officials' ? <NewsPage scope="officials" refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
      {target === 'compare' ? <ComparePage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      {target === 'rankings' ? <RankingsPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
    </>
    );
  };

  /**
   * 點第二層頁籤：手機開卡片，桌機直接換頁（Header 判斷寬度）。
   * 點到「就是現在這一頁」的那一格＝把卡片關掉（不要用卡片重複顯示同一頁）。
   */
  const onOpenCard = (target: Route) => {
    setCardRoute(target === route ? null : target);
  };

  return (
    <ErrorBoundary>
      <CountiesEnabledContext.Provider value={countiesEnabled}>
        <AppShell
        header={
          <Header
            route={route}
            onNavigate={navigate}
            onOpenCard={onOpenCard}
            source={source}
            fetchedAt={fetchedAt}
            stale={stale}
            failed={failed}
            syncOpen={syncOpen}
            onSyncToggle={() => setSyncOpen((v) => !v)}
            query={route === 'legislators' ? query.filters.q : ''}
            onQueryChange={onQueryChange}
            onRefresh={(force?: boolean) => void sync.start(syncScope, { force })}
            refreshing={sync.state.phase === 'running' || health.phase === 'loading' || meta.phase === 'loading'}
            syncMessage={
              sync.state.phase === 'running'
                ? syncRunningText({
                    scopeLabel: scopeLabelOf(sync.state.scope),
                    detail: sync.state.progress ?? null,
                    finished: sync.state.finished,
                    elapsedMs: sync.state.elapsedMs ?? 0,
                  })
                : sync.state.message
            }
            syncTone={
              sync.state.phase === 'running'
                ? 'running'
                : sync.state.phase === 'error'
                  ? 'error'
                  : sync.state.phase === 'blocked'
                    ? 'blocked'
                    : 'ok'
            }
            syncEnabled={health.data?.sync_enabled !== false}
            hiddenRoutes={hiddenRoutes}
            syncScopes={syncSources.data?.scopes ?? []}
            syncScope={syncScope}
            onSyncScopeChange={setSyncScope}
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
              socialFreshness={health.data?.social ?? null}
              sessionLabel={sessionLabel}
              onOpenId={setPendingId}
              onNavigate={(href) => {
                setSelected(null);
                navigate(href);
              }}
              onCompare={(l) => {
                setSelected(null);
                navigate(pathFor('compare', { ids: l.id }));
              }}
            />
          ) : null
        }
      >
        <OfflineNotice />

        {/* 同步有問題時一定顯示；正常時由頁首狀態鈕展開 */}
        {syncOpen || failed || stale ? (
          <div id="sync-panel">
            <SyncStatusBanner health={health} refreshToken={refreshToken} sources={syncSources.data?.scopes ?? null} />
          </div>
        ) : null}

        {pendingId ? (
          <DetailById
            key={pendingId}
            id={pendingId}
            onLoaded={(l) => {
              setPendingId(null);
              setMissingId(null);
              setSelected(l);
            }}
            onMissing={(id) => {
              setPendingId(null);
              setMissingId(id);
            }}
          />
        ) : null}

        {missingId && !selected ? (
          <div className="state-block empty" role="status">
            <b>找不到這位委員的資料</b>
            <p className="muted">資料可能尚未同步，或該筆資料已不在目前屆次的開放下載範圍。</p>
            <button type="button" onClick={() => setMissingId(null)}>
              關閉
            </button>
          </div>
        ) : null}

        {renderPage(route)}
      </AppShell>
      </CountiesEnabledContext.Provider>

      {/* 手機的第二層頁籤卡片：內容就是那一頁（與主要內容區共用 renderPage） */}
      {cardRoute ? (
        <PageCard title={navLabelOf(cardRoute) ?? '這一頁'} onClose={() => setCardRoute(null)}>
          {renderPage(cardRoute)}
        </PageCard>
      ) : null}
    </ErrorBoundary>
  );
}
