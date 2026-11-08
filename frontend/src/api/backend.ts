/** 어느 백엔드에 붙어 있는지. vite.config.ts와 .env.service 참고 */
export type Backend = 'intake' | 'service';

export const backend: Backend = import.meta.env.VITE_API_TARGET === 'service' ? 'service' : 'intake';

/** Windows 시연판(FastAPI) API를 선택했는지 */
export const isDemoBackend = backend === 'service';

export const backendLabel = backend === 'service' ? '검토 서비스 (127.0.0.1:8765)' : '접수 API (127.0.0.1:18765)';
