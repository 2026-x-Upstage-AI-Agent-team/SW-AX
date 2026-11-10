import { busyStates, recoverableStates, stateLabel } from '../api/labels';
import type { DashTeam } from '../api/service';
import type { TeamRow } from './useOverview';

export const reviewStages = [
  { key: 'review', label: '검토 대기', description: '원문 대조와 담당자 결정이 필요해요.' },
  { key: 'supplement', label: '보완 진행', description: '보완 안내와 추가 서류를 확인해요.' },
  { key: 'processing', label: '자동 검토 중', description: '서류 판독과 AI 검토를 기다려요.' },
  { key: 'assignment', label: '팀 배정 확인', description: '파일의 소속 팀을 먼저 확인해요.' },
  { key: 'approved', label: '승인 완료', description: '담당자가 승인한 팀이에요.' },
] as const;
export type ReviewStage = typeof reviewStages[number]['key'];

/** AI success and the staff's approval are distinct steps. Held files block review. */
export function reviewStage(team: DashTeam): ReviewStage {
  const submission = team.submission;
  if (team.held || !submission) return 'assignment';
  if (busyStates.has(submission.state)) return 'processing';
  if (recoverableStates.has(submission.state) || submission.state !== 'done') return 'review';
  if (submission.decision === '승인') return 'approved';
  if (submission.decision === '보완 필요' || submission.verdict === '재제출요청') return 'supplement';
  return 'review';
}

export function queueGroups(rows: TeamRow[]) {
  const groups: Record<ReviewStage, TeamRow[]> = { review: [], supplement: [], processing: [], assignment: [], approved: [] };
  for (const row of rows) groups[reviewStage(row)].push(row);
  return groups;
}

export function reviewPriority(row: TeamRow) {
  const state = reviewStage(row);
  if (state === 'review' && row.submission && (recoverableStates.has(row.submission.state) || row.submission.state !== 'done')) return 0;
  if (state === 'review' && row.submission?.verdict === '담당자확인') return 1;
  return { review: 2, supplement: 3, assignment: 4, processing: 5, approved: 6 }[state];
}

export function nextReviewAction(row: TeamRow): { label: string; to: string; hint: string } {
  const submission = row.submission;
  const stage = reviewStage(row);
  const detail = submission ? '/teams/' + submission.id : '/review';
  if (stage === 'assignment') return { label: '팀 배정 확인', to: '/assign', hint: '이 팀에 속할 파일을 확인한 뒤 검토할 수 있습니다.' };
  if (stage === 'processing') return { label: '진행 보기', to: detail, hint: '검토 결과가 도착하면 담당자 결정을 기록할 수 있습니다.' };
  if (stage === 'approved') return { label: '지급 정보 입력', to: '/report', hint: '보고서에서 시상구분과 지급 금액을 확인하세요.' };
  if (stage === 'supplement') {
    const mail = row.leaderMail;
    const mailTo = mail ? '/mail?mail=' + encodeURIComponent(mail.id) : '/mail';
    if (mail?.state === 'recipient_check') return { label: '수신 주소 확인', to: mailTo, hint: '보완 안내를 보내기 전에 수신자를 확인하세요.' };
    if (mail?.state === 'draft') return { label: '보완 안내 검토', to: mailTo, hint: '초안과 수신자를 확인하고 발송을 승인하세요.' };
    if (mail?.state === 'sent' || mail?.state === 'local') return { label: '보완 서류 첨부', to: '/intake?base=' + encodeURIComponent(submission!.id), hint: '새로 받은 서류를 같은 팀의 다음 제출본으로 첨부하세요.' };
    if (mail) return { label: '안내 상태 확인', to: mailTo, hint: '팀장 안내의 발송 상태를 확인하세요.' };
    return { label: '보완 항목 확인', to: detail, hint: '원본과 보완 사유를 확인하고 필요한 안내를 준비하세요.' };
  }
  if (submission?.state !== 'done') return { label: '처리 상태 확인', to: detail, hint: submission?.error || `${stateLabel(submission?.state)} 상태를 확인하고 처리를 이어가세요.` };
  return submission.verdict === '성공'
    ? { label: '승인 검토', to: detail, hint: 'AI 검토를 통과했습니다. 원본 확인 후 담당자 승인이 필요합니다.' }
    : { label: '원문 대조', to: detail, hint: '판정 근거를 확인하고 승인 또는 보완 필요를 기록하세요.' };
}
