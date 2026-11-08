import { useState } from 'react';
import { Link } from 'react-router';
import { useAsync } from '../api/client';
import { listAdminAlerts, listMails } from '../api/review';
import { Page } from '../components/Layout';
import { MailBadge, Notice, PageHeader, VerdictBadge, buttonStyles, cx } from '../components/ui';

type Tab = 'leader' | 'admin';

const rules = [
  { t: '재제출요청', d: '판정 즉시 보완할 서류·위치·방법을 한 통으로 보냅니다.' },
  { t: '담당자확인', d: '원본 대조 후 ‘이상 없음’ 또는 ‘보완 필요’ 결과만 한 통 보냅니다.' },
  { t: '수신자 확인 필요', d: '팀장 주소가 없거나 접수 정보와 다르면 발송을 멈추고 알립니다.' },
  { t: '반송·실패', d: '원인을 해소한 뒤 현재 버전의 그 메일만 다시 보냅니다.' },
];

export default function Mail() {
  const [tab, setTab] = useState<Tab>('leader');
  const mails = useAsync(listMails, []);
  const alerts = useAsync(listAdminAlerts, []);

  return (
    <Page width="normal">
      <PageHeader
        title="발송 이력"
        demo
        lead="같은 팀·제출 버전·안내 종류의 메일은 한 번만 보냅니다. 원본, 주민번호·계좌번호·학번, 다른 팀 정보는 메일에 담지 않습니다."
        side={
          <div className="flex flex-[0_1_380px] items-center gap-3.5 rounded-[18px] bg-canvas px-[18px] py-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="5.5" width="18" height="13" rx="2" />
              <path d="M3.5 7l8.5 6 8.5-6" />
            </svg>
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-sm font-bold">담당자 Gmail</span>
              <span className="text-xs text-muted">발신 겸 알림 수신 · 연결 상태 API 연결 전</span>
            </div>
            <button type="button" disabled className={cx(buttonStyles.secondary, 'min-h-10 px-3.5 text-[13px]')}>
              Google로 연결
            </button>
          </div>
        }
      />

      <div role="tablist" aria-label="수신자" className="flex gap-1.5 self-start rounded-full bg-canvas p-1">
        {(
          [
            ['leader', '팀장 안내'],
            ['admin', '담당자 알림'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx('min-h-10 rounded-full px-[18px] text-sm', tab === key ? 'bg-white font-bold shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-muted')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'leader' ? (
        !mails.data ? (
          <Notice error={mails.error} onRetry={mails.reload} />
        ) : (
          <div className="overflow-x-auto rounded-[18px] border border-line">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀 · 버전</th>
                  <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">안내 종류</th>
                  <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">제목</th>
                  <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">상태</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">시각</th>
                </tr>
              </thead>
              <tbody>
                {mails.data.map((m) => (
                  <tr key={m.submissionId} className="border-b border-line-soft last:border-b-0">
                    <td className="px-5 py-4 align-top">
                      <Link to={`/teams/${m.submissionId}`} className="font-bold text-ink hover:text-brand-strong">
                        {m.teamName}
                      </Link>
                      <div className="mt-0.5 font-mono text-xs text-subtle">
                        {m.submissionId} · v{m.version}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 align-top text-ink-2">{m.kind}</td>
                    <td className="px-3 py-4 align-top">{m.subject}</td>
                    <td className="px-3 py-4 align-top">
                      <MailBadge state={m.state} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 align-top text-[13px] text-subtle">{m.state === 'sent' ? m.sentAt ?? '[발송 시각]' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !alerts.data ? (
        <Notice error={alerts.error} onRetry={alerts.reload} />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {alerts.data.map((a) => (
            <li key={a.submissionId}>
              <Link to={`/teams/${a.submissionId}`} className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line px-5 py-4 hover:bg-canvas">
                <VerdictBadge verdict={a.verdict} />
                <strong className="text-sm">{a.teamName}</strong>
                <span className="flex-[1_1_300px] text-sm text-ink-2">{a.message}</span>
                <span className="text-sm text-brand-strong">원본 보기 →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="legend-h" className="flex flex-col gap-3.5">
        <h2 id="legend-h" className="text-xl font-extrabold">
          상태가 바뀌는 경우
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
