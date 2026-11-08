import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { FileUp } from 'lucide-react';
import { ApiError, bytes } from '../../api/client';
import { teamLabel, uploadBatch, type AwardEvent, type AwardTeam } from '../../api/intake';
import { docLabels } from '../../api/labels';
import type { SubmissionDetail } from '../../api/service';
import { buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';

type Picked = { id: string; file: File };

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
  const [target, setTarget] = useState(base?.team ?? '');
  const [removed, setRemoved] = useState<string[]>([]);
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const total = files.reduce((sum, entry) => sum + entry.file.size, 0);

  function add(list: FileList | null) {
    if (busy || !list?.length) return;
    const added = Array.from(list);
    if (files.length + added.length > MAX_FILES || total + added.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) {
      setError('한 번에 100개, 합계 300 MiB까지 선택해 주세요.');
      return;
    }
    for (const file of added) {
      if (!/\.(hwp|hwpx)$/i.test(file.name) || /^00(?:\D|$)/.test(file.name)) {
        setError(file.name + ' 파일은 접수할 수 없습니다. 00 지급내역서를 제외한 HWP·HWPX를 선택해 주세요.');
        return;
      }
      if (!file.size || file.size > MAX_FILE) {
        setError(file.name + ' 파일이 비었거나 40 MiB를 초과합니다.');
        return;
      }
    }
    setFiles((current) => [...current, ...added.map((file) => ({ id: crypto.randomUUID(), file }))]);
    setError('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !files.length) return;
    setError('');
    setBusy(true);
    setProgress(0);
    try {
      const manifest = files.map(({ file }) => ({ name: file.name, size: file.size }));
      const selection = JSON.stringify([event.id, target, base?.id ?? '', removed, manifest, files.map((x) => x.file.lastModified)]);
      const stored = readPending();
      const key = stored?.selection === selection ? stored.key : crypto.randomUUID();
      writePending({ selection, key });
      const form = new FormData();
      form.set('event', event.id);
      if (target) form.set('target', target);
      if (base) {
        form.set('base', base.id);
        form.set('removed', JSON.stringify(removed));
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
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
        {base ? (
          <fieldset className="flex flex-col gap-2 rounded-2xl bg-canvas p-4">
            <legend className="sr-only">교체할 이전 원본</legend>
            <p className="text-sm font-bold">이전 버전 원본 중 교체·제외할 파일</p>
            <p className="text-[13px] text-muted">선택하지 않은 파일은 새 버전에 그대로 남습니다. 빠진 서류는 아래에 추가만 하면 됩니다.</p>
            {base.files.map((f) => (
              <label key={f.id} className="flex min-h-10 items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={removed.includes(f.id)}
                  onChange={(e) => setRemoved((list) => (e.target.checked ? [...list, f.id] : list.filter((x) => x !== f.id)))}
                  className="size-4 accent-brand"
                />
                <span className="break-all">{f.name}</span>
                <span className="text-xs text-muted">{docLabels[f.kind] ?? f.kind}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <>
            <label htmlFor="target" className="text-sm font-bold">
              접수 출처
            </label>
            <select id="target" value={target} onChange={(e) => setTarget(e.target.value)} className="h-11 max-w-[370px] rounded-xl border border-line-2 bg-white px-3">
              <option value="">팀 미지정 · 혼합 접수</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamLabel(t)}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted">한 팀에서 받은 묶음이면 그 팀을 지정할 수 있습니다.</p>
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
          <span className="text-[13px] text-muted">00 지급내역서 제외 · 파일당 40 MiB · 합계 300 MiB</span>
        </button>
        {files.length > 0 && (
          <ol className="mt-2">
            {files.map(({ id, file }) => (
              <li key={id} className="flex flex-wrap items-center gap-2.5 border-b border-line-soft py-3 text-sm">
                <span className="flex-[1_1_160px] break-all">{file.name}</span>
                <small className="whitespace-nowrap text-muted">{bytes(file.size)}</small>
                <button
                  type="button"
                  aria-label={file.name + ' 선택 취소'}
                  className={buttonStyles.text}
                  onClick={() => {
                    setFiles((list) => list.filter((item) => item.id !== id));
                    setError('');
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
        <div role="status" className="flex items-center gap-2.5 text-sm">
          <progress max={100} value={progress} className="max-w-1/2 accent-brand" />
          {progress === 100 ? '원본 저장 확인 중' : '원본 전송 중 ' + progress + '%'}
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
        <span>
          선택 <b>{files.length}</b>개 · {bytes(total)}
        </span>
        <button className={buttonStyles.primary} disabled={busy || !files.length}>
          {base ? '보완본 접수하기' : '원본 접수하기'}
        </button>
      </footer>
    </form>
  );
}
