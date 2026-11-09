import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Save } from 'lucide-react';
import { createEditor, type RhwpEditor } from '@rhwp/editor';
import { ApiError } from '../api/client';
import { exportEditedHwpx, getEditHistory, readVersion, saveVersion, versionName, versionUrl, type EditHistory } from '../api/documentVersions';
import { buttonStyles, Feedback } from '../components/ui';

export default function DocumentEditor() {
  const { id = '' } = useParams();
  return <Editor key={id} file={id} />;
}

function Editor({ file }: { file: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<RhwpEditor | null>(null);
  const locked = useRef(false);
  const saveAction = useRef<() => void>(() => {});
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const [history, setHistory] = useState<EditHistory | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = history?.versions[0]?.version ?? 0;
  const legacy = location.pathname === '/document-editor';
  const review = query.get('review');
  const back = (review ? '/teams/' + encodeURIComponent(review) : '/assign') + '?file=' + encodeURIComponent(file);
  const legacyRoute = query.get('from') ?? '';
  const returnUrl = legacy ? '/#' + (/^(intake|review)(\/[\w-]+)?$/.test(legacyRoute) ? legacyRoute : 'intake') : '#' + back;

  useEffect(() => {
    const controller = new AbortController();
    let instance: RhwpEditor | undefined;
    const start = async () => {
      const info = await getEditHistory(file, controller.signal);
      const initial = info.versions[0]?.version ?? 0;
      const data = await readVersion(file, initial, controller.signal);
      if (controller.signal.aborted || !mount.current) return;
      setHistory(info);
      setVersion(initial);
      instance = await createEditor(mount.current, {
        studioUrl: new URL('/rhwp/viewer.html', location.origin).href, renderer: 'canvas2d', handshakeTimeoutMs: 10000,
      });
      if (controller.signal.aborted) { instance.destroy(); return; }
      instance.element.title = '한글 문서 자유 편집';
      await instance.loadFile(data, versionName(info.name, initial), { suppressDialogs: true });
      if (controller.signal.aborted) return;
      editor.current = instance;
      setReady(true);
      setBusy(false);
    };
    setBusy(true);
    setReady(false);
    setError('');
    setMessage('');
    setConflict(false);
    start().catch((err: Error) => {
      if (controller.signal.aborted) return;
      instance?.destroy();
      setError('편집기를 열지 못했습니다. ' + err.message);
      setBusy(false);
    });
    const handleMessage = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === editor.current?.element.contentWindow && event.data?.type === 'swax-save-version') saveAction.current();
    };
    window.addEventListener('message', handleMessage);
    return () => {
      controller.abort();
      editor.current = null;
      instance?.destroy();
      window.removeEventListener('message', handleMessage);
    };
  }, [file, attempt]);

  async function canLeave() {
    const current = editor.current;
    if (!current) return true;
    try {
      if (!(await current.getDocumentState()).dirty) return true;
    } catch { /* Ask before discarding a document whose dirty state is unavailable. */ }
    return window.confirm('저장하지 않은 변경을 닫을까요?');
  }

  async function switchVersion(selected: number) {
    const current = editor.current;
    if (!current || !history || locked.current || selected === version) return;
    locked.current = true;
    setBusy(true);
    current.element.inert = true;
    try {
      if (!(await canLeave())) return;
      const bytes = await readVersion(file, selected);
      await current.loadFile(bytes, versionName(history.name, selected), { skipUnsavedGuard: true, suppressDialogs: true });
      setVersion(selected);
      setMessage('');
      setError('');
      setConflict(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      current.element.inert = false;
      locked.current = false;
      setBusy(false);
    }
  }

  async function save() {
    const current = editor.current;
    if (!current || !history || locked.current || conflict || version !== latest) return;
    locked.current = true;
    current.element.inert = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const bytes = await exportEditedHwpx(current);
      const saved = await saveVersion(file, version, bytes);
      setVersion(saved.version);
      setHistory({ ...history, versions: [saved, ...history.versions.filter(v => v.version !== saved.version)] });
      setMessage('수정본 v' + saved.version + '을 저장했습니다.');
      try {
        await current.notifySaved(versionName(history.name, saved.version));
      } catch {
        setMessage('수정본 v' + saved.version + '을 저장했습니다. 편집을 계속하려면 저장된 버전을 다시 여세요.');
        setConflict(true);
      }
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) setConflict(true);
    } finally {
      current.element.inert = false;
      locked.current = false;
      setBusy(false);
    }
  }

  async function downloadChanges() {
    if (!editor.current || !history) return;
    try {
      const bytes = await exportEditedHwpx(editor.current);
      const url = URL.createObjectURL(new Blob([bytes]));
      const link = document.createElement('a');
      link.href = url;
      link.download = history.name.replace(/\.hwpx?$/i, '') + '-내편집본.hwpx';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError((err as Error).message); }
  }

  useEffect(() => { saveAction.current = () => { void save(); }; });

  return (
    <main className="flex h-dvh min-h-[32rem] flex-col bg-canvas" aria-label="한글 문서 편집">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-white px-4 py-3">
        <a href={returnUrl} className={buttonStyles.text} onClick={async e => {
          e.preventDefault();
          if (locked.current || !(await canLeave())) return;
          if (legacy) window.location.assign(returnUrl);
          else navigate(back);
        }}><ArrowLeft size={16} />{review || legacyRoute.startsWith('review') ? '팀별 검토' : '팀 배정 확인'}</a>
        <div className="min-w-36 flex-1">
          <h1 className="font-bold text-ink">한글 문서 편집</h1>
          {history && <p className="break-all text-sm text-muted">{history.name}</p>}
        </div>
        {history && <label className="flex items-center gap-2 text-sm font-semibold">버전
          <select aria-label="문서 버전" className="rounded-lg border border-line-2 bg-white p-2" value={version} disabled={busy || !ready}
            onChange={e => void switchVersion(Number(e.target.value))}>
            {history.versions.map(v => <option key={v.version} value={v.version}>수정본 v{v.version} · {v.editor} · {new Date(v.saved_at).toLocaleString('ko-KR')}</option>)}
            <option value={0}>접수 원본</option>
          </select>
        </label>}
        {ready && history && <a href={versionUrl(file, version)} download={versionName(history.name, version)} className={buttonStyles.text}>저장본 내려받기</a>}
        <button type="button" className={buttonStyles.primary} disabled={!ready || busy || conflict || version !== latest} onClick={() => void save()}>
          <Save size={16} aria-hidden="true" />새 버전으로 저장
        </button>
      </header>
      {busy && <p className="px-4 py-2 text-sm text-muted" role="status">{ready ? '문서를 처리하는 중…' : '한글 편집기를 여는 중…'}</p>}
      <Feedback error={error} message={message} />
      {ready && !busy && version !== latest && <p className="px-4 py-2 text-sm text-muted">이전 버전입니다. 계속 편집하려면 최신 수정본을 여세요.</p>}
      {conflict && <button className={buttonStyles.text + ' mx-2 self-start'} onClick={() => void downloadChanges()}>내 편집 내용 내려받기</button>}
      {(conflict || (!ready && error)) && <button className={buttonStyles.outline + ' m-2 self-start'} onClick={async () => {
        if (await canLeave()) setAttempt(v => v + 1);
      }}>{conflict ? '최신 수정본 다시 열기' : '다시 시도'}</button>}
      <div ref={mount} className="min-h-0 flex-1" />
    </main>
  );
}
