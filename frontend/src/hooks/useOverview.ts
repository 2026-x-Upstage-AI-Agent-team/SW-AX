import { useEffect, useState } from 'react';
import { getSubmission, isLeaderMail, type DashTeam, type MailRow, type SubmissionDetail } from '../api/service';
import { useEvent } from '../context/EventContext';
import { receiptName } from '../api/intake';
import { reviewEvidence } from '../api/reviewEvidence';

export type TeamRow = DashTeam & {
  detail?: SubmissionDetail;
  reviewSummary?: string;
  /** 현재 제출본의 마지막 팀장 안내 */
  leaderMail?: MailRow;
};

/**
 * 현황판과 검토 목록에는 현재 서류가 있는 팀만 표시하고 판정 근거는 팀별 제출본에서 읽는다.
 * 대시보드가 갱신될 때마다 다시 읽는다.
 */
export function useOverview() {
  const { dashboard, dashboardError, refresh } = useEvent();
  const [details, setDetails] = useState<Record<string, SubmissionDetail>>({});

  useEffect(() => {
    if (!dashboard) return;
    let alive = true;
    const ids = dashboard.teams.map((t) => t.current).filter((id): id is string => !!id);
    Promise.allSettled(ids.map((id) => getSubmission(id))).then((results) => {
      if (!alive) return;
      const next: Record<string, SubmissionDetail> = {};
      results.forEach((r) => {
        if (r.status === 'fulfilled') next[r.value.id] = r.value;
      });
      setDetails(next);
    });
    return () => {
      alive = false;
    };
  }, [dashboard]);

  const hasOriginals = dashboard?.batches.some((batch) => batch.count > 0);
  const activeTeams = dashboard?.teams.filter((team) =>
    team.has_documents ?? (Boolean(team.submission?.count) || Boolean(hasOriginals && team.held)));
  const rows: TeamRow[] | undefined = activeTeams?.map((t) => {
    const detail = t.current ? details[t.current] : undefined;
    return {
      ...t,
      name: receiptName(t.name, t.intake_number),
      detail,
      reviewSummary: t.submission?.state === 'done' ? reviewEvidence(detail?.result, t.submission.verdict).summary : undefined,
      leaderMail: dashboard?.mail.find((m) => m.submission === t.current && isLeaderMail(m)),
    };
  });

  return { dashboard, rows, error: dashboardError, refresh };
}
