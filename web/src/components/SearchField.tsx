import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  /** 送出前的等待時間（毫秒） */
  delayMs?: number;
  className?: string;
}

/**
 * 關鍵字輸入。Header 與 FilterBar 共用同一份 URL 狀態（q），
 * 所以輸入時先更新本地草稿、延遲後才寫回 URL，避免每個字都打一次 API、也避免
 * 塞爆瀏覽器上一頁歷史（寫回時使用 replace 模式）。
 */
export function SearchField({
  value,
  onChange,
  placeholder = '搜尋委員、選區、委員會',
  ariaLabel,
  delayMs = 300,
  className,
}: SearchFieldProps) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const latestDraftRef = useRef(draft);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // 外部（URL／上一頁）改變時同步草稿，但不要打断正在輸入的使用者
  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
      latestDraftRef.current = value;
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = (next: string) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (next !== value) onChangeRef.current(next);
  };

  const commitSoon = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flush(latestDraftRef.current);
    }, delayMs);
  };

  return (
    <div className={className ? `search ${className}` : 'search'}>
      <Search aria-hidden="true" />
      <input
        type="search"
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          flush(latestDraftRef.current);
        }}
        onChange={(event) => {
          const next = event.target.value;
          latestDraftRef.current = next;
          setDraft(next);
          commitSoon();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            flush(latestDraftRef.current);
          }
          if (event.key === 'Escape' && latestDraftRef.current !== '') {
            event.preventDefault();
            latestDraftRef.current = '';
            setDraft('');
            flush('');
          }
        }}
      />
      {draft !== '' ? (
        <button
          type="button"
          className="search-clear"
          aria-label="清除關鍵字"
          onClick={() => {
            latestDraftRef.current = '';
            setDraft('');
            flush('');
          }}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
