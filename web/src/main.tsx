import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器，無法啟動立委觀測站。');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
