import { AlertTriangle, Inbox, Loader2, RotateCcw } from 'lucide-react';
import type { ApiError } from '../api/client';
import { ConnectionHint } from './ConnectionHint';

/**
 * 每個資料區塊的四態（loading / ready / empty / error）共用元件。
 * ready 由各元件自行渲染；另外三態一律走這裡，避免出現「無聲的空畫面」。
 */

export function LoadingState({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="state-block loading" role="status" aria-live="polite">
      <Loader2 className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="state-block empty" role="status">
      <Inbox aria-hidden="true" />
      <div>
        <b>{message}</b>
        {hint ? <small>{hint}</small> : null}
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = '資料載入失敗',
}: {
  error: ApiError | null;
  onRetry: () => void;
  title?: string;
}) {
  const detail = error ? `${error.message}${error.code ? `（${error.code}）` : ''}` : '未知錯誤';
  return (
    <div className="state-block error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <b>{title}</b>
        <small>{detail}</small>
        {/* 「連不上」時多講一句最可能的原因與該做什麼（例如：請開啟手機的 Tailscale） */}
        <ConnectionHint code={error?.code ?? null} />
      </div>
      <button type="button" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        重試
      </button>
    </div>
  );
}
