import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { reviewLive } from '../api/backend';
import { busyStates, recoverableStates, stateLabel } from '../api/labels';
import type { Verdict } from '../api/service';
import { DemoBadge, DocChips, Notice, StateBadge, VerdictBadge, buttonStyles, cx } from '../components/ui';
import { useEvent } from '../context/EventContext';
import { useOverview, type TeamRow } from '../hooks/useOverview';

const steps = [
  { t: '일괄 업로드', d: '여러 팀 파일 혼합' },
  { t: '팀 배정', d: '01 명단과 근거 대조' },
  { t: 'Studio 판정', d: '분류·추출·검증' },
  { t: '담당자 확인', d: '원본 쪽·행 대조' },
  { t: '팀장 메일', d: '보완 사유 자동 안내' },
  { t: '보고서', d: 'HWPX · PDF 편철' },
];

type Filter = 'all' | 'action' | 'ok';

const summaryTone: Record<Verdict, string> = {
  성공: 'text-brand-strong',
  담당자확인: 'text-caution',
  재제출요청: 'text-alert-strong',
};
const summaryNote: Record<Verdict, string> = {
  성공: '담당자 승인 후 보고서 편철',
  담당자확인: '원본 대조 후 결과 발송',
  재제출요청: '팀장 보완 메일 자동 발송',
};

type Alert = { key: string; text: string; sub: string; to: string; action: string };

/** 담당자가 지금 손대야 하는 일 */
function needsAction(r: TeamRow) {
  const s = r.submission;
  if (r.held || !s) return true;
  if (recoverableStates.has(s.state) || s.state === 'ownership') return true;
  if (s.verdict === '성공') return s.decision !== '승인';
  return s.verdict !== null;
}

export default function Dashboard() {
  const { event } = useEvent();
  const { dashboard, rows, error, refresh } = useOverview();
  const [filter, setFilter] = useState<Filter>('all');
  const list = rows ?? [];
  const count = (v: Verdict) => list.filter((r) => r.submission?.verdict === v).length;
  const processing = list.filter((r) => r.submission && busyStates.has(r.submission.state)).length;
  const visible = useMemo(
    () => list.filter((r) => (filter === 'all' ? true : filter === 'ok' ? !needsAction(r) : needsAction(r))),
    [list, filter],
  );

  const alerts: Alert[] = [];
  const pendingFiles = dashboard?.batches.reduce((n, b) => n + (b.pending ?? 0), 0) ?? 0;
  if (pendingFiles > 0)
    alerts.push({ key: 'assign', text: `팀 배정을 확인할 파일이 ${pendingFiles}개 있습니다.`, sub: '배정이 끝나야 해당 팀의 판정과 누락 안내가 진행됩니다.', to: '/assign', action: '팀 배정 확인' });
  for (const r of list) {
    const s = r.submission;
    if (!s) continue;
    if (recoverableStates.has(s.state) || s.state === 'ownership')
      alerts.push({ key: r.id + 'state', text: `${r.name} · ${stateLabel(s.state)}`, sub: s.error || '처리를 재개하거나 원본을 확인해 주세요.', to: `/teams/${s.id}`, action: '열기' });
    else if (s.verdict === '담당자확인' && !s.decision)
      alerts.push({ key: r.id + 'check', text: `${r.name} · 원본 대조가 필요합니다.`, sub: r.detail?.result?.reason ?? '판정 근거를 확인한 뒤 ‘승인’ 또는 ‘보완 필요’를 기록하면 팀장에게 결과 한 통이 발송됩니다.', to: `/teams/${s.id}`, action: '원본 대조하기' });
    else if (s.verdict === '재제출요청' && !r.email)
      alerts.push({ key: r.id + 'mail', text: `${r.name} · 팀장 이메일이 없습니다.`, sub: '보완 요청 메일이 수신자 확인을 기다립니다.', to: `/teams/${s.id}`, action: '이메일 입력' });
  }

  return (
    <main className="mx-auto flex max-w-[1200px] flex-col gap-14 px-6 pb-24 pt-16">
      <section className="flex flex-col items-center gap-5 text-center">
        <p className="text-[15px] font-bold text-brand-strong">{event?.name ?? '대회'} · 시상금 증빙 검토</p>
        <h1 className="text-[clamp(36px,5vw,60px)] font-extrabold leading-[1.12] tracking-[-0.035em]">
          서류 대조는 맡기고,
          <br />
          판단만 하세요.
        </h1>
        <p className="max-w-[620px] text-lg leading-relaxed text-muted">
          여러 팀의 01 신청서·02 동의서·03 대표 증빙을 한 번에 올리면, 팀을 나누고 서로 맞지 않는 곳만 골라 보여 드립니다.
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Link to="/intake" className={buttonStyles.primary}>
            파일 일괄 업로드
          </Link>
          {alerts[0] && (
            <Link to={alerts[0].to} className={cx(buttonStyles.text, 'text-base')}>
              확인할 일 {alerts.length}건 →
            </Link>
          )}
        </div>
      </section>

      <ol aria-label="처리 단계" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-[18px] border border-line">
        {steps.map((s, i) => (
          <li key={s.t} className="flex flex-col gap-1.5 border-r border-line bg-[#fafbfb] px-5 py-[18px] last:border-r-0">
            <span className="font-mono text-xs text-subtle">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-[15px] font-bold">{s.t}</span>
            <span className="text-[13px] text-muted">{s.d}</span>
          </li>
        ))}
      </ol>

      {!dashboard ? (
        <Notice error={error && `${error} (검토 서비스가 실행 중인지 확인해 주세요.)`} onRetry={refresh} />
      ) : (
        <>
          {reviewLive && (
            <p className="-mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
              <span>Studio {dashboard.connected ? `연결됨 · 설정 ${dashboard.config}` : 'API 키 미설정'}</span>
              <span>메일 {dashboard.gmail_oauth_connected || dashboard.gmail_account ? `Gmail ${dashboard.gmail_account ?? ''}` : dashboard.smtp ? 'SMTP' : '로컬 메일함'}</span>
              {processing > 0 && <span className="font-bold text-brand-strong">처리 중 {processing}팀 · 자동 새로고침</span>}
            </p>
          )}

          <section aria-label="판정 요약" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            <div className="flex flex-col gap-2 rounded-[22px] bg-canvas p-7">
              <span className="text-sm text-muted">접수 팀</span>
              <span className="text-[44px] font-extrabold tracking-[-0.03em]">{list.length}</span>
              <span className="text-[13px] text-muted">{processing > 0 ? `판정 중 ${processing}팀` : dashboard.events.find((e) => e.id === dashboard.event)?.name}</span>
            </div>
            {(['성공', '담당자확인', '재제출요청'] as Verdict[]).map((v) => (
              <div key={v} className="flex flex-col gap-2 rounded-[22px] bg-canvas p-7">
                <span className={cx('text-sm font-bold', summaryTone[v])}>{v}</span>
                <span className="text-[44px] font-extrabold tracking-[-0.03em]">{count(v)}</span>
                <span className="text-[13px] text-muted">{summaryNote[v]}</span>
              </div>
            ))}
          </section>

          {alerts.length > 0 && (
            <section aria-label="확인할 일" className="flex flex-col gap-2.5">
              {alerts.slice(0, 5).map((a) => (
                <div key={a.key} role="status" className="flex flex-wrap items-center gap-4 rounded-[18px] border border-caution-line bg-caution-bg px-6 py-4">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-caution" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v6M12 16.5v.5" />
                  </svg>
                  <div className="flex flex-[1_1_380px] flex-col gap-1">
                    <strong className="text-[15px]">{a.text}</strong>
                    <span className="text-sm text-muted">{a.sub}</span>
                  </div>
                  <Link to={a.to} className={buttonStyles.outline}>
                    {a.action}
                  </Link>
                </div>
              ))}
              {alerts.length > 5 && <p className="text-sm text-muted">외 {alerts.length - 5}건은 아래 표에서 ‘조치 필요’로 볼 수 있습니다.</p>}
            </section>
          )}

          <TeamTable
            list={visible}
            total={list.length}
            counts={{ action: list.filter(needsAction).length, ok: list.filter((r) => !needsAction(r)).length }}
            filter={filter}
            setFilter={setFilter}
          />
        </>
      )}
    </main>
  );
}

