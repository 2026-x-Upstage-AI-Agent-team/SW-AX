import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Link } from '../components/workspaceNavigation';
import { workflowLabels } from '../components/workspaceMenu';
import { when } from '../api/labels';
import {
  getMail,
  getSubmission,
  isLeaderMail,
  isMailDraft,
  retryMail,
  saveMailDraft,
  setTeamEmail,
  type Dashboard,
  type MailRow,
  type MailView,
  type SubmissionDetail,
} from '../api/service';
import { Page } from '../components/Layout';
import { Feedback, Notice, PageHeader, StateBadge, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';
import { isSupplementMail } from '../hooks/reviewQueue';

type Tab = 'drafts' | 'leader';
const mailPanel = 'surface flex min-h-28 min-w-0 flex-col gap-3.5 p-[clamp(18px,2vw,24px)]';

export default function Mail() {
  const [search] = useSearchParams();
  const requested = search.get('mail');
  const supplement = search.get('supplement');
  return <MailWorkspace key={search.toString()} requested={requested} supplement={supplement} />;
}

function MailWorkspace({ requested, supplement }: { requested: string | null; supplement: string | null }) {
  const { dashboard, dashboardError, refresh } = useEvent();
  const [tab, setTab] = useState<Tab>();
  const [picked, setPicked] = useState('');
  const [message, setMessage] = useState('');
  const mail = dashboard?.mail.filter(m => supplement ? isSupplementMail(m, supplement) : isLeaderMail(m)) ?? [];
  const drafts = mail.filter(isMailDraft);
  const requestedMail = requested ? mail.find(m => m.id === requested) : undefined;
  const showAll = requestedMail ? !isMailDraft(requestedMail) : !!supplement && drafts.length === 0 && mail.length > 0;
  const activeTab = tab ?? (showAll ? 'leader' : 'drafts');
  const list = activeTab === 'drafts' ? drafts : mail;
  const selected = list.find(m => m.id === (picked || requested)) ?? (requested && !tab ? undefined : list[0]);
  const noEmail = dashboard?.teams.filter(t => !t.email && t.submission && (!supplement || t.submission.id === supplement)) ?? [];

  return (
    <Page width="review">
      <PageHeader title={workflowLabels.mail} lead="팀장에게 보낼 안내의 수신자와 내용을 확인하세요. ‘승인 후 발송’을 누르면 메일을 보냅니다."
        side={supplement && <Link to="/mail" className={buttonStyles.outline}>전체 팀 메일 보기</Link>} />

      {!dashboard ? (
        <Notice error={dashboardError} onRetry={refresh} />
      ) : (
        <>
          {dashboard.smtp && !dashboard.mail_ready && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-xl border border-caution-line bg-caution-bg py-2.5 pl-[18px] pr-3 text-sm">
              <span className="flex-[1_1_320px] font-medium">발신 계정 연결을 기다리고 있습니다. 승인한 메일은 계정이 연결되면 발송됩니다.</span>
              <Link to="/gmail" className="action border border-caution-line bg-white text-brand-strong">Gmail 연결</Link>
            </div>
          )}
          {message && <Feedback message={message} />}

          <div className="@container flex flex-col gap-4">
            <div role="group" aria-label="메일 보기" className="segments self-start">
              {(
                [
                  ['drafts', `승인 대기 ${drafts.length}`],
                  ['leader', `전체 메일 ${mail.length}`],
                ] as Array<[Tab, string]>
              ).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={activeTab === key} className="segment"
                  onClick={() => { setTab(key); setMessage(''); }}>
                  {label}
                </button>
              ))}
            </div>

            <div className="grid items-start gap-5 @min-[52rem]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                <section aria-labelledby="mail-list-h" className={mailPanel}>
                  <h2 id="mail-list-h" className="panel-title">메일 목록</h2>
                  {list.length === 0 ? (
                    <p key={activeTab} className="motion-results text-sm text-muted">
                      {supplement && mail.length === 0 ? '이 제출본의 보완 요청 메일이 아직 준비되지 않았습니다.' : activeTab === 'drafts' ? '승인을 기다리는 메일이 없습니다.' : '아직 만들어진 메일이 없습니다.'}
                    </p>
                  ) : (
                    <ul key={activeTab} aria-label={activeTab === 'drafts' ? '승인 대기 메일' : '팀장 안내 메일'} className="motion-results flex flex-col gap-1">
                      {list.map((m) => (
                        <li key={m.id}>
                          <button type="button" aria-current={selected?.id === m.id ? 'true' : undefined}
                            onClick={() => { setPicked(m.id); setMessage(''); }}
                            className={cx('flex w-full flex-col items-start gap-1.5 rounded-[10px] border-[1.5px] p-3 text-left',
                              selected?.id === m.id ? 'border-brand-strong bg-brand-tint' : 'border-transparent hover:bg-line-soft')}>
                            <span className="flex flex-wrap items-center gap-2 text-sm">
                              {m.name && <strong>{m.name}{m.version ? ` v${m.version}` : ''}</strong>}
                              <span>{m.kind}</span>
                              <StateBadge state={m.state} />
                            </span>
                            <span className="text-xs text-muted">
                              {m.sent_to && m.sent_to + ' · '}초안 생성 {when(m.created)}
                              {['sent', 'local'].includes(m.state) && (m.sent_at ? ' · 발송 ' + when(m.sent_at) : ' · 발송 시각 기록 없음')}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {noEmail.length > 0 && <EmailList teams={noEmail} onSaved={refresh} />}
              </div>

              <section aria-labelledby="draft-h" className={mailPanel}>
                {selected ? (
                  <MailDetail key={selected.id + ':' + selected.state} m={selected} emailTeamId={noEmail.find(t => t.submission?.id === selected.submission)?.id}
                    onSaved={refresh} onApproved={setMessage} />
                ) : (
                  <>
                    <h2 id="draft-h" className="panel-title">초안 검토</h2>
                    <p className="motion-results text-sm text-muted">{requested && !requestedMail
                      ? '요청한 메일을 찾을 수 없습니다. 목록에서 확인할 메일을 선택하세요.'
                      : '목록에서 메일을 고르면 내용이 여기에 표시됩니다.'}</p>
                  </>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

function MailDetail({ m, emailTeamId, onSaved, onApproved }: {
  m: MailRow; emailTeamId?: string; onSaved: () => void; onApproved: (message: string) => void;
}) {
  const [view, setView] = useState<MailView>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);
  const editable = view && isMailDraft(m) && isMailDraft(view);

  useEffect(() => {
    let alive = true;
    getMail(m.id).then(
      (data) => alive && setView(data),
      (err: Error) => alive && setError(err.message),
    ).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [m.id]);

  async function save(approve: boolean) {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await saveMailDraft(view, approve);
      setView(saved);
      if (approve) onApproved(`${m.name ?? ''} ${m.kind} 메일의 발송을 승인했습니다. 수신자 · ${saved.recipient}`);
      else setMessage('초안을 저장했습니다.');
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function retry() {
    setError('');
    setBusy(true);
    try {
      await retryMail(m.id, confirm);
      setConfirm(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="draft-h" className="panel-title">{isMailDraft(m) ? '초안 검토' : '메일 내용'}</h2>
        <span className="text-[13px] text-muted">{m.name}{m.version ? ` v${m.version}` : ''} · {m.kind}</span>
      </div>
      {!view ? (
        error ? <Feedback error={error} /> : <p role="status" className="text-sm text-muted">불러오는 중…</p>
      ) : (
        <div className="motion-results flex flex-col gap-3.5">
          <p className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            받는 사람<strong className="break-all">{view.recipient || view.sent_to || '주소 확인 필요'}</strong>
            {m.state === 'recipient_check' && emailTeamId && (
              <button type="button" className={buttonStyles.text} onClick={() => document.getElementById('team-email-' + emailTeamId)?.focus()}>
                수신 주소 확인
              </button>
            )}
          </p>
          {m.state === 'recipient_check' && !emailTeamId && <RecipientCheck submission={m.submission} onSaved={onSaved} />}
          {editable ? (
            <>
              <label className="flex flex-col gap-1.5 text-sm font-bold">제목
                <input className={cx(inputStyle, 'font-normal')} value={view.subject} maxLength={255} disabled={busy}
                  onChange={(e) => { setView({ ...view, subject: e.target.value }); setMessage(''); }} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-bold">본문
                <textarea className={cx(inputStyle, 'h-auto py-2.5 font-normal leading-relaxed')} rows={10} value={view.body} maxLength={50000} disabled={busy}
                  onChange={(e) => { setView({ ...view, body: e.target.value }); setMessage(''); }} />
              </label>
              <p className="text-xs text-muted">주민번호·계좌번호·학번과 다른 팀의 정보는 본문에서 제외해 주세요.</p>
              {!view.can_approve && <p className="text-sm font-medium text-caution">발송하려면 현재 제출본과 수신 주소를 확인해 주세요.</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={buttonStyles.secondary} onClick={() => save(false)}
                  disabled={busy || !view.subject.trim() || !view.body.trim()}>초안 저장</button>
                <button type="button" className={buttonStyles.primary} onClick={() => save(true)}
                  disabled={busy || !view.can_approve || !view.subject.trim() || !view.body.trim()}>승인 후 발송</button>
              </div>
            </>
          ) : (
            <div className="rounded-xl bg-canvas p-4 text-sm leading-relaxed text-ink-2">
              {view.subject && <strong className="mb-1 block text-ink">{view.subject}</strong>}
              <p className="whitespace-pre-line">{view.body}</p>
              {view.approved_by && <p className="mt-2 text-xs text-muted">발송 승인 · {view.approved_by} · {when(view.approved_at)}</p>}
            </div>
          )}
        </div>
      )}
      {(m.state === 'failed' || m.state === 'uncertain') && (
        <div className="flex flex-wrap items-center gap-3">
          {m.state === 'uncertain' && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="size-4 accent-brand" />
              받은편지함·발송함에서 미발송을 확인함
            </label>
          )}
          <button type="button" onClick={retry} disabled={busy || (m.state === 'uncertain' && !confirm)} className={buttonStyles.text}>
            초안으로 다시 열기
          </button>
        </div>
      )}
      {view && <Feedback error={error} message={message} />}
    </>
  );
}

/** 등록 주소와 신청서 주소가 달라 보류된 안내: 처음 첨부한 파일를 대조해 이 제출본의 수신 주소를 확인한다. */
function RecipientCheck({ submission, onSaved }: { submission: string; onSaved: () => void }) {
  const [detail, setDetail] = useState<SubmissionDetail>();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getSubmission(submission).then(
      (s) => { if (alive) { setDetail(s); setEmail(s.email); } },
      (err: Error) => alive && setError(err.message),
    );
    return () => { alive = false; };
  }, [submission]);

  async function save() {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      await setTeamEmail(detail.team, email.trim(), detail.id);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <Feedback error={error} />;
  const current = detail.id === detail.current && !detail.held && detail.state === 'done';
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-caution-line bg-caution-bg p-4">
      {detail.application_emails && (
        <p className="break-all text-sm text-ink-2">신청서 대표 이메일 · {detail.application_emails.join(', ') || '미확인'}</p>
      )}
      <p className="text-sm text-caution">처음 첨부한 파일와 신청서를 대조해 수신 주소를 확인한 뒤 초안을 승인해 주세요.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-[1_1_220px] flex-col gap-1.5 text-xs text-muted">
          팀장 이메일 (처음 첨부한 파일에서 확인한 주소 한 개)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy || !current} className={inputStyle} />
        </label>
        <button type="button" onClick={save} disabled={busy || !current || !email.trim()} className={buttonStyles.secondary}>
          이 제출본의 수신 주소 확인
        </button>
      </div>
      {!current && <p className="text-xs text-muted">현재 팀의 판정이 끝난 제출본에서만 주소를 확인할 수 있습니다.</p>}
      <Feedback error={error} />
    </div>
  );
}

function EmailList({ teams, onSaved }: { teams: Dashboard['teams']; onSaved: () => void }) {
  return (
    <section aria-labelledby="missing-h" className="surface flex flex-col gap-3 p-[18px_20px_20px]">
      <div className="flex flex-col gap-1">
        <h2 id="missing-h" tabIndex={-1} className="panel-title">이메일이 없는 팀 {teams.length}</h2>
        <p className="text-[13px] text-muted">이 팀들의 안내는 주소를 확인할 때까지 발송을 기다립니다. 처음 첨부한 파일에서 확인한 주소 한 개를 넣어 주세요.</p>
      </div>
      <ul className="flex flex-col gap-3">
        {teams.map((t) => (
          <EmailRow key={t.id} id={t.id} name={t.name} onSaved={onSaved} />
        ))}
      </ul>
    </section>
  );
}

function EmailRow({ id, name, onSaved }: { id: string; name: string; onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await setTeamEmail(id, email.trim());
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = 'team-email-' + id;
  return (
    <li className="flex flex-col gap-1.5">
      <label htmlFor={field} className="text-sm font-bold">{name}</label>
      <div className="flex gap-2">
        <input id={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className={cx(inputStyle, 'min-w-0 flex-1')} />
        <button type="button" onClick={save} disabled={busy || !email.trim()} aria-label={`${name} 팀장 이메일 저장`} className={buttonStyles.secondary}>
          저장
        </button>
      </div>
      <Feedback error={error} />
    </li>
  );
}
