import { Outlet } from 'react-router';
import { Link } from '../components/workspaceNavigation';
import { ArrowRight, CheckCheck, ClipboardCheck, Clock3, FileCheck2, FileText, FolderOpen, GraduationCap, Handshake, Receipt, Upload, ListChecks, LogOut, type LucideIcon } from 'lucide-react';
import { isDemoBackend } from '../api/backend';
import { useApi } from '../api/client';
import { categoryPath, type Category } from '../api/workspaces';
import { Notice, buttonStyles } from '../components/ui';
import { useEffect, useState } from 'react';

const categoryIcons: Record<string, LucideIcon> = {
  awards: FileCheck2, 'result-reports': FileText, 'expense-evidence': Receipt,
  scholarships: GraduationCap, participation: ClipboardCheck, agreements: Handshake,
};

function CategoryContent({ category }: { category: Category }) {
  const Icon = categoryIcons[category.id] ?? FileText;
  return <>
    <div className="category-card-top"><span className="category-icon"><Icon size={27} strokeWidth={1.6} aria-hidden="true" /></span>
      <span className={'category-status ' + (category.enabled ? 'is-available' : '')}>{category.enabled ? '사용 가능' : '준비 중'}</span></div>
    <h2 id={'category-' + category.id}>{category.name}</h2>
    <p>{category.description}</p>
    <span className="category-action">{category.enabled ? <>워크스페이스 선택<ArrowRight size={17} aria-hidden="true" /></>
      : <><Clock3 size={16} aria-hidden="true" />준비가 끝나면 이용할 수 있어요</>}</span>
  </>;
}

export function PortalLayout() {
  const session = useApi<{ login: string | null }>(isDemoBackend ? null : '/api/auth/session');
  useEffect(() => { document.title = '서류 업무 공간 | SW·AX'; }, []);
  return <div className="portal">
    <header className="portal-header">
      <Link to="/" className="brand-lockup" aria-label="SW·AX 업무 선택">
        <span className="brand-mark"><CheckCheck size={22} aria-hidden="true" /></span>
        <span><strong>SW·AX</strong><small>서류 업무 공간</small></span>
      </Link>
      <div className="portal-account">{session.data?.login && <span>{session.data.login}</span>}{!isDemoBackend && <a href="/logout" className={buttonStyles.secondary}><LogOut size={16} aria-hidden="true" />로그아웃</a>}</div>
    </header>
    <main className="portal-main"><Outlet /></main>
  </div>;
}

export default function Categories() {
  const [revision, setRevision] = useState(0);
  const categories = useApi<Category[]>('/api/categories', revision);
  return <>
    <section className="portal-intro">
      <p className="portal-eyebrow">업무 선택</p>
      <h1>어떤 서류 업무를 시작할까요?</h1>
      <p>업무를 선택하고, 워크스페이스에서 파일과 검토 결과를 한곳에 모아 보세요.<br />회색으로 표시된 업무는 준비 중이에요.</p>
    </section>
    {!categories.data ? <Notice error={categories.error} onRetry={() => setRevision(v => v + 1)} />
      : <section className="category-grid" aria-label="업무 카테고리">
        {categories.data.map(category => category.enabled
          ? <Link key={category.id} to={categoryPath(category.id)} className="category-card"><CategoryContent category={category} /></Link>
          : <article key={category.id} className="category-card category-card-disabled" aria-disabled="true" aria-labelledby={'category-' + category.id}>
            <CategoryContent category={category} /></article>)}
      </section>}
    <ol className="portal-steps" aria-label="서류 업무 진행 순서">
      {[{ Icon: FolderOpen, title: '작업 공간 만들기', text: '대회별로 파일과 이력을 관리해요.' },
        { Icon: Upload, title: '파일 첨부하기', text: '한 팀의 서류를 함께 올려 주세요.' },
        { Icon: ListChecks, title: '검토하고 마무리', text: '검토 결과를 확인하고 보고서를 만들어요.' }].map(({ Icon, title, text }, index) =>
          <li key={title}><Icon size={20} aria-hidden="true" /><div><strong><span>0{index + 1}</span>{title}</strong><p>{text}</p></div></li>)}
    </ol>
  </>;
}
