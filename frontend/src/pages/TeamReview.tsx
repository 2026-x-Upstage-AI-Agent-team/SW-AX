import { useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Check as CheckMark, ChevronDown } from 'lucide-react';
import { Link } from '../components/workspaceNavigation';
import { useAsync, usePolling } from '../api/client';
import { receiptName } from '../api/intake';
import { isDemoBackend } from '../api/backend';
import { busyStates, docLabels, issueLabels, recoverableStates, stateLabel, when } from '../api/labels';
import { reviewEvidence, studioExplanation } from '../api/reviewEvidence';
import {
  getSubmission,
  retrySubmission,
  reviewBody,
  saveReview,
  type Decision,
  type Check,
  type DocKey,
  type Member,
  type Recipient,
  type Ref,
  type SubmissionDetail,
} from '../api/service';
import { Page } from '../components/Layout';
import DocumentPreview from '../components/DocumentPreview';
import { workflowLabels } from '../components/workspaceMenu';
import { ProgressTrack } from '../components/WorkflowProgress';
import {
  CheckIcon,
  Feedback,
  Notice,
  StateBadge,
  VerdictBadge,
  buttonStyles,
  checkState,
  cx,
  inputStyle,
} from '../components/ui';
import { useEvent } from '../context/EventContext';
import { isSupplementMail, supplementMailAction } from '../hooks/reviewQueue';

const DOC_KEYS: DocKey[] = ['01', '02', '03', '?'];

