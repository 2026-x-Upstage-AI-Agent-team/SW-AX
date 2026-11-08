import { useEffect, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 검토 서비스는 상태를 바꾸는 요청에 이 헤더가 있어야 받는다. Spring Boot는 무시한다. */
export const STAFF_HEADER = { 'X-Award-Client': 'staff' } as const;

/** FastAPI 검증 오류(detail 배열)와 일반 오류 문구를 한 줄로 만든다. */
export function errorText(data: unknown, fallback: string): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) return '입력값을 확인해 주세요. (' + detail.map((d) => d?.loc?.slice(-1)[0] ?? '').join(', ') + ')';
  return fallback;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = method === 'GET' || method === 'HEAD' ? options.headers : { ...STAFF_HEADER, ...options.headers };
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', ...options, headers });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('서버에 연결하지 못했습니다. API 서버가 실행 중인지 확인해 주세요.', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(errorText(data, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'), response.status);
  return data as T;
}

export function sendJson<T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  return api<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export const postJson = <T,>(path: string, body: unknown) => sendJson<T>(path, body, 'POST');

export type Loadable<T> = { data?: T; error?: string };

/** GET 요청 결과를 path·revision별로 보관한다. revision을 올리면 다시 조회한다. */
export function useApi<T>(path: string | null, revision = 0): Loadable<T> {
  const [result, setResult] = useState<{ path: string; revision: number; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal }).then(
      (data) => setResult({ path, revision, data }),
      (err: Error) => {
        if (!controller.signal.aborted) setResult({ path, revision, error: err.message });
      },
    );
    return () => controller.abort();
  }, [path, revision]);
  return result?.path === path && result.revision === revision ? result : {};
}

/**
 * 비동기 함수를 화면에서 읽을 때 쓰는 훅. deps가 바뀌면 다시 부른다.
 * 다시 불러오는 동안에는 이전 data를 유지해 화면이 깜빡이지 않게 한다.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Loadable<T>>({});
  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && setState({ data }),
      (err: Error) => alive && setState((prev) => ({ data: prev.data, error: err.message })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((v) => v + 1) };
}

/** busy인 동안 ms마다 refresh를 부른다. */
export function usePolling(busy: boolean, refresh: () => void, ms = 4000) {
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [busy, refresh, ms]);
}

export function bytes(size: number): string {
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' KiB';
  return (size / 1024 ** 2).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' MiB';
}

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
