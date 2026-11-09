import { useState } from 'react';
import { Link } from 'react-router';
import { ADMIN_NOTICE } from '../api/labels';
import { setTeamEmail, type Dashboard } from '../api/service';
import { Page } from '../components/Layout';
import MailItem from '../components/MailItem';
import { Feedback, Notice, PageHeader, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

type Tab = 'leader' | 'admin';

const rules = [
  { t: '재제출요청', d: '판정 즉시 보완할 서류와 방법을 팀장에게 한 통으로 보냅니다.' },
  { t: '담당자확인', d: '원본 대조 후 ‘승인’ 또는 ‘보완 필요’를 기록하면 결과만 한 통 보냅니다.' },
  { t: '수신자 확인 필요', d: '주소가 없거나 신청서와 다르면 팀장 안내를 보류합니다. 팀별 검토에서 원접수와 대조해 수신 주소를 확인하세요.' },
  { t: '실패·확인 필요', d: '원인을 해소한 뒤 현재 버전의 그 메일만 다시 보냅니다.' },
];

export default function Mail() {
  const { dashboard, dashboardError, refresh } = useEvent();
  const [tab, setTab] = useState<Tab>('leader');
  const list = dashboard?.mail.filter((m) => (tab === 'admin' ? m.kind === ADMIN_NOTICE : m.kind !== ADMIN_NOTICE)) ?? [];
  const noEmail = dashboard?.teams.filter((t) => !t.email && t.submission) ?? [];

  return (
    <Page width="normal">
      <PageHeader
        title="발송 이력"
        lead="같은 팀·제출 버전·안내 종류의 메일은 한 번만 보냅니다. 원본, 주민번호·계좌번호·학번, 다른 팀 정보는 메일에 담지 않습니다."
        side={<Link to="/gmail" className={buttonStyles.secondary}>Gmail 연결</Link>}
      />

      {!dashboard ? (
        <Notice error={dashboardError} onRetry={refresh} />
      ) : (
        <>
          {noEmail.length > 0 && <EmailList teams={noEmail} onSaved={refresh} />}

          <div role="group" aria-label="수신자" className="segments self-start">
            {(
              [
                ['leader', `팀장 안내 ${dashboard.mail.filter((m) => m.kind !== ADMIN_NOTICE).length}`],
                ['admin', `담당자 알림 ${dashboard.mail.filter((m) => m.kind === ADMIN_NOTICE).length}`],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
                className="segment"
              >
                {label}
              </button>
            ))}
          </div>

          {list.length === 0 ? (
            <p className="rounded-[18px] border border-line px-6 py-8 text-center text-sm text-muted">아직 만들어진 메일이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((m) => (
                <MailItem key={m.id} m={m} onSaved={refresh} showTeam />
              ))}
            </ul>
          )}
        </>
      )}

      <section aria-labelledby="legend-h" className="flex flex-col gap-3.5">
        <h2 id="legend-h" className="text-xl font-extrabold">
          메일이 나가는 경우
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          {rules.map((r) => (
            <div key={r.t} className="flex flex-col gap-1.5 rounded-[18px] bg-canvas p-5">
              <strong className="text-sm">{r.t}</strong>
              <span className="text-[13px] leading-relaxed text-ink-2">{r.d}</span>
            </div>
          ))}
        </div>
      </section>
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
