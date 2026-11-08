import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { backend } from '../api/backend';
import { useEvent } from '../context/EventContext';
import { cx } from './ui';

const menu = [
  { to: '/', label: '업무 현황', end: true },
  { to: '/intake', label: '원본 접수', end: false },
  { to: '/assign', label: '팀 배정 확인', end: false },
  { to: '/mail', label: '발송 이력', end: false },
  { to: '/report', label: '보고서', end: false },
];

export default function Layout() {
  const { events, eventsError, event, selectEvent } = useEvent();
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-20 border-b border-line bg-white/90 backdrop-blur-md">
        <nav aria-label="주 메뉴" className="mx-auto flex min-h-14 max-w-[1240px] flex-wrap items-center gap-x-7 gap-y-1 px-6 py-1">
          <Link to="/" className="flex items-center gap-2 text-base font-extrabold tracking-[-0.02em] text-ink">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-brand" />
            시상금 서류 검토실
          </Link>
          <ul className="flex flex-auto flex-wrap gap-1">
            {menu.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cx(
                      'relative inline-flex min-h-11 items-center px-3 text-sm',
                      isActive
                        ? 'font-bold text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand'
                        : 'text-muted hover:text-ink',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-[13px] text-muted">
              대회
              <select
                className="h-9 max-w-52 rounded-[10px] border border-line-2 bg-white px-2.5 text-ink disabled:text-subtle"
                value={event?.id ?? ''}
                disabled={!events?.length}
                onChange={(e) => selectEvent(e.target.value)}
                title={eventsError}
              >
                {!events?.length && <option value="">{eventsError ? 'API 연결 안 됨' : '불러오는 중'}</option>}
                {events?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <span
              className="hidden rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted lg:inline"
              title={backend === 'service' ? '검토 서비스(FastAPI, 127.0.0.1:8765)에 연결해 판정·검토·메일·보고서까지 실제로 처리합니다.' : '접수 API(Spring Boot, 127.0.0.1:18765)에 연결합니다. 판정·검토 화면은 예시 데이터입니다.'}
            >
              {backend === 'service' ? '검토 서비스' : '접수 API'}
            </span>
            <NavLink to="/manage" className={({ isActive }) => cx('inline-flex min-h-11 items-center px-2 text-[13px]', isActive ? 'font-bold text-ink' : 'text-brand-strong hover:text-brand-deep')}>
              대회·팀 관리
            </NavLink>
          </div>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

/** 회색 바탕 화면용 본문 컨테이너 */
export function Page({ children, tone = 'white', width = 'wide' }: { children: ReactNode; tone?: 'white' | 'gray'; width?: 'wide' | 'normal' }) {
  return (
    <div className={tone === 'gray' ? 'min-h-[calc(100vh-57px)] bg-canvas' : ''}>
      <main className={cx('mx-auto flex flex-col gap-8 px-6 pb-24 pt-10', width === 'wide' ? 'max-w-[1240px]' : 'max-w-[1200px]')}>{children}</main>
    </div>
  );
}
