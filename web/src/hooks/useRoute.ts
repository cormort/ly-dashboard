import { useCallback, useEffect, useState } from 'react';

export type Route = 'home' | 'dashboard' | 'legislators' | 'socialwall' | 'bills' | 'budget' | 'rankings' | 'compare' | 'funds' | 'agencies' | 'foundations' | 'administrative' | 'dgbas' | 'committees' | 'news' | 'allnews' | 'agencynews' | 'officials' | 'counties' | 'council' | 'councilactivity' | 'my';

const PATHS: Record<Route, string> = {
  // 預設首頁是總覽；最近動態移到 /activity
  home: '/activity',
  dashboard: '/',
  legislators: '/legislators',
  socialwall: '/legislators/wall',
  bills: '/bills',
  budget: '/budget',
  rankings: '/rankings',
  compare: '/compare',
  funds: '/funds',
  agencies: '/agencies',
  foundations: '/foundations',
  administrative: '/administrative',
  dgbas: '/dgbas',
  committees: '/committees',
  news: '/news',
  allnews: '/news/all',
  agencynews: '/news/agencies',
  officials: '/officials',
  counties: '/counties',
  council: '/council',
  councilactivity: '/council/activity',
  my: '/my',
};

export function routeOf(pathname: string): Route {
  // `/legislators/wall`（粉專牆）要排在 `/legislators` 前面，否則會被當成委員查詢
  if (pathname.startsWith('/legislators/wall')) return 'socialwall';
  if (pathname.startsWith('/legislators')) return 'legislators';
  if (pathname.startsWith('/activity')) return 'home';
  if (pathname.startsWith('/bills')) return 'bills';
  if (pathname.startsWith('/budget')) return 'budget';
  if (pathname.startsWith('/rankings')) return 'rankings';
  if (pathname.startsWith('/compare')) return 'compare';
  if (pathname.startsWith('/funds')) return 'funds';
  if (pathname.startsWith('/agencies')) return 'agencies';
  if (pathname.startsWith('/foundations')) return 'foundations';
  if (pathname.startsWith('/administrative')) return 'administrative';
  if (pathname.startsWith('/dgbas')) return 'dgbas';
  if (pathname.startsWith('/committees')) return 'committees';
  // `/news/all` 要排在 `/news` 前面，否則會被當成委員新聞
  if (pathname.startsWith('/news/all')) return 'allnews';
  if (pathname.startsWith('/news/agencies')) return 'agencynews';
  if (pathname.startsWith('/news')) return 'news';
  if (pathname.startsWith('/officials')) return 'officials';
  if (pathname.startsWith('/counties')) return 'counties';
  // `/council/activity` 要排在 `/council` 前面
  if (pathname.startsWith('/council/activity')) return 'councilactivity';
  if (pathname.startsWith('/council')) return 'council';
  if (pathname.startsWith('/my')) return 'my';
  // `/dashboard` 是舊網址，一併導到總覽
  return 'dashboard';
}

/** 帶 query string 的頁面網址，例如 `pathFor('bills', { law: '國土計畫法' })` */
export function pathFor(route: Route, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  const suffix = qs.toString();
  return `${PATHS[route]}${suffix ? `?${suffix}` : ''}`;
}

/**
 * 三頁式路由（首頁動態／委員查詢／法案查詢），用 pathname 表示，伺服器的 SPA fallback 會接住。
 * 換頁後補發 popstate，讓讀 URL 的 hook（篩選條件）重新解析。
 */
export function useRoute(): { route: Route; navigate: (href: string) => void } {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((href: string) => {
    if (href === `${window.location.pathname}${window.location.search}`) return;
    window.history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo({ top: 0 });
  }, []);

  return { route, navigate };
}
