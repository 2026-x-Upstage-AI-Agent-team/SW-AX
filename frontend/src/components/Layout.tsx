import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router';
import { AtSign, CalendarDays, CheckCheck, ChevronDown, Files, Inbox, LayoutDashboard, Mail, Menu, PanelLeftClose, Settings2 } from 'lucide-react';
import { backend } from '../api/backend';
import { isLeaderMail, isMailDraft } from '../api/service';
import { useEvent } from '../context/EventContext';
import { cx } from './ui';
import WorkerStatus, { useWorkerControl } from './WorkerStatus';

const menu = [
  { to: '/', label: '업무 현황', Icon: LayoutDashboard },
  { to: '/intake', label: '문서 업로드', Icon: Inbox },
  { to: '/mail', label: '이메일 발송', Icon: Mail },
  { to: '/report', label: '보고서', Icon: Files },
];

/** 메뉴가 켜지는 경로. 팀별 검토는 업무 현황, 팀 배정 확인은 문서 업로드 아래에 있다. */
function isMenuActive(to: string, pathname: string) {
  if (to === '/') return pathname === '/' || pathname.startsWith('/teams/');
  if (to === '/intake') return pathname.startsWith('/intake') || pathname.startsWith('/assign');
  return pathname === to || pathname.startsWith(to + '/');
}

function Brand({ subtitle = '시상금 서류 검토실', onNavigate }: { subtitle?: string; onNavigate?: () => void }) {
  return (
    <Link to="/home" className="brand-lockup" onClick={onNavigate} aria-label="SW·AX 문서 업무 홈으로">
      <span className="brand-mark"><CheckCheck size={22} strokeWidth={2.5} aria-hidden="true" /></span>
      <span className="min-w-0"><strong>SW·AX</strong><small title={subtitle}>{subtitle}</small></span>
    </Link>
  );
}

function WorkspaceNav({ worker, onNavigate }: { worker: ReturnType<typeof useWorkerControl>; onNavigate?: () => void }) {
  const { events, eventsError, event, selectEvent, dashboard } = useEvent();
  const { pathname } = useLocation();
  const drafts = dashboard?.mail.filter((m) => isLeaderMail(m) && isMailDraft(m)).length ?? 0;
  return (
    <>
      <label className="event-field">
        <span>대회 선택</span>
        <span className="event-picker">
          <CalendarDays size={17} aria-hidden="true" />
          <select value={event?.id ?? ''} disabled={!events?.length} onChange={(e) => selectEvent(e.target.value)} title={eventsError ?? event?.name}>
            {!events?.length && <option value="">{eventsError ? 'API 연결 안 됨' : events ? '등록된 대회 없음' : '불러오는 중…'}</option>}
            {events?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </label>
      <nav aria-label="주 메뉴" className="workspace-nav">
        {menu.map(({ to, label, Icon }) => (
          <Link key={to} to={to} onClick={onNavigate} aria-current={isMenuActive(to, pathname) ? 'page' : undefined}
            className={cx('nav-item', isMenuActive(to, pathname) && 'is-current')}>
            <Icon size={19} aria-hidden="true" />{label}
            {to === '/mail' && drafts > 0 && <span className="nav-count">{drafts}<span className="sr-only">건 승인 대기</span></span>}
          </Link>
        ))}
      </nav>
      <div className="sidebar-foot">
        <WorkerStatus control={worker} />
        <NavLink to="/gmail" onClick={onNavigate} className={({ isActive }) => cx('nav-item', isActive && 'is-current')}>
          <AtSign size={19} aria-hidden="true" />Gmail 연결
        </NavLink>
        <NavLink to="/manage" onClick={onNavigate} className={({ isActive }) => cx('nav-item', isActive && 'is-current')}>
          <Settings2 size={19} aria-hidden="true" />대회 등록
        </NavLink>
        <p className="service-mode">{backend === 'service' ? '검토 서비스' : '접수 API'}</p>
      </div>
    </>
  );
}

export default function Layout() {
  const worker = useWorkerControl();
  const menuDialog = useRef<HTMLDialogElement>(null);
  const { event } = useEvent();
  const { pathname } = useLocation();
  const navigation = useNavigationType();
  const previousPath = useRef(pathname);
  const close = () => menuDialog.current?.close();
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    if (menuDialog.current?.open) menuDialog.current.close();
    if (navigation !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigation]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 60rem)');
    const onResize = () => { if (desktop.matches && menuDialog.current?.open) menuDialog.current.close(); };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, []);

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
        <button type="button" className="icon-button" aria-label="메뉴 열기" aria-haspopup="dialog"
          aria-controls="workspace-menu" onClick={() => menuDialog.current?.showModal()}>
          <Menu size={22} aria-hidden="true" />
        </button>
      </header>
      <dialog ref={menuDialog} id="workspace-menu" className="mobile-menu" aria-label="작업 메뉴"
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
      <div className="workspace-body"><Outlet /></div>
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
