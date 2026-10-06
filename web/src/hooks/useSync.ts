import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHealth, fetchSyncRuns, startSync, toApiError } from '../api/client';

/**
 * 手動同步：POST /sync（202，背景執行）→ 輪詢 /health 的 syncing 與 /sync-runs。
 * 進度 = 本次觸發後新增的 sync_runs 涵蓋了幾個資料來源；總數不固定，所以不顯示百分比。
 * 結束時（無論成功失敗）呼叫 onFinished，讓頁面重新讀取資料。
 */
/**
 * `blocked`：後端的防呆擋下來（409）。代表這次按下去**不會取得更新的資訊**
 * （已經有同步在跑，或同一個範圍剛同步過），所以畫面直接把原因講給使用者聽，
 * 並提供「仍要重跑」（force）——防呆只擋明顯沒意義的那一類。
 */
export type SyncPhase = 'idle' | 'running' | 'done' | 'error' | 'blocked';

export interface SyncState {
  phase: SyncPhase;
  /** 本次同步已完成的資料來源數 */
  finished: number;
  /** 給人看的結果／錯誤說明 */
  message: string | null;
  /** 這次實際觸發的同步範圍（選單可能在過程中又被改，所以記下來） */
  scope: string | null;
  /** 被防呆擋下（可以按「仍要重跑」強制執行） */
  blocked?: boolean;
}

const POLL_MS = 2_000;
/** 完整同步約 4 分鐘；超過 15 分鐘視為卡住 */
const MAX_POLLS = (15 * 60 * 1000) / POLL_MS;
const MESSAGE_MS = 8_000;
/** 防呆訊息要留久一點，讓使用者看清楚為什麼不給跑（還有「仍要重跑」可按） */
const BLOCKED_MS = 30_000;

const IDLE: SyncState = { phase: 'idle', finished: 0, message: null, scope: null };

export function useSync(onFinished: () => void) {
  const [state, setState] = useState<SyncState>(IDLE);
  const runningRef = useRef(false);
  const aliveRef = useRef(true);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  });
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 結果訊息只留一會兒，避免橫在頁首
  useEffect(() => {
    if (state.phase !== 'done' && state.phase !== 'error' && state.phase !== 'blocked') return;
    const timer = setTimeout(() => setState(IDLE), state.phase === 'blocked' ? BLOCKED_MS : MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const start = useCallback(async (scope?: string, options: { force?: boolean } = {}) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const update = (next: SyncState) => {
      if (aliveRef.current) setState(next);
    };
    update({ phase: 'running', finished: 0, message: null, scope: scope ?? null });

    try {
      const baseline = (await fetchSyncRuns(1)).items[0]?.id ?? 0;
      await startSync(scope, { force: options.force });

      for (let i = 0; i < MAX_POLLS && aliveRef.current; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const [health, runs] = await Promise.all([fetchHealth(), fetchSyncRuns(50)]);
        const fresh = runs.items.filter((run) => run.id > baseline);
        const finished = new Set(fresh.map((run) => run.dataset)).size;
        if (health.syncing) {
          update({ phase: 'running', finished, message: null, scope: scope ?? null });
          continue;
        }
        const failed = new Set(fresh.filter((run) => run.status === 'failed').map((run) => run.dataset)).size;
        update(
          failed > 0
            ? { phase: 'error', finished, message: `${failed} 個資料來源同步失敗，保留舊資料`, scope: scope ?? null }
            : { phase: 'done', finished, message: '資料已更新', scope: scope ?? null },
        );
        onFinishedRef.current();
        return;
      }
      update({ phase: 'error', finished: 0, message: '同步時間過長，請稍後到同步紀錄查看', scope: scope ?? null });
    } catch (cause) {
      const error = toApiError(cause);
      // 409 是防呆（不會取得更新的資訊），不是壞掉：直接講原因，並讓使用者能強制重跑
      const blocked = error.status === 409 && (error.code === 'sync_too_soon' || error.code === 'sync_in_progress');
      update({
        phase: blocked ? 'blocked' : 'error',
        finished: 0,
        message: blocked ? error.message.replace(/（HTTP \d+）$/, '') : error.message,
        scope: scope ?? null,
        blocked,
      });
    } finally {
      runningRef.current = false;
    }
  }, []);

  return { state, start };
}
