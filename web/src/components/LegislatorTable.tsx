import { useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import type { Legislator } from '../api/types';
import { partyStyle } from '../lib/parties';
import { shortCommittee, text } from '../lib/format';

type SortKey = 'name' | 'party' | 'area' | 'bills' | 'news' | 'post';

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: '姓名' },
  { key: 'party', label: '黨籍' },
  { key: 'area', label: '選區' },
  { key: 'bills', label: '提案', numeric: true },
  { key: 'news', label: '新聞', numeric: true },
  { key: 'post', label: '最新貼文' },
];

const latestPost = (l: Legislator) => l.social.map((s) => s.latest_post_date).filter(Boolean).sort().at(-1) ?? '';

function sortValue(l: Legislator, key: SortKey): string | number {
  switch (key) {
    case 'party':
      return partyStyle(l.party).order;
    case 'area':
      return l.area_name ?? '';
    case 'bills':
      return l.bill_count;
    case 'news':
      return l.news_count;
    case 'post':
      return latestPost(l);
    default:
      return l.name;
  }
}

export interface LegislatorTableProps {
  items: readonly Legislator[];
  isTracked: (id: string) => boolean;
  onToggleTrack: (legislator: Legislator) => void;
  onOpen: (legislator: Legislator) => void;
}

/** 列表模式：密集、可排序。數字欄預設由多到少，文字欄由小到大。 */
export function LegislatorTable({ items, isTracked, onToggleTrack, onOpen }: LegislatorTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });

  const rows = useMemo(() => {
    const sorted = [...items].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant');
      return cmp || a.name.localeCompare(b.name, 'zh-Hant');
    });
    return sort.desc ? sorted.reverse() : sorted;
  }, [items, sort]);

  const toggleSort = (key: SortKey, numeric?: boolean) =>
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: Boolean(numeric) || key === 'post' }));

  return (
    <div className="table-wrap">
      <table className="roster">
        <thead>
          <tr>
            <th scope="col" className="col-track">
              <span className="sr-only">追蹤</span>
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={col.numeric ? 'num' : undefined}
                aria-sort={sort.key === col.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
              >
                <button type="button" onClick={() => toggleSort(col.key, col.numeric)}>
                  {col.label}
                  <span aria-hidden="true" className="sort-mark">
                    {sort.key === col.key ? (sort.desc ? '↓' : '↑') : ''}
                  </span>
                </button>
              </th>
            ))}
            <th scope="col">主要媒體</th>
            <th scope="col">委員會</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => {
            const style = partyStyle(l.party);
            const tracked = isTracked(l.id);
            return (
              <tr key={l.id}>
                <td className="col-track">
                  <button
                    type="button"
                    className="icon-button"
                    aria-pressed={tracked}
                    aria-label={tracked ? `取消追蹤 ${l.name}` : `追蹤 ${l.name}`}
                    onClick={() => onToggleTrack(l)}
                  >
                    <Star className={tracked ? 'active' : undefined} aria-hidden="true" />
                  </button>
                </td>
                <th scope="row">
                  <button type="button" className="name-button" onClick={() => onOpen(l)}>
                    {l.name}
                  </button>
                  {l.is_convener ? <span className="convener-mark">召委</span> : null}
                </th>
                <td>
                  <span className="party-tag" style={{ color: style.color }}>
                    <span className="swatch" style={{ background: style.color }} aria-hidden="true" />
                    {style.short}
                  </span>
                </td>
                <td>{text(l.area_name)}</td>
                <td className="num">{l.bill_count}</td>
                <td className="num">{l.news_count}</td>
                <td className="num">{latestPost(l) ? latestPost(l).slice(5).replace('-', '/') : '—'}</td>
                <td>{l.top_source ? `${l.top_source.name} ${Math.round((l.top_source.count / l.news_count) * 100)}%` : '—'}</td>
                <td className="committees">
                  {l.committees.length
                    ? l.committees.map((c) => (
                        <span key={c.id} className={c.is_convener ? 'committee is-convener' : 'committee'}>
                          {shortCommittee(c.id)}
                          {c.is_convener ? '・召' : ''}
                        </span>
                      ))
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
