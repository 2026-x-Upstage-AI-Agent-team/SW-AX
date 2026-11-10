import { Link } from '../components/workspaceNavigation';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowRight, Check, ChevronDown, CircleAlert, FileUp } from 'lucide-react';
import type { Verdict } from '../api/service';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles } from '../components/ui';
import { useWorkspaceOverview } from '../context/WorkspaceOverviewContext';
import { queueGroups, reviewStages } from '../hooks/reviewQueue';
import { workspaceTasks, type WorkspaceTask as Alert } from '../hooks/workspaceTasks';
import type { TeamRow } from '../hooks/useOverview';

const verdicts: Array<{ key: Verdict; label: string; color: string }> = [
  { key: '성공', label: '성공', color: 'var(--chart-success)' },
  { key: '담당자확인', label: '담당자 확인', color: 'var(--chart-review)' },
  { key: '재제출요청', label: '재제출 요청', color: 'var(--chart-return)' },
];

export default function Dashboard() {
  const [search] = useSearchParams();
  const { dashboard, rows, error, refresh } = useWorkspaceOverview();
  const list = rows ?? [];
  const groups = queueGroups(list);
  const alerts = workspaceTasks(dashboard, list);
  useEffect(() => {
    if (dashboard && search.get('focus') === 'tasks') {
      const heading = document.getElementById('queue-heading');
      heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start' });
    }
  }, [dashboard, search]);
  const queued = list.flatMap(row => row.submission?.state === 'queued' ? [row.submission.received ?? row.submission.created] : []);
  return <Page tone="gray">
    <PageHeader title="업무 현황" side={<Link to="/intake" className={buttonStyles.primary}><FileUp size={17} aria-hidden="true" />파일 첨부하기</Link>} />
    {!dashboard ? <Notice error={error} onRetry={refresh} /> : <>
      <div className="overview-panels"><ActionQueue alerts={alerts} /><VerdictSummary rows={list} /></div>
      <section aria-label="업무 진행 요약" className="surface flex flex-col gap-4 p-[22px]">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="panel-title">단계별 현황</h2>
          <span className="text-sm text-muted">승인 완료 <strong className="text-brand-strong">{groups.approved.length}</strong> / 전체 {list.length}팀</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{reviewStages.map(stage =>
          <Link key={stage.key} to={'/review?filter=' + stage.key} className="file-download" aria-label={`${stage.label} ${groups[stage.key].length}팀 보기`}>
            <span><strong>{stage.label} <span className="text-brand-strong">{groups[stage.key].length}</span></strong><small>{stage.description}</small></span><ArrowRight size={16} aria-hidden="true" />
          </Link>)}</div>
        <p className="text-xs text-muted">AI 판정과 담당자의 서류 승인은 별도 단계입니다. 팀별 검토에서 원문을 대조하고 후속 작업을 진행하세요.</p>
      </section>
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-subtle">
        <span>Studio {dashboard.connected ? `연결됨 · 설정 ${dashboard.config}` : '연결 대기'}</span>
        {dashboard.gmail_account ? <Link to="/gmail" className="font-semibold text-brand-strong underline underline-offset-2">담당자 Gmail {dashboard.mail_ready ? '연결됨' : '인증 대기'}</Link> : <span>메일 {dashboard.smtp ? 'SMTP' : '로컬 메일함'}</span>}
        {queued.length > 0 && <span>대기 {queued.length}팀 · 최초 첨부 {new Date(Math.min(...queued) * 1000).toLocaleString('ko-KR')}</span>}
        {groups.processing.length > 0 && <span>처리 중 {groups.processing.length}팀 · 자동 새로고침</span>}
      </p>
    </>}
  </Page>;
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
      <h2 id="summary-heading" className="panel-title">AI 판정 분포</h2>
      <div className="summary-body">
        <div className="verdict-ring" style={stops.length ? { background: `conic-gradient(${stops.join(', ')})` } : undefined}>
          <div className="ring-center"><strong>{rows.length}</strong><span>첨부한 팀</span></div>
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
      <h2 id="queue-heading" tabIndex={-1} className="panel-title">확인할 일 <span className="heading-count">{alerts.length}</span></h2>
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
