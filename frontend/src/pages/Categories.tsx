import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router';
import { CheckCheck, ClipboardCheck, FileStack, FileText, GraduationCap, Handshake, LogOut, Receipt, type LucideIcon } from 'lucide-react';
import { isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { categoryPath, type Category } from '../api/workspaces';
import { Notice, buttonStyles } from '../components/ui';

const categoryIcons: Record<string, LucideIcon> = {
  awards: FileStack, 'result-reports': FileText, 'expense-evidence': Receipt,
  scholarships: GraduationCap, participation: ClipboardCheck, agreements: Handshake,
};

/** The main branch's document-work home, with additional categories and workspace entry. */
export function PortalLayout() {
  const session = useApi<{ login: string | null }>(isDemoBackend ? null : '/api/auth/session');
  useEffect(() => { document.title = '문서 업무 | SW·AX'; }, []);
  return <div className="flex min-h-dvh flex-col bg-canvas">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-line bg-white px-[clamp(1rem,3.5vw,2.5rem)] py-3.5">
      <Link to="/" className="brand-lockup" aria-label="SW·AX 업무 선택">
        <span className="brand-mark"><CheckCheck size={22} strokeWidth={2.5} aria-hidden="true" /></span>
        <span className="min-w-0"><strong>SW·AX</strong><small>SW중심대학 문서 자동화</small></span>
      </Link>
      {!isDemoBackend && <div className="flex flex-wrap items-center gap-3">
        {session.data?.login && <span className="text-sm text-ink-2">{session.data.login}</span>}
        <a href="/logout" className={buttonStyles.secondary}><LogOut size={16} aria-hidden="true" />로그아웃</a>
      </div>}
    </header>
    <main id="workspace-content" tabIndex={-1} className="mx-auto flex w-full max-w-280 flex-1 flex-col gap-7 px-[clamp(1rem,3.5vw,2.5rem)] py-12 focus:outline-none"><Outlet /></main>
  </div>;
}

export default function Categories() {
  const [revision, setRevision] = useState(0);
  const categories = useApi<Category[]>('/api/categories', revision);
  return <>
    <div className="flex flex-col gap-1.5">
      <h1 className="page-title">문서 업무</h1>
      <p className="page-lead">처리할 문서 업무를 선택하세요.</p>
    </div>
    {!categories.data ? <Notice error={categories.error} onRetry={() => setRevision(v => v + 1)} />
      : <ul aria-label="업무 카테고리" className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18.75rem),1fr))]">
        {categories.data.map(category => {
          const Icon = categoryIcons[category.id] ?? FileText;
          return <li key={category.id} aria-disabled={!category.enabled || undefined} aria-labelledby={'category-' + category.id}
            className={category.enabled ? 'surface flex min-h-70 flex-col gap-3.5 p-[22px]'
              : 'category-card-disabled flex min-h-70 flex-col gap-3.5 rounded-[14px] border border-dashed border-line-2 bg-white/60 p-[22px] text-muted'}>
            <span aria-hidden="true" className={'grid size-11 place-items-center rounded-xl ' + (category.enabled ? 'bg-brand-tint text-brand-strong' : 'bg-fill')}><Icon size={22} /></span>
            <div className="flex flex-col gap-1.5">
              <h2 id={'category-' + category.id} className={'text-lg font-bold leading-snug' + (category.enabled ? '' : ' text-ink-2')}>{category.name}</h2>
              <p className={'text-sm' + (category.enabled ? ' text-ink-2' : '')}>{category.description}</p>
            </div>
            {category.enabled ? <Link to={categoryPath(category.id)} className={buttonStyles.primary + ' mt-auto w-full'} aria-label={category.name + ' 들어가기'}>들어가기</Link>
              : <p className="mt-auto"><span className="inline-flex h-[26px] items-center rounded-full bg-fill px-2.5 text-xs font-bold text-ink-2">준비 중</span></p>}
          </li>;
        })}
      </ul>}
  </>;
}
