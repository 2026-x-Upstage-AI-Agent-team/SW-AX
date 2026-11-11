import { recoverableStates, stateLabel } from '../api/labels';
import type { Dashboard } from '../api/service';
import type { TeamRow } from './useOverview';
import { supplementMailAction } from './reviewQueue';

export type WorkspaceTask = { key: string; text: string; sub: string; to: string; action: string };

export function workspaceTasks(dashboard?: Dashboard, list: TeamRow[] = []): WorkspaceTask[] {
  const alerts: WorkspaceTask[] = [];
  for (const b of dashboard?.batches ?? []) {
    if (b.state === 'conflict')
      alerts.push({ key: b.id, text: '같은 제출본에 보완 서류 첨부가 겹쳤습니다.', sub: '첨부한 파일과 최신 제출본을 대조해 주세요.', to: '/intake/batches/' + b.id, action: '보완본 확인' });
  }
  const pendingFiles = dashboard?.batches.filter(b => b.state !== 'preparing' && b.state !== 'conflict')
    .reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  if (pendingFiles > 0)
    alerts.push({ key: 'assign', text: `팀 배정을 확인할 파일이 ${pendingFiles}개 있습니다.`, sub: '배정이 끝나야 해당 팀의 판정과 누락 안내가 진행됩니다.', to: '/assign', action: '팀 배정 확인' });
  for (const r of list) {
    const s = r.submission;
    if (!s) continue;
    const priorAccess = r.detail?.history.find((h) => h.id !== s.id && h.state === 'access');
    if (recoverableStates.has(s.state) || s.state === 'ownership')
      alerts.push({ key: r.id + 'state', text: `${r.name} · ${stateLabel(s.state)}`, sub: s.error || '처리를 재개하거나 원본을 확인해 주세요.', to: `/teams/${s.id}`, action: '열기' });
    else if (priorAccess)
      alerts.push({ key: r.id + 'access', text: `${r.name} · Studio 접근 권한 확인`, sub: `제출 v${priorAccess.version}에서 인증 오류가 발생했습니다. 키·사용량을 확인한 뒤 재개할 수 있습니다.`, to: `/teams/${priorAccess.id}`, action: '인증 확인' });
    else if (s.verdict === '담당자확인' && !s.decision)
      alerts.push({ key: r.id + 'check', text: `${r.name} · 원본 대조가 필요합니다.`, sub: r.reviewSummary ?? '검토할 서류를 확인해 주세요.', to: `/teams/${s.id}`, action: '원본 대조하기' });
    else if (r.leaderMail?.state === 'recipient_check')
      alerts.push({ key: r.id + 'mail', text: `${r.name} · 팀장 수신 주소를 확인해 주세요.`, sub: '팀장 안내 메일이 보류 중입니다. 신청서와 제출 경로의 주소를 대조해 주세요.', to: '/mail?mail=' + encodeURIComponent(r.leaderMail.id), action: '주소 확인' });
    else if (s.verdict === '재제출요청' && !r.email)
      alerts.push({ key: r.id + 'mail', text: `${r.name} · 팀장 이메일이 없습니다.`, sub: '보완 요청 메일이 수신자 확인을 기다립니다.', to: supplementMailAction(s.id).to, action: '이메일 입력' });
    else if (!r.held && s.state === 'done' && s.verdict === '성공' && !s.decision)
      alerts.push({ key: r.id + 'approval', text: `${r.name} · 담당자 승인 대기`, sub: '성공 판정의 원본과 근거를 검토하고 담당자 결정을 기록하세요.', to: `/teams/${s.id}`, action: '판정 검토' });
  }

  return alerts;
}
