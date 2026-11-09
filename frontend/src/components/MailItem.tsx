import { useState } from 'react';
import { Link } from 'react-router';
import { when } from '../api/labels';
import { getMail, isMailDraft, retryMail, saveMailDraft, type MailRow, type MailView } from '../api/service';
import { Feedback, StateBadge, buttonStyles, cx, inputStyle } from './ui';

export default function MailItem({ m, onSaved, showTeam, onApproved }: {
  m: MailRow; onSaved: () => void; showTeam?: boolean; onApproved?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MailView>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setOpen(!open);
    setError('');
    setMessage('');
    if (open) return;
    setView(undefined);
    setBusy(true);
    try { setView(await getMail(m.id)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function save(approve: boolean) {
    if (!view || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await saveMailDraft(view, approve);
      setView(saved);
      if (approve) onApproved?.(`${m.name ?? ''} ${m.kind} 메일의 발송을 승인했습니다. 수신자 · ${saved.recipient}`);
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
      setOpen(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-[14px] bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {showTeam && m.name && <strong className="text-sm">{m.name}{m.version ? ` v${m.version}` : ''}</strong>}
        <span className={cx('text-sm', !showTeam && 'font-bold')}>{m.kind}</span>
        <StateBadge state={m.state} />
        {showTeam && m.state === 'recipient_check' && (
          <Link to={`/teams/${m.submission}`} className={buttonStyles.text}>수신 주소 확인</Link>
        )}
        <span className="text-xs text-subtle">
          {m.sent_to && m.sent_to + ' · '}초안 생성 {when(m.created)}
          {['sent', 'local'].includes(m.state) && (m.sent_at ? ' · 발송 ' + when(m.sent_at) : ' · 발송 시각 기록 없음')}
        </span>
        <button type="button" onClick={toggle} disabled={busy} aria-expanded={open} className={cx('ml-auto', isMailDraft(m) && showTeam ? buttonStyles.secondary : buttonStyles.text)}>
          {open ? '접기' : isMailDraft(m) && showTeam ? '초안 검토' : '본문 보기'}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-xl bg-white p-3 text-[13px] leading-relaxed text-ink-2">
          {view && showTeam && isMailDraft(m) && isMailDraft(view) ? (
            <div className="grid gap-3">
              <p>받는 사람 <strong className="ml-2 break-all">{view.recipient || '주소 확인 필요'}</strong></p>
              <div className="grid gap-1">
                <label className="font-semibold" htmlFor={`mail-subject-${m.id}`}>제목</label>
                <input id={`mail-subject-${m.id}`} className={inputStyle} value={view.subject} maxLength={255} disabled={busy}
                  onChange={e => { setView({ ...view, subject: e.target.value }); setMessage(''); }} />
              </div>
              <div className="grid gap-1">
                <label className="font-semibold" htmlFor={`mail-body-${m.id}`}>본문</label>
                <textarea id={`mail-body-${m.id}`} className={cx(inputStyle, 'leading-relaxed font-normal')} rows={8} value={view.body} maxLength={50000} disabled={busy}
                  onChange={e => { setView({ ...view, body: e.target.value }); setMessage(''); }} />
              </div>
              <p className="text-xs text-muted">주민번호·계좌번호·학번과 다른 팀의 정보는 본문에서 제외해 주세요.</p>
              {!view.can_approve && <p className="text-sm text-caution">발송하려면 현재 제출본과 수신 주소를 확인해 주세요.</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonStyles.secondary} onClick={() => save(false)}
                  disabled={busy || !view.subject.trim() || !view.body.trim()}>초안 저장</button>
                <button type="button" className={buttonStyles.primary} onClick={() => save(true)}
                  disabled={busy || !view.can_approve || !view.subject.trim() || !view.body.trim()}>승인 후 발송</button>
              </div>
            </div>
          ) : view ? (
            <>
              {view.subject && <strong className="mb-1 block text-ink">{view.subject}</strong>}
              <p className="whitespace-pre-line">{view.body}</p>
              {!showTeam && isMailDraft(m) && <Link to="/mail" className={buttonStyles.text}>이메일 발송에서 검토</Link>}
              {view.approved_by && <p className="mt-2 text-xs text-muted">발송 승인 · {view.approved_by} · {when(view.approved_at)}</p>}
            </>
          ) : (
            !error && '불러오는 중…'
          )}
        </div>
      )}
      {(m.state === 'failed' || m.state === 'uncertain') && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {m.state === 'uncertain' && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="size-4 accent-brand" />
              받은편지함·발송함에서 미발송을 확인함
            </label>
          )}
          <button type="button" onClick={retry} disabled={busy || (m.state === 'uncertain' && !confirm)} className={cx(buttonStyles.text, 'min-h-9 px-0')}>
            초안으로 다시 열기
          </button>
        </div>
      )}
      <Feedback error={error} message={message} />
    </li>
  );
}
