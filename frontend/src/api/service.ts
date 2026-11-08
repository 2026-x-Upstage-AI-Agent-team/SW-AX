// 검토 서비스(service/app.py, FastAPI) API.
// VITE_API_TARGET=service일 때 실제로 호출하고, 아니면 mocks/service.ts의 같은 형태 예시 데이터를 돌려준다.
// 예시 데이터일 때 상태를 바꾸는 호출은 오류를 던진다.
import { reviewLive } from './backend';
import { api, sendJson, ApiError, STAFF_HEADER, errorText } from './client';
import * as mock from '../mocks/service';

export type Verdict = '성공' | '담당자확인' | '재제출요청';
export type DocKey = '01' | '02' | '03' | '?';
export type Decision = '승인' | '보완 필요';

export type SubInfo = {
  id: string;
  team: string;
  version: number;
  created: number;
  updated: number;
  state: string;
  error: string;
  job: string | null;
  decision: Decision | null;
  revision: number;
  attempts: number;
  verdict: Verdict | null;
  students: number;
  count: number;
  award_type: string;
  support_amount: string;
  status_url: string;
};

export type DashTeam = {
  id: string;
  name: string;
  rep: string;
  email: string;
  current: string | null;
  held: boolean;
  submission: SubInfo | null;
};

export type BatchRow = { id: string; state: string; created: number; count: number; pending: number };
export type ReportRow = { id: string; version: number; state: string; error: string; created: number };
export type MailRow = {
  id: string;
  submission: string;
  kind: string;
  state: string;
  sent_to: string | null;
  created: number;
  version?: number;
  name?: string;
};

export type Dashboard = {
  events: Array<{ id: string; name: string }>;
  teams: DashTeam[];
  batches: BatchRow[];
  reports: ReportRow[];
  mail: MailRow[];
  smtp: boolean;
  gmail_account: string | null;
  gmail_oauth_connected: boolean;
  mail_ready: boolean;
  config: string;
  connected: boolean;
  event: string;
};

export type FileInfo = {
  id: string;
  name: string;
  kind: string;
  state: string;
  team: string | null;
  reason: string;
  pages: number;
  size: number;
  candidates: string[];
  excluded: string[];
  page: number;
  url: string;
};

export type Ref = { id: string; page: number; row?: number };
export type Check = { label: string; passed: boolean | null; refs: Ref[] };

export type Member = { role: string; name: string; student_id: string; major: string; school: string };
export type Recipient = {
  bank_name?: string;
  account_number?: string;
  account_holder?: string;
  rrn_display?: string;
  gross_amount?: string;
  tax_amount?: string;
  net_amount?: string;
};

export type StudioResult = {
  verdict: Verdict;
  reason: string;
  program: string;
  team_name: string;
  rep: string;
  members: Member[];
  recipient: Recipient;
  documents: Record<DocKey, Ref[]>;
  checks: Check[];
  issues: string[];
  consent_names: string[];
  staff_report: string | Record<string, unknown>;
};

export type Fields = { members: Member[]; recipient: Recipient; award_type: string; support_amount: string };

export type SubmissionDetail = SubInfo & {
  team_name: string;
  rep: string;
  email: string;
  held: boolean;
  current: string | null;
  note: string;
  fields: Fields;
  result: StudioResult | null;
  files: FileInfo[];
  history: Array<{ id: string; version: number; state: string; job: string | null; decision: Decision | null }>;
  mail: MailRow[];
  audit: Array<{ ts: number; action: string; actor: string }>;
};

export type BatchDetail = {
  id: string;
  event: string;
  state: string;
  revision: number;
  created: number;
  target: string | null;
  base: string | null;
  files: FileInfo[];
  teams: Array<{ team: string; submission_id: string; status_url: string }>;
};

export type DraftTeam = Fields & {
  team: string;
  submission: string | null;
  rep: string;
  version: number | null;
  pending: string[];
};

export type ReportView = {
  id: string;
  version: number;
  state: string;
  created: number;
  error: string;
  parent: string | null;
  stale: boolean;
  teams: string[];
};

export type MailView = MailRow & { body: string; subject?: string };

export type ReviewInput = {
  revision: number;
  decision: Decision | '작성 중';
  note: string;
  members: Member[];
  recipient: Recipient;
  award_type: string;
  support_amount: string;
  issues: string[];
};

export const OFFLINE_MESSAGE = '예시 데이터에서는 저장할 수 없습니다. 검토 서비스에 연결해 실행해 주세요. (npm run dev:service)';

function live<T>(fn: () => Promise<T>): Promise<T> {
  if (!reviewLive) return Promise.reject(new ApiError(OFFLINE_MESSAGE, 0));
  return fn();
}

const enc = encodeURIComponent;

