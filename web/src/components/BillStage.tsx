import { BILL_STAGES, billStage } from '../lib/billStage';

/** 立法流程小步驟條：已走過的點實心、目前所在點加框、撤案類標紅。 */
export function BillStageBar({ status }: { status: string }) {
  const stage = billStage(status);
  if (!stage) return null;
  const label = stage.stopped ? `已中止：${status}` : `立法進度：${BILL_STAGES[stage.index]}（${stage.index + 1}/${BILL_STAGES.length}）`;
  return (
    <ol className={stage.stopped ? 'stage-bar stopped' : 'stage-bar'} aria-label={label} title={label}>
      {BILL_STAGES.map((name, i) => (
        <li key={name} className={i < stage.index ? 'done' : i === stage.index ? 'current' : undefined}>
          <span className="sr-only">{name}</span>
        </li>
      ))}
    </ol>
  );
}