export default function TeamReview() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const requestedBack = search.get('back');
  const back = requestedBack && /^\/review(?:\?[^#]*)?$/.test(requestedBack) ? requestedBack : '/review';
  const { revision, refresh } = useEvent();
  const result = useAsync(() => getSubmission(id), [id, revision]);
  const submission = result.data?.id === id ? result.data : undefined;
  const slow = !!submission && (recoverableStates.has(submission.state) || !!submission.error);
  usePolling(!!submission && (busyStates.has(submission.state) || (slow && submission.state !== 'failed')), refresh, slow ? 15000 : 3000);

  return (
    <Page tone="gray" width="review">
      <div className="team-review">
        <Link to={back} className="team-review-back">
          ← {workflowLabels.review}
        </Link>
        {!submission ? <Notice error={result.error} onRetry={result.reload} /> : <Review key={submission.id} s={submission} onSaved={refresh} />}
      </div>
    </Page>
  );
}

function Review({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const [params] = useSearchParams();
  const returnedFile = s.files.find(f => f.id === params.get('file'));
  const res = s.result;
  const docs = res?.documents;
  const evidence = reviewEvidence(res, s.verdict);
  const firstIssue = evidence.problems.find(c => c.refs.length);
  const initialRef = firstIssue?.refs[0] ?? DOC_KEYS.map((k) => docs?.[k]?.[0]).find(Boolean);
  const [view, setView] = useState<Partial<Ref> & { evidence?: number }>(returnedFile ? { id: returnedFile.id, page: 1 } : initialRef ?? { id: s.files[0]?.id });
  const previewPanel = useRef<HTMLElement>(null);
  const file = s.files.find((f) => f.id === view.id);
  const fileDoc = (fid?: string) => DOC_KEYS.find((k) => docs?.[k]?.some((r) => r.id === fid)) ?? (s.files.find((f) => f.id === fid)?.kind as DocKey | undefined);
  const activeDoc = fileDoc(view.id);
  const outdated = s.current !== s.id;
  const checksByDocument = new Map<DocKey, Check[]>();
  for (const check of evidence.problems) {
    const kind = check.refs.length ? fileDoc(check.refs[0].id) ?? '?' : '?';
    const checks = checksByDocument.get(kind) ?? [];
    checks.push(check);
    checksByDocument.set(kind, checks);
  }

  function showEvidence(ref?: Ref) {
    setView(previous => ({ ...ref, evidence: (previous.evidence ?? 0) + 1 }));
    previewPanel.current?.focus();
  }

  function renderChecks(checks: Check[]) {
    return <ul className="team-review-checks">{checks.map(c => {
      const state = checkState(c.passed);
      return (
        <li key={c.label} className="team-review-check" data-state={state}>
          <div className="team-review-check-label">
            <span className="team-review-check-icon"><CheckIcon state={state} /></span>
            <span>{c.label}</span>
          </div>
          <div className="team-review-evidence-links">
            {c.refs.length ? c.refs.map((r, j) => {
              const kind = fileDoc(r.id) ?? '?';
              const copies = docs?.[kind] ?? [];
              const copy = copies.findIndex(entry => entry.id === r.id);
              return (
                <button key={j} type="button" aria-controls="review-preview" onClick={() => showEvidence(r)} className="team-review-evidence-link"
                  data-selected={view.id === r.id && view.page === r.page && view.row === r.row}>
                  {kind} {docLabels[kind]}{copies.length > 1 && copy >= 0 && ` (${copy + 1}번째)`} · {r.page}쪽{r.row && ` · ${r.row}행`}
                </button>
              );
            }) : <button type="button" aria-controls="review-preview" onClick={() => showEvidence()} className="team-review-evidence-link">확정 파일 목록 보기</button>}
          </div>
        </li>
      );
    })}</ul>;
  }

  return (
    <>
      {outdated && (
        <p className="rounded-2xl border border-caution-line bg-caution-bg px-5 py-3 text-sm">
          이전 제출 버전입니다.{' '}
          {s.current && (
            <Link to={`/teams/${s.current}`} className="font-bold text-brand-strong underline underline-offset-2">
              최신 버전 보기
            </Link>
          )}
        </p>
      )}
      <header className="team-review-heading">
        <div className="team-review-heading-copy">
          <div className="team-review-heading-title">
            <h1>{receiptName(s.result?.team_name?.trim() || '미확인', s.intake_number)}</h1>
            {s.state === 'done' && s.verdict ? <VerdictBadge verdict={s.verdict} size="md" /> : <StateBadge state={s.state} size="md" />}
            {s.decision && (
              <span className={cx('rounded-full border px-3 py-1.5 text-[13px] font-bold', s.decision === '승인' ? 'border-brand text-brand-strong' : 'border-alert-strong text-alert-strong')}>
                담당자 {s.decision}
              </span>
            )}
          </div>
          <div className="team-review-meta">
            <span>대표 {s.fields.members.find((m) => m.role === '대표')?.name.trim() || '미확인'}</span>
            <span>제출 v{s.version}</span>
            <span>원본 {s.count}개</span>
          </div>
        </div>
        <div className="team-review-heading-actions">
          {file && <Link to={'/files/' + file.id + '/edit?review=' + encodeURIComponent(s.id)} target="_blank" rel="noreferrer" className={buttonStyles.outline}>한글 문서 편집</Link>}
          {!outdated && (
            <Link to={`/intake?base=${s.id}`} className={cx(buttonStyles.primary, 'team-review-attach')}>
              보완 서류 올리기
            </Link>
          )}
        </div>
      </header>
      {evidence.summary && <p className="team-review-summary">{evidence.summary}</p>}
      {s.held && <Feedback error="이 팀에 속할 수 있는 미배정 파일이 있어 검토 저장과 안내가 보류됩니다. 팀 배정 확인에서 먼저 정리해 주세요." />}
      {s.state !== 'done' && <StatusCard s={s} onSaved={onSaved} />}

      <div className="team-review-columns">
        <section ref={previewPanel} id="review-preview" tabIndex={-1} aria-label="원문 미리보기" className="team-review-card team-review-preview">
          <StudioExplanation s={s} />
          <div role="tablist" aria-label="서류" className="team-review-tabs">
            {DOC_KEYS.filter((k) => k !== '?' || (docs?.['?']?.length ?? 0) > 0).map((k) => {
              const refs = docs?.[k] ?? s.files.filter((f) => f.kind === k).map((f) => ({ id: f.id, page: f.page }));
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={activeDoc === k}
                  disabled={refs.length === 0}
                  onClick={() => setView(refs[0])}
                  className={cx(
                    'team-review-tab',
                    !refs.length && 'text-alert-strong',
                  )}
                >
                  {k === '?' ? '기타' : k} {docLabels[k]}
                  {refs.length === 0 && ' · 없음'}
                  {refs.length > 1 && ` · ${refs.length}건`}
                </button>
              );
            })}
            <button type="button" role="tab" aria-selected={!file} onClick={() => setView({})} className="team-review-tab">
              확정 파일 목록
            </button>
          </div>
          {activeDoc && (docs?.[activeDoc]?.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {docs![activeDoc].map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setView(r)}
                  className={cx('file-name min-h-9 rounded-lg px-3 text-left', view.id === r.id ? 'bg-alert-tint font-bold text-alert-strong' : 'bg-canvas text-ink-2')}
                >
                  {i + 1}번째 · {s.files.find((f) => f.id === r.id)?.name}
                </button>
              ))}
            </div>
          )}
          <div className="team-review-document">
            {file ? (<>
              <div className="team-review-document-toolbar">
                <span className="file-name text-ink">
                  {file.name} {view.page ? `· ${view.page}쪽` : ''} {view.row ? `· ${view.row}행` : ''}
                </span>
              </div>
              <div className="team-review-document-body">
                <DocumentPreview key={`${file.id}-${view.evidence ?? 'latest'}`} file={file} page={view.page} original={!!view.evidence} openLink />
              </div>
            </>) : (
              <section aria-label="확정 파일 목록" className="team-review-document-body">
                <h2 className="font-bold">제출 v{s.version} 확정 파일 목록 · {s.files.length}개</h2>
                <ol className="mt-2 list-decimal space-y-1 pl-6">
                  {s.files.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => showEvidence({ id: f.id, page: f.page || 1 })}
                        className="file-name min-h-10 text-left font-bold text-brand-strong underline underline-offset-2">
                        {f.name}
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
          <HistoryCard s={s} />
        </section>

        <aside aria-label="검토 체크리스트" className="team-review-checklist">
          <section className="team-review-card">
            <div className="team-review-card-heading">
              <h2>서류별 체크리스트</h2>
              {res && <span>확인 {evidence.problems.length} · 통과 {evidence.passed.length}</span>}
            </div>
            {!res ? (
              <p className="text-sm text-muted">Studio 판정이 끝나면 항목이 표시됩니다.</p>
            ) : <>
              {DOC_KEYS.map(kind => {
                const checks = checksByDocument.get(kind);
                return checks && <section key={kind} className="team-review-check-group">
                  <h3><span className="team-review-document-code">{kind === '?' ? '기타' : kind}</span>{docLabels[kind]}</h3>
                  {renderChecks(checks)}
                </section>;
              })}
              {evidence.passed.length > 0 && <details className="team-review-check-group">
                <summary className="team-review-passed-summary">
                  <span className="team-review-check-icon"><CheckMark size={14} aria-hidden="true" /></span>
                  통과한 항목 {evidence.passed.length}개
                  <ChevronDown size={15} aria-hidden="true" />
                </summary>
                {renderChecks(evidence.passed)}
              </details>}
            </>}
          </section>
          <DecisionCard key={s.revision} s={s} onSaved={onSaved} />
        </aside>
      </div>

      <MembersCard key={s.revision} s={s} onSaved={onSaved} />
    </>
  );
}

