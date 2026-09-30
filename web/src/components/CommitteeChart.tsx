import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, Table2 } from 'lucide-react';
import type { ApiResource } from '../hooks/useApi';
import type { CommitteeKind, CommitteesResponse } from '../api/types';
import { committeeAxisLabel } from '../lib/format';
import { EmptyState, ErrorState, LoadingState } from './DataStates';

export interface CommitteeChartProps {
  committees: ApiResource<CommitteesResponse>;
  /** 目前會期顯示名稱，用於空狀態文案 */
  sessionScopeLabel: string;
}

const KIND_LABELS: Record<CommitteeKind, string> = {
  standing: '常設',
  special: '特種',
  ad_hoc: '任務型',
};

/**
 * 委員會席次圖。
 *
 * 資料直接取 /api/v1/committees 的 `count`（後端已算好），
 * **不在前端重新聚合委員名單** —— 也就不可能再出現舊版「委員會名稱帶屆期前綴、
 * 跨屆資料混在一起」的失真圖表。
 */
export function CommitteeChart({ committees, sessionScopeLabel }: CommitteeChartProps) {
  const [showTable, setShowTable] = useState(false);

  if (committees.phase === 'loading' && !committees.data) {
    return (
      <section className="panel chart" aria-label="委員會席次">
        <h2>委員會席次</h2>
        <LoadingState label="讀取委員會資料…" />
      </section>
    );
  }

  if (committees.phase === 'error') {
    return (
      <section className="panel chart" aria-label="委員會席次">
        <h2>委員會席次</h2>
        <ErrorState
          title="無法取得委員會資料（/api/v1/committees）"
          error={committees.error}
          onRetry={committees.reload}
        />
      </section>
    );
  }

  const items = committees.data?.items ?? [];

  if (items.length === 0) {
    return (
      <section className="panel chart" aria-label="委員會席次">
        <h2>委員會席次</h2>
        <EmptyState
          message="此會期尚無委員會資料"
          hint={`範圍：${sessionScopeLabel}。請切換會期或稍後再試。`}
        />
      </section>
    );
  }

  const chartData = items.map((item) => ({
    id: item.id,
    label: committeeAxisLabel(item.id),
    count: item.count,
    kind: item.kind,
    conveners: item.conveners.map((convener) => convener.name),
  }));

  const totalSeats = items.reduce((sum, item) => sum + item.count, 0);
  const description = `委員會席次長條圖，共 ${items.length} 個委員會、${totalSeats} 席。${items
    .map((item) => `${item.id} ${item.count} 席`)
    .join('；')}。`;

  return (
    <section className="panel chart" aria-label="委員會席次">
      <div className="sectionhead">
        <h2>委員會席次</h2>
        <button
          type="button"
          onClick={() => setShowTable((value) => !value)}
          aria-pressed={showTable}
        >
          <Table2 aria-hidden="true" />
          {showTable ? '隱藏表格' : '以表格檢視'}
        </button>
      </div>

      <p className="muted chart-scope">範圍：{sessionScopeLabel}（資料來自 /api/v1/committees）</p>

      <div className="chartbox" role="img" aria-label="委員會席次長條圖" aria-describedby="committee-chart-desc">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="label" stroke="#94a3b8" interval={0} tick={{ fontSize: 12 }} />
            <YAxis stroke="#94a3b8" allowDecimals={false} width={36} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10 }}
              labelStyle={{ color: '#f8fafc' }}
              formatter={(value) => [`${String(value)} 席`, '席次'] as [string, string]}
              labelFormatter={(_label, payload) => {
                const first = payload?.[0]?.payload as { id?: string; kind?: CommitteeKind } | undefined;
                if (!first?.id) return '';
                const kind = first.kind ? `（${KIND_LABELS[first.kind]}）` : '';
                return `${first.id}${kind}`;
              }}
            />
            <Bar dataKey="count" name="席次" fill="#3b82f6" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 圖表的文字替代：螢幕閱讀器與無法看圖者都能取得同樣資訊 */}
      <p id="committee-chart-desc" className="sr-only">
        {description}
      </p>

      {showTable ? (
        <table className="data-table">
          <caption>委員會席次明細（{sessionScopeLabel}）</caption>
          <thead>
            <tr>
              <th scope="col">委員會</th>
              <th scope="col">類別</th>
              <th scope="col">席次</th>
              <th scope="col">召委</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <th scope="row">{item.id}</th>
                <td>{KIND_LABELS[item.kind]}</td>
                <td>{item.count}</td>
                <td>{item.conveners.length > 0 ? item.conveners.map((c) => c.name).join('、') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {items.length > 0 ? (
        <p className="muted">
          <BarChart3 aria-hidden="true" /> 共 {items.length} 個委員會、{totalSeats} 席。
        </p>
      ) : null}
    </section>
  );
}
