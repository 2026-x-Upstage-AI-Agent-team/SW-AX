import { useState } from 'react';
import { Link } from 'react-router';
import { isLeaderMail, isMailDraft, setTeamEmail, type Dashboard } from '../api/service';
import { Page } from '../components/Layout';
import MailItem from '../components/MailItem';
import { Feedback, Notice, PageHeader, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

type Tab = 'drafts' | 'leader';

export default function Mail() {
  const { dashboard, dashboardError, refresh } = useEvent();
  const [tab, setTab] = useState<Tab>('drafts');
  const [message, setMessage] = useState('');
  const mail = dashboard?.mail.filter(isLeaderMail) ?? [];
  const list = tab === 'drafts' ? mail.filter(isMailDraft) : mail;
  const noEmail = dashboard?.teams.filter((t) => !t.email && t.submission) ?? [];

  return (
    <Page width="normal">
      <PageHeader
        title="이메일 발송"
        lead="판정 결과로 작성된 초안을 확인하세요. 담당자가 수신자와 내용을 확인하고 승인한 메일만 발송됩니다."
        side={<Link to="/gmail" className={buttonStyles.secondary}>Gmail 연결</Link>}
      />

      {!dashboard ? (
        <Notice error={dashboardError} onRetry={refresh} />
      ) : (
        <>
          {dashboard.smtp && !dashboard.mail_ready && (
            <p className="rounded-[14px] border border-caution-line bg-caution-bg px-4 py-3 text-sm text-ink-2">
              발신 계정 연결을 기다리고 있습니다. 승인한 메일은 계정이 연결되면 발송됩니다.
            </p>
          )}
          {noEmail.length > 0 && <EmailList teams={noEmail} onSaved={refresh} />}

          <div role="group" aria-label="메일 목록" className="segments flex-wrap self-start">
            {(
              [
                ['drafts', `승인 대기 ${mail.filter(isMailDraft).length}`],
                ['leader', `팀장 안내 ${mail.length}`],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => { setTab(key); setMessage(''); }}
                className="segment"
              >
                {label}
              </button>
            ))}
          </div>
          {message && <p role="status" className="text-sm font-semibold text-brand-strong">{message}</p>}
          {list.length === 0 ? (
            <p className="rounded-[18px] border border-line px-6 py-8 text-center text-sm text-muted">{tab === 'drafts' ? '승인을 기다리는 메일이 없습니다.' : '아직 만들어진 메일이 없습니다.'}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((m) => (
                <MailItem key={m.id} m={m} onSaved={refresh} onApproved={setMessage} showTeam />
              ))}
            </ul>
          )}
        </>
      )}

    </Page>
  );
}

function EmailList({ teams, onSaved }: { teams: Dashboard['teams']; onSaved: () => void }) {
  return (
    <section aria-labelledby="email-h" className="flex flex-col gap-3 rounded-[18px] border border-caution-line bg-caution-bg p-5">
      <h2 id="email-h" className="text-[15px] font-extrabold">
        팀장 이메일이 없는 팀 {teams.length}
      </h2>
      <p className="text-[13px] text-ink-2">이 팀들의 안내는 주소를 확인할 때까지 발송을 기다립니다. 원접수에서 확인한 주소 한 개를 넣어 주세요.</p>
      <ul className="flex flex-col gap-2">
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
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-32 text-sm font-bold">{name}</span>
        <input type="email" aria-label={`${name} 팀장 이메일`} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className={cx(inputStyle, 'max-w-xs flex-1 bg-white')} />
        <button type="button" onClick={save} disabled={busy || !email.trim()} className={buttonStyles.secondary}>
          저장
        </button>
      </div>
      <Feedback error={error} />
    </li>
  );
}
