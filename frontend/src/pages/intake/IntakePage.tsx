import { useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { Link, useNavigate } from '../../components/workspaceNavigation';
import { workflowLabels } from '../../components/workspaceMenu';
import { backend } from '../../api/backend';
import { api, bytes, formatDate, useApi, useAsync, usePolling } from '../../api/client';
import { paths, teamLabel, type BatchDetails, type BatchSummary } from '../../api/intake';
import { busyStates, docLabels, recoverableStates, when } from '../../api/labels';
import { filePreviewUrl, getBatch, getSubmission, isFileProcessed, reviewBatchConflict } from '../../api/service';
import IntakeLayout from '../../components/IntakeLayout';
import DeleteIntake from '../../components/DeleteIntake';
import WorkflowProgress from '../../components/WorkflowProgress';
import { Feedback, Notice, StateBadge, buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';
import Upload, { UploadOverview } from './Upload';

const card = 'flex flex-col gap-4 rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]';

type BatchJob = { state: string; submissionId: string | null };
type UploadReceipt = { batchId: string; count: number };

function useUploadReceipt(batchId: string) {
  const receipt = useLocation().state?.uploaded as UploadReceipt | undefined;
  return receipt?.batchId === batchId ? receipt : undefined;
}

function ViewBatchProgress({ batchId }: { batchId: string }) {
  return <Link to={'/intake/batches/' + encodeURIComponent(batchId)} replace
    data-tour="upload-receipt" className={buttonStyles.primary}>{workflowLabels.progressAction}</Link>;
}

function BatchLoading({ receipt, error, onRetry }: { receipt?: UploadReceipt; error?: string; onRetry: () => void }) {
  if (!receipt || error) return <Notice error={error} onRetry={onRetry} />;
  return <WorkflowProgress title={`서류 ${receipt.count}개를 올렸어요.`}
    description="올린 서류의 검토 상태를 불러오는 중이에요."
    tone="working" action={<ViewBatchProgress batchId={receipt.batchId} />} />;
}

function BatchReviewStatus({ preparing, needsAssignment, jobs, receipt }: {
  preparing: boolean;
  needsAssignment: boolean;
  jobs: BatchJob[];
  receipt?: UploadReceipt;
}) {
  const updates = '진행 상태는 자동으로 갱신돼요. 다른 팀 서류를 계속 올릴 수 있어요.';
  const progressAction = receipt && <ViewBatchProgress batchId={receipt.batchId} />;
  const workingTitle = preparing ? '첨부한 파일을 판독 중이에요'
    : jobs.some(job => busyStates.has(job.state) && job.state !== 'queued') ? 'AI가 서류를 검토 중이에요'
    : jobs.some(job => job.state === 'queued') ? '자동 검토를 기다리고 있어요' : '';
  if (workingTitle) return <WorkflowProgress
    title={workingTitle}
    description={receipt ? `서류 ${receipt.count}개를 올렸어요. ${updates}` : updates}
    tone="working"
    action={progressAction}
  />;

  const stopped = jobs.find(job => recoverableStates.has(job.state) || job.state === 'ownership');
  if (stopped) return <WorkflowProgress
    title="검토 상태를 확인해 주세요"
    description="팀별 결과 확인에서 사유와 이어서 할 일을 확인할 수 있어요."
    tone="attention"
    action={<Link to={stopped.submissionId ? '/teams/' + stopped.submissionId : '/review?filter=all'} className={buttonStyles.secondary}>검토 상태 보기</Link>}
  />;
  if (needsAssignment) return <WorkflowProgress
    title="팀 배정 확인이 필요해요"
    description="파일이 어느 팀의 서류인지 확인한 뒤 검토를 이어갈 수 있어요."
    tone="attention"
    action={<Link to="/assign" className={buttonStyles.secondary}>팀 배정 확인하기</Link>}
  />;

  const completed = jobs.filter(job => job.state === 'done');
  if (completed.length === 0) return receipt ? <WorkflowProgress
    title={`서류 ${receipt.count}개를 올렸어요.`}
    description="검토 진행에서 올린 서류와 현재 상태를 확인할 수 있어요."
    tone="complete"
    action={progressAction}
  /> : null;
  const single = completed.length === 1 ? completed[0].submissionId : null;
  const filter = new URLSearchParams({ filter: 'all' });
  completed.forEach(job => { if (job.submissionId) filter.append('submission', job.submissionId); });
  return <WorkflowProgress
    title="AI 검토가 완료됐어요"
    description={`${completed.length}팀의 검토 결과를 확인할 수 있어요.`}
    tone="complete"
    action={<Link to={single ? '/teams/' + encodeURIComponent(single) : '/review?' + filter}
      data-tour={receipt ? 'upload-receipt' : undefined} className={buttonStyles.primary}>{workflowLabels.review}</Link>}
  />;
}

/** /intake (서류 올리기), /intake/batches (검토 진행), /intake/batches/:id (검토 진행 상세) */
export default function IntakePage({ view }: { view: 'upload' | 'history' | 'detail' }) {
  const { event, events, eventsError, teams, teamsError, refresh } = useEvent();
  const [search] = useSearchParams();
  const baseId = search.get('base');

  return (
    <IntakeLayout view={view === 'upload' ? baseId ? 'replacement' : 'upload' : 'progress'}>
      {!events ? (
        <Notice error={eventsError && `${eventsError} (API 서버가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />
      ) : !event ? (
        <p className="rounded-2xl bg-white px-5 py-4 text-sm">
          등록된 대회가 없습니다.{' '}
          <Link to="/manage" className="font-bold text-brand-strong underline underline-offset-2">
            대회 등록
          </Link>
          에서 먼저 대회를 등록해 주세요.
        </p>
      ) : !teams ? (
        <Notice error={teamsError} onRetry={refresh} />
      ) : view === 'upload' ? (
        <div className="motion-results grid min-w-0 items-start gap-5 min-[1180px]:grid-cols-[minmax(0,3fr)_minmax(17rem,2fr)]">
          {baseId ? <BaseUpload sid={baseId} /> : <Upload key={event.id} event={event} teams={teams} />}
          <UploadOverview />
        </div>
      ) : backend === 'service' ? (
        view === 'history' ? <ServiceHistory /> : <ServiceDetail />
      ) : view === 'history' ? (
        <History key={event.id} eventId={event.id} />
      ) : (
        <Detail eventId={event.id} />
      )}
    </IntakeLayout>
  );
}

function BaseUpload({ sid }: { sid: string }) {
  const { event, teams } = useEvent();
  const base = useAsync(() => getSubmission(sid), [sid]);
  if (!base.data) return <Notice error={base.error} onRetry={base.reload} />;
  if (base.data.current !== base.data.id) return <Feedback error="최신 제출본에서만 보완 서류를 올릴 수 있습니다." />;
  return <Upload key={sid} event={event!} teams={teams ?? []} base={base.data} />;
}

// ── Spring Boot 접수 API ─────────────────────────────

function History({ eventId }: { eventId: string }) {
  const { dashboard, revision, refresh } = useEvent();
  const location = useLocation();
  const [message, setMessage] = useState(location.state?.eventId === eventId ? location.state.message : '');
  const result = useApi<BatchSummary[]>(paths.batches(eventId), revision);
  const preparing = new Set(dashboard?.batches.filter(batch => batch.state === 'preparing').map(batch => batch.id));
  if (!result.data) return <Notice error={result.error} onRetry={refresh} />;
  return (
    <section className={cx(card, 'motion-results')}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">
          올린 서류 <em className="ml-1 text-base not-italic text-brand-strong">{result.data.length}</em>
        </h2>
        <button type="button" onClick={refresh} className={buttonStyles.text}>
          새로고침
        </button>
      </div>
      <Feedback message={message} />
      {result.data.length === 0 ? (
        <p className="py-6 text-sm text-muted">아직 올린 서류가 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['첨부번호', '첨부 일시', '지정 팀', '원본', '상태', '관리'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-2 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.data.map((batch) => (
                <tr key={batch.batch_id} className="border-b border-line-soft">
                  <td className="whitespace-nowrap px-2 py-3">
                    <span className="block font-mono">{batch.batch_id.slice(0, 8)}</span>
                    <Link to={`/intake/batches/${encodeURIComponent(batch.batch_id)}`} className="mt-1 inline-flex font-semibold text-brand-strong hover:underline">
                      {workflowLabels.progressAction}<span className="sr-only"> · {batch.batch_id.slice(0, 8)}</span>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{formatDate(batch.created_at)}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep, intake_number: batch.intake_number }) : '미지정'}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.file_count}개</td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <StateBadge state={preparing.has(batch.batch_id) ? 'preparing' : batch.status ?? 'received'} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <DeleteIntake kind="묶음" name={'첨부 ' + batch.batch_id.slice(0, 8)} path={paths.batch(batch.batch_id)}
                      onDeleted={() => { setMessage('첨부 ' + batch.batch_id.slice(0, 8) + ' 묶음을 삭제했습니다.'); refresh(); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Detail({ eventId }: { eventId: string }) {
  const { id = '' } = useParams();
  const receipt = useUploadReceipt(id);
  const { dashboard, dashboardError, revision, teams, refresh } = useEvent();
  const navigate = useNavigate();
  const [deleted, setDeleted] = useState<{ batch: string; name: string }>();
  const result = useAsync(() => api<BatchDetails>(paths.batch(id)), [id, revision]);
  const detail = result.data?.batch.batch_id === id ? result.data : undefined;
  const links = new Map((detail?.teams ?? []).map((link) => [link.team, link]));
  const current = new Map(dashboard?.teams.flatMap(team => team.submission ? [[team.submission.id, team.submission.state] as const] : []));
  const jobs = new Map<string, BatchJob>();
  for (const [team, link] of links) {
    const job = link.review_job;
    if (!job) continue;
    const state = link.submission_id ? current.get(link.submission_id) : undefined;
    const isCurrent = job.state === 'queued' || job.state === 'running' || (job.state === 'done' && state === 'ownership');
    jobs.set(team, { state: isCurrent ? state ?? job.state : job.state, submissionId: link.submission_id });
  }
  const teamIds = new Set((detail?.files ?? []).flatMap((file) => file.team ? [file.team] : []));
  for (const team of links.keys()) teamIds.add(team);
  const batchState = dashboard?.batches.find(item => item.id === id)?.state;
  const preparing = batchState === 'preparing';
  const reviewJobs = [...jobs.values()];
  const trackingJobs = reviewJobs.some(job => job.submissionId && busyStates.has(current.get(job.submissionId) ?? ''));
  const unresolvedFiles = detail?.files.some(file => file.state === 'unassigned' || (file.team && !links.has(file.team)));
  const conflicted = detail?.batch.status === 'conflict' || detail?.batch.status === 'conflict_reviewed';
  usePolling(Boolean(detail?.batch.event_id === eventId && !conflicted && !result.error && !preparing && !trackingJobs
    && (unresolvedFiles || reviewJobs.some(job => busyStates.has(job.state)))), result.reload, 3000);
  if (!detail) return <BatchLoading receipt={receipt} error={result.error} onRetry={result.reload} />;
  const { batch, files } = detail;
  const targetName = batch.team_name && teamLabel({ name: batch.team_name, rep: batch.team_rep, intake_number: batch.intake_number });
  if (batch.event_id !== eventId) return <Feedback error="선택한 대회의 첨부번호가 아닙니다." />;
  const status = result.error ? <Notice error={result.error} onRetry={result.reload} /> : !conflicted && (
    dashboardError && !jobs.size ? <Notice error={dashboardError} onRetry={refresh} /> :
    <BatchReviewStatus preparing={preparing} jobs={reviewJobs} receipt={receipt}
      needsAssignment={batchState === 'review' || files.some(file => file.state === 'unassigned') || reviewJobs.some(job => job.state === 'blocked')} />
  );
  if (receipt && !conflicted) return status;
  return (
    <div className="motion-results flex flex-col gap-4">
      <Feedback message={deleted?.batch === id ? deleted.name + ' 원본을 삭제했습니다.' : ''} />
      {status}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">검토 진행 상세</h2>
          <StateBadge state={batch.status ?? 'received'} />
        </div>
        <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-sm">
          <dt className="text-muted">첨부번호</dt>
          <dd className="break-all font-mono">{batch.batch_id}</dd>
          <dt className="text-muted">첨부 일시</dt>
          <dd>{formatDate(batch.created_at)}</dd>
          <dt className="text-muted">지정 팀</dt>
          <dd>{targetName || '미지정 · 여러 팀 서류 올리기'}</dd>
        </dl>
      </section>
      {batch.status === 'conflict' && <CorrectionNotice id={batch.batch_id} current={batch.current_submission} onSaved={result.reload} />}
      {!conflicted && <section className={card} aria-labelledby="review-jobs-title">
        <div className="flex items-center justify-between">
          <h2 id="review-jobs-title" className="text-xl font-extrabold">팀별 판정 작업</h2>
          <button type="button" onClick={result.reload} className={buttonStyles.text}>새로고침</button>
        </div>
        {teamIds.size === 0 ? (
          <p className="text-sm text-muted">원본을 팀에 배정하고 제출본을 확정하면 판정 작업이 등록됩니다.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {Array.from(teamIds, (id) => {
              const team = teams?.find((entry) => entry.id === id);
              const link = links.get(id);
              const job = link?.review_job;
              let submission = '제출본 확정 전';
              if (link?.version != null) submission = `제출본 v${link.version}${link.state === 'superseded' ? ' · 이전 첨부' : ''}`;
              if (link?.state === 'blocked') submission = '미배정 원본 확인 중';
              if (link?.state === 'empty') submission = '배정 원본 없음';
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="break-all font-semibold">{id === batch.target_team_id && targetName ? targetName : team ? teamLabel(team) : id}</p>
                    {link?.submission_id ? <Link to={`/teams/${link.submission_id}`} className={buttonStyles.text}>{submission} · 검토 열기</Link>
                      : <p className="mt-1 text-xs text-muted">{submission}</p>}
                  </div>
                  {job ? (
                    <div className="min-w-0 sm:text-right">
                      <StateBadge state={jobs.get(id)?.state ?? job.state} />
                      {job.verdict && <p className="mt-1 text-sm font-semibold">{job.verdict}</p>}
                      <p className="mt-1 break-all font-mono text-xs text-subtle">작업 {job.review_job_id}</p>
                    </div>
                  ) : <span className="text-sm text-muted">작업 미등록</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">
            첨부한 파일 <em className="ml-1 text-base not-italic text-brand-strong">{files.length}</em>
          </h2>
          {!conflicted && <Link to="/assign" className={buttonStyles.text}>팀 배정 확인</Link>}
          <span className="text-sm text-muted">{bytes(batch.total_bytes)}</span>
        </div>
        <ol>
          {files.map((file) => (
            <li key={file.item_id} className="flex flex-wrap items-center gap-2.5 border-b border-line-soft py-3 text-sm">
              <span className="file-name flex-[1_1_160px]">{file.name}</span>
              <small className="whitespace-nowrap text-muted">{bytes(file.size)}</small>
              <a className={buttonStyles.text} href={paths.original(batch.batch_id, file.item_id)} download>
                원본 받기
              </a>
              <DeleteIntake kind="원본" name={file.name} path={paths.batch(id) + '/files/' + file.item_id}
                onDeleted={impact => {
                  if (impact.batch_count) navigate('/intake/batches', { replace: true, state: { eventId, message: '마지막 원본과 첨부 묶음을 삭제했습니다.' } });
                  else setDeleted({ batch: id, name: file.name });
                  refresh();
                }} />
            </li>
          ))}
        </ol>
      </section>
      <div className="flex flex-wrap gap-3">
        {batch.intake_number != null && <Link to="/intake" className={buttonStyles.primary}>다음 팀 서류 올리기</Link>}
        <Link to="/intake/batches" className={buttonStyles.secondary}>
          검토 진행 목록으로
        </Link>
      </div>
    </div>
  );
}

// ── 검토 서비스 ──────────────────────────────────────

function ServiceHistory() {
  const { dashboard, refresh } = useEvent();
  if (!dashboard) return <Notice onRetry={refresh} />;
  const batches = dashboard.batches;
  return (
    <section className={cx(card, 'motion-results')}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">
          올린 서류 <em className="ml-1 text-base not-italic text-brand-strong">{batches.length}</em>
        </h2>
        <button type="button" onClick={refresh} className={buttonStyles.text}>
          새로고침
        </button>
      </div>
      {batches.length === 0 ? (
        <p className="py-6 text-sm text-muted">아직 올린 서류가 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['첨부번호', '첨부 일시', '원본', '배정 확인', '상태'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-2 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-line-soft">
                  <td className="whitespace-nowrap px-2 py-3">
                    <span className="block font-mono">{b.id.slice(0, 8)}</span>
                    <Link to={`/intake/batches/${encodeURIComponent(b.id)}`} className="mt-1 inline-flex font-semibold text-brand-strong hover:underline">
                      {workflowLabels.progressAction}<span className="sr-only"> · {b.id.slice(0, 8)}</span>
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{when(b.created)}</td>
                  <td className="whitespace-nowrap px-2 py-3">{b.count}개</td>
                  <td className="whitespace-nowrap px-2 py-3">{b.pending ? <Link to="/assign" className="font-bold text-caution">{b.pending}개 →</Link> : '—'}</td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <StateBadge state={b.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CorrectionNotice({ id, current, onSaved }: { id: string; current?: string | null; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { refresh } = useEvent();
  async function finish() {
    setSaving(true);
    setError('');
    try {
      await reviewBatchConflict(id);
      onSaved();
      refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  return <div className={card}>
    <strong>보완 기준 제출본이 변경됐습니다.</strong>
    <p>아래 첨부한 파일을 최신 확정본과 대조하고, 반영할 파일만 다시 첨부해 주세요.</p>
    {current && <Link to={'/intake?base=' + current} className={buttonStyles.text}>최신 제출본에서 보완 서류 올리기</Link>}
    <button type="button" className={cx(buttonStyles.outline, 'self-start')} disabled={saving} onClick={finish}>이 첨부의 대조 완료</button>
    <Feedback error={error} />
  </div>;
}

function ServiceDetail() {
  const { id = '' } = useParams();
  const receipt = useUploadReceipt(id);
  const { dashboard, revision, refresh } = useEvent();
  const result = useAsync(() => getBatch(id), [id, revision]);
  const trackingPreparation = dashboard?.batches.some(batch => batch.id === id && batch.state === 'preparing');
  const detail = result.data?.id === id ? result.data : undefined;
  usePolling(detail?.state === 'preparing' && !trackingPreparation && !result.error, result.reload, 3000);
  if (!detail) return <BatchLoading receipt={receipt} error={result.error} onRetry={result.reload} />;
  const b = detail;
  const teamName = (tid?: string | null) => dashboard?.teams.find((t) => t.id === tid)?.name ?? '';
  const pending = b.files.filter((f) => !isFileProcessed(f)).length;
  const jobs = b.teams.flatMap(team => {
    const submission = dashboard?.teams.find(entry => entry.submission?.id === team.submission_id)?.submission;
    return submission ? [{ state: submission.state, submissionId: submission.id }] : [];
  });
  const conflicted = b.state === 'conflict' || b.state === 'conflict_reviewed';
  const status = result.error ? <Notice error={result.error} onRetry={result.reload} /> : !conflicted &&
    <BatchReviewStatus preparing={b.state === 'preparing'} needsAssignment={pending > 0} jobs={jobs} receipt={receipt} />;
  if (receipt && !conflicted) return status;
  return (
    <div className="motion-results flex flex-col gap-4">
      {status}
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-extrabold">검토 진행 상세</h2>
          <StateBadge state={b.state} />
        </div>
        <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-sm">
          <dt className="text-muted">첨부번호</dt>
          <dd className="break-all font-mono">{b.id}</dd>
          <dt className="text-muted">첨부 일시</dt>
          <dd>{when(b.created)}</dd>
          <dt className="text-muted">지정 팀</dt>
          <dd>{b.target ? teamName(b.target) : '미지정 · 여러 팀 서류 올리기'}{b.base && ' · 보완 서류 올리기'}</dd>
        </dl>
        {b.state === 'conflict' && <CorrectionNotice id={b.id} current={dashboard?.teams.find((t) => t.id === b.target)?.current} onSaved={result.reload} />}
        {pending > 0 && b.state !== 'conflict' && b.state !== 'conflict_reviewed' && (
          <Link to="/assign" className={cx(buttonStyles.outline, 'self-start')}>
            팀 배정 확인 {pending}개
          </Link>
        )}
        {b.teams.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {b.teams.map((t) => (
              <Link key={t.team} to={`/teams/${t.submission_id}`} className="rounded-full bg-brand-tint px-3.5 py-2 text-sm font-bold text-brand-deep">
                {teamName(t.team)} 검토 →
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className={card}>
        <h2 className="text-xl font-extrabold">
          첨부한 파일 <em className="ml-1 text-base not-italic text-brand-strong">{b.files.length}</em>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['파일', '종류', '상태', '팀', '근거'].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-2 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.files.map((f) => (
                <tr key={f.id} className="border-b border-line-soft align-top">
                  <td className="px-2 py-3">
                    {f.url ? (
                      <a href={filePreviewUrl(f)} target="_blank" rel="noreferrer" className="file-name text-brand-strong underline underline-offset-2">
                        {f.name}
                      </a>
                    ) : (
                      <span className="file-name">{f.name}</span>
                    )}
                    <div className="text-xs text-subtle">
                      {bytes(f.size)}
                      {f.pages ? ` · ${f.pages}쪽` : ''}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{docLabels[f.kind] ?? f.kind}</td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <StateBadge state={f.state} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{teamName(f.team) || '—'}</td>
                  <td className="px-2 py-3 text-[13px] text-ink-2">{f.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div>
        <Link to="/intake/batches" className={buttonStyles.secondary} onClick={refresh}>
          검토 진행 목록으로
        </Link>
      </div>
    </div>
  );
}
