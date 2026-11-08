import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// VITE_API_TARGET
//   intake  (기본) Spring Boot 운영판 접수 API — 127.0.0.1:18765
//   service       Windows 시연판 검토 서비스(FastAPI) — 127.0.0.1:8765
//                 Studio 판정·팀 배정·검토·메일·보고서 API까지 모두 연결된다.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const service = env.VITE_API_TARGET === 'service';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: service ? 'http://127.0.0.1:8765' : 'http://127.0.0.1:18765',
          changeOrigin: true,
          configure: (proxy) => {
            // 검토 서비스는 Origin과 Host가 같은 요청만 받는다. 프록시 뒤에서는 Origin을 떼어 보낸다.
            if (service) proxy.on('proxyReq', (req) => req.removeHeader('origin'));
          },
        },
      },
    },
  };
});
