import type { BudgetProgress, BudgetYear } from '../api/types';

/**
 * 預算審議的「進度」呈現：各年度有幾件、審竣幾件、還剩幾件。
 *
 * 數字都由後端算好（`budgetProgress`，見 server/queries.mjs 的五級分類）：
 * reviewed 已審竣／in_review 審議中／pending 待審查／letter 函件處理／returned 退回，
 * awaiting＝尚未審竣（審議中＋待審查＋退回，不含函件）。
 *
 * 為什麼要這樣分：立法院的預算議案裡「交付查照」這種**函件處理**是最大宗（實測 6,104 筆，
 * 真的審查完畢只有 2,017 筆），把它算進「已結案」或「待審查」都會誤導。
 */

/** 年度名稱：上游沒給年度的是 `unknown`（實測 1,565 筆，多半是決議函） */
export const yearLabel = (name: string): string => (name === 'unknown' ? '年度不明' : `${name} 年度`);

/** 一句話的進度統計，例如「總 40 件・已審竣 15・尚未審竣 25（審議中 22、待審查 3）」 */
export function budgetProgressText(progress: BudgetProgress | null | undefined): string {
  if (!progress || progress.total === 0) return '沒有符合的案子';
  const parts = [`總 ${progress.total} 件`, `已審竣 ${progress.reviewed}`, `尚未審竣 ${progress.awaiting}`];
  const detail = [];
  if (progress.in_review) detail.push(`審議中 ${progress.in_review}`);
  if (progress.pending) detail.push(`待審查 ${progress.pending}`);
  if (progress.returned) detail.push(`退回 ${progress.returned}`);
  if (detail.length) parts.push(`（${detail.join('、')}）`);
  if (progress.letter) parts.push(`・函件處理 ${progress.letter} 件不列入審查`);
  return parts.join('・').replace('・（', '（');
}

/** 堆疊長條的比例（已審竣／審議中／待審查與退回；函件不畫，因為它不經審查） */
export function budgetProgressBar(progress: BudgetProgress | null | undefined): { key: string; label: string; width: number }[] {
  const total = progress?.total ?? 0;
  if (!progress || total === 0) return [];
  const segments = [
    { key: 'reviewed', label: '已審竣', value: progress.reviewed },
    { key: 'in_review', label: '審議中', value: progress.in_review },
    { key: 'pending', label: '待審查／退回', value: progress.pending + progress.returned },
  ];
  const drawn = segments.reduce((sum, s) => sum + s.value, 0);
  if (drawn === 0) return [];
  return segments
    .filter((s) => s.value > 0)
    .map((s) => ({ key: s.key, label: `${s.label} ${s.value}`, width: (s.value / drawn) * 100 }));
}

export interface YearProgressListProps {
  /** 全部年度（含匯總那一列用得到） */
  years: BudgetYear[];
  /** 目前選的年度（空字串＝全部年度） */
  active: string;
  /** 目前條件的整體進度（選「全部年度」時顯示） */
  progress?: BudgetProgress | null;
  onPick: (year: string) => void;
}

/**
 * 各年度的審議進度一覽：每一列是一個年度，數字與長條都來自後端統計。
 * 點一列就只看那一年（等同套用年度條件）。
 */
export function YearProgressList({ years, active, progress = null, onPick }: YearProgressListProps) {
  if (years.length === 0) return null;
  const rows: { key: string; label: string; progress: BudgetProgress }[] = [
    ...(progress && active ? [{ key: '', label: '全部年度', progress }] : []),
    ...years.map((y) => ({ key: y.name, label: yearLabel(y.name), progress: y.progress })),
  ];
  return (
    <div className="year-progress" role="group" aria-label="各年度審議進度">
      {rows.map((row) => {
        const segments = budgetProgressBar(row.progress);
        return (
          <button
            key={row.key || 'all'}
            type="button"
            className="year-progress-row"
            aria-pressed={active === row.key}
            onClick={() => onPick(row.key)}
            title={`${row.label}：${budgetProgressText(row.progress)}`}
          >
            <span className="year-progress-name">{row.label}</span>
            <span className="year-bar" aria-hidden="true">
              {segments.map((s) => (
                <span key={s.key} className={`year-bar-part ${s.key}`} style={{ width: `${s.width}%` }} title={`${s.label}`} />
              ))}
            </span>
            <span className="year-progress-numbers">
              <b>{row.progress.reviewed}</b>
              <span className="muted">/ {row.progress.total} 已審竣</span>
              <span className="muted">・剩 {row.progress.awaiting}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
