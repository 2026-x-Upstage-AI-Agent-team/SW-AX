import { useState } from 'react';
import { when } from '../api/labels';
import { getMail, retryMail, type MailRow, type MailView } from '../api/service';
import { Feedback, StateBadge, buttonStyles, cx } from './ui';

/** 안내 메일 한 건: 상태, 본문 보기, 실패·불확실 건 재시도 */
export default function MailItem({ m, onSaved, showTeam }: { m: MailRow; onSaved: () => void; showTeam?: boolean }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MailView>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    setOpen((v) => !v);
    if (!view) getMail(m.id).then(setView, (err: Error) => setError(err.message));
  }
  async function retry() {
    setError('');
    try {
      await retryMail(m.id, confirm);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="rounded-[14px] bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {showTeam && m.name && <strong className="text-sm">{m.name}{m.version ? ` v${m.version}` : ''}</strong>}
        <span className={cx('text-sm', !showTeam && 'font-bold')}>{m.kind}</span>
        <StateBadge state={m.state} />
        <span className="text-xs text-subtle">
          {m.sent_to ?? '수신자 확인 필요'} · {when(m.created)}
        </span>
        <button type="button" onClick={toggle} aria-expanded={open} className="ml-auto text-xs font-bold text-brand-strong">
          {open ? '접기' : '본문 보기'}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-xl bg-white p-3 text-[13px] leading-relaxed text-ink-2">
          {view ? (
            <>
              {view.subject && <strong className="mb-1 block text-ink">{view.subject}</strong>}
              <p className="whitespace-pre-line">{view.body}</p>
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
          <button type="button" onClick={retry} disabled={m.state === 'uncertain' && !confirm} className={cx(buttonStyles.text, 'min-h-9 px-0')}>
            다시 보내기
          </button>
        </div>
      )}
      <Feedback error={error} />
    </li>
  );
}
