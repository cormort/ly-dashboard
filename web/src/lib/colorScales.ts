/**
 * 縣市統計地圖用的連續色階（與 tw_statistic_map 的 Plotly 色階同名同色）。
 * 統計地圖是「顏色只代表黨籍」規則的例外：這裡的顏色代表數值。
 */
export type ScaleName = 'YlOrRd' | 'Blues' | 'Greens' | 'Hot' | 'Viridis' | 'OrRd' | 'RdYlGn';

const STOPS: Record<ScaleName, string[]> = {
  YlOrRd: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  Blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  Greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  Hot: ['#000000', '#e60000', '#ffd200', '#ffffff'],
  Viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  OrRd: ['#fff7ec', '#fee8c8', '#fdd49e', '#fdbb84', '#fc8d59', '#ef6548', '#d7301f', '#b30000', '#7f0000'],
  RdYlGn: ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'],
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** t ∈ [0, 1] 對應的顏色 */
export function colorAt(scale: ScaleName, t: number): string {
  const stops = STOPS[scale];
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = rgb(stops[i]);
  const b = rgb(stops[i + 1]);
  const f = x - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

/** 圖例用的 CSS 漸層 */
export function gradient(scale: ScaleName): string {
  return `linear-gradient(to right, ${STOPS[scale].join(', ')})`;
}
