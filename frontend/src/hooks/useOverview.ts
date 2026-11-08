import { useEffect, useState } from 'react';
import { getSubmission, isLeaderMail, type DashTeam, type MailRow, type SubmissionDetail } from '../api/service';
import { useEvent } from '../context/EventContext';

export type TeamRow = DashTeam & {
  detail?: SubmissionDetail;
  /** 현재 제출본의 마지막 팀장 안내 */
  leaderMail?: MailRow;
};

/**
 * 현황판 팀 목록. 대시보드에는 판정 근거와 서류 구성이 없어서 팀별 제출본을 함께 읽는다.
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

  const rows: TeamRow[] | undefined = dashboard?.teams.map((t) => ({
    ...t,
    detail: t.current ? details[t.current] : undefined,
    leaderMail: dashboard.mail.find((m) => m.submission === t.current && isLeaderMail(m)),
  }));

  return { dashboard, rows, error: dashboardError, refresh };
}
