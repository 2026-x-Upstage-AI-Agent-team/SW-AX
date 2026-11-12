import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link as PortalLink, Outlet, useLocation, useNavigate, useNavigationType, useParams } from 'react-router';
import { AtSign, FolderOpen, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings2 } from 'lucide-react';
import { backend, isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { isLeaderMail, isMailDraft } from '../api/service';
import { categoryPath, workspacePath, type Category } from '../api/workspaces';
import { useEvent } from '../context/EventContext';
import { WorkspaceOverviewProvider, useWorkspaceOverview } from '../context/WorkspaceOverviewContext';
import { queueGroups } from '../hooks/reviewQueue';
import { workspaceTasks } from '../hooks/workspaceTasks';
import { Link, NavLink } from './workspaceNavigation';
import { currentMenu, dashboardMenu, mailMenu, workflowMenu, workspaceSection } from './workspaceMenu';
import { cx } from './ui';
import WorkerStatus, { useWorkerControl } from './WorkerStatus';
import { WorkspaceTourProvider, useWorkspaceTour } from './WorkspaceTour';
import WorkspaceHelp from './WorkspaceHelp';
import WorkspacePicker from './WorkspacePicker';
import BrandMark from './BrandMark';
import WorkspaceSearch from './WorkspaceSearch';
import AccountMenu from './AccountMenu';

type NavigationControl = {
  compact: boolean;
  search: () => void; toggleRail: () => void;
};

function Brand({ subtitle, compact = false, onNavigate }: { subtitle: string; compact?: boolean; onNavigate?: () => void }) {
  return <PortalLink to="/" className="brand-lockup" onClick={onNavigate} aria-label="SW·AX 업무 선택">
    <BrandMark />
    <span className={compact ? 'sr-only' : 'min-w-0'}><strong>SW-AX</strong><small title={subtitle}>{subtitle}</small></span>
  </PortalLink>;
}

function WorkspaceNav({ worker, control, onNavigate, account }: { worker: ReturnType<typeof useWorkerControl>; control: NavigationControl; onNavigate?: () => void; account?: ReactNode }) {
  const { events, eventsError, event, dashboard } = useEvent();
  const { rows } = useWorkspaceOverview();
  const { categoryId = 'awards' } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const section = workspaceSection(pathname);
  const workspaces = events?.filter(item => (item.category_id ?? 'awards') === categoryId);
  const drafts = dashboard?.mail.filter(m => isLeaderMail(m) && isMailDraft(m)).length ?? 0;
  const reviewCount = queueGroups(rows ?? []).review.length;
  const tasks = workspaceTasks(dashboard, rows).length;
  const renderMenu = (item: typeof workflowMenu[number] | typeof dashboardMenu | typeof mailMenu) => {
    const count = item.to === '/mail' ? drafts : item.to === '/review' ? reviewCount : item.to === '/' ? tasks : 0;
    const link = <Link key={item.to} to={item.to} onClick={onNavigate} aria-label={item.label}
      aria-current={currentMenu(item.to, section) ? 'page' : undefined} data-tour={item.tour}
      title={item.label + (count ? ` · 확인할 일 ${count}건` : '')}
      className={cx('nav-item', currentMenu(item.to, section) && 'is-current', control.compact && 'justify-center')}>
      <item.Icon size={19} aria-hidden="true" />
      <span className={control.compact ? 'sr-only' : undefined}>{item.label}</span>
      {!control.compact && count > 0 && item.to !== '/' && <span className="nav-count">{count}</span>}
    </Link>;
    return item.to === '/' ? <div key={item.to} className="relative">{link}{!control.compact && count > 0 && <Link to="/?focus=tasks" onClick={onNavigate} aria-label={`확인할 일 ${count}건`} title={`확인할 일 ${count}건`} className="nav-count absolute right-3 top-1/2 -translate-y-1/2">{count}</Link>}</div> : link;
  };
  return <>
    {control.compact ? <PortalLink to={categoryPath(categoryId)} onClick={onNavigate} className="nav-item my-4 justify-center" aria-label="워크스페이스 목록" title={event?.name}><FolderOpen size={19} aria-hidden="true" /></PortalLink>
      : <div className="event-field">
        <div className="flex items-center justify-between gap-2"><span>워크스페이스</span><PortalLink to={categoryPath(categoryId)} onClick={onNavigate} aria-label="워크스페이스 목록" className="text-brand-strong hover:underline">목록</PortalLink></div>
        <WorkspacePicker workspaces={workspaces} current={event} error={eventsError}
          onSelect={id => { onNavigate?.(); navigate(workspacePath(id, '/', categoryId)); }} />
      </div>}
    <nav aria-label="주 메뉴" className="workspace-nav">
      {renderMenu(dashboardMenu)}
      {!control.compact && <p className="rail-label">업무 순서</p>}
      <ol className="workspace-nav" aria-label="업무 순서" role="list">
        {workflowMenu.map(item => <li key={item.to}>{renderMenu(item)}</li>)}
      </ol>
      {renderMenu(mailMenu)}
    </nav>
    <div className="sidebar-foot">
      {!control.compact && <p className="rail-label">설정</p>}
      <NavLink to="/gmail" onClick={onNavigate} aria-label="Gmail 연결" title="Gmail 연결" className={({ isActive }) => cx('nav-item', isActive && 'is-current', control.compact && 'justify-center')}><AtSign size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>Gmail 연결</span></NavLink>
      <NavLink to="/manage" onClick={onNavigate} aria-label="워크스페이스 설정" title="워크스페이스 설정" className={({ isActive }) => cx('nav-item', isActive && 'is-current', control.compact && 'justify-center')}><Settings2 size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>워크스페이스 설정</span></NavLink>
      <div className={cx('flex items-center justify-between', control.compact && 'flex-col')}>
        <button type="button" className="icon-button min-[60rem]:hidden" onClick={control.search} aria-label="현재 워크스페이스 검색" title="검색 · Ctrl+K"><Search size={20} aria-hidden="true" /></button>
        <button type="button" className="icon-button hidden min-[60rem]:grid" onClick={control.toggleRail} aria-label={control.compact ? '사이드바 펼치기' : '사이드바 접기'} title={control.compact ? '사이드바 펼치기' : '사이드바 접기'}>{control.compact ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}</button>
        {account}
      </div>
      <WorkerStatus control={worker} />
    </div>
  </>;
}

export default function Layout() {
  return <WorkspaceTourProvider><WorkspaceOverviewProvider><WorkspaceLayout /></WorkspaceOverviewProvider></WorkspaceTourProvider>;
}

function WorkspaceLayout() {
  const worker = useWorkerControl();
  const { active, start, menuDialog, openMenu, closeMenu } = useWorkspaceTour();
  const { event } = useEvent();
  const { categoryId = 'awards' } = useParams();
  const categories = useApi<Category[]>('/api/categories');
  const categoryName = categories.data?.find(category => category.id === categoryId)?.name
    ?? (categoryId === 'awards' ? '시상금 서류 검토' : '확인 중');
  const brandSubtitle = `업무: ${categoryName}`;
  const { pathname } = useLocation();
  const navigation = useNavigationType();
  const previousPath = useRef(pathname);
  const railKey = 'swax.main-sidebar-collapsed.' + backend;
  const [collapsed, setCollapsed] = useState(() => {
    if (active) return false;
    try { return localStorage.getItem(railKey) === 'true'; } catch { return false; }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState<'toolbar' | 'drawer' | null>(null);
  const session = useApi<{ login: string | null }>(isDemoBackend ? null : '/api/auth/session');
  const login = session.data?.login ?? '담당자';
  const close = useCallback(() => {
    closeMenu();
    setAccountOpen(null);
  }, [closeMenu]);
  const openSearch = useCallback(() => {
    close();
    setSearchOpen(true);
  }, [close]);
  const startGuide = () => { setCollapsed(false); setAccountOpen(null); start(); };
  useEffect(() => { try { localStorage.setItem(railKey, String(collapsed)); } catch { /* Optional preference. */ } }, [collapsed, railKey]);
  useLayoutEffect(() => { if (active) setCollapsed(false); }, [active]);
  useEffect(() => { document.title = `${event?.name ?? '워크스페이스'} | SW·AX`; }, [event?.name]);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    close();
    if (navigation !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigation, close]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 60rem)');
    const onResize = () => {
      setAccountOpen(null);
      if (desktop.matches) closeMenu();
    };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, [closeMenu]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);
  const control: NavigationControl = {
    compact: collapsed, search: openSearch, toggleRail: () => setCollapsed(value => !value),
  };
  return <div className="workspace" data-rail-collapsed={collapsed} data-tour-active={active}>
    <a className="skip-link" href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>본문으로 바로가기</a>
    <aside className="workspace-rail" aria-label="작업 공간"><Brand subtitle={brandSubtitle} compact={collapsed} /><WorkspaceNav worker={worker} control={control} /></aside>
    <header className="mobile-bar"><Brand subtitle={brandSubtitle} /><button type="button" className="icon-button" aria-label="메뉴 열기" aria-haspopup="dialog" data-tour="menu-open" aria-controls="workspace-menu" onClick={openMenu}><Menu size={22} aria-hidden="true" /></button></header>
    <dialog ref={menuDialog} id="workspace-menu" className="mobile-menu" aria-label="작업 메뉴" onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="mobile-menu-body">
        <div className="flex items-center justify-between gap-2"><Brand subtitle={brandSubtitle} onNavigate={close} /><button type="button" className="icon-button" aria-label="메뉴 닫기" onClick={close} autoFocus><PanelLeftClose size={20} aria-hidden="true" /></button></div>
        <WorkspaceNav worker={worker} control={{ ...control, compact: false }} onNavigate={close}
          account={<AccountMenu compact login={login} open={accountOpen === 'drawer'} onOpenChange={open => setAccountOpen(open ? 'drawer' : null)} />} />
      </div>
    </dialog>
    <div className="workspace-body">
      <header className="workspace-toolbar">
        <button type="button" className="toolbar-search" aria-label="현재 워크스페이스 검색" onClick={control.search}>
          <Search size={18} aria-hidden="true" />
          <span>팀·파일·메뉴 검색</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>
        <AccountMenu login={login} open={accountOpen === 'toolbar'} onOpenChange={open => setAccountOpen(open ? 'toolbar' : null)} />
      </header>
      <Outlet />
    </div>
    {!active && <WorkspaceHelp onStartGuide={startGuide} />}
    <WorkspaceSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
  </div>;
}

export function Page({ children, tone = 'white', width = 'wide' }: { children: ReactNode; tone?: 'white' | 'gray'; width?: 'wide' | 'normal' | 'review' }) {
  return <main id="workspace-content" tabIndex={-1} className={cx('workspace-page', width === 'normal' && 'page-normal', width === 'review' && 'page-review', tone === 'white' && 'page-paper')}>{children}</main>;
}
