import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const INTAKE_API = 'http://127.0.0.1:18765'; // Spring Boot 운영판 접수 API
const REVIEW_SERVICE = 'http://127.0.0.1:8765'; // Windows 시연판 검토 서비스(FastAPI)

// npm run dev          → 접수 API
// npm run dev:service  → 검토 서비스 (--mode service, .env.service가 VITE_API_TARGET=service를 넣는다)
export default defineConfig(({ mode }) => {
  const service = mode === 'service';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: service ? REVIEW_SERVICE : INTAKE_API,
          changeOrigin: true,
          // 검토 서비스는 Origin과 Host가 같은 요청만 받는다. 프록시 뒤에서는 Origin을 서비스 주소로 맞춘다.
          headers: service ? { origin: REVIEW_SERVICE } : undefined,
        },
      },
    },
  };
});
