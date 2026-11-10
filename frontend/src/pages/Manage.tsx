import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { categoryPath } from '../api/workspaces';
import { sendJson } from '../api/client';
import { backend } from '../api/backend';
import DeleteIntake from '../components/DeleteIntake';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

export default function Manage() {
  const { event, events, eventsError, dashboard, refresh } = useEvent();
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!event || saving) return;
    const data = new FormData(e.currentTarget);
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await sendJson('/api/events/' + event.id + '/overview', { date: data.get('date'), place: data.get('place') }, 'PUT');
      setMessage('지급내역서의 행사 정보를 저장했습니다.');
      refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return <Page tone="gray" width="normal">
    <PageHeader title="워크스페이스 설정" lead="현재 작업 공간과 지급내역서에 들어갈 행사 정보를 관리합니다." />
    {!events && <Notice error={eventsError} onRetry={refresh} />}
    <div className="flex w-full max-w-160 flex-col gap-4">
      {event && <section className="surface flex flex-col gap-3.5 p-[20px_22px_22px]" aria-labelledby="workspace-settings-heading">
        <h2 id="workspace-settings-heading" className="panel-title">현재 워크스페이스</h2>
        <p className="text-sm font-semibold">{event.name}</p>
        {backend === 'intake' && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm">
          <span className="text-muted">새 작업 공간은 워크스페이스 목록에서 만들 수 있어요.</span>
          <DeleteIntake kind="워크스페이스" name={event.name} path={'/api/events/' + event.id} onDeleted={() => navigate(categoryPath(categoryId))} />
        </div>}
      </section>}
      {event && dashboard?.overview && <form key={event.id} onSubmit={save} aria-labelledby="overview-h" className="surface flex flex-col gap-3.5 p-[20px_22px_22px]">
        <h2 id="overview-h" className="panel-title">지급내역서 행사 정보</h2>
        <label className="flex flex-col gap-1.5 text-sm font-bold">행사 일시<input name="date" maxLength={120} defaultValue={dashboard.overview.date} className={inputStyle + ' font-normal'} /></label>
        <label className="flex flex-col gap-1.5 text-sm font-bold">행사 장소<input name="place" maxLength={160} defaultValue={dashboard.overview.place} className={inputStyle + ' font-normal'} /></label>
        <button className={buttonStyles.secondary + ' self-start'} disabled={saving}>행사 정보 저장</button>
      </form>}
    </div>
    {message && <p role="status" className="max-w-160 rounded-xl bg-brand-tint px-5 py-4 text-sm text-brand-deep">{message}</p>}
    {error && <p role="alert" className="max-w-160 rounded-xl bg-alert-soft px-5 py-4 text-sm text-alert-strong">{error}</p>}
  </Page>;
}
