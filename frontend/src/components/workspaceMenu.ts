import { ClipboardCheck, Files, FileUp, LayoutDashboard, ListChecks, Mail } from 'lucide-react';

export const workflowLabels = {
  upload: '서류 올리기',
  choose: '파일 선택',
  submit: '선택한 서류 올리기',
  progress: '검토 진행',
  progressAction: '검토 진행 보기',
  review: '팀별 결과 확인',
  mail: '팀장 안내 메일',
  mailAction: '안내 메일 검토',
  report: '지급 보고서',
  reportAction: '보고서 만들기',
  saveReview: '검토 결과 저장',
} as const;

export const workflowMenu = [
  { to: '/intake', label: workflowLabels.upload, Icon: FileUp, tour: 'nav-upload' },
  { to: '/intake/batches', label: workflowLabels.progress, Icon: ListChecks, tour: 'nav-progress' },
  { to: '/review', label: workflowLabels.review, Icon: ClipboardCheck, tour: 'nav-review' },
  { to: '/report', label: workflowLabels.report, Icon: Files, tour: 'nav-report' },
];
export const dashboardMenu = { to: '/', label: '업무 현황', Icon: LayoutDashboard, tour: 'nav-dashboard' };
export const mailMenu = { to: '/mail', label: workflowLabels.mail, Icon: Mail, tour: undefined };
export const teamAssignmentMenu = { to: '/assign', label: '팀 배정 확인' };
export const pcConnectionMenu = { to: '/pc-connect', label: '내 PC 연결' };
export const primaryMenu = [dashboardMenu, ...workflowMenu, mailMenu];

export function workspaceSection(pathname: string) {
  return pathname.replace(/^\/categories\/[^/]+\/workspaces\/[^/]+/, '') || '/';
}

export function currentMenu(to: string, section: string) {
  if (to === '/') return section === '/';
  if (to === '/review') return section === '/review' || section.startsWith('/teams/');
  if (to === '/intake') return section === '/intake';
  if (to === '/intake/batches' && section === '/assign') return true;
  return section === to || section.startsWith(to + '/');
}

export function breadcrumb(section: string) {
  if (section.startsWith('/teams/')) return { parent: workflowLabels.review, to: '/review', label: '검토 상세' };
  if (section.startsWith('/intake/batches/')) return { parent: workflowLabels.progress, to: '/intake/batches', label: '검토 진행 상세' };
  if (section === '/assign') return { parent: workflowLabels.progress, to: '/intake/batches', label: teamAssignmentMenu.label };
  if (section === pcConnectionMenu.to) return { parent: '설정', to: '/manage', label: pcConnectionMenu.label };
  if (section === '/gmail' || section === '/manage') return { parent: '설정', to: '/manage', label: section === '/gmail' ? 'Gmail 연결' : '워크스페이스 설정' };
  return { parent: '워크스페이스', to: '/', label: primaryMenu.find(item => currentMenu(item.to, section))?.label ?? '페이지' };
}
