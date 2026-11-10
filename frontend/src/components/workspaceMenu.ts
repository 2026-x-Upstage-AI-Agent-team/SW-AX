import { ClipboardCheck, Files, LayoutDashboard, Mail } from 'lucide-react';

export const documentMenu = [
  { to: '/intake', label: '파일 첨부', tour: 'nav-upload' },
  { to: '/intake/batches', label: '첨부 내역', tour: 'upload-history' },
  { to: '/assign', label: '팀 배정 확인', tour: undefined },
];

export const primaryMenu = [
  { to: '/', label: '업무 현황', Icon: LayoutDashboard, tour: 'nav-dashboard' },
  { to: '/review', label: '팀별 검토', Icon: ClipboardCheck, tour: 'nav-review' },
  { to: '/mail', label: '팀장 안내', Icon: Mail, tour: 'nav-mail' },
  { to: '/report', label: '보고서', Icon: Files, tour: 'nav-report' },
];

export function workspaceSection(pathname: string) {
  return pathname.replace(/^\/categories\/[^/]+\/workspaces\/[^/]+/, '') || '/';
}

export function currentMenu(to: string, section: string) {
  if (to === '/') return section === '/';
  if (to === '/review') return section === '/review' || section.startsWith('/teams/');
  if (to === '/intake') return section === '/intake';
  return section === to || section.startsWith(to + '/');
}

export function breadcrumb(section: string) {
  if (section.startsWith('/teams/')) return { parent: '팀별 검토', to: '/review', label: '검토 상세' };
  if (section.startsWith('/intake/batches/')) return { parent: '서류 관리', to: '/intake/batches', label: '첨부 상세' };
  const document = documentMenu.find(item => currentMenu(item.to, section));
  if (document) return { parent: '서류 관리', to: '/intake', label: document.label };
  if (section === '/gmail' || section === '/manage') return { parent: '설정', to: '/manage', label: section === '/gmail' ? 'Gmail 연결' : '워크스페이스 설정' };
  return { parent: '워크스페이스', to: '/', label: primaryMenu.find(item => currentMenu(item.to, section))?.label ?? '페이지' };
}
