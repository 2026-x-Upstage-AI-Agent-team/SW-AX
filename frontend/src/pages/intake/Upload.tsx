import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '../../components/workspaceNavigation';
import { ArrowRight, Check, FileUp, LoaderCircle, X } from 'lucide-react';
import { ApiError, bytes } from '../../api/client';
import { isDemoBackend } from '../../api/backend';
import { teamLabel, uploadBatch, type AwardEvent, type AwardTeam } from '../../api/intake';
import { docLabels, when } from '../../api/labels';
import { getEditHistory, readVersion, versionName } from '../../api/documentVersions';
import type { SubmissionDetail } from '../../api/service';
import { StateBadge, buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';

type Picked = { id: string; file: File; sourceId?: string };

const MAX_FILES = 100;
const MAX_TOTAL = 300 * 1024 ** 2;
const MAX_FILE = 40 * 1024 ** 2;
const PENDING_KEY = 'intake.pending';

const receiptSteps = [
  ['원본 저장', '파일을 저장하고 첨부번호를 발급합니다.'],
  ['판독 · 제출본 확정', '원본을 판독해 검토용 PDF와 팀 제출본을 준비합니다.'],
  ['Studio 판정', '성공, 담당자 확인, 재제출 요청 중 하나로 판정합니다.'],
  ['담당자 검토 · 메일', '원문과 근거를 확인하고 팀장 안내를 검토합니다.'],
  ['지급내역 · 보고서', '확정한 팀의 서류를 HWPX와 PDF로 정리합니다.'],
];

export function UploadOverview() {
  const { dashboard, dashboardError } = useEvent();
  const recent = dashboard?.batches.slice().sort((a, b) => b.created - a.created).slice(0, 4) ?? [];

  return (
    <aside aria-label="파일 첨부 안내" className="grid min-w-0 gap-5">
      <section className="rounded-[20px] bg-ink p-[clamp(18px,2.5vw,24px)] text-white">
        <h2 className="text-lg font-semibold">첨부 뒤 진행 순서</h2>
        <ol className="mt-4 grid gap-3.5">
          {receiptSteps.map(([title, description], index) => (
            <li key={title} className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className={cx('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold', index === 0 ? 'bg-brand-accent text-[#022c22]' : 'bg-[#1e293b] text-line')}>
                {index + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="mt-0.5 text-[13px] leading-relaxed text-[#cbd5e1]">{description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="surface min-w-0 rounded-[20px] p-[clamp(18px,2.5vw,24px)]">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <h2 className="text-lg font-semibold">최근 첨부</h2>
          <Link to="/intake/batches" className={buttonStyles.text}>
            첨부 내역 전체<ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
        {recent.length ? (
          <ul className="mt-1.5">
            {recent.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line-soft py-3">
                <div className="min-w-0">
                  <Link to={`/intake/batches/${encodeURIComponent(batch.id)}`} className="font-semibold text-ink hover:text-brand-strong hover:underline">
                    첨부 {batch.id.slice(0, 8)}
                  </Link>
                  <p className="mt-0.5 text-[13px] text-muted">원본 {batch.count}개 · {when(batch.created)}</p>
                </div>
                <StateBadge state={batch.state} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {dashboardError ? '최근 첨부 내역을 불러오지 못했습니다.' : dashboard ? '아직 첨부한 문서가 없습니다.' : '최근 첨부 내역을 불러오는 중입니다.'}
          </p>
        )}
      </section>
    </aside>
  );
}

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
    /* 저장소를 쓸 수 없으면 새 키로 첨부한다 */
  }
}

/** base가 있으면 그 제출본의 보완 서류 첨부: 팀이 고정되고, 교체할 이전 원본을 고를 수 있다. */
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
        setFileError(file.name + ' 파일은 첨부할 수 없습니다. 00 지급내역서를 제외한 HWP·HWPX를 선택해 주세요.');
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

  // 화면 어디에 놓아도 파일을 받는다. 파일이 아닌 끌기(텍스트 등)는 건드리지 않는다.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addRef.current(e.dataTransfer?.files ?? null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

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
        setError(err.message + ' 첨부 내역을 확인해 주세요. 다시 첨부하면 새 첨부번호가 생성됩니다.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} data-tour="upload-form" data-tour-pending={files.length > 0} data-tour-busy={busy || !!loadingEdit} className="surface flex min-w-0 flex-col gap-5 rounded-[20px] p-[clamp(18px,2.5vw,24px)]">
      {dragging && (
        <div aria-hidden="true" className="drop-overlay">
          <span><FileUp size={28} strokeWidth={1.7} />여기에 놓아 파일 추가</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{base ? `${base.team_name} 보완본 (v${base.version} → 새 버전)` : '첨부할 서류'}</h2>
        <span className="text-xs font-medium text-muted">HWP · HWPX</span>
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
              첨부할 팀
            </label>
            <select id="target" value={target} onChange={(e) => setTarget(e.target.value)} className="h-11 w-full min-w-0 rounded-full border border-line-2 bg-white px-4 text-sm text-ink">
              {!isDemoBackend && <option value="bundle">새 팀 서류 첨부 · 팀명 입력 없이</option>}
              <option value="">팀 미지정 · 여러 팀 서류 첨부</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamLabel(t)}
                </option>
              ))}
            </select>
            <p className="text-[13px] leading-relaxed text-muted">{target === 'bundle'
              ? '한 팀에서 받은 서류만 함께 올리세요. 첨부 순서대로 팀번호를 부여하고, 판정 후 신청서의 팀명을 표시합니다. 신청서가 없어도 받은 서류로 판정합니다.'
              : target ? '선택한 기존 팀에 첨부합니다.' : '여러 팀의 서류를 함께 받았을 때 사용합니다. 팀을 구분할 근거가 부족하면 담당자가 배정합니다.'}</p>
          </>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          accept=".hwp,.hwpx"
          aria-label="첨부할 서류 파일 선택"
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label="첨부할 서류 파일 선택"
          data-tour="file-picker"
          aria-describedby={fileError ? 'upload-limits upload-file-error' : 'upload-limits'}
          onClick={() => picker.current?.click()}
          className={cx(
            'mt-3 grid w-full place-items-center gap-2 rounded-[20px] border-2 border-dashed px-4 py-7 text-center sm:px-6 sm:py-9',
            dragging ? 'border-brand-strong bg-brand-tint ring-2 ring-brand-strong' : 'border-brand-bright bg-brand-tint hover:border-brand-strong',
          )}
        >
          <span aria-hidden="true" className="mb-1 grid size-14 place-items-center rounded-full bg-brand-strong text-white">
            <FileUp size={24} strokeWidth={2} />
          </span>
          <strong className="text-base font-semibold text-ink sm:text-lg">화면 어디에나 파일을 끌어다 놓거나 선택하세요</strong>
          <span id="upload-limits" className="text-[13px] leading-relaxed text-muted">00 지급내역서 제외 · 최대 100개 · 파일당 40 MiB · 합계 300 MiB</span>
          <span aria-hidden="true" className="mt-1.5 inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-semibold text-white">파일 선택</span>
        </button>
        {fileError && <p id="upload-file-error" role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-sm text-alert-strong">{fileError}</p>}
        {files.length > 0 && (
          <div className="mt-4 grid gap-2.5">
            <h3 className="font-semibold">선택한 원본 {files.length}개</h3>
            <ol className="grid gap-2.5">
              {files.map(({ id, file }, index) => (
                <li key={id} className="flex min-w-0 items-center gap-2.5 rounded-2xl border border-line py-1.5 pr-1.5 pl-3 text-sm">
                  <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-white">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <span className="file-name block font-semibold">{file.name}</span>
                    <small className="text-xs text-muted">{bytes(file.size)}</small>
                  </div>
                  <button
                    type="button"
                    aria-label={file.name + ' 선택 취소'}
                    className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink"
                    onClick={() => {
                      setFiles((list) => list.filter((item) => item.id !== id));
                      setError('');
                      setFileError('');
                    }}
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-sm text-alert-strong">
          {error}
        </p>
      )}
      {busy && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-canvas px-4 py-3 text-sm">
          <span role="status">{progress === 100 ? '서버에서 원본 저장 확인 중' : '원본 전송 중'}</span>
          <progress aria-label={progress === 100 ? '원본 저장 확인' : '원본 전송률'} max={100} value={progress === 100 ? undefined : progress} className="max-w-1/2 accent-brand" />
          {progress < 100 && <span aria-hidden="true" className="tabular-nums">{progress}%</span>}
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-sm">
        <span className="text-muted">
          선택 <b className="text-ink">{files.length}</b>개 · {bytes(total)}
        </span>
        <button className={cx(buttonStyles.primary, 'min-h-[52px] rounded-full px-5')} data-tour="upload-submit" disabled={busy || !!loadingEdit || !files.length}>
          {busy ? <LoaderCircle size={17} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
          {busy ? '첨부 중…' : base ? '보완 서류 첨부하기' : '파일 첨부하기'}
        </button>
      </footer>
    </form>
  );
}
