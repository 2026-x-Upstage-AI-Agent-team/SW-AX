import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { Link, useNavigate } from '../components/workspaceNavigation';
import { ArrowLeft, ArrowRight, FolderOpen, Plus } from 'lucide-react';
import { useApi } from '../api/client';
import { createEvent, type AwardEvent } from '../api/intake';
import { categoryPath, workspacePath, type Category } from '../api/workspaces';
import { Feedback, Notice, buttonStyles, inputStyle } from '../components/ui';

export default function Workspaces() {
  const { categoryId = '' } = useParams();
  return <WorkspaceList key={categoryId} categoryId={categoryId} />;
}

function WorkspaceList({ categoryId }: { categoryId: string }) {
  const navigate = useNavigate();
  const [revision, setRevision] = useState(0);
  const categories = useApi<Category[]>('/api/categories', revision);
  const category = categories.data?.find(item => item.id === categoryId);
  const workspaces = useApi<AwardEvent[]>(category?.enabled ? '/api/events?category=' + encodeURIComponent(categoryId) : null, revision);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => setRevision(v => v + 1);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (saving || !category?.enabled || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const created = await createEvent(name.trim(), categoryId);
      navigate(workspacePath(created.id, '/', categoryId));
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  if (!categories.data) return <Notice error={categories.error} onRetry={refresh} />;
  if (!category) return <div className="surface p-6"><h1 className="text-2xl font-bold">업무 카테고리를 찾을 수 없습니다.</h1><Link to="/" className={buttonStyles.text}>업무 다시 선택</Link></div>;
  if (!category.enabled) return <section className="surface grid gap-4 p-6">
    <p className="portal-eyebrow">{category.name}</p><h1 className="text-2xl font-bold">준비 중인 업무입니다.</h1>
    <p className="text-muted">현재는 시상금 서류 검토를 이용할 수 있습니다.</p>
    <Link to="/" className={buttonStyles.primary + ' justify-self-start'}>업무 선택으로 돌아가기</Link>
  </section>;
  return <>
    <Link to="/" className={buttonStyles.text + ' self-start'}><ArrowLeft size={16} aria-hidden="true" />업무 선택</Link>
    <section className="portal-intro workspace-intro">
      <p className="portal-eyebrow">{category.name}</p>
      <h1>워크스페이스</h1>
      <p>작업할 대회를 선택하거나 새로운 작업 공간을 만드세요.<br />각 공간에서 파일 첨부부터 검토, 보고서 작성까지 이어집니다.</p>
    </section>
    <div className="workspace-selection">
      <section aria-labelledby="workspace-list-heading" className="workspace-list">
        <h2 id="workspace-list-heading">내 워크스페이스 <span>{workspaces.data?.length ?? 0}</span></h2>
        {!workspaces.data ? <Notice error={workspaces.error} onRetry={refresh} />
          : workspaces.data.length === 0 ? <div className="workspace-empty"><FolderOpen size={34} strokeWidth={1.5} aria-hidden="true" /><h3>첫 워크스페이스를 만들어 보세요.</h3><p>대회 이름을 입력하면 서류를 첨부할 작업 공간이 만들어집니다.</p></div>
          : workspaces.data.map(workspace => <Link key={workspace.id} to={workspacePath(workspace.id, '/', categoryId)} className="workspace-card">
            <span className="workspace-card-icon"><FolderOpen size={23} aria-hidden="true" /></span>
            <div><h3>{workspace.name}</h3><p>{category.name}</p></div>
            <ArrowRight size={19} aria-hidden="true" />
          </Link>)}
      </section>
      <form onSubmit={create} className="workspace-create" aria-label="워크스페이스 만들기">
        <span className="workspace-card-icon"><Plus size={23} aria-hidden="true" /></span>
        <h2>워크스페이스 만들기</h2>
        <p>한 대회의 서류와 검토 이력을 함께 관리합니다.</p>
        <label htmlFor="workspace-name">대회명</label>
        <input id="workspace-name" value={name} onChange={e => setName(e.target.value)} maxLength={160} required disabled={saving} placeholder="예: 2026 웨이브" className={inputStyle} autoComplete="off" />
        <Feedback error={error} />
        <button className={buttonStyles.primary} disabled={saving || !name.trim()}>{saving ? '만드는 중…' : '워크스페이스 만들기'}<ArrowRight size={17} aria-hidden="true" /></button>
        <small>만든 다음 바로 파일을 첨부할 수 있어요.</small>
      </form>
    </div>
    <p className="portal-bottom-note"><Link to={categoryPath(categoryId)}>워크스페이스 목록</Link>에서는 내 계정에 배정된 작업 공간을 확인할 수 있습니다.</p>
  </>;
}
