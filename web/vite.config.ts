import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端只呼叫同源 /api/v1/*（見 docs/API.md「前端使用規則」第 1 條），
// 開發與預覽都由 Vite 代理到後端，不直接打 data.ly.gov.tw（CORS/WAF 會擋）。
const proxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
} as const;

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  // build.outDir 使用 Vite 預設值 'dist'（刻意不覆寫）。
});
