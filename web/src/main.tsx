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
