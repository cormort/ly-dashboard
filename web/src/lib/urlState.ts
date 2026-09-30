/**
 * 篩選狀態（單一真相來源：URL query string）。
 *
 * `?term=&session=&q=&party=&region=&committee=&convener=1&tracked=1`
 * term / session / q / party / region / committee 為 null 或空字串 = 未指定（沿用 API 預設）。
 * session 允許值：會期 id（如 "11-5"）或 `all`（該屆全部會期）。
 */

export const ALL_SESSIONS = 'all';

export interface FilterState {
  term: number | null;
  session: string | null;
  q: string;
  party: string | null;
  region: string | null;
  committee: string | null;
  convener: boolean;
  /** 只看本瀏覽器追蹤中的委員（前端過濾） */
  tracked: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  term: null,
  session: null,
  q: '',
  party: null,
  region: null,
  committee: null,
  convener: false,
  tracked: false,
};

function first(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseFilters(search: string): FilterState {
  const params = new URLSearchParams(search);
  const termRaw = first(params, 'term');
  const term = termRaw !== null && /^\d+$/.test(termRaw) ? Number(termRaw) : null;
  return {
    term,
    session: first(params, 'session'),
    q: first(params, 'q') ?? '',
    party: first(params, 'party'),
    region: first(params, 'region'),
    committee: first(params, 'committee'),
    convener: first(params, 'convener') === '1',
    tracked: first(params, 'tracked') === '1',
  };
}

/** 只寫入「有值」的參數，讓 URL 保持可讀；順序固定方便分享與比對。 */
export function serializeFilters(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.term !== null) params.set('term', String(state.term));
  if (state.session) params.set('session', state.session);
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.party) params.set('party', state.party);
  if (state.region) params.set('region', state.region);
  if (state.committee) params.set('committee', state.committee);
  if (state.convener) params.set('convener', '1');
  if (state.tracked) params.set('tracked', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function filtersEqual(a: FilterState, b: FilterState): boolean {
  return (
    a.term === b.term &&
    a.session === b.session &&
    a.q === b.q &&
    a.party === b.party &&
    a.region === b.region &&
    a.committee === b.committee &&
    a.convener === b.convener &&
    a.tracked === b.tracked
  );
}

/** 切換屆次時清掉只對舊屆有意義的條件 */
export function resetForTermChange(next: FilterState, term: number, session: string | null): FilterState {
  return { ...EMPTY_FILTERS, term, session, q: next.q, convener: next.convener, tracked: next.tracked };
}
