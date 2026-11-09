import { useState, type FormEvent } from 'react';
import { createEvent, createTeam, teamLabel } from '../api/intake';
import { sendJson } from '../api/client';
import { backend } from '../api/backend';
import DeleteIntake from '../components/DeleteIntake';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles } from '../components/ui';
import { useEvent } from '../context/EventContext';

const input = 'h-11 w-full rounded-xl border border-line-2 bg-white px-3 text-ink';

export default function Manage() {
  const { event, events, eventsError, teams, dashboard, refresh, selectEvent } = useEvent();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>, kind: 'event' | 'team' | 'overview') {
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
      } else if (event) {
        const created = await createTeam(event.id, name, String(data.get('rep') ?? ''));
        setMessage(created.name + ' 팀을 등록했습니다.');
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
      <PageHeader title="대회·팀 관리" lead="대회를 등록하고, 이미 알고 있는 참가 팀을 미리 넣어 둘 수 있습니다. 팀 지정 없이 혼합 접수해도 됩니다." />
      {!events && <Notice error={eventsError && `${eventsError} (접수 API 서버가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />}

      <form onSubmit={(e) => save(e, 'event')} className="flex flex-col gap-3 rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]">
        <h2 className="text-xl font-extrabold">대회 등록</h2>
        <label htmlFor="event-name" className="text-sm font-bold">
          대회명
        </label>
        <div className="flex flex-wrap gap-3">
          <input id="event-name" name="name" maxLength={160} required className={input + ' flex-[1_1_240px]'} />
          <button className={buttonStyles.primary} disabled={saving}>
            대회 등록
          </button>
        </div>
      </form>

      {event && dashboard?.overview && (
        <form key={event.id} onSubmit={(e) => save(e, 'overview')} className="grid gap-3 rounded-[22px] border border-line bg-white p-6">
          <h2 className="text-xl font-extrabold">지급내역서 행사 정보</h2>
          <label>행사 일시<input name="date" maxLength={120} defaultValue={dashboard.overview.date} className={input} /></label>
          <label>행사 장소<input name="place" maxLength={160} defaultValue={dashboard.overview.place} className={input} /></label>
          <button className={buttonStyles.secondary} disabled={saving}>행사 정보 저장</button>
        </form>
      )}
      {event && (
        <section className="flex flex-col gap-4 rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-extrabold">{event.name} 참가 팀</h2>
            {backend === 'intake' && <DeleteIntake key={event.id} kind="대회" name={event.name} path={'/api/events/' + event.id}
              onDeleted={() => {
                setError('');
                setMessage(event.name + ' 대회를 삭제했습니다.');
                selectEvent(events?.find(item => item.id !== event.id)?.id ?? '');
                refresh();
              }} />}
          </div>
          {teams && teams.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {teams.map((t) => (
                <li key={t.id} className="rounded-lg bg-canvas px-2.5 py-1.5 text-sm">
                  {teamLabel(t)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">등록된 팀이 없습니다. 팀 지정 없이 혼합 접수할 수 있습니다.</p>
          )}
          <form onSubmit={(e) => save(e, 'team')} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label className="flex flex-col gap-2 text-sm font-bold">
              팀명
              <input name="name" maxLength={160} required className={input} />
            </label>
            <label className="flex flex-col gap-2 text-sm font-bold">
              <span>
                대표자 <small className="font-normal text-muted">(선택)</small>
              </span>
              <input name="rep" maxLength={80} className={input} />
            </label>
            <button className={buttonStyles.secondary + ' min-h-11'} disabled={saving}>
              팀 등록
            </button>
          </form>
        </section>
      )}
      {message && (
        <p role="status" className="rounded-2xl bg-brand-tint px-5 py-4 text-sm text-brand-deep">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-2xl bg-alert-soft px-5 py-4 text-sm text-alert-strong">
          {error}
        </p>
      )}
    </Page>
  );
}
