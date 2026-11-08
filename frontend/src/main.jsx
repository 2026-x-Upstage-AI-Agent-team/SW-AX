import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, bytes, teamLabel, useApi } from './api';
import Upload from './Upload';
import './style.css';

const pages = { upload: '원본 접수', history: '접수 내역', manage: '대회·팀 관리' };
const date = value => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const route = () => new URLSearchParams(location.hash.slice(1));
function go(view, event, batch) {
  const params = new URLSearchParams({ view });
  if (event) params.set('event', event);
  if (batch) params.set('batch', batch);
  location.hash = params.toString();
}

function Notice({ message, retry }) {
  return <div className="notice" role={message ? 'alert' : 'status'}>
    {message || '불러오는 중…'} {message && <button className="text-button" onClick={retry}>다시 조회</button>}
  </div>;
}

function Management({ event, teams, onSaved }) {
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e, isTeam) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = Object.fromEntries(new FormData(form));
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await api(isTeam ? '/api/events/' + event.id + '/teams' : '/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      form.reset();
      setMessage(result.name + (isTeam ? ' 팀을 등록했습니다.' : ' 대회를 등록했습니다.'));
      onSaved(isTeam ? event.id : result.id);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <div className="stack">
    <form className="panel" onSubmit={e => save(e, false)}>
      <h2>대회 등록</h2><label htmlFor="event-name">대회명</label>
      <div className="inline"><input id="event-name" name="name" maxLength="160" required />
        <button className="primary" disabled={saving}>대회 등록</button></div>
    </form>
    {event && <section className="panel"><h2>참가 팀</h2>
      {teams.length > 0 ? <ul className="teams">{teams.map(t => <li key={t.id}>{teamLabel(t)}</li>)}</ul>
        : <p className="hint">등록된 팀이 없습니다. 팀 지정 없이 혼합 접수할 수 있습니다.</p>}
      <form onSubmit={e => save(e, true)} className="team-form">
        <label>팀명<input name="name" maxLength="160" required /></label>
        <label>대표자 <small>(선택)</small><input name="rep" maxLength="80" /></label>
        <button className="secondary" disabled={saving}>팀 등록</button>
      </form>
    </section>}
    {message && <p role="status" className="notice">{message}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}

function History({ event, open, refresh, revision }) {
  const result = useApi('/api/intake-batches?event=' + event.id, revision);
  if (!result.data) return <Notice message={result.error} retry={refresh} />;
  return <section className="panel">
    <div className="panel-head"><h2>접수 목록 <em>{result.data.length}</em></h2>
      <button className="text-button" onClick={refresh}>새로고침</button></div>
    {result.data.length === 0 ? <p className="empty">아직 접수한 원본이 없습니다.</p> :
      <div className="table-wrap"><table><thead><tr>
        <th>접수번호</th><th>접수 일시</th><th>지정 팀</th><th>원본</th><th>상태</th>
      </tr></thead><tbody>{result.data.map(batch => <tr key={batch.batch_id}>
        <td><button className="receipt-link" onClick={() => open(batch.batch_id)}>{batch.batch_id.slice(0, 8)}</button></td>
        <td>{date(batch.created_at)}</td><td>{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep }) : '미지정'}</td>
        <td>{batch.file_count}개</td><td><span className="status">원본 접수 완료</span></td></tr>)}</tbody></table></div>}
  </section>;
}

function Details({ id, event, revision, refresh }) {
  const result = useApi('/api/intake-batches/' + encodeURIComponent(id), revision);
  if (!result.data) return <Notice message={result.error} retry={refresh} />;
  const { batch, files } = result.data;
  if (batch.event_id !== event.id) return <p role="alert">선택한 대회의 접수번호가 아닙니다.</p>;
  return <div className="stack">
    <section className="panel"><div className="panel-head"><h2>접수 상세</h2><span className="status">원본 접수 완료</span></div>
      <dl className="facts"><dt>접수번호</dt><dd className="receipt-id">{batch.batch_id}</dd>
        <dt>접수 일시</dt><dd>{date(batch.created_at)}</dd><dt>지정 팀</dt>
        <dd>{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep }) : '미지정 · 혼합 접수'}</dd>
        <dt>검토 상태</dt><dd>내용 판독 전</dd></dl>
    </section>
    <section className="panel"><div className="panel-head"><h2>접수 원본 <em>{files.length}</em></h2><span className="muted">{bytes(batch.total_bytes)}</span></div>
      <ol className="file-list">{files.map(file => <li key={file.item_id}>
        <span className="filename">{file.name}</span><small>{bytes(file.size)}</small>
        <a className="text-button" href={'/api/intake-batches/' + batch.batch_id + '/files/' + file.item_id + '/original'} download>원본 받기</a>
      </li>)}</ol></section>
    <div><button className="secondary" onClick={() => go('history', event.id)}>접수 목록으로</button></div>
  </div>;
}

function App() {
  const [nav, setNav] = useState(route);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const change = () => setNav(route());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const refresh = () => setRevision(v => v + 1);
  const events = useApi('/api/events', revision);
  const wanted = nav.get('event');
  const event = events.data?.find(item => item.id === wanted) || (!wanted && events.data?.[0]);
  const teams = useApi(event ? '/api/events/' + event.id + '/teams' : null, revision);
  const requestedView = nav.get('view');
  const view = !event && events.data ? 'manage' : (Object.hasOwn(pages, requestedView) ? requestedView : 'upload');
  const batch = nav.get('batch');
  const navigate = (v, id = event?.id) => go(v, id);
  const registered = id => { refresh(); go('manage', id); };
  return <>
    <header className="mast"><div className="brand"><span className="mark" aria-hidden="true">W</span><strong>SW·AX</strong><span className="brand-rule"></span>시상금 증빙 관리</div></header>
    <div className="layout"><aside><label htmlFor="event-select">대회 선택</label>
      <select id="event-select" value={event?.id || ''} disabled={busy || !events.data?.length}
        onChange={e => navigate(view, e.target.value)}>
        {!event && <option value="">대회 선택</option>}
        {events.data?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <nav aria-label="담당자 메뉴">{Object.entries(pages).map(([key, text]) =>
        <button key={key} onClick={() => navigate(key)} disabled={busy || (!event && key !== 'manage')}
          aria-current={view === key ? 'page' : undefined}>{text}</button>)}</nav>
    </aside><main>
      {event && <p className="context">{event.name}</p>}
      <h1>{pages[view]}</h1>
      {!events.data ? <Notice message={events.error} retry={refresh} />
        : event && !teams.data ? <Notice message={teams.error} retry={refresh} />
        : view === 'manage' ? <Management key={event?.id} event={event} teams={teams.data || []} onSaved={registered} />
        : view === 'upload' ? <Upload key={event.id} event={event} teams={teams.data} busy={busy} setBusy={setBusy}
            onDone={id => go('history', event.id, id)} />
        : batch ? <Details event={event} id={batch} refresh={refresh} revision={revision} />
        : <History event={event} open={id => go('history', event.id, id)} refresh={refresh} revision={revision} />}
    </main></div>
  </>;
}

createRoot(document.getElementById('root')).render(<App />);
