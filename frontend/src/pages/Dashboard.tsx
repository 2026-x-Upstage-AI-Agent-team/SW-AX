import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Check, ChevronDown, CircleAlert, FileUp } from 'lucide-react';
import { busyStates, recoverableStates, stateLabel } from '../api/labels';
import type { Verdict } from '../api/service';
import { Page } from '../components/Layout';
import { DocChips, Notice, PageHeader, StateBadge, VerdictBadge, buttonStyles, cx } from '../components/ui';
import { useEvent } from '../context/EventContext';
import { useOverview, type TeamRow } from '../hooks/useOverview';

type VerdictGroup = 'pending' | 'action' | 'ok';
type Filter = 'all' | VerdictGroup;

const verdicts: Array<{ key: Verdict; label: string; color: string }> = [
  { key: '성공', label: '성공', color: 'var(--chart-success)' },
  { key: '담당자확인', label: '담당자 확인', color: 'var(--chart-review)' },
  { key: '재제출요청', label: '재제출 요청', color: 'var(--chart-return)' },
];

type Alert = { key: string; text: string; sub: string; to: string; action: string };

function verdictGroup({ held, submission }: TeamRow): VerdictGroup {
  if (held || !submission) return 'action';
  if (busyStates.has(submission.state)) return 'pending';
  return submission.state === 'done' && submission.verdict === '성공' ? 'ok' : 'action';
}

