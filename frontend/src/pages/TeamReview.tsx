import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAsync, usePolling } from '../api/client';
import { busyStates, docLabels, issueLabels, recoverableStates, stateLabel, when } from '../api/labels';
import {
  filePreviewUrl,
  getSubmission,
  retrySubmission,
  reviewBody,
  saveReview,
  setTeamEmail,
  type Decision,
  type DocKey,
  type Member,
  type Recipient,
  type Ref,
  type SubmissionDetail,
} from '../api/service';
import { Page } from '../components/Layout';
import MailItem from '../components/MailItem';
import {
  CheckIcon,
  Feedback,
  Notice,
  PdfFrame,
  StateBadge,
  VerdictBadge,
  buttonStyles,
  checkState,
  cx,
  inputStyle,
} from '../components/ui';
import { useEvent } from '../context/EventContext';

const DOC_KEYS: DocKey[] = ['01', '02', '03', '?'];

export default function TeamReview() {
  const { id = '' } = useParams();
  const { revision, refresh } = useEvent();
  const result = useAsync(() => getSubmission(id), [id, revision]);
  const submission = result.data?.id === id ? result.data : undefined;
  const slow = !!submission && (recoverableStates.has(submission.state) || !!submission.error);
  usePolling(!!submission && (busyStates.has(submission.state) || (slow && submission.state !== 'failed')), refresh, slow ? 15000 : 3000);

  return (
    <Page tone="gray">
      <div className="flex flex-col gap-3.5">
        <Link to="/" className="text-sm text-brand-strong hover:text-brand-deep">
          ← 업무 현황
        </Link>
        {!submission ? <Notice error={result.error} onRetry={result.reload} /> : <Review key={submission.id} s={submission} onSaved={refresh} />}
      </div>
    </Page>
  );
}

