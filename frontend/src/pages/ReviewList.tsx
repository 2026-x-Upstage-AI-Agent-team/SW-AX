import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowRight, Search } from 'lucide-react';
import { Page } from '../components/Layout';
import { Link } from '../components/workspaceNavigation';
import { DocChips, Notice, PageHeader, StateBadge, VerdictBadge, buttonStyles, cx, inputStyle } from '../components/ui';
import { useWorkspaceOverview } from '../context/WorkspaceOverviewContext';
import { nextReviewAction, queueGroups, reviewPriority, reviewStage, reviewStages, type ReviewStage } from '../hooks/reviewQueue';
import type { TeamRow } from '../hooks/useOverview';

export default function ReviewList() {
  const { dashboard, rows, error, refresh } = useWorkspaceOverview();
  const [search, setSearch] = useSearchParams();
  const filter = search.get('filter') === 'all' || reviewStages.some(stage => stage.key === search.get('filter')) ? search.get('filter')! as ReviewStage | 'all' : 'review';
  const query = search.get('q') ?? '';
  const searchText = query.trim().toLocaleLowerCase();
  const order = search.get('sort') === 'recent' ? 'recent' : 'priority';
  const groups = queueGroups(rows ?? []);
  const candidates = filter === 'all' ? rows ?? [] : groups[filter];
  const list = candidates.filter(row => `${row.name} ${row.rep ?? ''}`.toLocaleLowerCase().includes(searchText)).sort((a, b) =>
    order === 'recent' ? (b.submission?.received ?? b.submission?.created ?? 0) - (a.submission?.received ?? a.submission?.created ?? 0) : reviewPriority(a) - reviewPriority(b));
  const next = [...groups.review].sort((a, b) => reviewPriority(a) - reviewPriority(b))[0];
  const focused = search.get('team');
  useEffect(() => {
    if (!focused) return;
    const element = document.getElementById('review-team-' + focused);
    element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest' });
  }, [focused, list.length]);

  function update(key: string, value: string, replace = false) {
    const params = new URLSearchParams(search);
    params.delete('team');
    if (value) params.set(key, value); else params.delete(key);
    setSearch(params, { replace });
  }
  function withReturn(to: string, row: TeamRow) {
    if (!to.startsWith('/teams/')) return to;
    const params = new URLSearchParams(search);
    params.set('team', row.id);
    return to + '?back=' + encodeURIComponent('/review?' + params.toString());
  }

  return <Page tone="gray">
    <PageHeader title="팀별 검토" lead="확인할 팀을 골라 원문을 대조하고, 승인·보완 처리를 이어가세요." side={next &&
      <Link to={withReturn('/teams/' + next.submission!.id, next)} className={buttonStyles.primary}>다음 팀 검토<ArrowRight size={17} aria-hidden="true" /></Link>
    } />
    {!dashboard ? <Notice error={error} onRetry={refresh} /> : !rows?.length ? <div className="motion-results surface flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted"><h2>아직 검토할 팀이 없습니다.</h2><p>팀의 서류를 첨부하면 자동 검토를 마친 뒤 이곳에서 처리할 수 있습니다.</p><Link to="/intake" className={buttonStyles.primary}>파일 첨부</Link></div> : <>
      <div className="flex flex-col gap-4">
        <div role="group" aria-label="검토 작업 필터" className="segments self-start">
          {reviewStages.map(stage => <button key={stage.key} type="button" className="segment" aria-label={`${stage.label} ${groups[stage.key].length}`} aria-pressed={filter === stage.key} onClick={() => update('filter', stage.key)}>{stage.label}<span className="ml-1 text-subtle">{groups[stage.key].length}</span></button>)}
          <button type="button" className="segment" aria-label={`전체 ${rows.length}`} aria-pressed={filter === 'all'} onClick={() => update('filter', 'all')}>전체<span className="ml-1 text-subtle">{rows.length}</span></button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-[1_1_18rem] items-center gap-2"><Search size={17} aria-hidden="true" /><span className="sr-only">팀명 또는 대표자 검색</span><input type="search" className={inputStyle} value={query} onChange={event => update('q', event.target.value, true)} placeholder="팀명 또는 대표자로 찾기" /></label>
          <label className="flex flex-[0_1_14rem] flex-col gap-1.5 text-xs font-semibold text-muted"><span>정렬</span><select className={inputStyle} value={order} onChange={event => update('sort', event.target.value)}><option value="priority">확인할 팀 우선</option><option value="recent">최근 첨부순</option></select></label>
        </div>
      </div>
      <section aria-labelledby="teams-h" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2"><h2 id="teams-h" tabIndex={-1} className="panel-title">검토 대상 팀</h2><span aria-live="polite">{list.length}팀</span></div>
        <div key={`${filter}:${order}:${searchText}`} className="motion-results flex flex-col gap-3">
          {list.length ? list.map(row => {
            const submission = row.submission;
            const stage = reviewStage(row);
            const action = nextReviewAction(row);
            const detail = submission && withReturn('/teams/' + submission.id, row);
            const actionTo = withReturn(action.to, row);
            return <article key={row.id} id={'review-team-' + row.id} tabIndex={-1} aria-labelledby={'review-title-' + row.id} className="surface grid gap-4 p-[22px] lg:[grid-template-columns:minmax(12rem,.8fr)_minmax(0,1.5fr)_auto]">
              <div className="flex min-w-0 flex-col items-start gap-2 [&>h3]:font-bold [&>p]:text-xs [&>p]:text-muted"><span className={cx('inline-flex rounded-full px-2 py-1 text-xs font-semibold', stage === 'approved' ? 'bg-brand-tint text-brand-strong' : 'bg-fill text-ink-2')}>{reviewStages.find(item => item.key === stage)?.label}</span>
                <h3 id={'review-title-' + row.id}>{detail ? <Link to={detail}>{row.name}</Link> : row.name}</h3>
                <p>{row.rep && <span>{row.rep} · </span>}{submission ? `제출 v${submission.version}${submission.count !== undefined ? ' · 서류 ' + submission.count + '개' : ''}` : '제출본 없음'}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted"><span>AI 판정</span>{submission?.state === 'done' && submission.verdict ? <VerdictBadge verdict={submission.verdict} /> : submission ? <StateBadge state={submission.state} /> : <span>아직 없음</span>}</div>
                <p className="text-sm leading-relaxed text-ink-2" data-review-summary>{row.reviewSummary || action.hint}</p>
                {submission && <DocChips documents={row.detail?.result?.documents} />}
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-end lg:justify-center"><Link to={actionTo} className={buttonStyles.outline} aria-label={`${row.name} ${action.label}`}>{action.label}<ArrowRight size={16} aria-hidden="true" /></Link>
                {detail && action.to !== '/teams/' + submission!.id && <Link to={detail} className="action action-text" aria-label={`${row.name} 검토 내역 열기`}>검토 내역</Link>}
              </div>
            </article>;
          }) : <div className="surface flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted"><h3>{query ? '검색 조건에 맞는 팀이 없습니다.' : '이 단계에 해당하는 팀이 없습니다.'}</h3><p>{query ? '팀명·대표자 또는 선택한 작업 단계를 확인해 주세요.' : '다른 작업 단계에서 진행 중인 팀을 확인할 수 있습니다.'}</p><button type="button" className={buttonStyles.secondary} onClick={() => { const params = new URLSearchParams(); params.set('filter', 'all'); setSearch(params); }}>전체 팀 보기</button></div>}
        </div>
      </section>
    </>}
  </Page>;
}