export default function Dashboard() {
  const { events } = useEvent();
  const { dashboard, rows, error, refresh } = useOverview();
  const list = rows ?? [];
  const processing = list.filter((r) => r.submission && busyStates.has(r.submission.state)).length;
  const queued = list.flatMap((r) => r.submission?.state === 'queued' ? [r.submission.received ?? r.submission.created] : []);

  const alerts: Alert[] = [];
  for (const b of dashboard?.batches ?? []) {
    if (b.state === 'conflict')
      alerts.push({ key: b.id, text: '같은 제출본에 보완 접수가 겹쳤습니다.', sub: '접수 원본과 최신 제출본을 대조해 주세요.', to: '/intake/batches/' + b.id, action: '보완본 확인' });
  }
  const pendingFiles = dashboard?.batches.reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  if (pendingFiles > 0)
    alerts.push({ key: 'assign', text: `팀 배정을 확인할 파일이 ${pendingFiles}개 있습니다.`, sub: '배정이 끝나야 해당 팀의 판정과 누락 안내가 진행됩니다.', to: '/assign', action: '팀 배정 확인' });
  for (const r of list) {
    const s = r.submission;
    if (!s) continue;
    const priorAccess = r.detail?.history.find((h) => h.id !== s.id && h.state === 'access');
    if (recoverableStates.has(s.state) || s.state === 'ownership')
      alerts.push({ key: r.id + 'state', text: `${r.name} · ${stateLabel(s.state)}`, sub: s.error || '처리를 재개하거나 원본을 확인해 주세요.', to: `/teams/${s.id}`, action: '열기' });
    else if (priorAccess)
      alerts.push({ key: r.id + 'access', text: `${r.name} · Studio 접근 권한 확인`, sub: `제출 v${priorAccess.version}에서 인증 오류가 발생했습니다. 키·사용량을 확인한 뒤 재개할 수 있습니다.`, to: `/teams/${priorAccess.id}`, action: '인증 확인' });
    else if (s.verdict === '담당자확인' && !s.decision)
      alerts.push({ key: r.id + 'check', text: `${r.name} · 원본 대조가 필요합니다.`, sub: r.reviewSummary ?? '검토할 서류를 확인해 주세요.', to: `/teams/${s.id}`, action: '원본 대조하기' });
    else if (r.leaderMail?.state === 'recipient_check')
      alerts.push({ key: r.id + 'mail', text: `${r.name} · 팀장 수신 주소를 확인해 주세요.`, sub: '팀장 안내가 보류 중입니다. 신청서와 원접수의 주소를 대조해 주세요.', to: `/teams/${s.id}`, action: '주소 확인' });
    else if (s.verdict === '재제출요청' && !r.email)
      alerts.push({ key: r.id + 'mail', text: `${r.name} · 팀장 이메일이 없습니다.`, sub: '보완 요청 메일이 수신자 확인을 기다립니다.', to: `/teams/${s.id}`, action: '이메일 입력' });
    else if (verdictGroup(r) === 'ok' && !s.decision)
      alerts.push({ key: r.id + 'approval', text: `${r.name} · 담당자 승인 대기`, sub: '성공 판정의 원본과 근거를 검토하고 담당자 결정을 기록하세요.', to: `/teams/${s.id}`, action: '판정 검토' });
  }

  return (
    <Page tone="gray">
      <PageHeader title="업무 현황"  side={
        <Link to="/intake" className={buttonStyles.primary}><FileUp size={17} aria-hidden="true" />원본 접수하기</Link>
      } />
      {events?.length === 0 ? <Link to="/manage" className={buttonStyles.text}>대회를 등록해 원본 접수를 시작하세요.</Link> : !dashboard ? (
        <Notice error={error && `${error} (검토 서비스가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />
      ) : (
        <>
          <div className="overview-panels">
            <VerdictSummary rows={list} />
            <ActionQueue alerts={alerts} />
          </div>
          <TeamTable rows={list} />
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-subtle">
              <span>Studio {dashboard.connected ? `연결됨 · 설정 ${dashboard.config}` : '연결 대기'}</span>
              {dashboard.gmail_account ? (
                <Link to="/gmail" className="font-semibold text-brand-strong underline underline-offset-2">
                  담당자 Gmail {dashboard.mail_ready ? '연결됨' : '인증 대기'}
                </Link>
              ) : <span>메일 {dashboard.smtp ? 'SMTP' : '로컬 메일함'}</span>}
              {queued.length > 0 && <span>대기 {queued.length}팀 · 최초 접수 {new Date(Math.min(...queued) * 1000).toLocaleString('ko-KR')}</span>}
              {processing > 0 && <span>처리 중 {processing}팀 · 자동 새로고침</span>}
          </p>
        </>
      )}
    </Page>
  );
}

function VerdictSummary({ rows }: { rows: TeamRow[] }) {
  const done = rows.filter((r) => !r.held && r.submission?.state === 'done' && r.submission.verdict);
  const groups = verdicts.map(({ key, label, color }) => ({
    label, color, count: done.filter((r) => r.submission?.verdict === key).length,
  }));
  if (done.length < rows.length) groups.push({ label: '판정 전', color: 'var(--chart-pending)', count: rows.length - done.length });
  let end = 0;
  const stops = groups.filter((g) => g.count > 0).map((g) => {
    const start = end;
    end += (g.count / rows.length) * 100;
    return `${g.color} ${start}% ${end}%`;
  });
  return (
    <section className="surface summary-panel" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="panel-title">판정 현황</h2>
      <div className="summary-body">
        <div className="verdict-ring" style={stops.length ? { background: `conic-gradient(${stops.join(', ')})` } : undefined}>
          <div className="ring-center"><strong>{rows.length}</strong><span>접수 팀</span></div>
        </div>
        <dl className="verdict-legend">
          {groups.map(({ label, color, count }) => (
            <div key={label}><dt><i aria-hidden="true" style={{ backgroundColor: color }} />{label}</dt><dd>{count}<small>팀</small></dd></div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ActionQueue({ alerts }: { alerts: Alert[] }) {
  const item = (a: Alert) => (
    <li key={a.key}>
      <Link to={a.to} className="queue-link">
        <span className="queue-icon"><CircleAlert size={17} aria-hidden="true" /></span>
        <span className="min-w-0"><strong>{a.text}</strong><small>{a.sub}</small></span>
        <span className="sr-only">{a.action}</span><ArrowRight size={16} className="queue-arrow" aria-hidden="true" />
      </Link>
    </li>
  );
  return (
    <section className="surface queue-panel" aria-labelledby="queue-heading">
      <h2 id="queue-heading" className="panel-title">확인할 일 <span className="heading-count">{alerts.length}</span></h2>
      {alerts.length ? (
        <>
          <ul className="queue-list">{alerts.slice(0, 2).map(item)}</ul>
          {alerts.length > 2 && <details className="queue-more">
            <summary><span>나머지 {alerts.length - 2}건</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <ul className="queue-list">{alerts.slice(2).map(item)}</ul>
          </details>}
        </>
      ) : <p className="queue-empty"><Check size={19} aria-hidden="true" />지금 확인할 일이 없습니다.</p>}
    </section>
  );
}

function TeamTable({ rows }: { rows: TeamRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const groups: Record<Filter, TeamRow[]> = { all: rows, pending: [], action: [], ok: [] };
  for (const row of rows) groups[verdictGroup(row)].push(row);
  const list = groups[filter];
  const filters: Array<[Filter, string]> = [
    ['all', `전체 ${rows.length}`],
    ['pending', `처리 대기 ${groups.pending.length}`],
    ['action', `조치 필요 ${groups.action.length}`],
    ['ok', `정리됨 ${groups.ok.length}`],
  ];
  return (
    <section aria-labelledby="teams-h" className="surface team-panel">
      <div className="team-panel-head">
        <div className="flex items-center gap-3">
          <h2 id="teams-h" className="panel-title">
            팀별 판정
          </h2>
        </div>
        <div role="group" aria-label="판정 필터" className="segments">
          {filters.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className="segment"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-muted">
          아직 접수된 팀이 없습니다.{' '}
          <Link to="/intake" className="font-bold text-brand-strong underline underline-offset-2">
            원본을 접수
          </Link>
          하면 팀이 자동으로 만들어집니다.
        </p>
      ) : (
        <div className="team-table-scroll" role="region" aria-label="팀별 판정 표" tabIndex={0}>
          <table className="w-full min-w-[55rem] border-collapse text-sm">
            <thead>
              <tr className="bg-canvas text-left text-xs text-muted">
                <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">접수 서류</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">판정</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">판정 사유</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">담당자 결정</th>
                <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀장 안내</th>
                <th scope="col" className="border-b border-line px-5 py-3.5 text-right font-medium">검토</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="px-5 py-8 text-center text-muted">이 필터에 해당하는 팀이 없습니다.</td></tr>}
              {list.map((r) => {
                const s = r.submission;
                const reviewPath = s && `/teams/${s.id}`;
                return (
                  <tr key={r.id} className="border-b border-line-soft last:border-b-0 hover:bg-[#fafbfb]">
                    <td className="team-identity px-5 py-4 align-top">
                      {reviewPath ? (
                        <Link to={reviewPath} className="font-bold text-ink hover:text-brand-strong">
                          {r.name}
                        </Link>
                      ) : (
                        <strong>{r.name}</strong>
                      )}
                      <div className="mt-0.5 text-xs text-subtle">
                        {r.rep && <span>{r.rep} · </span>}
                        <span className="font-semibold tabular-nums">{s ? `v${s.version}` : '제출본 없음'}</span>
                      </div>
                    </td>
                    <td data-label="접수 서류" className="team-docs px-3 py-4 align-top">{s ? <DocChips documents={r.detail?.result?.documents} /> : '—'}</td>
                    <td className="team-verdict px-3 py-4 align-top">
                      {r.held ? (
                        <StateBadge state="unassigned" />
                      ) : s?.verdict && s.state === 'done' ? (
                        <VerdictBadge verdict={s.verdict} />
                      ) : s ? (
                        <StateBadge state={s.state} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="team-reason min-w-44 max-w-[380px] px-3 py-4 align-top leading-relaxed text-ink-2">
                      {r.held
                        ? '미배정 파일의 소속 확인'
                        : r.reviewSummary || s?.error || (s && busyStates.has(s.state) ? '판정 결과 대기 중' : '')}
                    </td>
                    <td data-label="담당자 결정" className="team-decision whitespace-nowrap px-3 py-4 align-top">
                      {s?.decision ? <span className={cx('text-xs font-bold', s.decision === '승인' ? 'text-brand-strong' : 'text-alert-strong')}>{s.decision}</span> : <span className="text-xs text-subtle">미기록</span>}
                    </td>
                    <td data-label="팀장 안내" className="team-mail px-5 py-4 align-top">{r.leaderMail ? <StateBadge state={r.leaderMail.state} /> : <span className="text-xs text-subtle">없음</span>}</td>
                    <td className="team-review-action whitespace-nowrap px-5 py-4 text-right align-top">
                      {reviewPath ? (
                        <Link to={reviewPath} className={buttonStyles.outline}
                          aria-label={`${r.name}${r.rep ? ` (${r.rep})` : ''} 검토 열기`}>
                          검토 열기 <ArrowRight size={16} aria-hidden="true" />
                        </Link>
                      ) : <span className="text-xs text-muted">제출본 없음</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
