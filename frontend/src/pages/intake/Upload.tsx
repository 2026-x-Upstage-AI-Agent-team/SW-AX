import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { FileUp } from 'lucide-react';
import { ApiError, bytes } from '../../api/client';
import { isDemoBackend } from '../../api/backend';
import { teamLabel, uploadBatch, type AwardEvent, type AwardTeam } from '../../api/intake';
import { docLabels } from '../../api/labels';
import { getEditHistory, readVersion, versionName } from '../../api/documentVersions';
import type { SubmissionDetail } from '../../api/service';
import { buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';

type Picked = { id: string; file: File; sourceId?: string };

const MAX_FILES = 100;
const MAX_TOTAL = 300 * 1024 ** 2;
const MAX_FILE = 40 * 1024 ** 2;
const PENDING_KEY = 'intake.pending';

function readPending(): { selection: string; key: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  } catch {
    return null;
  }
}
function writePending(value: { selection: string; key: string } | null) {
  try {
    if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* 저장소를 쓸 수 없으면 새 키로 접수한다 */
  }
}

/** base가 있으면 그 제출본의 보완 접수: 팀이 고정되고, 교체할 이전 원본을 고를 수 있다. */
export default function Upload({ event, teams, base }: { event: AwardEvent; teams: AwardTeam[]; base?: SubmissionDetail }) {
  const navigate = useNavigate();
  const { refresh } = useEvent();
  const picker = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState(base?.team ?? (isDemoBackend ? '' : 'bundle'));
  const [removed, setRemoved] = useState<string[]>([]);
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState('');
  const [dragging, setDragging] = useState(false);
  const total = files.reduce((sum, entry) => sum + entry.file.size, 0);
  const replaced = [...new Set([...removed, ...files.flatMap(f => f.sourceId ? [f.sourceId] : [])])];

  async function useSavedEdit(id: string) {
    if (busy || loadingEdit || files.some(f => f.sourceId === id)) return;
    setLoadingEdit(id);
    setFileError('');
    try {
      const history = await getEditHistory(id);
      const latest = history.versions[0];
      if (!latest) throw new Error(history.name + '에 저장된 수정본이 없습니다. 한글 문서 편집에서 먼저 저장해 주세요.');
      const content = await readVersion(id, latest.version);
      if (files.length >= MAX_FILES || total + content.byteLength > MAX_TOTAL) throw new Error('한 번에 100개, 합계 300 MiB까지 선택해 주세요.');
      const file = new File([content], versionName(history.name, latest.version), { lastModified: Date.parse(latest.saved_at) });
      setFiles(current => [...current, { id: crypto.randomUUID(), file, sourceId: id }]);
    } catch (err) {
      setFileError((err as Error).message);
    } finally {
      setLoadingEdit('');
    }
  }

  function add(list: FileList | null) {
    if (busy || !list?.length) return;
    setError('');
    const added = Array.from(list);
    if (files.length + added.length > MAX_FILES || total + added.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
      setFileError('한 번에 100개, 합계 300 MiB까지 선택해 주세요.');
      return;
    }
    for (const file of added) {
      if (!/\.(hwp|hwpx)$/i.test(file.name) || /^00(?:\D|$)/.test(file.name)) {
        setFileError(file.name + ' 파일은 접수할 수 없습니다. 00 지급내역서를 제외한 HWP·HWPX를 선택해 주세요.');
        return;
      }
      if (!file.size || file.size > MAX_FILE) {
        setFileError(file.name + ' 파일이 비었거나 40 MiB를 초과합니다.');
        return;
      }
    }
    setFiles((current) => [...current, ...added.map((file) => ({ id: crypto.randomUUID(), file }))]);
    setFileError('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || loadingEdit || !files.length) return;
    setError('');
    setFileError('');
    setBusy(true);
    setProgress(0);
    try {
      const manifest = files.map(({ file }) => ({ name: file.name, size: file.size }));
      const selection = JSON.stringify([event.id, target, base?.id ?? '', replaced, manifest, files.map((x) => x.file.lastModified)]);
      const stored = readPending();
      const key = stored?.selection === selection ? stored.key : crypto.randomUUID();
      writePending({ selection, key });
      const form = new FormData();
      form.set('event', event.id);
      if (target === 'bundle') form.set('mode', 'bundle');
      else if (target) form.set('target', target);
      if (base) {
        form.set('base', base.id);
        form.set('removed', JSON.stringify(replaced));
      }
      form.set('manifest', JSON.stringify(manifest));
      files.forEach(({ file }) => form.append('files', file));
      const receipt = await uploadBatch(form, key, setProgress);
      writePending(null);
      refresh();
      navigate(`/intake/batches/${receipt.batch_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        writePending(null);
        setError(err.message + ' 접수 내역을 확인해 주세요. 다시 접수하면 새 접수번호가 생성됩니다.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="surface flex flex-col gap-6 p-[clamp(18px,3vw,32px)]">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">{base ? `${base.team_name} 보완본 (v${base.version} → 새 버전)` : '제출 원본'}</h2>
        <span className="text-sm text-muted">HWP · HWPX</span>
      </div>
      <fieldset disabled={busy || !!loadingEdit} className="flex min-w-0 flex-col gap-2">
        {base ? (
          <fieldset className="flex flex-col gap-2 rounded-2xl bg-canvas p-4">
            <legend className="sr-only">교체할 이전 원본</legend>
            <p className="text-sm font-bold">이전 버전 원본 중 교체·제외할 파일</p>
            <p className="text-[13px] text-muted">선택하지 않은 파일은 새 버전에 그대로 남습니다. 빠진 서류는 아래에 추가만 하면 됩니다.</p>
            {base.files.map((f) => (
              <div key={f.id} className="flex min-h-10 flex-wrap items-center gap-2.5 text-sm">
                <label className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={replaced.includes(f.id)}
                    disabled={files.some(item => item.sourceId === f.id)}
                    onChange={(e) => setRemoved((list) => (e.target.checked ? [...list, f.id] : list.filter((x) => x !== f.id)))}
                    className="size-4 accent-brand"
                  />
                  <span className="file-name">{f.name}</span>
                  <span className="text-xs text-muted">{docLabels[f.kind] ?? f.kind}</span>
                </label>
                <button type="button" className={buttonStyles.text} disabled={files.some(item => item.sourceId === f.id)} onClick={() => void useSavedEdit(f.id)}>
                  {loadingEdit === f.id ? '불러오는 중…' : '저장한 수정본 사용'}
                </button>
              </div>
            ))}
          </fieldset>
        ) : (
          <>
            <label htmlFor="target" className="text-sm font-bold">
              접수 출처
            </label>
            <select id="target" value={target} onChange={(e) => setTarget(e.target.value)} className="h-11 max-w-[370px] rounded-xl border border-line-2 bg-white px-3">
              {!isDemoBackend && <option value="bundle">새 팀 묶음 접수 · 팀명 입력 없이</option>}
              <option value="">팀 미지정 · 혼합 접수</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamLabel(t)}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted">{target === 'bundle'
              ? '한 팀에서 받은 서류만 함께 올리세요. 접수 순서대로 팀번호를 부여하고, 판정 후 신청서의 팀명을 표시합니다. 신청서가 없어도 받은 서류로 판정합니다.'
              : target ? '선택한 기존 팀에 접수합니다.' : '여러 팀의 서류를 함께 받았을 때 사용합니다. 팀을 구분할 근거가 부족하면 담당자가 배정합니다.'}</p>
          </>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          accept=".hwp,.hwpx"
          aria-label="제출 원본 파일 선택"
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label="제출 원본 파일 선택"
          aria-describedby={fileError ? 'upload-limits upload-file-error' : 'upload-limits'}
          onClick={() => picker.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
          className={cx(
            'mt-4 grid w-full place-items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-brand-deep sm:py-11',
            dragging ? 'border-brand-strong bg-brand-tint ring-2 ring-brand-strong' : 'border-brand/65 bg-canvas hover:border-brand-strong hover:bg-brand-tint',
          )}
        >
          <span aria-hidden="true" className="mb-1 grid size-12 place-items-center rounded-2xl bg-brand-tint">
            <FileUp size={25} strokeWidth={1.7} />
          </span>
          <strong className="text-base text-ink">{dragging ? '여기에 놓아 파일 추가' : '파일을 끌어오거나 선택하세요'}</strong>
          <span id="upload-limits" className="text-[13px] text-muted">00 지급내역서 제외 · 최대 100개 · 파일당 40 MiB · 합계 300 MiB</span>
        </button>
        {fileError && <p id="upload-file-error" role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-sm text-alert-strong">{fileError}</p>}
        {files.length > 0 && (
          <ol className="mt-2">
            {files.map(({ id, file }) => (
              <li key={id} className="flex flex-wrap items-center gap-2.5 border-b border-line-soft py-3 text-sm">
                <span className="file-name flex-[1_1_160px]">{file.name}</span>
                <small className="whitespace-nowrap text-muted">{bytes(file.size)}</small>
                <button
                  type="button"
                  aria-label={file.name + ' 선택 취소'}
                  className={buttonStyles.text}
                  onClick={() => {
                    setFiles((list) => list.filter((item) => item.id !== id));
                    setError('');
                    setFileError('');
                  }}
                >
                  제거
                </button>
              </li>
            ))}
          </ol>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-sm text-alert-strong">
          {error}
        </p>
      )}
      {busy && (
        <div className="flex flex-wrap items-center gap-2.5 text-sm">
          <span role="status">{progress === 100 ? '서버에서 원본 저장 확인 중' : '원본 전송 중'}</span>
          <progress aria-label={progress === 100 ? '원본 저장 확인' : '원본 전송률'} max={100} value={progress === 100 ? undefined : progress} className="max-w-1/2 accent-brand" />
          {progress < 100 && <span aria-hidden="true" className="tabular-nums">{progress}%</span>}
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
        <span>
          선택 <b>{files.length}</b>개 · {bytes(total)}
        </span>
        <button className={buttonStyles.primary} disabled={busy || !!loadingEdit || !files.length}>
          {busy ? '접수 중…' : base ? '보완본 접수하기' : '원본 접수하기'}
        </button>
      </footer>
    </form>
  );
}
