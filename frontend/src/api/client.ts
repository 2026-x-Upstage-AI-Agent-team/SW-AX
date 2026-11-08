import { useEffect, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.detail || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', response.status);
  }
  return data as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

/** 비동기 함수(mock 계층 포함)를 화면에서 읽을 때 쓰는 훅. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Loadable<T>>({});
  useEffect(() => {
    let alive = true;
    setState({});
    load().then(
      (data) => alive && setState({ data }),
      (err: Error) => alive && setState({ error: err.message }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((v) => v + 1) };
}

export function bytes(size: number): string {
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' KiB';
  return (size / 1024 ** 2).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' MiB';
}

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
