import { useEffect, useState } from 'react';

export async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return data;
}

export function useApi(path, revision = 0) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(
      data => setResult({ path, revision, data }),
      err => { if (!controller.signal.aborted) setResult({ path, revision, error: err.message }); },
    );
    return () => controller.abort();
  }, [path, revision]);
  return result?.path === path && result.revision === revision ? result : {};
}

export function upload(form, key, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timeout;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => xhr.abort(), 120_000);
    };
    xhr.open('POST', '/api/intake-batches');
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => {
      armTimeout();
      if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = xhr.onabort = () => reject(new Error('전송 결과를 받지 못했습니다. 같은 파일로 다시 접수해 주세요.'));
    xhr.onload = () => {
      if (xhr.status === 202 && xhr.response?.batch_id) resolve(xhr.response);
      else reject(Object.assign(new Error(xhr.response?.detail || '원본을 접수하지 못했습니다. 파일 목록을 확인해 주세요.'), { status: xhr.status }));
    };
    xhr.onloadend = () => clearTimeout(timeout);
    armTimeout();
    xhr.send(form);
  });
}

export function bytes(size) {
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' KiB';
  return (size / 1024 ** 2).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' MiB';
}

export const teamLabel = team => team.name + (team.rep ? ' · ' + team.rep : '');