// ── 조회 ─────────────────────────────────────────────

export const getDashboard = (event: string) =>
  reviewLive ? api<Dashboard>(`/api/dashboard?event=${enc(event)}`) : mock.dashboard();

export const getSubmission = (sid: string) =>
  reviewLive ? api<SubmissionDetail>(`/api/submissions/${enc(sid)}`) : mock.submission(sid);

export const getBatch = (bid: string) => (reviewLive ? api<BatchDetail>(`/api/intake-batches/${enc(bid)}`) : mock.batch(bid));

export const getDraft = (event: string) =>
  reviewLive ? api<{ teams: DraftTeam[] }>(`/api/events/${enc(event)}/draft`) : mock.draft();

export const getMail = (mid: string) => (reviewLive ? api<MailView>(`/api/mail/${enc(mid)}`) : mock.mail(mid));

export const getReport = (rid: string) => live(() => api<ReportView>(`/api/reports/${enc(rid)}`));

/** 검토용 PDF 주소. 예시 데이터에는 없다. */
export const filePreviewUrl = (f: Pick<FileInfo, 'url'>, page?: number) => (f.url ? f.url + (page ? `#page=${page}` : '') : '');
export const reportFileUrl = (rid: string, kind: 'preview' | 'hwpx' | 'pdf') => `/api/reports/${enc(rid)}/${kind}`;

// ── 변경 ─────────────────────────────────────────────

export const saveReview = (sid: string, body: ReviewInput) =>
  live(() => sendJson<{ saved: boolean }>(`/api/submissions/${enc(sid)}/review`, body, 'PUT'));

export const retrySubmission = (sid: string, body: { job?: string; confirmed_absent?: boolean }) =>
  live(() => sendJson<SubInfo>(`/api/submissions/${enc(sid)}/retry`, { job: '', confirmed_absent: false, ...body }));

export const setTeamEmail = (tid: string, email: string) =>
  live(() => sendJson<{ saved: boolean }>(`/api/teams/${enc(tid)}/email`, { email }, 'PUT'));

export type AssignInput = { action: 'assign' | 'outside' | 'hold'; team?: string; reason: string; revision: number; exclude?: string[] };

export const assignFile = (bid: string, fid: string, body: AssignInput) =>
  live(() =>
    sendJson<{ saved: boolean }>(`/api/intake-batches/${enc(bid)}/files/${enc(fid)}/assignment`, { team: '', exclude: [], ...body }, 'PUT'),
  );

export const retryFile = (bid: string, fid: string) =>
  live(() => sendJson<{ saved: boolean }>(`/api/intake-batches/${enc(bid)}/files/${enc(fid)}/retry`, {}));

export const retryMail = (mid: string, confirmedAbsent: boolean) =>
  live(() => sendJson<{ saved: boolean }>(`/api/mail/${enc(mid)}/retry`, { job: '', confirmed_absent: confirmedAbsent }));

export const createReport = (event: string, submissions: string[]) =>
  live(() => sendJson<{ id: string; version: number; status_url?: string }>('/api/reports', { event, submissions }));

export const confirmReport = (rid: string) => live(() => sendJson<{ saved: boolean }>(`/api/reports/${enc(rid)}/confirm`, {}));

export const uploadEditedReport = (rid: string, file: File) =>
  live(async () => {
    const form = new FormData();
    form.set('file', file);
    const response = await fetch(`/api/reports/${enc(rid)}/edited`, { method: 'POST', body: form, headers: STAFF_HEADER });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(errorText(data, '편집본을 올리지 못했습니다.'), response.status);
    return data as { id: string; version: number };
  });

export const connectGmail = (appPassword: string) =>
  live(() => sendJson<{ connected: boolean; address: string }>('/api/settings/gmail/connect', { app_password: appPassword }));

export const startGmailOAuth = (clientJson: string) =>
  live(() => sendJson<{ url: string }>('/api/settings/gmail/oauth/start', { client_json: clientJson }));

// ── 보조 ─────────────────────────────────────────────

/** 저장된 검토 내용을 바탕으로 일부만 바꿔 PUT 본문을 만든다. */
export function reviewBody(s: SubmissionDetail, patch: Partial<ReviewInput>): ReviewInput {
  return {
    revision: s.revision,
    decision: s.decision ?? '작성 중',
    note: s.note,
    members: s.fields.members,
    recipient: s.fields.recipient,
    award_type: s.fields.award_type ?? '',
    support_amount: s.fields.support_amount ?? '',
    issues: s.result?.issues ?? [],
    ...patch,
  };
}

/** 팀장에게 가는 안내인지(담당자 알림 제외) */
export const isLeaderMail = (m: MailRow) => m.kind !== '담당자 알림';
