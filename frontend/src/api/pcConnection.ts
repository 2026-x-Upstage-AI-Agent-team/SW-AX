import { useCallback, useEffect, useState } from 'react';
import { isDemoBackend } from './backend';
import { api, ApiError, postJson } from './client';

export type PcDevice = { id?: string; name?: string; registered?: boolean; online?: boolean; hancom_ready?: boolean };
export type PcStatus = { enabled: boolean; device?: PcDevice; pending?: number; download_available?: boolean };
const browserKey = 'swax.pc.browser';
const installedKey = 'swax.pc.installed';
let transientBrowser: string | undefined;

export function browserId() {
  if (transientBrowser) return transientBrowser;
  try {
    const saved = localStorage.getItem(browserKey);
    transientBrowser = saved && /^[a-f0-9-]{36}$/i.test(saved) ? saved : crypto.randomUUID();
    localStorage.setItem(browserKey, transientBrowser);
  } catch { transientBrowser = crypto.randomUUID(); }
  return transientBrowser;
}

export function rememberInstallation() {
  try { localStorage.setItem(installedKey, '1'); } catch { /* Connection remains server-verified. */ }
}

export function installationKnown() {
  try { return localStorage.getItem(installedKey) === '1'; } catch { return false; }
}

export function usePcConnection() {
  const [status, setStatus] = useState<PcStatus | undefined>(() => isDemoBackend ? { enabled: false } : undefined);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (isDemoBackend) return;
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await api<PcStatus>('/api/pc-connections?browser=' + browserId(), { signal: AbortSignal.timeout(8000) });
        if (active) {
          if (result.device?.registered) rememberInstallation();
          setStatus(result); setError('');
        }
      } catch (cause) {
        if (active) {
          if (cause instanceof ApiError && cause.status === 404) setStatus({ enabled: false });
          else setError('PC 연결 상태를 확인하지 못했습니다.');
        }
      } finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(read, 6000);
    window.addEventListener('focus', read);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', read); };
  }, [revision]);
  return { status, error, refresh };
}

export function pairPc() {
  return postJson<{ uri: string; code: string }>('/api/pc-connections/pair', { browser_id: browserId() });
}

export function pcLabel(status?: PcStatus) {
  if (!status) return 'PC 연결 확인 중';
  const device = status.device;
  if (device?.online && device.hancom_ready) return 'PC 연결됨';
  if (device?.online) return '한글 설치·실행 확인 필요';
  if (device?.id || installationKnown()) return '연결 프로그램 실행 필요';
  return 'PC 연결 필요';
}
