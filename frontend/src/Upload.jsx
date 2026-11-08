import React, { useRef, useState } from 'react';
import { bytes, teamLabel, upload } from './api';

export default function Upload({ event, teams, onDone, busy, setBusy }) {
  const picker = useRef(null);
  const [target, setTarget] = useState('');
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const total = files.reduce((sum, entry) => sum + entry.file.size, 0);

  function add(list) {
    if (busy || !list.length) return;
    const added = Array.from(list);
    if (files.length + added.length > 100 || total + added.reduce((n, f) => n + f.size, 0) > 300 * 1024 ** 2) {
      setError('한 번에 100개, 합계 300 MiB까지 선택해 주세요.'); return;
    }
    for (const file of added) {
      if (!/\.(hwp|hwpx)$/i.test(file.name) || /^00(?:\D|$)/.test(file.name)) {
        setError(file.name + ' 파일은 접수할 수 없습니다. 00 지급내역서를 제외한 HWP·HWPX를 선택해 주세요.'); return;
      }
      if (!file.size || file.size > 40 * 1024 ** 2) {
        setError(file.name + ' 파일이 비었거나 40 MiB를 초과합니다.'); return;
      }
    }
    setFiles(current => [...current, ...added.map(file => ({ id: crypto.randomUUID(), file }))]);
    setError('');
  }

  async function submit(e) {
    e.preventDefault();
    if (busy || !files.length) return;
    setError(''); setBusy(true); setProgress(0);
    try {
      const manifest = files.map(({ file }) => ({ name: file.name, size: file.size }));
      const selection = JSON.stringify([event.id, target, manifest, files.map(x => x.file.lastModified)]);
      const stored = JSON.parse(sessionStorage.getItem('intake.pending') || 'null');
      const key = stored?.selection === selection ? stored.key : crypto.randomUUID();
      sessionStorage.setItem('intake.pending', JSON.stringify({ selection, key }));
      const form = new FormData();
      form.set('event', event.id);
      if (target) form.set('target', target);
      form.set('manifest', JSON.stringify(manifest));
      files.forEach(({ file }) => form.append('files', file));
      const receipt = await upload(form, key, setProgress);
      sessionStorage.removeItem('intake.pending');
      onDone(receipt.batch_id);
    } catch (err) {
      if (err.status === 409) {
        sessionStorage.removeItem('intake.pending');
        setError(err.message + ' 접수 내역을 확인해 주세요. 다시 접수하면 새 접수번호가 생성됩니다.');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="panel upload">
    <div className="panel-head"><h2>제출 원본</h2><span className="muted">HWP · HWPX</span></div>
    <fieldset disabled={busy}>
      <label htmlFor="target">접수 출처</label>
      <select id="target" value={target} onChange={e => setTarget(e.target.value)}>
        <option value="">팀 미지정 · 혼합 접수</option>
        {teams.map(t => <option key={t.id} value={t.id}>{teamLabel(t)}</option>)}
      </select>
      <p className="hint">한 팀에서 받은 묶음이면 그 팀을 지정할 수 있습니다.</p>
      <input ref={picker} type="file" multiple accept=".hwp,.hwpx" aria-label="제출 원본 파일 선택" hidden
        onChange={e => { add(e.target.files); e.target.value = ''; }} />
      <button type="button" className={'drop' + (dragging ? ' over' : '')} onClick={() => picker.current.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); add(e.dataTransfer.files); }}>
        <span className="drop-icon" aria-hidden="true">↑</span>
        <strong>파일을 끌어오거나 선택하세요</strong>
        <span>00 지급내역서 제외 · 파일당 40 MiB · 합계 300 MiB</span>
      </button>
      {files.length > 0 && <ol className="file-list">{files.map(({ id, file }) => <li key={id}>
        <span className="filename">{file.name}</span><small>{bytes(file.size)}</small>
        <button type="button" className="text-button" aria-label={file.name + ' 선택 취소'}
          onClick={() => { setFiles(list => list.filter(item => item.id !== id)); setError(''); }}>제거</button>
      </li>)}</ol>}
    </fieldset>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && <div role="status" className="progress"><progress max="100" value={progress} />
      {progress === 100 ? '원본 저장 확인 중' : '원본 전송 중 ' + progress + '%'}</div>}
    <footer className="actions"><span>선택 <b>{files.length}</b>개 · {bytes(total)}</span>
      <button className="primary" disabled={busy || !files.length}>원본 접수하기</button></footer>
  </form>;
}
