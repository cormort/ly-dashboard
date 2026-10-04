import type { CSSProperties, ReactNode } from 'react';

/** 站內連結：保有真正的 href（可開新分頁、可複製），一般點擊走 SPA 導覽不整頁重載 */
export function RouteLink({
  href,
  onNavigate,
  children,
  className,
  title,
  style,
}: {
  href: string;
  onNavigate: (href: string) => void;
  children: ReactNode;
  className?: string;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <a
      href={href}
      className={className}
      title={title}
      style={style}
      onClick={(event) => {
        // 修飾鍵／中鍵留給瀏覽器（新分頁）
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(href);
      }}
    >
      {children}
    </a>
  );
}
