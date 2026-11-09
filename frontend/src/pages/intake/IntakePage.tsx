import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { backend } from '../../api/backend';
import { api, bytes, formatDate, useApi, useAsync, usePolling } from '../../api/client';
import { paths, teamLabel, type BatchDetails, type BatchSummary } from '../../api/intake';
import { docLabels, when } from '../../api/labels';
import { filePreviewUrl, getBatch, getSubmission, isFileProcessed, reviewBatchConflict } from '../../api/service';
import { Page } from '../../components/Layout';
import DeleteIntake from '../../components/DeleteIntake';
import { Feedback, Notice, PageHeader, StateBadge, buttonStyles, cx } from '../../components/ui';
import { useEvent } from '../../context/EventContext';
import Upload from './Upload';

const card = 'flex flex-col gap-4 rounded-[22px] border border-line bg-white p-[clamp(18px,3vw,32px)]';

/** /intake (업로드·보완 접수), /intake/batches (접수 내역), /intake/batches/:id (접수 상세) */
export default function IntakePage({ view }: { view: 'upload' | 'history' | 'detail' }) {
  const { event, events, eventsError, teams, teamsError, refresh } = useEvent();
  const [search] = useSearchParams();
  const baseId = search.get('base');

  return (
    <Page tone="gray" width="normal">
      <PageHeader
        title={baseId ? '보완본 접수' : '원본 접수'}
        lead={
          baseId
            ? '팀장이 보완해 보낸 서류를 같은 팀의 새 제출 버전으로 접수합니다. 교체할 이전 원본을 고르고 새 파일을 올리면 다시 판정합니다.'
            : backend === 'intake' ? '한 팀에서 받은 신청서(01), 동의서(02), 대표 증빙(03)을 한 묶음으로 올리세요. 다음 팀 서류는 새로 접수하세요.'
            : '여러 팀의 신청서(01), 동의서(02), 대표 증빙(03)을 한 번에 접수할 수 있습니다.'
        }
      />
      <nav aria-label="원본 접수" className="segments self-start">
        {[
          ['/intake', '접수하기', true],
          ['/intake/batches', '접수 내역', false],
        ].map(([to, label, end]) => (
          <NavLink
            key={to as string}
            to={to as string}
            end={end as boolean}
            className="segment"
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {!events ? (
        <Notice error={eventsError && `${eventsError} (API 서버가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />
      ) : !event ? (
        <p className="rounded-2xl bg-white px-5 py-4 text-sm">
          등록된 대회가 없습니다.{' '}
          <Link to="/manage" className="font-bold text-brand-strong underline underline-offset-2">
            대회·팀 관리
          </Link>
          에서 먼저 대회를 등록해 주세요.
        </p>
      ) : !teams ? (
        <Notice error={teamsError} onRetry={refresh} />
      ) : view === 'upload' ? (
        baseId ? <BaseUpload sid={baseId} /> : <Upload key={event.id} event={event} teams={teams} />
      ) : backend === 'service' ? (
        view === 'history' ? <ServiceHistory /> : <ServiceDetail />
      ) : view === 'history' ? (
        <History key={event.id} eventId={event.id} />
      ) : (
        <Detail eventId={event.id} />
      )}
    </Page>
  );
}

function BaseUpload({ sid }: { sid: string }) {
  const { event, teams } = useEvent();
  const base = useAsync(() => getSubmission(sid), [sid]);
  if (!base.data) return <Notice error={base.error} onRetry={base.reload} />;
  if (base.data.current !== base.data.id) return <Feedback error="최신 제출 버전에서만 보완 접수할 수 있습니다." />;
  return <Upload key={sid} event={event!} teams={teams ?? []} base={base.data} />;
}

// ── Spring Boot 접수 API ─────────────────────────────

function History({ eventId }: { eventId: string }) {
  const { revision, refresh } = useEvent();
  const location = useLocation();
  const [message, setMessage] = useState(location.state?.eventId === eventId ? location.state.message : '');
  const result = useApi<BatchSummary[]>(paths.batches(eventId), revision);
  if (!result.data) return <Notice error={result.error} onRetry={refresh} />;
  return (
    <section className={card}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">
          접수 목록 <em className="ml-1 text-base not-italic text-brand-strong">{result.data.length}</em>
        </h2>
        <button type="button" onClick={refresh} className={buttonStyles.text}>
          새로고침
        </button>
      </div>
      <Feedback message={message} />
      {result.data.length === 0 ? (
        <p className="py-6 text-sm text-muted">아직 접수한 원본이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['접수번호', '접수 일시', '지정 팀', '원본', '상태', '관리'].map((h) => (
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
                    <Link to={`/intake/batches/${batch.batch_id}`} className="font-mono text-brand-strong underline underline-offset-2">
                      {batch.batch_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">{formatDate(batch.created_at)}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.team_name ? teamLabel({ name: batch.team_name, rep: batch.team_rep, intake_number: batch.intake_number }) : '미지정'}</td>
                  <td className="whitespace-nowrap px-2 py-3">{batch.file_count}개</td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <StateBadge state={batch.status ?? 'received'} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-3">
                    <DeleteIntake kind="묶음" name={'접수 ' + batch.batch_id.slice(0, 8)} path={paths.batch(batch.batch_id)}
                      onDeleted={() => { setMessage('접수 ' + batch.batch_id.slice(0, 8) + ' 묶음을 삭제했습니다.'); refresh(); }} />
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
  const { revision, teams, refresh } = useEvent();
  const navigate = useNavigate();
  const [deleted, setDeleted] = useState<{ batch: string; name: string }>();
  const result = useAsync(() => api<BatchDetails>(paths.batch(id)), [id, revision]);
  const detail = result.data?.batch.batch_id === id ? result.data : undefined;
  const links = new Map((detail?.teams ?? []).map((link) => [link.team, link]));
  const teamIds = new Set((detail?.files ?? []).flatMap((file) => file.team ? [file.team] : []));
  for (const team of links.keys()) teamIds.add(team);
  const pending = detail?.files.some((file) => file.state === 'unassigned' || (file.team && !links.has(file.team)))
    || detail?.teams?.some(({ review_job }) => review_job?.state === 'queued' || review_job?.state === 'running');
  const conflicted = detail?.batch.status === 'conflict' || detail?.batch.status === 'conflict_reviewed';
  usePolling(Boolean(detail?.batch.event_id === eventId && !conflicted && !result.error && pending), result.reload, 3000);
  if (result.error || !detail) return <Notice error={result.error} onRetry={result.reload} />;
  const { batch, files } = detail;
  const targetName = batch.team_name && teamLabel({ name: batch.team_name, rep: batch.team_rep, intake_number: batch.intake_number });
  if (batch.event_id !== eventId) return <Feedback error="선택한 대회의 접수번호가 아닙니다." />;
  return (
    <div className="flex flex-col gap-4">
      <Feedback message={deleted?.batch === id ? deleted.name + ' 원본을 삭제했습니다.' : ''} />
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">접수 상세</h2>
          <StateBadge state={batch.status ?? 'received'} />
        </div>
        <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-sm">
          <dt className="text-muted">접수번호</dt>
          <dd className="break-all font-mono">{batch.batch_id}</dd>
          <dt className="text-muted">접수 일시</dt>
          <dd>{formatDate(batch.created_at)}</dd>
          <dt className="text-muted">지정 팀</dt>
          <dd>{targetName || '미지정 · 혼합 접수'}</dd>
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
              if (link?.version != null) submission = `제출본 v${link.version}${link.state === 'superseded' ? ' · 이전 접수' : ''}`;
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
                      <StateBadge state={job.state} />
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
            접수 원본 <em className="ml-1 text-base not-italic text-brand-strong">{files.length}</em>
          </h2>
          {!conflicted && <Link to="/assign" className={buttonStyles.text}>원본 배정 확인</Link>}
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
                  if (impact.batch_count) navigate('/intake/batches', { replace: true, state: { eventId, message: '마지막 원본과 접수 묶음을 삭제했습니다.' } });
                  else setDeleted({ batch: id, name: file.name });
                  refresh();
                }} />
            </li>
          ))}
        </ol>
      </section>
      <div className="flex flex-wrap gap-3">
        {batch.intake_number != null && <Link to="/intake" className={buttonStyles.primary}>다음 팀 서류 접수</Link>}
        <Link to="/intake/batches" className={buttonStyles.secondary}>
          접수 목록으로
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
    <section className={card}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold">
          접수 목록 <em className="ml-1 text-base not-italic text-brand-strong">{batches.length}</em>
        </h2>
        <button type="button" onClick={refresh} className={buttonStyles.text}>
          새로고침
        </button>
      </div>
      {batches.length === 0 ? (
        <p className="py-6 text-sm text-muted">아직 접수한 원본이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-[13px] text-muted">
                {['접수번호', '접수 일시', '원본', '배정 확인', '상태'].map((h) => (
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
                    <Link to={`/intake/batches/${b.id}`} className="font-mono text-brand-strong underline underline-offset-2">
                      {b.id.slice(0, 8)}
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
    <p>아래 접수 원본을 최신 확정본과 대조하고, 반영할 파일만 다시 접수해 주세요.</p>
    {current && <Link to={'/intake?base=' + current} className={buttonStyles.text}>최신 제출본에서 보완 접수</Link>}
    <button type="button" className={cx(buttonStyles.outline, 'self-start')} disabled={saving} onClick={finish}>이 접수의 대조 완료</button>
    <Feedback error={error} />
  </div>;
}

function ServiceDetail() {
  const { id = '' } = useParams();
  const { dashboard, revision, refresh } = useEvent();
  const result = useAsync(() => getBatch(id), [id, revision]);
  usePolling(result.data?.state === 'preparing', result.reload, 3000);
  if (!result.data) return <Notice error={result.error} onRetry={result.reload} />;
  const b = result.data;
  const teamName = (tid?: string | null) => dashboard?.teams.find((t) => t.id === tid)?.name ?? '';
  const pending = b.files.filter((f) => !isFileProcessed(f)).length;
  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-extrabold">접수 상세</h2>
          <StateBadge state={b.state} />
        </div>
        <dl className="grid grid-cols-[86px_minmax(0,1fr)] gap-3 text-sm">
          <dt className="text-muted">접수번호</dt>
          <dd className="break-all font-mono">{b.id}</dd>
          <dt className="text-muted">접수 일시</dt>
          <dd>{when(b.created)}</dd>
          <dt className="text-muted">지정 팀</dt>
          <dd>{b.target ? teamName(b.target) : '미지정 · 혼합 접수'}{b.base && ' · 보완 접수'}</dd>
        </dl>
        {b.state === 'preparing' && <p className="text-sm text-muted">원본을 PDF로 바꾸고 본문을 읽는 중입니다. 화면이 자동으로 새로고침됩니다.</p>}
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
          접수 원본 <em className="ml-1 text-base not-italic text-brand-strong">{b.files.length}</em>
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
          접수 목록으로
        </Link>
      </div>
    </div>
  );
}
