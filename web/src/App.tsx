import { useEffect, useState } from 'react';
import { buildUrl } from './api/client';
import type { HealthResponse, Legislator, LegislatorsResponse, MetaResponse } from './api/types';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header } from './components/Header';
import { LegislatorDetail } from './components/LegislatorDetail';
import { legislatorDetailUrl } from './lib/legislators';
import { SyncStatusBanner } from './components/SyncStatusBanner';
import { useApi } from './hooks/useApi';
import { useQueryState } from './hooks/useQueryState';
import { pathFor, useRoute } from './hooks/useRoute';
import { useTracked } from './hooks/useTracked';
import { sessionLabelIndex } from './lib/sessions';
import { BillsPage } from './pages/BillsPage';
import { BudgetPage } from './pages/BudgetPage';
import { DashboardPage } from './pages/DashboardPage';
import { FundsPage } from './pages/FundsPage';
import { ComparePage } from './pages/ComparePage';
import { HomePage } from './pages/HomePage';
import { LegislatorsPage } from './pages/LegislatorsPage';
import { RankingsPage } from './pages/RankingsPage';

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
  const tracked = useTracked();

  const health = useApi<HealthResponse>(buildUrl('/health'), { refreshToken });
  const meta = useApi<MetaResponse>(buildUrl('/meta'), { refreshToken });

  const source = health.data?.meta.source ?? meta.data?.meta.source ?? null;
  const fetchedAt = health.data?.meta.fetched_at ?? meta.data?.meta.fetched_at ?? null;
  const stale = health.data?.meta.stale ?? meta.data?.meta.stale ?? false;
  const failed = health.phase === 'error' || health.data?.last_runs[0]?.status === 'failed' || health.data?.ok === false;
  const labels = sessionLabelIndex(meta.data?.terms ?? []);
  const sessionLabel = (sessionId: string) => labels.get(sessionId) ?? sessionId;

  // 頁首搜尋一律查委員：不在委員頁時帶著關鍵字切過去
  const onQueryChange = (value: string) => {
    if (route === 'legislators') query.update({ q: value }, 'replace');
    else navigate(pathFor('legislators', { q: value.trim() }));
  };

  return (
    <ErrorBoundary>
      <AppShell
        header={
          <Header
            route={route}
            onNavigate={navigate}
            source={source}
            fetchedAt={fetchedAt}
            stale={stale}
            failed={failed}
            syncOpen={syncOpen}
            onSyncToggle={() => setSyncOpen((v) => !v)}
            query={route === 'legislators' ? query.filters.q : ''}
            onQueryChange={onQueryChange}
            onRefresh={() => setRefreshToken((value) => value + 1)}
            refreshing={health.phase === 'loading' || meta.phase === 'loading'}
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
              onOpenId={setPendingId}
              onCompare={(l) => {
                setSelected(null);
                navigate(pathFor('compare', { ids: l.id }));
              }}
            />
          ) : null
        }
      >
        {/* 同步有問題時一定顯示；正常時由頁首狀態鈕展開 */}
        {syncOpen || failed || stale ? (
          <div id="sync-panel">
            <SyncStatusBanner health={health} refreshToken={refreshToken} />
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

        {route === 'home' ? <HomePage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} tracked={tracked} /> : null}
        {route === 'legislators' ? (
          <LegislatorsPage query={query} meta={meta} tracked={tracked} refreshToken={refreshToken} onOpen={setSelected} />
        ) : null}
        {route === 'bills' ? <BillsPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
        {route === 'dashboard' ? <DashboardPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
        {route === 'budget' ? <BudgetPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
        {route === 'funds' ? <FundsPage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
        {route === 'compare' ? <ComparePage refreshToken={refreshToken} onOpenId={setPendingId} /> : null}
        {route === 'rankings' ? <RankingsPage refreshToken={refreshToken} onOpenId={setPendingId} onNavigate={navigate} /> : null}
      </AppShell>
    </ErrorBoundary>
  );
}
