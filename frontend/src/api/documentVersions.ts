import { api, ApiError, errorText } from './client';
import type { RhwpEditor } from '@rhwp/editor';

export type EditVersion = { version: number; editor: string; saved_at: string };
export type EditHistory = { name: string; versions: EditVersion[] };

export const versionHistoryPath = (file: string) => '/api/files/' + encodeURIComponent(file) + '/versions';
export const versionChannel = 'swax-document-versions';
export const getEditHistory = (file: string, signal?: AbortSignal) => api<EditHistory>(versionHistoryPath(file), { signal });
export const versionUrl = (file: string, version: number) => versionHistoryPath(file) + '/' + version + '/content';
export const versionName = (name: string, version: number) =>
  version === 0 ? name : name.replace(/\.hwpx?$/i, '') + '-v' + version + '.hwpx';

export async function readVersion(file: string, version: number, signal?: AbortSignal) {
  const response = await fetch(versionUrl(file, version), { cache: 'no-store', signal });
  if (!response.ok) throw new ApiError(errorText(await response.json().catch(() => ({})), '문서를 열 수 없습니다.'), response.status);
  return response.arrayBuffer();
}

export async function exportEditedHwpx(editor: RhwpEditor): Promise<ArrayBuffer> {
  const data = Uint8Array.from(await editor.exportHwpx()).buffer;
  const worker = new Worker(new URL('./hwpxExport.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.bytes);
      worker.onerror = () => reject(new Error('HWPX 저장 파일을 준비하지 못했습니다.'));
      worker.postMessage(data, [data]);
    });
  } finally { worker.terminate(); }
}

export async function saveVersion(file: string, base: number, bytes: ArrayBuffer) {
  const form = new FormData();
  form.set('baseVersion', String(base));
  form.set('document', new Blob([bytes], { type: 'application/octet-stream' }), 'edited.hwpx');
  const saved = await api<EditVersion>(versionHistoryPath(file), { method: 'POST', body: form });
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(versionChannel);
    channel.postMessage(file);
    channel.close();
  }
  return saved;
}
