// Spring Boot 접수 API (backend/src/main/java/kr/swax/intake)와 연결되는 실제 호출.
import { ApiError, STAFF_HEADER, errorText, postJson } from './client';

export type AwardEvent = { id: string; name: string };
export type AwardTeam = { id: string; name: string; rep: string };

export type BatchSummary = {
  batch_id: string;
  status: string;
  created_at: string;
  team_name: string | null;
  team_rep: string | null;
  file_count: number;
};

export type BatchFile = { item_id: string; name: string; size: number; team: string | null; state: string };

type BatchTeam = {
  submission_id: string | null;
  team: string;
  state: 'confirmed' | 'blocked' | 'empty' | 'superseded';
  version: number | null;
  review_job: {
    review_job_id: string;
    state: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'superseded';
    status_url: string;
    verdict?: string;
  } | null;
};

export type BatchDetails = {
  batch: {
    batch_id: string;
    status: string;
    current_submission?: string | null;
    event_id: string;
    created_at: string;
    team_name: string | null;
    team_rep: string | null;
    total_bytes: number;
  };
  files: BatchFile[];
  teams: BatchTeam[];
};

export type Receipt = { batch_id: string; status?: string; status_url?: string };

export const paths = {
  events: '/api/events',
  teams: (event: string) => `/api/events/${event}/teams`,
  batches: (event: string) => `/api/intake-batches?event=${event}`,
  batch: (id: string) => `/api/intake-batches/${encodeURIComponent(id)}`,
  original: (batch: string, file: string) => `/api/intake-batches/${batch}/files/${file}/original`,
};

export function receiptName(name: string, number?: number | null) {
  const provisional = `접수 ${number}팀`;
  return number && name !== provisional ? `${provisional} · ${name}` : name;
}

export const teamLabel = (team: { name: string; rep?: string | null }) => team.name + (team.rep ? ' · ' + team.rep : '');

export const createEvent = (name: string) => postJson<AwardEvent>(paths.events, { name });

export const createTeam = (event: string, name: string, rep: string) =>
  postJson<AwardTeam>(paths.teams(event), { name, rep });

/**
 * 원본 일괄 업로드. 같은 선택을 다시 보내면 같은 Idempotency-Key로 기존 접수번호를 받는다.
 * Spring Boot는 202, 검토 서비스는 202(새 접수) 또는 200(이미 배정까지 끝난 같은 접수)을 돌려준다.
 */
export function uploadBatch(form: FormData, key: string, onProgress: (percent: number) => void): Promise<Receipt> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => xhr.abort(), 120_000);
    };
    xhr.open('POST', '/api/intake-batches');
    xhr.setRequestHeader('Idempotency-Key', key);
    for (const [name, value] of Object.entries(STAFF_HEADER)) xhr.setRequestHeader(name, value);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      armTimeout();
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = xhr.onabort = () =>
      reject(new ApiError('전송 결과를 받지 못했습니다. 같은 파일로 다시 접수해 주세요.', 0));
    xhr.onload = () => {
      if ((xhr.status === 202 || xhr.status === 200) && xhr.response?.batch_id) resolve(xhr.response as Receipt);
      else reject(new ApiError(errorText(xhr.response, '원본을 접수하지 못했습니다. 파일 목록을 확인해 주세요.'), xhr.status));
    };
    xhr.onloadend = () => clearTimeout(timeout);
    armTimeout();
    xhr.send(form);
  });
}
