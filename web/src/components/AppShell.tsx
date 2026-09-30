import type { ReactNode } from 'react';

/** 版面外框：Header（固定）＋ 主內容 ＋ 可選的詳情側欄。 */
export function AppShell({
  header,
  children,
  sidebar,
}: {
  header: ReactNode;
  children: ReactNode;
  sidebar?: ReactNode;
}) {
  return (
    <div className="app">
      {header}
      <main>{children}</main>
      {sidebar}
    </div>
  );
}
