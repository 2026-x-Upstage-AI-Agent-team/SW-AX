import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link as PortalLink, Outlet, useLocation, useNavigate, useNavigationType, useParams } from 'react-router';
import { AtSign, CalendarDays, CheckCheck, ChevronDown, FolderOpen, Inbox, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings2, UserRound } from 'lucide-react';
import { backend, isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { isLeaderMail, isMailDraft } from '../api/service';
import { categoryPath, workspacePath, type Category } from '../api/workspaces';
import { useEvent } from '../context/EventContext';
import { WorkspaceOverviewProvider, useWorkspaceOverview } from '../context/WorkspaceOverviewContext';
import { queueGroups } from '../hooks/reviewQueue';
import { workspaceTasks } from '../hooks/workspaceTasks';
import { Link, NavLink } from './workspaceNavigation';
import { currentMenu, documentMenu, primaryMenu, workspaceSection } from './workspaceMenu';
import { buttonStyles, cx } from './ui';
import WorkerStatus, { useWorkerControl } from './WorkerStatus';
import { WorkspaceTourProvider, useWorkspaceTour } from './WorkspaceTour';
import WorkspaceHelp from './WorkspaceHelp';
import WorkspaceSearch from './WorkspaceSearch';

type NavigationControl = {
  compact: boolean; documentsOpen: boolean; toggleDocuments: () => void;
  search: () => void; account: () => void; toggleRail: () => void;
};

function Brand({ subtitle, compact = false, onNavigate }: { subtitle: string; compact?: boolean; onNavigate?: () => void }) {
  return <PortalLink to="/" className="brand-lockup" onClick={onNavigate} aria-label="SW·AX 업무 선택">
    <span className="brand-mark"><CheckCheck size={22} strokeWidth={2.5} aria-hidden="true" /></span>
    <span className={compact ? 'sr-only' : 'min-w-0'}><strong>SW·AX</strong><small title={subtitle}>{subtitle}</small></span>
  </PortalLink>;
}

function WorkspaceNav({ worker, control, onNavigate }: { worker: ReturnType<typeof useWorkerControl>; control: NavigationControl; onNavigate?: () => void }) {
  const { events, eventsError, event, dashboard } = useEvent();
  const { rows } = useWorkspaceOverview();
  const { categoryId = 'awards' } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const pickerId = useId();
  const section = workspaceSection(pathname);
  const workspaces = events?.filter(item => (item.category_id ?? 'awards') === categoryId);
  const drafts = dashboard?.mail.filter(m => isLeaderMail(m) && isMailDraft(m)).length ?? 0;
  const reviewCount = queueGroups(rows ?? []).review.length;
  const tasks = workspaceTasks(dashboard, rows).length;
  const documentActive = section === '/assign' || section.startsWith('/intake');
  const renderMenu = (item: typeof primaryMenu[number]) => {
    const count = item.to === '/mail' ? drafts : item.to === '/review' ? reviewCount : item.to === '/' ? tasks : 0;
    const link = <Link key={item.to} to={item.to} onClick={onNavigate} aria-label={item.label}
      aria-current={currentMenu(item.to, section) ? 'page' : undefined} data-tour={item.tour}
      title={item.label + (count ? ` · 확인할 일 ${count}건` : '')}
      className={cx('nav-item', currentMenu(item.to, section) && 'is-current', control.compact && 'justify-center')}>
      <item.Icon size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>{item.label}</span>
      {!control.compact && count > 0 && item.to !== '/' && <span className="nav-count">{count}</span>}
    </Link>;
    return item.to === '/' ? <div key={item.to} className="relative">{link}{!control.compact && count > 0 && <Link to="/?focus=tasks" onClick={onNavigate} aria-label={`확인할 일 ${count}건`} title={`확인할 일 ${count}건`} className="nav-count absolute right-3 top-1/2 -translate-y-1/2">{count}</Link>}</div> : link;
  };
  return <>
    {control.compact ? <PortalLink to={categoryPath(categoryId)} onClick={onNavigate} className="nav-item my-4 justify-center" aria-label="워크스페이스 목록" title={event?.name}><FolderOpen size={19} aria-hidden="true" /></PortalLink>
      : <div className="event-field">
        <div className="flex items-center justify-between gap-2"><label htmlFor={pickerId}>워크스페이스</label><PortalLink to={categoryPath(categoryId)} onClick={onNavigate} aria-label="워크스페이스 목록" className="text-brand-strong hover:underline">목록</PortalLink></div>
        <span className="event-picker"><CalendarDays size={17} aria-hidden="true" />
          <select id={pickerId} aria-label="워크스페이스 선택" value={event?.id ?? ''} disabled={!workspaces?.length} title={eventsError ?? event?.name}
            onChange={event => { onNavigate?.(); navigate(workspacePath(event.target.value, '/', categoryId)); }}>
            {!workspaces?.length && <option value="">워크스페이스 없음</option>}
            {workspaces?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select><ChevronDown size={15} aria-hidden="true" /></span>
      </div>}
    <nav aria-label="주 메뉴" className="workspace-nav">
      {renderMenu(primaryMenu[0])}
      <button type="button" onClick={control.toggleDocuments} aria-label="서류 관리" title="서류 관리" aria-expanded={control.documentsOpen && !control.compact}
        aria-current={documentActive && (!control.documentsOpen || control.compact) ? 'page' : undefined}
        className={cx('nav-item w-full', documentActive && 'is-current', control.compact && 'justify-center')}>
        <Inbox size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>서류 관리</span>{!control.compact && <ChevronDown size={15} className={cx('ml-auto', control.documentsOpen && 'rotate-180')} aria-hidden="true" />}
      </button>
      {control.documentsOpen && !control.compact && <div className="ml-3 grid gap-1 border-l border-line pl-2">{documentMenu.map(item =>
        <Link key={item.to} to={item.to} onClick={onNavigate} data-tour={item.tour} aria-label={item.label}
          aria-current={currentMenu(item.to, section) ? 'page' : undefined} className={cx('nav-item text-[.85rem]', currentMenu(item.to, section) && 'is-current')}>{item.label}</Link>)}</div>}
      {primaryMenu.slice(1).map(renderMenu)}
    </nav>
    <div className="sidebar-foot">
      <WorkerStatus control={worker} />
      <NavLink to="/gmail" onClick={onNavigate} aria-label="Gmail 연결" title="Gmail 연결" className={({ isActive }) => cx('nav-item', isActive && 'is-current', control.compact && 'justify-center')}><AtSign size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>Gmail 연결</span></NavLink>
      <NavLink to="/manage" onClick={onNavigate} aria-label="워크스페이스 설정" title="워크스페이스 설정" className={({ isActive }) => cx('nav-item', isActive && 'is-current', control.compact && 'justify-center')}><Settings2 size={19} aria-hidden="true" /><span className={control.compact ? 'sr-only' : undefined}>워크스페이스 설정</span></NavLink>
      <div className={cx('flex items-center justify-between', control.compact && 'flex-col')}>
        <button type="button" className="icon-button" onClick={() => { onNavigate?.(); control.search(); }} aria-label="현재 워크스페이스 검색" title="검색 · Ctrl+K"><Search size={20} aria-hidden="true" /></button>
        <button type="button" className="icon-button hidden min-[60rem]:grid" onClick={control.toggleRail} aria-label={control.compact ? '사이드바 펼치기' : '사이드바 접기'} title={control.compact ? '사이드바 펼치기' : '사이드바 접기'}>{control.compact ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}</button>
        <button type="button" className="icon-button" onClick={() => { onNavigate?.(); control.account(); }} aria-label="계정 메뉴" title="계정 메뉴"><UserRound size={20} aria-hidden="true" /></button>
      </div>
    </div>
  </>;
}

export default function Layout() {
  return <WorkspaceTourProvider><WorkspaceOverviewProvider><WorkspaceLayout /></WorkspaceOverviewProvider></WorkspaceTourProvider>;
}

function WorkspaceLayout() {
  const worker = useWorkerControl();
  const { active, start, menuDialog, openMenu, closeMenu: close } = useWorkspaceTour();
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
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(railKey) === 'true'; } catch { return false; } });
  const [documentsOpen, setDocumentsOpen] = useState(() => /\/(intake|assign)(\/|$)/.test(pathname));
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountDialog = useRef<HTMLDialogElement>(null);
  const session = useApi<{ login: string | null }>(isDemoBackend ? null : '/api/auth/session');
  const startGuide = () => { setCollapsed(false); setDocumentsOpen(true); start(); };
  useEffect(() => { try { localStorage.setItem(railKey, String(collapsed)); } catch { /* Optional preference. */ } }, [collapsed, railKey]);
  useEffect(() => { if (active) { setCollapsed(false); setDocumentsOpen(true); } }, [active]);
  useEffect(() => { document.title = `${event?.name ?? '워크스페이스'} | SW·AX`; }, [event?.name]);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    close();
    if (/\/(intake|assign)(\/|$)/.test(pathname)) setDocumentsOpen(true);
    if (navigation !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigation, close]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 60rem)');
    const onResize = () => { if (desktop.matches) close(); };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, [close]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); close(); setAccountOpen(false); setSearchOpen(true); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => { if (accountOpen) accountDialog.current?.showModal(); else accountDialog.current?.close(); }, [accountOpen]);
  const control: NavigationControl = {
    compact: collapsed, documentsOpen,
    toggleDocuments: () => { if (collapsed) { setCollapsed(false); setDocumentsOpen(true); } else setDocumentsOpen(value => !value); },
    search: () => setSearchOpen(true), account: () => setAccountOpen(true), toggleRail: () => setCollapsed(value => !value),
  };
  return <div className="workspace" data-rail-collapsed={collapsed}>
    <a className="skip-link" href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>본문으로 바로가기</a>
    <aside className="workspace-rail" aria-label="작업 공간"><Brand subtitle={brandSubtitle} compact={collapsed} /><WorkspaceNav worker={worker} control={control} /></aside>
    <header className="mobile-bar"><Brand subtitle={brandSubtitle} /><button type="button" className="icon-button" aria-label="메뉴 열기" aria-haspopup="dialog" data-tour="menu-open" aria-controls="workspace-menu" onClick={openMenu}><Menu size={22} aria-hidden="true" /></button></header>
    <dialog ref={menuDialog} id="workspace-menu" className="mobile-menu" aria-label="작업 메뉴" onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="mobile-menu-body"><div className="flex items-center justify-between gap-2"><Brand subtitle={brandSubtitle} onNavigate={close} /><button type="button" className="icon-button" aria-label="메뉴 닫기" onClick={close} autoFocus><PanelLeftClose size={20} aria-hidden="true" /></button></div><WorkspaceNav worker={worker} control={{ ...control, compact: false }} onNavigate={close} /></div>
    </dialog>
    <div className="workspace-body"><Outlet /></div>
    {!active && <WorkspaceHelp onStartGuide={startGuide} />}
    <WorkspaceSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    <dialog ref={accountDialog} className="deletion-dialog" aria-label="계정 메뉴" onClose={() => setAccountOpen(false)} onCancel={() => setAccountOpen(false)}>
      <div className="flex flex-col gap-4 p-6"><h2 className="panel-title">계정</h2><p className="text-sm">{session.data?.login ?? '담당자'}</p>
        <PortalLink to="/" className={buttonStyles.secondary} onClick={() => setAccountOpen(false)}>업무 선택</PortalLink>
        {!isDemoBackend && <a href="/logout" className={buttonStyles.outline}><LogOut size={16} aria-hidden="true" />로그아웃</a>}
        <button type="button" className={buttonStyles.text} onClick={() => setAccountOpen(false)}>닫기</button>
      </div>
    </dialog>
  </div>;
}

export function Page({ children, tone = 'white', width = 'wide' }: { children: ReactNode; tone?: 'white' | 'gray'; width?: 'wide' | 'normal' | 'review' }) {
  return <main id="workspace-content" tabIndex={-1} className={cx('workspace-page', width === 'normal' && 'page-normal', width === 'review' && 'page-review', tone === 'white' && 'page-paper')}>{children}</main>;
}
