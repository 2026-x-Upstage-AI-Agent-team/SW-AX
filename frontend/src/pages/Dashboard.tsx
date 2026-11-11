import { Link } from '../components/workspaceNavigation';
import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowRight, Check, ChevronDown, CircleAlert, FileCheck, FileUp, Sparkles } from 'lucide-react';
import type { Verdict } from '../api/service';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles } from '../components/ui';
import WorkflowProgress from '../components/WorkflowProgress';
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
  const preparing = dashboard?.batches.filter(batch => batch.state === 'preparing').length ?? 0;
  const processing = groups.processing.length;
  return <Page tone="gray">
    <PageHeader
      title="업무 현황"
      lead="서류 접수부터 검토와 보고서 확정까지 확인하세요."
      side={<Link to="/intake" className={buttonStyles.primary}><FileUp size={17} aria-hidden="true" />파일 첨부하기</Link>}
    />
    {!dashboard ? <Notice error={error} onRetry={refresh} /> : <>
      <div className="dashboard-metrics">
        <MetricCard label="담당자 조치 필요" count={alerts.length} unit="건" priority
          icon={<CircleAlert size={18} aria-hidden="true" />}
          detail={<Link to="/?focus=tasks" className="dashboard-metric-link">확인 목록 보기 <ArrowRight size={16} aria-hidden="true" /></Link>}
        />
        <MetricCard label="첨부한 팀" count={list.length} unit="팀"
          icon={<FileUp size={18} aria-hidden="true" />}
          detail={`원본 ${dashboard.batches.reduce((total, batch) => total + (batch.count ?? 0), 0)}개`}
        />
        <MetricCard label="AI 판정 완료" count={list.filter(hasVerdict).length} unit="팀"
          icon={<Sparkles size={18} aria-hidden="true" />}
          detail={`대기 ${queued.length} · 처리 중 ${Math.max(0, processing - queued.length)}`}
        />
        <MetricCard label="보고서 확정" count={dashboard.reports.filter(report => report.state === 'confirmed').length} unit="건"
          icon={<FileCheck size={18} aria-hidden="true" />}
          detail="HWPX · PDF"
        />
      </div>
      {(preparing > 0 || processing > 0) && <WorkflowProgress
        title="서류 자동 처리 중"
        description={[preparing > 0 && `파일 판독 ${preparing}건`, processing > 0 && `자동 검토 대기·진행 ${processing}팀`].filter(Boolean).join(' · ')}
        tone="working"
        action={<Link to={processing ? '/review?filter=processing' : '/intake/batches'} className={buttonStyles.secondary}>진행 상태 보기</Link>}
      />}
      <div className="dashboard-analysis">
        <section aria-label="업무 진행 요약" className="surface dashboard-stages">
          <div>
            <h2 className="panel-title">단계별 현황</h2>
            <p className="dashboard-caption">승인 완료 <strong>{groups.approved.length}</strong> / 전체 {list.length}팀</p>
          </div>
          <div className="dashboard-stage-list">{reviewStages.map(stage => {
            const count = groups[stage.key].length;
            const width = list.length ? count / list.length * 100 : 0;
            return <Link key={stage.key} to={'/review?filter=' + stage.key} className="dashboard-stage"
              aria-label={`${stage.label} ${count}팀 보기`} title={stage.description}>
              <span>{stage.label}</span>
              <span className="dashboard-stage-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></span>
              <span className="dashboard-stage-count">{count}팀<ArrowRight size={15} aria-hidden="true" /></span>
            </Link>;
          })}</div>
          <p className="dashboard-caption">AI 판정과 담당자의 서류 승인은 별도 단계입니다. 팀별 검토에서 원문을 대조하고 후속 작업을 진행하세요.</p>
        </section>
        <VerdictSummary rows={list} />
      </div>
      <ActionQueue alerts={alerts} />
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-subtle">
        <span>Studio {dashboard.connected ? `연결됨 · 설정 ${dashboard.config}` : '연결 대기'}</span>
        {dashboard.gmail_account ? <Link to="/gmail" className="font-semibold text-brand-strong underline underline-offset-2">담당자 Gmail {dashboard.mail_ready ? '연결됨' : '인증 대기'}</Link> : <span>메일 {dashboard.smtp ? 'SMTP' : '로컬 메일함'}</span>}
        {queued.length > 0 && <span>대기 {queued.length}팀 · 최초 첨부 {new Date(Math.min(...queued) * 1000).toLocaleString('ko-KR')}</span>}
      </p>
    </>}
  </Page>;
}

function MetricCard({ label, count, unit, detail, icon, priority = false }: {
  label: string;
  count: number;
  unit: string;
  detail: ReactNode;
  icon: ReactNode;
  priority?: boolean;
}) {
  return <dl className={priority ? 'surface dashboard-metric dashboard-metric-priority' : 'surface dashboard-metric'}>
    <dt>{label}<span className="dashboard-metric-icon">{icon}</span></dt>
    <dd className="dashboard-metric-value">{count}<span>{unit}</span></dd>
    <dd className="dashboard-caption">{detail}</dd>
  </dl>;
}

function hasVerdict(row: TeamRow) {
  return !row.held && row.submission?.state === 'done' && Boolean(row.submission.verdict);
}

function VerdictSummary({ rows }: { rows: TeamRow[] }) {
  const done = rows.filter(hasVerdict);
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
      <p className="dashboard-caption">판정 완료 {done.length}팀</p>
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
