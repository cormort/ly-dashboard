/** RFC 4180：含逗號、引號、換行的欄位加引號，引號重複 */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  const cell = (value: unknown) => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

/** 觸發瀏覽器下載；加 BOM 讓 Excel 以 UTF-8 開啟中文 */
export function downloadCsv(filename: string, rows: readonly (readonly unknown[])[]): void {
  const url = URL.createObjectURL(new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // 太早 revoke，Firefox／Safari 有機會把下載取消掉
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
