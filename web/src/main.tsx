import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyFontScale, loadFontScaleIndex } from './lib/fontScale';
import './styles.css';

// 先套用已存的字體倍率再 render，避免畫面先以預設大小閃一下
applyFontScale(loadFontScaleIndex());

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器，無法啟動立委觀測站。');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// T11：註冊 Service Worker（只在安全來源生效 —— https 或 localhost）。
// 它只快取靜態外框（見 web/public/sw.js），離線時畫面還在、資料一律連線取得。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      // 註冊失敗不影響功能，只是離線快取不會生效
      console.warn('[立委觀測站] Service Worker 註冊失敗', error);
    });
  });
}
