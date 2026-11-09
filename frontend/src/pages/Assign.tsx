import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { isDemoBackend } from '../api/backend';
import { useAsync } from '../api/client';
import { paths } from '../api/intake';
import { docLabels, when } from '../api/labels';
import { assignFile, filePreviewUrl, getBatch, retryFile, type BatchDetail, type Dashboard, type FileInfo } from '../api/service';
import { Page } from '../components/Layout';
import { Feedback, Notice, PageHeader, PdfFrame, StateBadge, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

type Item = { batch: BatchDetail; file: FileInfo };
type Action = 'assign' | 'outside' | 'hold';

const needs = (f: FileInfo) => f.state === 'unassigned' || f.state === 'error';

export default function Assign() {
  const { dashboard, dashboardError, events, eventsError, refresh } = useEvent();
  return (
    <Page tone="gray">
      <PageHeader title="팀 배정 확인" lead="자동 배정되지 않은 원본을 확인하고 배정할 팀과 근거를 기록하세요." />
      {dashboard ? <AssignmentQueue key={dashboard.event} dashboard={dashboard} /> : !eventsError && events?.length === 0 ? (
        <p className="surface p-6">등록된 대회가 없습니다. <Link to="/manage" className={buttonStyles.text}>대회·팀 관리</Link></p>
      ) : <Notice error={dashboardError || eventsError} onRetry={refresh} />}
    </Page>
  );
}

function AssignmentQueue({ dashboard }: { dashboard: Dashboard }) {
  const { refresh } = useEvent();
  const [query, setQuery] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selected = query.get('file');
  const previousFile = useRef<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [notice, setNotice] = useState('');
  const saved = (message: string) => {
    setNotice(message);
    refresh();
  };

  // 배정이 끝나지 않은 접수와 최근 접수 3건의 파일을 읽는다.
  const { data: batches, error, reload } = useAsync(() => {
    const open = dashboard.batches.filter((b) => b.pending > 0 || b.state !== 'assigned').map((b) => b.id);
    const recent = dashboard.batches.slice(0, 3).map((b) => b.id);
    return Promise.all([...new Set([...open, ...recent])].map(getBatch));
  }, [dashboard.batches]);

  const items: Item[] = (batches ?? []).flatMap((batch) => batch.files.map((file) => ({ batch, file })));
  const pending = items.filter((i) => needs(i.file));
  const others = items.filter((i) => !needs(i.file));
  const picked = items.find((i) => i.file.id === selected);
  const current = selected ? picked : pending[0];
  const pickedId = picked?.file.id ?? null;
  const teamName = (id?: string | null) => dashboard.teams.find((t) => t.id === id)?.name ?? (id ? '알 수 없는 팀' : '');
  const preparing = dashboard.batches.some((b) => b.state === 'preparing');

  function openFile(id: string) {
    const next = new URLSearchParams(query);
    next.set('file', id);
    setQuery(next, { replace: !!selected, state: { fromQueue: !selected || location.state?.fromQueue === true } });
  }

  function backToQueue() {
    if (picked && !needs(picked.file)) setShowDone(true);
    if (location.state?.fromQueue) navigate(-1);
    else {
      const next = new URLSearchParams(query);
      next.delete('file');
      setQuery(next, { replace: true });
    }
  }

  useEffect(() => {
    if (!batches || error) return;
    const last = previousFile.current;
    previousFile.current = pickedId;
    if (pickedId === last) return;
    const back = document.getElementById('assignment-back');
    if (pickedId && back?.getClientRects().length) {
      document.getElementById('detail-h')?.focus({ preventScroll: true });
      back.scrollIntoView({ block: 'start' });
    } else if (!pickedId && last) {
      (document.getElementById('assignment-file-' + last) ?? document.getElementById('queue-h'))?.focus();
    }
  }, [pickedId, batches, error]);

  if (error || !batches || (dashboard.batches.length > 0 && batches.length === 0)) return <Notice error={error} onRetry={reload} />;

  return (
    <>
      <dl aria-label="배정 요약" className="surface grid grid-cols-3 divide-x divide-line py-3">
        <Stat label="확인 필요" value={pending.length} warn={pending.length > 0} />
        <Stat label="최근 접수 파일" value={items.length} />
        <Stat label="접수 묶음" value={dashboard.batches.length} />
      </dl>
      {preparing && <p className="text-sm text-muted">파일 판독 중인 접수가 있어 자동으로 새로고침합니다.</p>}
      <Feedback message={notice} />
      {selected && !picked && <Feedback error="선택한 파일이 현재 대회의 최근 접수 목록에 없습니다. 목록에서 파일을 다시 선택하세요." />}

      {items.length === 0 ? (
        <p className="rounded-[22px] bg-white px-6 py-10 text-center text-sm text-muted">
          접수된 원본이 없습니다.{' '}
          <Link to="/intake" className="font-bold text-brand-strong underline underline-offset-2">
            원본 접수
          </Link>
        </p>
      ) : (
        <div className="assignment-workspace" data-detail-open={!!picked}>
          <section aria-labelledby="queue-h" className="assignment-queue surface overflow-hidden">
            <h2 id="queue-h" tabIndex={-1} className="px-[22px] pb-2.5 pt-[18px] text-base font-extrabold">
              확인할 파일 {pending.length}
            </h2>
            <ul>
              {pending.length === 0 && <li className="border-t border-line-soft px-[22px] py-4 text-sm text-brand-strong">모든 파일의 팀 배정이 끝났습니다.</li>}
              {pending.map((i) => (
                <FileRow key={i.file.id} item={i} active={current?.file.id === i.file.id} onClick={() => openFile(i.file.id)} teamName={teamName} />
              ))}
            </ul>
            {others.length > 0 && (
              <>
                <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className="w-full border-t border-line px-[22px] py-3 text-left text-sm font-bold text-ink-2">
                  배정·처리된 파일 {others.length} {showDone ? '접기' : '보기'}
                </button>
                {showDone && (
                  <ul>
                    {others.map((i) => (
                      <FileRow key={i.file.id} item={i} active={current?.file.id === i.file.id} onClick={() => openFile(i.file.id)} teamName={teamName} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {current && <Detail key={current.file.id + current.batch.revision} item={current} teamName={teamName} onBack={backToQueue} onSaved={saved} />}
        </div>
      )}
    </>
  );
}

function FileRow({ item, active, onClick, teamName }: { item: Item; active: boolean; onClick: () => void; teamName: (id?: string | null) => string }) {
  const f = item.file;
  return (
    <li className="border-t border-line-soft">
      <button
        id={'assignment-file-' + f.id}
        type="button"
        aria-current={active}
        onClick={onClick}
        className={cx('grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-l-[3px] px-4 py-3.5 text-left focus-visible:-outline-offset-3', active ? 'border-brand bg-brand-tint' : 'border-transparent hover:bg-canvas')}
      >
        <span className="file-name text-ink">{f.name}</span>
        <ChevronRight size={17} aria-hidden="true" className="row-span-2 text-muted" />
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink-2">
          <StateBadge state={f.state} />
          {f.kind !== '?' && <span>{docLabels[f.kind] ?? f.kind}</span>}
          {f.team && <span>· {teamName(f.team)}</span>}
          {needs(f) && f.candidates.length > 0 && <span>· 후보 {f.candidates.map(teamName).join(', ')}</span>}
        </span>
      </button>
    </li>
  );
}

function Detail({ item, teamName, onBack, onSaved }: { item: Item; teamName: (id?: string | null) => string; onBack: () => void; onSaved: (message: string) => void }) {
  const { dashboard } = useEvent();
  const { batch, file } = item;
  const teams = dashboard?.teams ?? [];
  const [action, setAction] = useState<Action>('assign');
  const [team, setTeam] = useState(file.team ?? file.candidates[0] ?? '');
  const [exclude, setExclude] = useState<string[]>(file.excluded);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [teamTouched, setTeamTouched] = useState(false);
  const [reasonTouched, setReasonTouched] = useState(false);
  const editable = batch.state !== 'preparing';
  const missingTeam = action === 'assign' && !team;
  const shortReason = reason.trim().length < 2;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editable || busy) return;
    if (missingTeam || shortReason) {
      setTeamTouched(true);
      setReasonTouched(true);
      const input = e.currentTarget.elements.namedItem(missingTeam ? 'team' : 'reason');
      if (input instanceof HTMLElement) input.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await assignFile(batch.id, file.id, { action, team: action === 'assign' ? team : '', reason: reason.trim(), revision: batch.revision, exclude: action === 'hold' ? exclude : [] });
      onSaved(
        action === 'assign'
          ? `${file.name} → ${teamName(team)} 배정을 기록했습니다. 팀 파일 목록이 확정되면 판정을 시작합니다.`
          : action === 'outside'
            ? `${file.name}을(를) 대상 외로 처리했습니다.`
            : `${file.name}을(를) 보류했습니다. 제외한 팀은 먼저 진행합니다.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError('');
    try {
      await retryFile(batch.id, file.id);
      onSaved(`${file.name} 판독을 다시 시작했습니다.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="detail-h" className="assignment-detail surface">
      <button type="button" onClick={onBack} id="assignment-back" className="assignment-back">
        <ChevronLeft size={18} aria-hidden="true" /> 파일 목록으로
      </button>
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <h2 id="detail-h" tabIndex={-1} className="file-name text-lg font-bold">
            {file.name}
          </h2>
          <span className="rounded-full bg-canvas px-2.5 py-1 text-sm font-semibold text-ink-2">본문 분류 · {docLabels[file.kind] ?? file.kind}</span>
          <StateBadge state={file.state} />
        </div>
        <p className="text-sm font-medium text-muted">
          접수 {when(batch.created)} · {file.pages ? `${file.pages}쪽` : '판독 전'}
          {batch.base && ' · 보완 접수'}
        </p>
        {file.reason && <p className="text-[15px] leading-relaxed text-ink-2">{file.reason}</p>}
        {file.team && <p className="text-sm">현재 배정: <strong>{teamName(file.team)}</strong></p>}
        {file.candidates.length > 0 && (
          <p className="text-sm text-ink-2">
            후보 팀: {file.candidates.map(teamName).join(', ')}
            {file.excluded.length > 0 && <span className="text-muted"> · 제외 {file.excluded.map(teamName).join(', ')}</span>}
          </p>
        )}

        <PdfFrame url={filePreviewUrl(file, file.page)} title={file.name} height={480}
          emptyMessage={file.state === 'error' ? '판독에 실패해 미리보기를 열 수 없습니다.' : batch.state === 'preparing' ? '원본을 판독하고 있습니다.' : undefined}>
          {!isDemoBackend && <a href={paths.original(batch.id, file.id)} download className={buttonStyles.outline}>
            <Download size={16} aria-hidden="true" /> 원본 받기
          </a>}
        </PdfFrame>

        {file.state === 'error' ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-2">손상된 파일이면 팀에서 다시 받아 접수해 주세요. 일시 오류라면 판독을 다시 시도할 수 있습니다.</span>
            <button type="button" onClick={retry} disabled={busy} className={buttonStyles.outline}>
              {busy ? '다시 요청 중…' : '판독 다시 시도'}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="border-t border-line pt-4">
            <fieldset disabled={!editable || busy} className="flex min-w-0 flex-col gap-4">
              <legend className="mb-3 font-bold">배정 결정</legend>
              <div role="radiogroup" aria-label="배정 결정" className="flex flex-wrap gap-2">
                {(
                  [
                    ['assign', '팀에 배정'],
                    ['hold', '보류 (후보 제외)'],
                    ['outside', '대상 외'],
                  ] as Array<[Action, string]>
                ).map(([key, label]) => (
                  <label key={key} className={cx('assignment-choice', action === key && 'is-selected')}>
                    <input type="radio" name="action" value={key} checked={action === key} onChange={() => setAction(key)} className="size-4 shrink-0 accent-brand-strong" />
                    {label}
                  </label>
                ))}
              </div>
              {action === 'assign' && (
                <div className="flex max-w-sm flex-col gap-1.5 text-sm">
                  <label htmlFor="assignment-team" className="font-semibold text-ink-2">배정할 팀</label>
                  <select id="assignment-team" name="team" required value={team} onChange={(e) => setTeam(e.target.value)}
                    onBlur={() => setTeamTouched(true)} aria-invalid={teamTouched && missingTeam}
                    aria-describedby={teamTouched && missingTeam ? 'team-error' : undefined} className={cx(inputStyle, 'aria-invalid:border-alert-strong')}>
                    <option value="">팀 선택</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.rep ? ` · ${t.rep}` : ''}
                        {file.candidates.includes(t.id) ? ' (후보)' : ''}
                      </option>
                    ))}
                  </select>
                  {teamTouched && missingTeam && <p id="team-error" role="alert" className="text-alert-strong">배정할 팀을 선택하세요.</p>}
                </div>
              )}
              {action === 'hold' && (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-sm font-semibold text-ink-2">관련이 없다고 확인한 팀 (이 팀들은 먼저 진행합니다)</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {teams.map((t) => (
                      <label key={t.id} className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={exclude.includes(t.id)}
                          onChange={(e) => setExclude((list) => (e.target.checked ? [...list, t.id] : list.filter((x) => x !== t.id)))}
                          className="size-4 accent-brand"
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="flex flex-col gap-1.5 text-sm">
                <label htmlFor="assignment-reason" className="font-semibold text-ink-2">근거 (원래 접수 경로 등, 2자 이상)</label>
                <textarea id="assignment-reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
                  onBlur={() => setReasonTouched(true)} required minLength={2} maxLength={500} rows={2}
                  aria-invalid={reasonTouched && shortReason} aria-describedby={reasonTouched && shortReason ? 'reason-error' : undefined}
                  className={cx(inputStyle, 'h-auto py-2.5 aria-invalid:border-alert-strong')} />
                {reasonTouched && shortReason && <p id="reason-error" role="alert" className="text-alert-strong">처리 근거를 2자 이상 입력하세요.</p>}
              </div>
              <div>
                <button type="submit" className={buttonStyles.primary}>
                  {busy ? '저장 중…' : action === 'assign' ? `${team ? teamName(team) : '팀'}에 배정` : action === 'hold' ? '보류 저장' : '대상 외 처리'}
                </button>
              </div>
            </fieldset>
          </form>
        )}
        {batch.state === 'preparing' && <p className="text-sm font-medium text-muted">파일 판독이 끝나면 배정할 수 있습니다.</p>}
        <Feedback error={error} />
      </div>
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex flex-col justify-between gap-1 px-2.5 sm:px-5">
      <dt className={cx('text-sm font-semibold', warn ? 'text-caution' : 'text-ink-2')}>{label}</dt>
      <dd className={cx('text-2xl font-bold tabular-nums', warn && 'text-caution')}>{value}</dd>
    </div>
  );
}