function Review({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const res = s.result;
  const docs = res?.documents;
  const firstIssue = res?.checks.find((c) => c.passed !== true && c.refs.length);
  const initialRef = firstIssue?.refs[0] ?? DOC_KEYS.map((k) => docs?.[k]?.[0]).find(Boolean);
  const [view, setView] = useState<Partial<Ref>>(initialRef ?? { id: s.files[0]?.id });
  const previewPanel = useRef<HTMLElement>(null);
  const file = s.files.find((f) => f.id === view.id);
  const fileDoc = (fid?: string) => DOC_KEYS.find((k) => docs?.[k]?.some((r) => r.id === fid)) ?? (s.files.find((f) => f.id === fid)?.kind as DocKey | undefined);
  const activeDoc = fileDoc(view.id);
  const outdated = s.current !== s.id;

  function showEvidence(ref?: Ref) {
    setView(ref ?? {});
    previewPanel.current?.focus();
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">{s.team_name}</h1>
        <span className="text-[13px] text-subtle">
          {s.rep && `대표 ${s.rep} · `}
          <span className="font-semibold tabular-nums">제출 v{s.version}</span> · 원본 {s.count}개
        </span>
        {s.state === 'done' && s.verdict ? <VerdictBadge verdict={s.verdict} size="md" /> : <StateBadge state={s.state} size="md" />}
        {s.decision && (
          <span className={cx('rounded-full border px-3 py-1.5 text-[13px] font-bold', s.decision === '승인' ? 'border-brand text-brand-strong' : 'border-alert-strong text-alert-strong')}>
            담당자 {s.decision}
          </span>
        )}
        <div className="flex-auto" />
        {!outdated && (
          <Link to={`/intake?base=${s.id}`} className={cx(buttonStyles.primary, 'min-h-11 px-5 text-sm')}>
            보완본 접수
          </Link>
        )}
      </div>
      {res?.reason && <p className="max-w-4xl text-[17px] leading-relaxed text-ink-2">{res.reason}</p>}
      {s.held && <Feedback error="이 팀에 속할 수 있는 미배정 파일이 있어 검토 저장과 안내가 보류됩니다. 팀 배정 확인에서 먼저 정리해 주세요." />}
      {s.state !== 'done' && <StatusCard s={s} onSaved={onSaved} />}

      <div className="mt-4 flex flex-wrap items-start gap-6">
        <section ref={previewPanel} id="review-preview" tabIndex={-1} aria-label="원문 미리보기" className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-[22px] border border-line bg-white">
          <div role="tablist" aria-label="서류" className="flex flex-wrap gap-1 border-b border-line px-4 py-3">
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
                    'min-h-10 rounded-[10px] px-3.5 text-[13px] disabled:cursor-not-allowed',
                    activeDoc === k ? 'bg-ink font-bold text-white' : refs.length ? 'text-muted hover:bg-canvas' : 'text-alert-strong',
                  )}
                >
                  {k === '?' ? '기타' : k} {docLabels[k]}
                  {refs.length === 0 && ' · 없음'}
                  {refs.length > 1 && ` · ${refs.length}건`}
                </button>
              );
            })}
            <button type="button" role="tab" aria-selected={!file} onClick={() => setView({})}
              className={cx('min-h-10 rounded-[10px] px-3.5 text-[13px]', !file ? 'bg-ink font-bold text-white' : 'text-muted hover:bg-canvas')}>
              확정 파일 목록
            </button>
          </div>
          {activeDoc && (docs?.[activeDoc]?.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2">
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
          <div className="flex flex-col gap-2 bg-paper p-3 sm:p-5">
            {file ? (<>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span className="file-name text-ink">
                  {file.name} {view.page ? `· ${view.page}쪽` : ''} {view.row ? `· ${view.row}행` : ''}
                </span>
                {file.url && (
                  <a href={filePreviewUrl(file, view.page)} target="_blank" rel="noreferrer" className="font-bold text-brand-strong">
                    새 창으로 열기
                  </a>
                )}
              </div>
              <PdfFrame key={`${file.id}-${view.page}`} url={filePreviewUrl(file, view.page)} title={file.name} />
            </>) : (
              <section aria-label="확정 파일 목록" className="rounded-xl bg-white p-4">
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
        </section>

        <aside aria-label="검토 체크리스트" className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
          <div className="rounded-[22px] border border-line bg-white py-2">
            <h2 className="px-[22px] pb-2 pt-4 text-[17px] font-extrabold">검토 항목</h2>
            {!res ? (
              <p className="px-[22px] pb-4 text-sm text-muted">Studio 판정이 끝나면 항목이 표시됩니다.</p>
            ) : (
              <ul>
                {[...res.checks]
                  .sort((a, b) => rank(a.passed) - rank(b.passed))
                  .map((c, i) => {
                    const st = checkState(c.passed);
                    return (
                      <li key={c.label + i} className={cx('border-t border-line-soft px-[22px] py-3', st === 'fail' && 'bg-alert-soft', st === 'check' && 'bg-caution-bg')}>
                        <div className="flex items-center gap-3">
                          <CheckIcon state={st} />
                          <span className="text-sm font-medium text-ink">{c.label}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 pl-7">
                          {c.refs.length ? c.refs.map((r, j) => {
                            const kind = fileDoc(r.id) ?? '?';
                            const copies = docs?.[kind] ?? [];
                            const copy = copies.findIndex((entry) => entry.id === r.id);
                            return (
                              <button key={j} type="button" aria-controls="review-preview" onClick={() => showEvidence(r)}
                                className={buttonStyles.text}>
                                {kind} {docLabels[kind]}{copies.length > 1 && copy >= 0 && ` (${copy + 1}번째)`} · {r.page}쪽{r.row && ` · ${r.row}행`}
                              </button>
                            );
                          }) : (
                            <button type="button" aria-controls="review-preview" onClick={() => showEvidence()} className={buttonStyles.text}>
                              확정 파일 목록 보기
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
          {typeof res?.staff_report === 'string' && res.staff_report.trim() && (
            <details className="rounded-[22px] border border-line bg-white px-[22px] py-4">
              <summary className="cursor-pointer text-[15px] font-extrabold">Studio 검토보고서</summary>
              <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-ink-2">{res.staff_report}</p>
            </details>
          )}
          <DecisionCard key={s.revision} s={s} onSaved={onSaved} />
          <LeaderCard s={s} onSaved={onSaved} />
        </aside>
      </div>

      <div className="mt-2 flex flex-wrap items-start gap-6">
        <MembersCard key={s.revision} s={s} onSaved={onSaved} />
        <HistoryCard s={s} />
      </div>
    </>
  );
}

/** 결론을 기록했을 때 실제로 일어나는 일 (service/app.py save_review 기준) */
function decidedMessage(s: SubmissionDetail, d: Decision) {
  if (s.verdict === '담당자확인') return `‘${d}’으로 기록했습니다. 팀장에게 ${d === '승인' ? '검토 완료' : '보완 요청'} 안내 한 통이 발송됩니다.`;
  if (d === '보완 필요') return '‘보완 필요’로 기록했습니다. 선택한 항목으로 팀장에게 보완 요청 메일이 발송됩니다.';
  return '승인했습니다. 시상구분·지원액을 넣으면 보고서에 편철할 수 있습니다.';
}

const rank = (p: boolean | null) => (p === false ? 0 : p === null ? 1 : 2);

/** 판정 전·실패 상태 안내와 재개 */
function StatusCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const [job, setJob] = useState('');
  const [absent, setAbsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recoverable = recoverableStates.has(s.state);

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
        <span className="text-sm text-ink-2">{s.error || (busyStates.has(s.state) ? 'Studio 판정을 기다리는 중입니다. 화면이 자동으로 새로고침됩니다.' : stateLabel(s.state))}</span>
        {s.job && <span className="font-mono text-xs text-subtle">{s.job}</span>}
      </div>
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
  const [decision, setDecision] = useState<Decision | ''>(s.decision ?? '');
  const [note, setNote] = useState(s.note);
  const [issues, setIssues] = useState<string[]>(s.result?.issues ?? []);
  const [award, setAward] = useState(s.fields.award_type ?? '');
  const [support, setSupport] = useState(s.fields.support_amount ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = !!s.decision;
  const canSave = s.state === 'done' && !s.held && s.current === s.id;
  const needsNote = s.verdict === '담당자확인' && !!decision;

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
          award_type: award,
          support_amount: support.replace(/\s/g, ''),
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
    <div className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-white p-[22px]">
      <h2 className="text-[17px] font-extrabold">담당자 검토</h2>
      <fieldset disabled={!canSave || busy} className="flex flex-col gap-3.5">
        <div role="radiogroup" aria-label="검토 결론" className="grid grid-cols-2 gap-2">
          {(['승인', '보완 필요'] as Decision[]).map((d) => (
            <label
              key={d}
              className={cx(
                'flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border text-sm',
                decision === d ? (d === '승인' ? 'border-brand bg-brand-tint font-bold text-brand-deep' : 'border-alert-strong bg-alert-soft font-bold text-alert-strong') : 'border-line-2',
                (locked ? decision !== d : d === '승인' && s.verdict === '재제출요청') && 'cursor-not-allowed opacity-40',
              )}
            >
              <input
                type="radio"
                name="decision"
                value={d}
                checked={decision === d}
                disabled={locked || (d === '승인' && s.verdict === '재제출요청')}
                onChange={() => setDecision(d)}
                className="sr-only"
              />
              {d}
            </label>
          ))}
        </div>
        {s.verdict === '재제출요청' && !locked && <p className="text-xs text-muted">재제출요청 판정은 보완본을 받아 다시 검토한 뒤 승인할 수 있습니다.</p>}
        {locked && <p className="text-xs text-muted">이미 안내한 결론은 바꿀 수 없습니다. 바꾸려면 보완본을 접수하세요.</p>}
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
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            시상구분
            <input value={award} onChange={(e) => setAward(e.target.value)} placeholder="미확인" maxLength={60} className={inputStyle} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            지원액(원)
            <input value={support} onChange={(e) => setSupport(e.target.value)} placeholder="미확인" inputMode="numeric" className={cx(inputStyle, 'font-mono')} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {!locked && (
            <button type="button" disabled={!decision} onClick={() => save(true)} className={cx(buttonStyles.primary, 'min-h-11 text-sm')}>
              결론 기록
            </button>
          )}
          <button type="button" onClick={() => save(false)} className={buttonStyles.secondary}>
            {locked ? '지급 정보 저장' : '임시 저장'}
          </button>
        </div>
      </fieldset>
      {s.state !== 'done' && <p className="text-xs text-subtle">Studio 판정이 끝난 뒤 기록할 수 있습니다.</p>}
      <Feedback error={error} message={message} />
    </div>
  );
}

/** 팀장 이메일과 안내 메일 */
function LeaderCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const [email, setEmail] = useState(s.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const current = s.id === s.current;
  const canConfirm = current && !s.held && s.state === 'done' && s.email_needs_confirmation !== undefined;
  const confirmAddress = canConfirm && s.email_needs_confirmation;
  useEffect(() => setEmail(s.email), [s.email]);

  async function saveEmail() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await setTeamEmail(s.team, email.trim(), confirmAddress && email.trim() ? s.id : undefined);
      setMessage(email.trim() ? '팀장 수신 주소를 저장했습니다.' : '팀장 안내는 수신 주소 확인을 기다립니다.');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[22px] border border-line bg-white p-[22px]">
      <h2 className="text-[17px] font-extrabold">팀장 안내</h2>
      {s.state === 'done' && s.application_emails && (
        <p className="break-all text-sm text-ink-2">신청서 대표 이메일 · {s.application_emails.join(', ') || '확인된 주소 없음'}</p>
      )}
      {confirmAddress && (
        <p className="text-sm text-caution">원접수와 신청서를 대조해 수신 주소를 확인해 주세요. 이 제출본의 팀장 안내는 주소 확인 후 발송합니다.</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-[1_1_220px] flex-col gap-1.5 text-xs text-muted">
          팀장 이메일 (원접수에서 확인한 주소 한 개)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy || !current} className={inputStyle} />
        </label>
        <button type="button" onClick={saveEmail} disabled={busy || !current || (email.trim() === s.email && !(confirmAddress && email.trim()))} className={buttonStyles.secondary}>
          {confirmAddress ? '이 제출본의 수신 주소 확인' : '저장'}
        </button>
      </div>
      <Feedback error={error} message={message} />
      {s.mail.length === 0 ? (
        <p className="text-sm text-muted">{s.verdict === '성공' && s.version === 1 ? '최초 정상 제출이라 보낼 안내가 없습니다.' : '아직 만들어진 안내가 없습니다.'}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {s.mail.map((m) => (
            <MailItem key={m.id} m={m} onSaved={onSaved} />
          ))}
        </ul>
      )}
      <p className="text-xs text-subtle">원본 첨부, 주민번호·계좌번호·학번, 다른 팀 정보는 메일에 넣지 않습니다.</p>
    </div>
  );
}

function MembersCard({ s, onSaved }: { s: SubmissionDetail; onSaved: () => void }) {
  const members = s.fields.members;
  const r = s.fields.recipient;
  return (
    <section className="min-w-0 flex-[2_1_560px] rounded-[22px] border border-line bg-white p-[22px]">
      <h2 className="mb-3 text-[17px] font-extrabold">추출된 명단과 대표 지급 정보</h2>
      {members.length === 0 ? (
        <p className="text-sm text-muted">추출된 명단이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
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
                  <td className="px-2 py-2">{m.name}</td>
                  <td className={cx('px-2 py-2 font-mono', !m.student_id && 'text-alert-strong')}>{m.student_id || '비어 있음'}</td>
                  <td className="px-2 py-2">{m.major}</td>
                  <td className="px-2 py-2">{m.school}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">은행·계좌</dt>
        <dd className="font-mono">{[r.bank_name, r.account_number].filter(Boolean).join(' ') || '—'}</dd>
        <dt className="text-muted">예금주</dt>
        <dd>{r.account_holder || '—'}</dd>
        <dt className="text-muted">주민번호 표기</dt>
        <dd className="font-mono">{r.rrn_display || '—'}</dd>
      </dl>
      {s.state === 'done' && s.id === s.current && !s.held && (
        <details className="mt-4">
          <summary className={buttonStyles.text}>원본 대조값 수정</summary>
          <ExtractionEditor s={s} onSaved={onSaved} />
        </details>
      )}
      <p className="mt-3 text-xs text-subtle">명단·계좌는 원본에서 읽은 값입니다. 원본이 틀렸다면 보완본을 받아 교체해 주세요.</p>
    </section>
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
    <section className="min-w-0 flex-[1_1_320px] rounded-[22px] border border-line bg-white p-[22px]">
      <h2 className="mb-3 text-[17px] font-extrabold">제출 버전과 기록</h2>
      <ol className="flex flex-col gap-1.5">
        {s.history.map((h) => (
          <li key={h.id}>
            <Link
              to={`/teams/${h.id}`}
              className={cx('flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm', h.id === s.id ? 'bg-brand-tint font-bold' : 'hover:bg-canvas')}
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
        <ul className="mt-4 flex max-h-72 flex-col gap-1 overflow-y-auto border-t border-line-soft pt-3 text-xs text-muted">
          {s.audit.map((a, i) => (
            <li key={i}>
              {when(a.ts)} · {a.action}
              {a.http_status && !a.action.includes(`HTTP ${a.http_status}`) && ` · HTTP ${a.http_status}`}
              {a.error_code && ` · ${a.error_code}`} · {a.actor}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
