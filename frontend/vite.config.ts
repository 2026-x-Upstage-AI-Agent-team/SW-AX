import { readFile } from 'node:fs/promises';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const INTAKE_API = 'http://127.0.0.1:18765'; // Spring Boot 운영판 접수 API
const REVIEW_SERVICE = 'http://127.0.0.1:8765'; // Windows 시연판 검토 서비스(FastAPI)

function localTestAccount(filename: string): Plugin {
  return {
    name: 'swax-local-test-account',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/__swax-local-test-account') return next();
        const { host, origin } = request.headers;
        const peer = request.socket.remoteAddress ?? '';
        const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host ?? '');
        const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
        const forwarded = Object.keys(request.headers).some(header => header === 'forwarded' || header.startsWith('x-forwarded-'));
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'POST' || !localHost || !localPeer || forwarded ||
            origin !== `http://${host}` || request.headers['sec-fetch-site'] !== 'same-origin') {
          response.statusCode = 404;
          return response.end();
        }
        try {
          const { url, login, password } = JSON.parse(await readFile(filename, 'utf8'));
          if (new URL(url).origin !== INTAKE_API || typeof login !== 'string' || !login.trim() ||
              typeof password !== 'string' || !password) throw new Error('Invalid local test account');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          return response.end(JSON.stringify({ login, password }));
        } catch {
          response.statusCode = 404;
          return response.end();
        }
      });
    },
  };
}

// npm run dev          → 접수 API
// npm run dev:service  → 검토 서비스 (--mode service, .env.service가 VITE_API_TARGET=service를 넣는다)
export default defineConfig(({ mode }) => {
  const service = mode === 'service';
  const reviewOrigin = service ? new URL(loadEnv(mode, '.', 'VITE_').VITE_REVIEW_SERVICE_URL || REVIEW_SERVICE).origin : '';
  const testAccountFile = loadEnv(mode, '.', 'SWAX_LOCAL_TEST_ACCOUNT_FILE').SWAX_LOCAL_TEST_ACCOUNT_FILE;
  return {
    plugins: [react(), tailwindcss(), !service && testAccountFile ? localTestAccount(testAccountFile) : false],
    server: {
      host: '127.0.0.1',
      proxy: {
        // Keep the existing local staff session and login flow available in the UI preview.
        '/login': { target: INTAKE_API, changeOrigin: true, autoRewrite: true },
        '/logout': { target: INTAKE_API, changeOrigin: true, autoRewrite: true },
        '/staff-access': { target: INTAKE_API, changeOrigin: true },
        '/api': {
          target: service ? reviewOrigin : INTAKE_API,
          changeOrigin: true,
          // 검토 서비스는 Origin과 Host가 같은 요청만 받는다. 프록시 뒤에서는 Origin을 서비스 주소로 맞춘다.
          headers: service ? { origin: reviewOrigin } : undefined,
        },
      },
    },
  };
});