function StudioExplanation({ s }: { s: SubmissionDetail }) {
  if (!s.result || !s.verdict || s.verdict === '성공') return null;
  const explanation = studioExplanation(s.result);
  return (
    <section aria-label="Upstage 검토 설명" className="team-review-explanation">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
        <h2>확인이 필요한 내용</h2>
        <span>Upstage 판정 근거 · 제출 v{s.version}</span>
      </div>
      <p className="whitespace-pre-line break-words text-[15px] leading-relaxed">{explanation.reason}</p>
      {explanation.fields.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed">
          {explanation.fields.map(field => <li key={field}>{field}</li>)}
        </ul>
      )}
    </section>
  );
}

/** 결론을 기록했을 때 실제로 일어나는 일 (service/app.py save_review 기준) */
function decidedMessage(s: SubmissionDetail, d: Decision) {
  if (d === '보완 필요') return '보완 필요로 저장했습니다. 안내 메일에서 선택한 보완 항목을 확인하세요.';
  if (s.verdict === '담당자확인') return '서류를 승인했습니다. 팀장 안내 메일에서 검토 완료 초안을 확인하세요.';
  return '서류를 승인했습니다.';
}


/** 판정 전·실패 상태 안내와 재개 */
function StatusCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const [job, setJob] = useState('');
  const [absent, setAbsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recoverable = recoverableStates.has(s.state);
  const processing = busyStates.has(s.state);
  const lastPoll = s.last_polled_at == null ? null : new Date(s.last_polled_at * 1000);
  const waiting = s.polling_delayed ? '처리 지연' : 'Studio 판정을 기다리는 중입니다. 화면이 자동으로 새로고침됩니다.';

  async function retry() {
    setBusy(true);
    setError('');
    try {
      await retrySubmission(s.id, s.state === 'uncertain' ? { job: job.trim(), confirmed_absent: absent } : {});
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx('flex flex-col gap-3 rounded-[18px] border px-6 py-4', recoverable || s.state === 'ownership' ? 'border-alert-strong/30 bg-alert-soft' : 'border-line bg-white')}>
      <div className="flex flex-wrap items-center gap-3">
        <StateBadge state={s.state} />
        <span role={processing ? 'status' : undefined} className="text-sm text-ink-2">{s.error || (processing ? waiting : stateLabel(s.state))}</span>
        {s.job && <span className="font-mono text-xs text-subtle">{s.job}</span>}
      </div>
      {processing && <ProgressTrack label="자동 검토 진행" />}
      {s.polling_delayed && (
        <p className="text-sm tabular-nums">마지막 조회 시각 · {lastPoll
          ? <time dateTime={lastPoll.toISOString()}>{lastPoll.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' })}</time>
          : '기록 없음'}</p>
      )}
      {!isDemoBackend && s.state === 'paused' && s.attempts > 0 && (
        <p className="text-sm tabular-nums">총 {s.attempts}회 시도 (최초 1회, 재시도 {s.attempts - 1}회)</p>
      )}
      {s.state === 'ownership' && (
        <Link to="/assign" className={cx(buttonStyles.outline, 'self-start')}>
          팀 배정 확인으로
        </Link>
      )}
      {recoverable && (
        <div className="flex flex-wrap items-end gap-3">
          {s.state === 'uncertain' && (
            <>
              <label className="flex flex-[1_1_240px] flex-col gap-1.5 text-xs text-muted">
                Studio 실행 이력에서 찾은 Job ID
                <input value={job} onChange={(e) => setJob(e.target.value)} placeholder="job_..." className={cx(inputStyle, 'font-mono')} />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={absent} onChange={(e) => setAbsent(e.target.checked)} className="size-4 accent-brand" />
                이력에 Job이 없음을 확인함
              </label>
            </>
          )}
          <button type="button" disabled={busy || (s.state === 'uncertain' && !job.trim() && !absent)} onClick={retry} className={buttonStyles.outline}>
            처리 재개
          </button>
        </div>
      )}
      <Feedback error={error} />
    </div>
  );
}

/** 담당자 검토 결론 기록 */
function DecisionCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const { dashboard } = useEvent();
  const [decision, setDecision] = useState<Decision | ''>(s.decision ?? '');
  const [note, setNote] = useState(s.note);
  const [issues, setIssues] = useState<string[]>(s.result?.issues ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = !!s.decision;
  const canSave = s.state === 'done' && !s.held && s.current === s.id;
  const needsNote = s.verdict === '담당자확인' && !!decision;
  const supplementMail = dashboard?.mail.find(mail => isSupplementMail(mail, s.id))
    ?? s.mail?.find(mail => isSupplementMail(mail, s.id));
  const mailAction = canSave && s.decision !== '승인' && (s.decision === '보완 필요' || s.verdict === '재제출요청')
    ? supplementMailAction(s.id, supplementMail)
    : null;

  async function save(final: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await saveReview(
        s.id,
        reviewBody(s, {
          decision: final && decision ? decision : s.decision ?? '작성 중',
          note,
          issues: decision === '보완 필요' ? issues : s.result?.issues ?? [],
        }),
      );
      setMessage(final && decision && !locked ? decidedMessage(s, decision) : '저장했습니다.');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="team-review-card">
      <h2 className="team-review-card-title">담당자 검토</h2>
      <fieldset disabled={!canSave || busy} className="flex flex-col gap-3.5">
        <div role="radiogroup" aria-label="검토 결론" className="grid gap-2.5">
          {(['승인', '보완 필요'] as Decision[]).map((d) => (
            <label
              key={d}
              className={cx(
                'team-review-decision',
                (locked ? decision !== d : d === '승인' && s.verdict === '재제출요청') && 'cursor-not-allowed opacity-40',
              )}
              data-selected={decision === d}
            >
              <input
                type="radio"
                name="decision"
                value={d}
                checked={decision === d}
                disabled={locked || (d === '승인' && s.verdict === '재제출요청')}
                onChange={() => setDecision(d)}
                className="size-[18px] shrink-0 accent-brand-strong"
              />
              {d === '승인' ? '서류 승인' : d}
            </label>
          ))}
        </div>
        {s.verdict === '재제출요청' && !locked && <p className="text-xs text-muted">재제출요청 판정은 보완본을 받아 다시 검토한 뒤 승인할 수 있습니다.</p>}
        {locked && <p className="text-xs text-muted">이미 저장한 검토 결과를 바꾸려면 보완 서류를 올리세요.</p>}
        {decision === '보완 필요' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-muted">팀장에게 안내할 보완 항목</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(issueLabels).map(([key, label]) => (
                <label key={key} className="flex min-h-9 items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={issues.includes(key)}
                    onChange={(e) => setIssues((list) => (e.target.checked ? [...list, key] : list.filter((k) => k !== key)))}
                    className="size-4 accent-brand"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          확인 메모{needsNote && <span className="text-caution"> · 원본과 대조한 결과를 한 줄로 기록해 주세요</span>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} className={cx(inputStyle, 'h-auto py-2.5 leading-relaxed')} />
        </label>
        <div className="team-review-decision-actions">
          {!locked && (
            <button type="button" disabled={!decision} onClick={() => save(true)} className={cx(buttonStyles.primary, 'min-h-11 text-sm')}>
              {workflowLabels.saveReview}
            </button>
          )}
          <button type="button" disabled={locked && note === s.note} onClick={() => save(false)} className={buttonStyles.secondary}>
            {locked ? '메모 저장' : '임시 저장'}
          </button>
        </div>
      </fieldset>
      {mailAction && <Link to={mailAction.to} className={cx(buttonStyles.outline, 'self-start')}>{mailAction.label}</Link>}
      {s.decision === '승인' && canSave && <Link to="/report" className={cx(buttonStyles.text, 'self-start')}>지급 보고서에서 지급 정보 입력 →</Link>}
      {s.state !== 'done' && <p className="text-xs text-subtle">Studio 판정이 끝난 뒤 기록할 수 있습니다.</p>}
      <Feedback error={error} message={message} />
    </div>
  );
}

function MembersCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const members = s.fields.members;
  const r = s.fields.recipient;
  const value = (v?: string) => v?.trim() ? v : '미확인';
  return (
    <details open={Boolean(s.result?.extraction_warnings?.length)} className="team-review-members">
      <summary className="team-review-card-title cursor-pointer">명단·지급 정보 대조</summary>
      {s.result?.extraction_warnings?.map((warning) => (
        <p key={warning} className="mt-3 text-sm text-caution">{warning}</p>
      ))}
      {members.length === 0 ? (
        <p className="text-sm text-muted">추출된 명단이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-muted">
                {['구분', '성명', '학번', '전공', '학교'].map((h) => (
                  <th key={h} scope="col" className="border-b border-line px-2 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="px-2 py-2">{m.role}</td>
                  <td className={cx('px-2 py-2', !m.name && 'text-alert-strong')}>{value(m.name)}</td>
                  <td className={cx('px-2 py-2 font-mono', !m.student_id && 'text-alert-strong')}>{value(m.student_id)}</td>
                  <td className="px-2 py-2">{value(m.major)}</td>
                  <td className="px-2 py-2">{value(m.school)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">은행·계좌</dt>
        <dd className="font-mono">{[value(r.bank_name), value(r.account_number)].join(' ')}</dd>
        <dt className="text-muted">예금주</dt>
        <dd>{value(r.account_holder)}</dd>
        <dt className="text-muted">주민번호 표기</dt>
        <dd className="font-mono">{value(r.rrn_display)}</dd>
      </dl>
      {s.result?.extracted && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-bold">Upstage 추출 원본값</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3 text-xs">{JSON.stringify({ values: s.result.extracted, sources: s.result.extraction_sources }, null, 2)}</pre>
        </details>
      )}
      {s.state === 'done' && s.id === s.current && !s.held && (
        <details className="mt-4">
          <summary className={buttonStyles.text}>원본 대조값 수정</summary>
          <ExtractionEditor s={s} onSaved={onSaved} />
        </details>
      )}
      <p className="mt-3 text-xs text-subtle">명단·계좌는 원본에서 읽은 값입니다. 원본이 틀렸다면 보완본을 받아 교체해 주세요.</p>
    </details>
  );
}

function ExtractionEditor({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const [members, setMembers] = useState<Member[]>(s.fields.members);
  const [recipient, setRecipient] = useState<Recipient>(s.fields.recipient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const memberFields = { name: '성명', student_id: '학번', major: '전공', school: '학교' } as const;
  const recipientFields = { bank_name: '은행', account_number: '계좌번호', account_holder: '예금주', rrn_display: '마스킹 주민번호' } as const;
  function edit(index: number, key: keyof Member, value: string) {
    setMembers((list) => list.map((person, i) => i === index ? { ...person, [key]: value } : person));
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await saveReview(s.id, reviewBody(s, { members, recipient }));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={busy} className="grid gap-3 pt-3">
      {members.map((m, i) => (
        <div key={i} className="grid gap-2 border-b border-line-soft pb-3 sm:grid-cols-2">
          <label>구분<select className={inputStyle} value={m.role} onChange={(e) => edit(i,'role',e.target.value)}>
            <option>대표</option><option>팀원</option>
          </select></label>
          {(Object.keys(memberFields) as (keyof typeof memberFields)[]).map((key) => <label key={key}>{memberFields[key]}
            <input className={inputStyle} value={m[key]} onChange={(e) => edit(i,key,e.target.value)} /></label>)}
          <button type="button" className={buttonStyles.text} onClick={() => setMembers(members.filter((_, n) => n !== i))}>이 행 삭제</button>
        </div>
      ))}
      <button type="button" className={buttonStyles.outline} onClick={() => setMembers([...members,
        { role: members.length ? '팀원' : '대표', name: '', student_id: '', major: '', school: '' }])}>명단 행 추가</button>
      {(Object.keys(recipientFields) as (keyof typeof recipientFields)[]).map((key) => <label key={key}>{recipientFields[key]}
        <input className={inputStyle} value={recipient[key] ?? ''} onChange={(e) => setRecipient({ ...recipient, [key]: e.target.value })} /></label>)}
      <button type="button" onClick={save} className={buttonStyles.secondary}>대조값 저장</button>
      <Feedback error={error} />
    </fieldset>
  );
}

function HistoryCard({ s }: { s: SubmissionDetail }) {
  return (
    <section className="team-review-history">
      <h2 className="team-review-card-title">제출 버전과 기록</h2>
      <ol className="team-review-versions">
        {s.history.map((h) => (
          <li key={h.id}>
            <Link
              to={`/teams/${h.id}`}
              className={cx('team-review-version', h.id === s.id && 'bg-brand-tint font-bold')}
            >
              <span className="font-mono">v{h.version}</span>
              <StateBadge state={h.state} />
              {h.decision && <span className="text-xs text-muted">{h.decision}</span>}
              {h.id === s.current && <span className="ml-auto text-xs text-brand-strong">현재</span>}
            </Link>
          </li>
        ))}
      </ol>
      {s.audit.length > 0 && (
        <ul className="team-review-audit">
          {s.audit.map((a, i) => (
            <li key={i}>
              {when(a.ts)} · {a.action}
              {a.http_status && !a.action.includes(`HTTP ${a.http_status}`) && ` · HTTP ${a.http_status}`}
              {a.error_code && ` · ${a.error_code}`}
              {a.attempts != null && a.attempts > 0 && ` · ${a.attempts}번째 시도`} · {a.actor}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
