// 판정·배정·발송·보고서 API의 화면용 계층.
// Spring Boot에 해당 API가 생기기 전까지 mocks/review.ts를 돌려준다.
// API가 생기면 이 파일의 함수 본문만 api()/postJson() 호출로 바꾸면 된다.
import { assignQueue, mails, adminAlerts, submissions } from '../mocks/review';

export type Verdict = '성공' | '담당자확인' | '재제출요청';
export type DocCode = '01' | '02' | '03';
export type DocState = 'ok' | 'missing' | 'duplicate';
export type CheckState = 'pass' | 'fail' | 'check' | 'na';
export type MailState = 'none' | 'sent' | 'waiting';

export type Check = {
  title: string;
  detail: string;
  state: CheckState;
  /** 원문 위치. 예) "01 p1" */
  location: string;
};

export type Submission = {
  id: string; // set01 …
  teamName: string;
  /** 공식 자료에 팀명이 없어 임시로 붙인 이름 */
  placeholderName: boolean;
  version: number;
  docs: Record<DocCode, DocState>;
  verdict: Verdict;
  /** Studio 최종판정 reason 원문 */
  reason: string;
  /** 목록용 한 줄 요약 */
  summary: string;
  checks: Check[];
  mail: { state: MailState; subject?: string; body?: string };
  /** 01 명단의 학생 수 (대표 포함). 알 때만 */
  memberCount?: number;
  /** 원문에서 강조할 칸 */
  highlight?: { doc: DocCode; field: 'account' };
};

export type AssignCandidate = { label: string; result: string; tone: 'ok' | 'warn' | 'neutral' };

export type AssignItem = {
  id: string;
  fileName: string;
  classifiedAs: string;
  status: 'pending' | 'auto' | 'assigned';
  team?: string;
  candidate?: string;
  reason: string;
  evidence?: AssignCandidate[];
};

export type MailRecord = {
  submissionId: string;
  teamName: string;
  version: number;
  kind: string;
  subject: string;
  state: MailState;
  sentAt?: string;
};

export type AdminAlert = { submissionId: string; teamName: string; message: string; verdict: Verdict };

const delay = <T,>(value: T, ms = 150) => new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

export const listSubmissions = () => delay(submissions);

export const getSubmission = async (id: string) => {
  const found = submissions.find((s) => s.id === id);
  if (!found) throw new Error('해당 팀 제출본을 찾을 수 없습니다.');
  return delay(found);
};

export const listAssignQueue = () => delay(assignQueue);

export const assignFile = (fileId: string, team: string) => delay({ fileId, team, status: 'assigned' as const });

export const listMails = () => delay(mails);

export const listAdminAlerts = () => delay(adminAlerts);

export const listReportTeams = async () => (await delay(submissions)).filter((s) => s.verdict === '성공');
