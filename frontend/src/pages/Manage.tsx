import { useState, type FormEvent } from 'react';
import { createEvent } from '../api/intake';
import { sendJson } from '../api/client';
import { backend } from '../api/backend';
import DeleteIntake from '../components/DeleteIntake';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles } from '../components/ui';
import { useEvent } from '../context/EventContext';

const input = 'h-11 w-full rounded-xl border border-line-2 bg-white px-3 text-ink';

export default function Manage() {
  const { event, events, eventsError, dashboard, refresh, selectEvent } = useEvent();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>, kind: 'event' | 'overview') {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') ?? '');
    setSaving(true);
    setError('');
    setMessage('');
    try {
      if (kind === 'event') {
        const created = await createEvent(name);
        selectEvent(created.id);
        setMessage(created.name + ' 대회를 등록했습니다.');
      } else if (event && kind === 'overview') {
        await sendJson('/api/events/' + event.id + '/overview', { date: data.get('date'), place: data.get('place') }, 'PUT');
        setMessage('지급내역서의 행사 정보를 저장했습니다.');
      }
      if (kind !== 'overview') form.reset();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page tone="gray" width="normal">
      <PageHeader title="대회 등록" lead="대회를 등록하고 지급내역서에 들어갈 행사 정보를 저장합니다." />
      {!events && <Notice error={eventsError && `${eventsError} (접수 API 서버가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />}

      <div className="flex w-full max-w-160 flex-col gap-4">
      <form onSubmit={(e) => save(e, 'event')} aria-labelledby="event-h" className="surface flex flex-col gap-3.5 p-[20px_22px_22px]">
        <h2 id="event-h" className="panel-title">대회 등록</h2>
        <label htmlFor="event-name" className="text-sm font-bold">
          대회명
        </label>
        <input id="event-name" name="name" maxLength={160} required className={input} />
        <button className={buttonStyles.primary + ' self-start'} disabled={saving}>
          대회 등록
        </button>
        {event && backend === 'intake' && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm">
            <span className="min-w-0 text-muted">선택한 대회 <strong className="text-ink">{event.name}</strong></span>
            <DeleteIntake key={event.id} kind="대회" name={event.name} path={'/api/events/' + event.id}
              onDeleted={() => {
                setError('');
                setMessage(event.name + ' 대회를 삭제했습니다.');
                selectEvent(events?.find(item => item.id !== event.id)?.id ?? '');
                refresh();
              }} />
          </div>
        )}
      </form>

      {event && dashboard?.overview && (
        <form key={event.id} onSubmit={(e) => save(e, 'overview')} aria-labelledby="overview-h" className="surface flex flex-col gap-3.5 p-[20px_22px_22px]">
          <h2 id="overview-h" className="panel-title">지급내역서 행사 정보</h2>
          <label className="flex flex-col gap-1.5 text-sm font-bold">행사 일시<input name="date" maxLength={120} defaultValue={dashboard.overview.date} className={input + ' font-normal'} /></label>
          <label className="flex flex-col gap-1.5 text-sm font-bold">행사 장소<input name="place" maxLength={160} defaultValue={dashboard.overview.place} className={input + ' font-normal'} /></label>
          <button className={buttonStyles.secondary + ' self-start'} disabled={saving}>행사 정보 저장</button>
        </form>
      )}
      </div>
      {message && (
        <p role="status" className="max-w-160 rounded-xl bg-brand-tint px-5 py-4 text-sm text-brand-deep">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="max-w-160 rounded-xl bg-alert-soft px-5 py-4 text-sm text-alert-strong">
          {error}
        </p>
      )}
    </Page>
  );
}
