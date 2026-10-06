import { useState } from 'react';
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

/** 這一年有沒有需要審查的案子？（全是函件處理的年度＝沒有） */
export const hasReviewableItems = (progress: BudgetProgress): boolean => progress.reviewed + progress.awaiting > 0;

/**
 * 一句話的進度統計，例如「總 40 件・已審竣 15・尚未審竣 25（審議中 22、待審查 3）」。
 * 整批都是函件處理時（例如某年度只有 1 件「請查照案」）不要印「已審竣 0・尚未審竣 0」——
 * 那種數字看起來像「一件都沒審」，其實是根本不經審查。
 */
export function budgetProgressText(progress: BudgetProgress | null | undefined): string {
  if (!progress || progress.total === 0) return '沒有符合的案子';
  if (!hasReviewableItems(progress)) return `總 ${progress.total} 件・其中 ${progress.letter} 件是函件處理（不經審查）`;
  const parts = [`總 ${progress.total} 件`, `已審竣 ${progress.reviewed}`, `尚未審竣 ${progress.awaiting}`];
  const detail = [];
  if (progress.in_review) detail.push(`審議中 ${progress.in_review}`);
  if (progress.pending) detail.push(`待審查 ${progress.pending}`);
  if (progress.returned) detail.push(`退回 ${progress.returned}`);
  if (detail.length) parts.push(`（${detail.join('、')}）`);
  if (progress.letter) parts.push(`函件處理 ${progress.letter} 件不列入審查`);
  return parts.join('・').replace('・（', '（');
}

/**
 * 合併後的「這幾筆議案紀錄各是什麼狀態」，例如「9 筆已審查完畢、13 筆交付審查」。
 * 一案一列時，單一狀態已經不能代表整個案子（115 年度總預算案就有 24 筆紀錄、狀態不一）。
 */
export function budgetRecordsText(recordStates: Partial<Record<string, number>>, records: number): string {
  if (!records || records <= 1) return '';
  const order = ['reviewed', 'in_review', 'pending', 'letter', 'returned'];
  const label: Record<string, string> = { reviewed: '已審查完畢', in_review: '交付審查', pending: '排入院會', letter: '函件處理', returned: '退回' };
  const parts = order.filter((k) => recordStates[k]).map((k) => `${recordStates[k]} 筆${label[k] ?? k}`);
  for (const [k, v] of Object.entries(recordStates)) if (!order.includes(k) && v) parts.push(`${v} 筆${label[k] ?? k}`);
  return parts.join('、');
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
  const [showLetterOnly, setShowLetterOnly] = useState(false);
  if (years.length === 0) return null;
  const toRow = (key: string, label: string, p: BudgetProgress) => ({ key, label, progress: p });
  const main: { key: string; label: string; progress: BudgetProgress }[] = [
    ...(progress && active ? [toRow('', '全部年度', progress)] : []),
    ...years.filter((y) => hasReviewableItems(y.progress)).map((y) => toRow(y.name, yearLabel(y.name), y.progress)),
  ];
  const letterOnly = years.filter((y) => !hasReviewableItems(y.progress)).map((y) => toRow(y.name, yearLabel(y.name), y.progress));

  const row = (r: { key: string; label: string; progress: BudgetProgress }) => {
    const segments = budgetProgressBar(r.progress);
    return (
      <button
        key={r.key || 'all'}
        type="button"
        className="year-progress-row"
        aria-pressed={active === r.key}
        onClick={() => onPick(r.key)}
        title={`${r.label}：${budgetProgressText(r.progress)}`}
      >
        <span className="year-progress-name">{r.label}</span>
        <span className="year-bar" aria-hidden="true">
          {segments.map((s) => (
            <span key={s.key} className={`year-bar-part ${s.key}`} style={{ width: `${s.width}%` }} title={`${s.label}`} />
          ))}
        </span>
        <span className="year-progress-numbers">
          {hasReviewableItems(r.progress) ? (
            <>
              <b>{r.progress.reviewed}</b>
              <span className="muted">/ {r.progress.total} 已審竣</span>
              <span className="muted">・剩 {r.progress.awaiting}</span>
            </>
          ) : (
            <span className="muted">函件處理 {r.progress.letter} 件</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="year-progress" role="group" aria-label="各年度審議進度">
      {main.map(row)}
      {letterOnly.length > 0 ? (
        <>
          <button
            type="button"
            className="link-button year-letter-toggle"
            aria-expanded={showLetterOnly}
            onClick={() => setShowLetterOnly(!showLetterOnly)}
          >
            {showLetterOnly ? '收起只有函件的年度' : `另有 ${letterOnly.length} 個年度只有函件處理（不經審查）`}
          </button>
          {showLetterOnly ? letterOnly.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
