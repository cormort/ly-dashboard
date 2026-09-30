import { Scale, SlidersHorizontal, X } from 'lucide-react';
import type { CommitteeItem } from '../api/types';
import type { FilterState } from '../lib/urlState';

export interface FilterBarProps {
  filters: FilterState;
  /** 黨籍選項：由該屆／會期名單列舉（後端回傳值直接使用，不在前端加工） */
  parties: string[];
  /** 選區（縣市層級）選項：由名單的 region 列舉 */
  regions: string[];
  /** 委員會選項：直接來自 /api/v1/committees（乾淨名稱） */
  committees: CommitteeItem[];
  /** 單選條件（屆次以外的離散切換，會寫入上一頁歷史） */
  onChange: (patch: Partial<FilterState>) => void;
  onReset: () => void;
  /** 目前條件符合的總筆數（後端 total） */
  resultTotal: number | null;
  /** 該屆／會期的委員總數 */
  rosterTotal: number | null;
}

export function FilterBar({
  filters,
  parties,
  regions,
  committees,
  onChange,
  onReset,
  resultTotal,
  rosterTotal,
}: FilterBarProps) {
  const hasFilters =
    filters.q.trim() !== '' ||
    filters.party !== null ||
    filters.region !== null ||
    filters.committee !== null ||
    filters.convener;

  return (
    <section className="panel filters-panel" aria-label="篩選條件">
      <div className="filters">
        <label>
          <span className="sr-only">黨籍</span>
          <select
            value={filters.party ?? ''}
            onChange={(event) => onChange({ party: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">全部黨籍</option>
            {parties.map((party) => (
              <option key={party} value={party}>
                {party}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="sr-only">選區</span>
          <select
            value={filters.region ?? ''}
            onChange={(event) => onChange({ region: event.target.value === '' ? null : event.target.value })}
          >
            <option value="">全部選區</option>
            {regions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="sr-only">委員會</span>
          <select
            value={filters.committee ?? ''}
            onChange={(event) =>
              onChange({ committee: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">全部委員會</option>
            {committees.map((committee) => (
              <option key={committee.id} value={committee.id}>
                {committee.id}（{committee.count} 席）
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={filters.convener ? 'primary' : undefined}
          aria-pressed={filters.convener}
          onClick={() => onChange({ convener: !filters.convener })}
        >
          <Scale aria-hidden="true" />
          只看召委
        </button>

        <button type="button" onClick={onReset} disabled={!hasFilters}>
          <X aria-hidden="true" />
          清除條件
        </button>
      </div>

      <p className="filter-summary" role="status">
        <SlidersHorizontal aria-hidden="true" />
        {resultTotal === null || rosterTotal === null
          ? '正在套用條件…'
          : `符合條件 ${resultTotal} 筆／共 ${rosterTotal} 筆`}
        {hasFilters ? '（條件已同步到網址，可直接分享或按上一頁）' : ''}
      </p>
    </section>
  );
}
