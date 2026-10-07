import { Scale, Star } from 'lucide-react';
import type { CommitteeItem } from '../api/types';
import { ClearFiltersButton } from './ClearFiltersButton';
import type { FilterState } from '../lib/urlState';

export interface FilterBarProps {
  filters: FilterState;
  /** 選區（縣市層級）選項：由名單的 region 列舉 */
  regions: string[];
  /** 委員會選項：直接來自 /api/v1/committees（乾淨名稱） */
  committees: CommitteeItem[];
  /** 單選條件（屆次以外的離散切換，會寫入上一頁歷史） */
  onChange: (patch: Partial<FilterState>) => void;
  onReset: () => void;
  /** 本會期召委人數、追蹤人數：顯示在切換按鈕上 */
  convenerCount: number | null;
  trackedCount: number;
}

/** 篩選列：黨籍在席次圖圖例上切換，這裡放選區、委員會、召委、追蹤。 */
export function FilterBar({ filters, regions, committees, onChange, onReset, convenerCount, trackedCount }: FilterBarProps) {
  const hasFilters =
    filters.q.trim() !== '' ||
    filters.party !== null ||
    filters.region !== null ||
    filters.committee !== null ||
    filters.convener ||
    filters.tracked;

  return (
    <div className="filters" role="group" aria-label="篩選條件">
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
          onChange={(event) => onChange({ committee: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">全部委員會</option>
          {committees.map((committee) => (
            <option key={committee.id} value={committee.id}>
              {committee.id}（{committee.count} 席）
            </option>
          ))}
        </select>
      </label>

      <button type="button" aria-pressed={filters.convener} onClick={() => onChange({ convener: !filters.convener })}>
        <Scale aria-hidden="true" />
        只看召委{convenerCount !== null ? `（${convenerCount}）` : ''}
      </button>

      <button type="button" aria-pressed={filters.tracked} onClick={() => onChange({ tracked: !filters.tracked })}>
        <Star aria-hidden="true" />
        追蹤中（{trackedCount}）
      </button>

      <ClearFiltersButton active={hasFilters} onClick={onReset} />
    </div>
  );
}
