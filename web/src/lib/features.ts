import { createContext, useContext } from 'react';

/**
 * 這台伺服器有沒有提供「縣市地圖」（/health 的 counties_enabled；伺服器設 LY_HIDE_COUNTIES=1 時為 false）。
 * 頁籤與所有連過去的連結都看它；/health 還沒回來前當作有（不讓頁籤閃一下消失又出現的機率變高）。
 */
export const CountiesEnabledContext = createContext(true);
export const useCountiesEnabled = () => useContext(CountiesEnabledContext);