function TeamTable({
  list,
  total,
  counts,
  filter,
  setFilter,
}: {
  list: TeamRow[];
  total: number;
  counts: { action: number; ok: number };
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  const filters: Array<[Filter, string]> = [
    ['all', `전체 ${total}`],
    ['action', `조치 필요 ${counts.action}`],
    ['ok', `정리됨 ${counts.ok}`],
  ];
  return (
    <section aria-labelledby="teams-h" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 id="teams-h" className="text-[28px] font-extrabold tracking-[-0.02em]">
            팀별 판정
          </h2>
          <DemoBadge />
        </div>
        <div role="group" aria-label="판정 필터" className="flex flex-wrap gap-1.5 rounded-full bg-canvas p-1">
          {filters.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cx('min-h-9 rounded-full px-3.5 text-[13px]', filter === key ? 'bg-white font-bold shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-muted')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <p className="rounded-[18px] border border-line px-6 py-10 text-center text-sm text-muted">
          아직 접수된 팀이 없습니다.{' '}
          <Link to="/intake" className="font-bold text-brand-strong underline underline-offset-2">
            원본을 접수
          </Link>
          하면 팀이 자동으로 만들어집니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[18px] border border-line">
          <table className="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">접수 서류</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">판정</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">근거</th>
                <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">담당자 결정</th>
                <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀장 안내</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const s = r.submission;
                return (
                  <tr key={r.id} className="border-b border-line-soft last:border-b-0 hover:bg-[#fafbfb]">
                    <td className="px-5 py-4 align-top">
                      {s ? (
                        <Link to={`/teams/${s.id}`} className="font-bold text-ink hover:text-brand-strong">
                          {r.name}
                        </Link>
                      ) : (
                        <strong>{r.name}</strong>
                      )}
                      <div className="mt-0.5 text-xs text-subtle">
                        {r.rep && <span>{r.rep} · </span>}
                        <span className="font-mono">{s ? `v${s.version}` : '제출본 없음'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-4 align-top">{s ? <DocChips documents={r.detail?.result?.documents} /> : '—'}</td>
                    <td className="px-3 py-4 align-top">
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
                    <td className="max-w-[420px] px-3 py-4 align-top leading-normal text-ink-2">
                      {r.held
                        ? '이 팀에 속할 수 있는 미배정 파일이 있어 판정을 기다립니다.'
                        : s?.error || r.detail?.result?.reason || (s && busyStates.has(s.state) ? 'Studio 판정을 기다리는 중입니다.' : '')}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 align-top">
                      {s?.decision ? <span className={cx('text-xs font-bold', s.decision === '승인' ? 'text-brand-strong' : 'text-alert-strong')}>{s.decision}</span> : <span className="text-xs text-subtle">미기록</span>}
                    </td>
                    <td className="px-5 py-4 align-top">{r.leaderMail ? <StateBadge state={r.leaderMail.state} /> : <span className="text-xs text-subtle">없음</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!reviewLive && <p className="text-xs text-subtle">예시 데이터: 판정·근거는 유잇 미션2 정답 JSON(set01–set10) 기준, set03–set10 팀명은 임시 표기입니다.</p>}
    </section>
  );
}
