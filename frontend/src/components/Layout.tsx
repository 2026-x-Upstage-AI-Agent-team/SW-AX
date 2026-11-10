import { useEffect, useRef, type ReactNode } from 'react';
import { Link as PortalLink, Outlet, useLocation, useNavigationType, useParams } from 'react-router';
import { ArrowLeft, AtSign, CheckCheck, Files, FileUp, LayoutDashboard, Mail, Menu, PanelLeftClose, Settings2 } from 'lucide-react';
import { isLeaderMail, isMailDraft } from '../api/service';
import { categoryPath } from '../api/workspaces';
import { NavLink } from './workspaceNavigation';
import { useEvent } from '../context/EventContext';
import { cx } from './ui';
import WorkerStatus, { useWorkerControl } from './WorkerStatus';
import WorkspaceGuideStart, { WorkspaceTourProvider, useWorkspaceTour } from './WorkspaceTour';

const menu = [
  { to: '/', label: '업무 현황', Icon: LayoutDashboard, tour: 'nav-dashboard' },
  { to: '/intake', label: '파일 첨부', Icon: FileUp, tour: 'nav-upload' },
  { to: '/mail', label: '이메일 발송', Icon: Mail, tour: 'nav-mail' },
  { to: '/report', label: '보고서', Icon: Files, tour: 'nav-report' },
];

function Brand({ subtitle = '시상금 서류 검토실', onNavigate }: { subtitle?: string; onNavigate?: () => void }) {
  return (
    <PortalLink to="/" className="brand-lockup" onClick={onNavigate} aria-label="SW·AX 업무 선택">
      <span className="brand-mark"><CheckCheck size={22} strokeWidth={2.5} aria-hidden="true" /></span>
      <span className="min-w-0"><strong>SW·AX</strong><small title={subtitle}>{subtitle}</small></span>
    </PortalLink>
  );
}

function WorkspaceNav({ worker, onNavigate }: { worker: ReturnType<typeof useWorkerControl>; onNavigate?: () => void }) {
  const { event, dashboard } = useEvent();
  const { categoryId } = useParams();
  const { pathname } = useLocation();
  const drafts = dashboard?.mail.filter(m => isLeaderMail(m) && isMailDraft(m)).length ?? 0;
  return (
    <>
      <div className="workspace-identity">
        <PortalLink to={categoryPath(categoryId)} onClick={onNavigate}><ArrowLeft size={15} aria-hidden="true" />워크스페이스 목록</PortalLink>
        <span>현재 워크스페이스</span><strong>{event?.name}</strong>
      </div>
      <nav aria-label="주 메뉴" className="workspace-nav">
        {menu.map(({ to, label, Icon, tour }) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={onNavigate} data-tour={tour}
            className={({ isActive }) => cx('nav-item', (isActive || (to === '/' && pathname.includes('/teams/')) || (to === '/intake' && pathname.includes('/assign'))) && 'is-current')}>
            <Icon size={19} aria-hidden="true" />{label}
            {to === '/mail' && drafts > 0 && <span className="nav-count">{drafts}<span className="sr-only">건 승인 대기</span></span>}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <WorkspaceGuideStart />
        <WorkerStatus control={worker} />
        <NavLink to="/gmail" onClick={onNavigate} className={({ isActive }) => cx('nav-item', isActive && 'is-current')}><AtSign size={19} aria-hidden="true" />Gmail 연결</NavLink>
        <NavLink to="/manage" onClick={onNavigate} className={({ isActive }) => cx('nav-item', isActive && 'is-current')}>
          <Settings2 size={19} aria-hidden="true" />워크스페이스 설정
        </NavLink>
      </div>
    </>
  );
}

export default function Layout() {
  return <WorkspaceTourProvider><WorkspaceLayout /></WorkspaceTourProvider>;
}

function WorkspaceLayout() {
  const worker = useWorkerControl();
  const { menuDialog, openMenu, closeMenu: close } = useWorkspaceTour();
  const { event } = useEvent();
  const { pathname } = useLocation();
  const navigation = useNavigationType();
  const previousPath = useRef(pathname);
  useEffect(() => { document.title = `${event?.name ?? '워크스페이스'} | SW·AX`; }, [event?.name]);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    close();
    if (navigation !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigation, close, menuDialog]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 60rem)');
    const onResize = () => { if (desktop.matches && menuDialog.current?.open) close(); };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, [close, menuDialog]);

  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-content" onClick={(e) => {
        e.preventDefault();
        document.getElementById('workspace-content')?.focus();
      }}>본문으로 바로가기</a>
      <aside className="workspace-rail" aria-label="작업 공간">
        <Brand />
        <WorkspaceNav worker={worker} />
      </aside>
      <header className="mobile-bar">
        <Brand subtitle={event?.name} />
        <button type="button" className="icon-button" aria-label="메뉴 열기" aria-haspopup="dialog" data-tour="menu-open"
          aria-controls="workspace-menu" onClick={openMenu}>
          <Menu size={22} aria-hidden="true" />
        </button>
      </header>
      <dialog ref={menuDialog} id="workspace-menu" className="mobile-menu" aria-label="작업 메뉴"
        onClose={close}
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="mobile-menu-body">
          <div className="flex items-center justify-between gap-2">
            <Brand onNavigate={close} />
            <button type="button" className="icon-button" aria-label="메뉴 닫기" onClick={close} autoFocus>
              <PanelLeftClose size={20} aria-hidden="true" />
            </button>
          </div>
          <WorkspaceNav worker={worker} onNavigate={close} />
        </div>
      </dialog>
      <div className="workspace-body">
        <div className="workspace-context"><span>시상금 서류 검토</span><span aria-hidden="true">/</span><strong>{event?.name}</strong></div>
        <Outlet />
      </div>
    </div>
  );
}

export function Page({ children, tone = 'white', width = 'wide' }: { children: ReactNode; tone?: 'white' | 'gray'; width?: 'wide' | 'normal' | 'review' }) {
  return (
    <main id="workspace-content" tabIndex={-1} className={cx('workspace-page', width === 'normal' && 'page-normal', width === 'review' && 'page-review', tone === 'white' && 'page-paper')}>
      {children}
    </main>
  );
}
