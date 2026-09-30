/**
 * 唯一的 HTTP 出入口。所有資料都必須經過這裡打同源 `/api/v1/*`，
 * 元件層不得直接呼叫 fetch（也就無法偷打 data.ly.gov.tw 或塞入假資料）。
 */
import type {
  ApiErrorBody,
  ChangeItem,
  ChangesResponse,
  CommitteesResponse,
  HealthResponse,
  Legislator,
  LegislatorQuery,
  LegislatorsResponse,
  MetaResponse,
  SyncRun,
  SyncRunsResponse,
} from './types';

export const API_BASE = '/api/v1';

export type ApiQueryValue = string | number | boolean | null | undefined;

/** 後端錯誤（HTTP 4xx/5xx）或網路／逾時錯誤的統一表示 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code ?? (this.status === 0 ? 'network_error' : 'http_error');
  }

  get isAbort(): boolean {
    return this.code === 'aborted';
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError('請求已取消', { code: 'aborted', cause: err });
  }
  if (err instanceof Error) return new ApiError(err.message, { code: 'network_error', cause: err });
  return new ApiError('未知的錯誤', { code: 'unknown', cause: err });
}

export function buildUrl(path: string, query?: Record<string, ApiQueryValue>): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
    }
  }
  const suffix = qs.toString();
  return `${API_BASE}${path}${suffix ? `?${suffix}` : ''}`;
}

interface RequestOptions {
  signal?: AbortSignal;
  /** 預設 15 秒，逾時視為網路錯誤 */
  timeoutMs?: number;
}

/** 低階呼叫：回傳已解析的 JSON，並把失敗一律轉成 ApiError */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { signal, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('請求已取消', { code: 'aborted', cause: err });
    const timedOut = controller.signal.aborted;
    throw new ApiError(
      timedOut ? `連線逾時（${Math.round(timeoutMs / 1000)} 秒）` : '無法連線到 API 伺服器',
      { code: timedOut ? 'timeout' : 'network_error', cause: err },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    const code = body?.error?.code ?? `http_${response.status}`;
    const message = body?.error?.message ?? `API 回應 ${response.status} ${response.statusText}`.trim();
    throw new ApiError(`${message}（HTTP ${response.status}）`, { status: response.status, code });
  }

  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new ApiError('API 回應不是有效的 JSON', { status: response.status, code: 'bad_json', cause: err });
  }
}

/* ------------------------------ 端點函式 ------------------------------ */

export function fetchHealth(options?: RequestOptions): Promise<HealthResponse> {
  return apiRequest<HealthResponse>(buildUrl('/health'), options);
}

export function fetchMeta(options?: RequestOptions): Promise<MetaResponse> {
  return apiRequest<MetaResponse>(buildUrl('/meta'), options);
}

export interface CommitteesQuery {
  term?: number;
  session?: string;
}

export function fetchCommittees(
  query: CommitteesQuery,
  options?: RequestOptions,
): Promise<CommitteesResponse> {
  return apiRequest<CommitteesResponse>(
    buildUrl('/committees', { term: query.term, session: query.session }),
    options,
  );
}

/** 空字串一律視為「未指定」，避免送出 `?party=` 這種無意義參數 */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 把 LegislatorQuery 轉成 query string（不送出空字串；convener 只在 true 時送） */
export function legislatorParams(query: LegislatorQuery): Record<string, ApiQueryValue> {
  return {
    term: query.term,
    session: blankToUndefined(query.session),
    q: blankToUndefined(query.q),
    party: blankToUndefined(query.party),
    committee: blankToUndefined(query.committee),
    convener: query.convener ? 1 : undefined,
    limit: query.limit,
    offset: query.offset,
  };
}

export function fetchLegislators(
  query: LegislatorQuery,
  options?: RequestOptions,
): Promise<LegislatorsResponse> {
  return apiRequest<LegislatorsResponse>(buildUrl('/legislators', legislatorParams(query)), options);
}

export interface ChangesQuery {
  since?: string;
  limit?: number;
}

export function fetchChanges(query: ChangesQuery = {}, options?: RequestOptions): Promise<ChangesResponse> {
  return apiRequest<ChangesResponse>(
    buildUrl('/changes', { since: query.since, limit: query.limit ?? 50 }),
    options,
  );
}

export function fetchSyncRuns(limit = 50, options?: RequestOptions): Promise<SyncRunsResponse> {
  return apiRequest<SyncRunsResponse>(buildUrl('/sync-runs', { limit }), options);
}

/** 只為了型別檢查時的自我說明用；實際渲染用不到。 */
export type { ChangeItem, Legislator, SyncRun };
