import { Link } from '../components/workspaceNavigation';
import { CheckCheck, FileStack, LogOut, Plus } from 'lucide-react';
import { isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { buttonStyles } from '../components/ui';

type Session = { login: string | null };

/** 로그인 뒤 처음 보는 화면. 시상금 서류 검토실은 SW중심대학 문서 업무 가운데 하나다. */
export default function Hub() {
  const session = useApi<Session>(isDemoBackend ? null : '/api/auth/session');
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-line bg-white px-[clamp(1rem,3.5vw,2.5rem)] py-3.5">
        <span className="brand-lockup">
          <span className="brand-mark"><CheckCheck size={22} strokeWidth={2.5} aria-hidden="true" /></span>
          <span className="min-w-0"><strong>SW·AX</strong><small>SW중심대학 문서 자동화</small></span>
        </span>
        {!isDemoBackend && (
          <div className="flex flex-wrap items-center gap-3">
            {session.data?.login && <span className="text-sm text-ink-2">{session.data.login}</span>}
            <a href="/logout" className={buttonStyles.secondary}><LogOut size={16} aria-hidden="true" />로그아웃</a>
          </div>
        )}
      </header>

      <main id="workspace-content" tabIndex={-1} className="mx-auto flex w-full max-w-280 flex-1 flex-col gap-7 px-[clamp(1rem,3.5vw,2.5rem)] py-12 focus:outline-none">
        <div className="flex flex-col gap-1.5">
          <h1 className="page-title">문서 업무</h1>
          <p className="page-lead">처리할 문서 업무를 선택하세요.</p>
        </div>

        <ul aria-label="문서 업무 목록" className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18.75rem),1fr))]">
          <li className="surface flex min-h-70 flex-col gap-3.5 p-[22px]">
            <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-brand-tint text-brand-strong"><FileStack size={22} /></span>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-bold leading-snug">시상금 서류 검토실</h2>
              <p className="text-sm text-ink-2">시상금 신청서·동의서·대표 증빙을 팀별로 대조하고 지급내역서 보고서를 만듭니다.</p>
            </div>
            <Link to="/" className={buttonStyles.primary + ' mt-auto w-full'} aria-label="시상금 서류 검토실 들어가기">들어가기</Link>
          </li>
          <li className="flex min-h-70 flex-col gap-3.5 rounded-[14px] border border-dashed border-line-2 bg-white/60 p-[22px] text-muted">
            <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-fill"><Plus size={22} /></span>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-bold leading-snug text-ink-2">다음 문서 업무</h2>
              <p className="text-sm">SW중심대학의 다른 문서 처리도 이곳에 추가됩니다.</p>
            </div>
            <p className="mt-auto"><span className="inline-flex h-[26px] items-center rounded-full bg-fill px-2.5 text-xs font-bold text-ink-2">준비 중</span></p>
          </li>
        </ul>
      </main>
    </div>
  );
}
