import { X } from 'lucide-react';

/** 各頁篩選列共用的「清除條件」：沒有條件時停用（灰色），有條件時才能按。 */
export function ClearFiltersButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="quiet" onClick={onClick} disabled={!active}>
      <X aria-hidden="true" />
      清除條件
    </button>
  );
}
