import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAsync } from '../api/client';
import { listSubmissions, type Submission, type Verdict } from '../api/review';
import { MailBadge, Notice, VerdictBadge, DocChips, DemoBadge, buttonStyles, cx } from '../components/ui';
import { useEvent } from '../context/EventContext';

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
  성공: '제출본 확정 가능',
  담당자확인: '원본 대조 후 결과 발송',
  재제출요청: '팀장 보완 메일 자동 발송',
};

export default function Dashboard() {
  const { event } = useEvent();
  const result = useAsync(listSubmissions, []);
  const [filter, setFilter] = useState<Filter>('all');
  const list = result.data ?? [];
  const count = (v: Verdict) => list.filter((s) => s.verdict === v).length;
  const visible = useMemo(
    () => list.filter((s) => (filter === 'all' ? true : filter === 'ok' ? s.verdict === '성공' : s.verdict !== '성공')),
    [list, filter],
  );
  const firstCheck = list.find((s) => s.verdict === '담당자확인');

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
          {firstCheck && (
            <Link to={`/teams/${firstCheck.id}`} className={cx(buttonStyles.text, 'text-base')}>
              검토 대기 열기 →
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

      {!result.data ? (
        <Notice error={result.error} onRetry={result.reload} />
      ) : (
        <>
          <section aria-label="판정 요약" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            <div className="flex flex-col gap-2 rounded-[22px] bg-canvas p-7">
              <span className="text-sm text-muted">접수 팀</span>
              <span className="text-[44px] font-extrabold tracking-[-0.03em]">{list.length}</span>
              <span className="text-[13px] text-muted">
                {list[0]?.id} – {list[list.length - 1]?.id}
              </span>
            </div>
            {(['성공', '담당자확인', '재제출요청'] as Verdict[]).map((v) => (
              <div key={v} className="flex flex-col gap-2 rounded-[22px] bg-canvas p-7">
                <span className={cx('text-sm font-bold', summaryTone[v])}>{v}</span>
                <span className="text-[44px] font-extrabold tracking-[-0.03em]">{count(v)}</span>
                <span className="text-[13px] text-muted">{summaryNote[v]}</span>
              </div>
            ))}
          </section>

          {firstCheck && (
            <section role="status" className="flex flex-wrap items-center gap-4 rounded-[18px] border border-caution-line bg-caution-bg px-6 py-5">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-caution" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6M12 16.5v.5" />
              </svg>
              <div className="flex flex-[1_1_380px] flex-col gap-1">
                <strong className="text-[15px]">
                  {firstCheck.id} {firstCheck.summary}
                </strong>
                <span className="text-sm text-muted">
                  원본을 대조해 ‘이상 없음’ 또는 ‘보완 필요’를 기록하면 팀장에게 결과 한 통이 발송됩니다.
                </span>
              </div>
              <Link to={`/teams/${firstCheck.id}`} className={buttonStyles.outline}>
                원본 대조하기
              </Link>
            </section>
          )}

          <TeamTable list={visible} total={list.length} counts={{ action: list.length - count('성공'), ok: count('성공') }} filter={filter} setFilter={setFilter} />
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
  list: Submission[];
  total: number;
  counts: { action: number; ok: number };
  filter: Filter;
  setFilter: (f: Filter) => void;
}) {
  const filters: Array<[Filter, string]> = [
    ['all', `전체 ${total}`],
    ['action', `조치 필요 ${counts.action}`],
    ['ok', `성공 ${counts.ok}`],
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
              className={cx(
                'min-h-9 rounded-full px-3.5 text-[13px]',
                filter === key ? 'bg-white font-bold shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-[18px] border border-line">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀</th>
              <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">접수 서류</th>
              <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">판정</th>
              <th scope="col" className="border-b border-line px-3 py-3.5 font-medium">근거</th>
              <th scope="col" className="border-b border-line px-5 py-3.5 font-medium">팀장 안내</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="border-b border-line-soft last:border-b-0 hover:bg-[#fafbfb]">
                <td className="px-5 py-4 align-top">
                  <Link to={`/teams/${s.id}`} className="font-bold text-ink hover:text-brand-strong">
                    {s.teamName}
                  </Link>
                  <div className="mt-0.5 font-mono text-xs text-subtle">
                    {s.id} · v{s.version}
                  </div>
                </td>
                <td className="px-3 py-4 align-top">
                  <DocChips docs={s.docs} />
                </td>
                <td className="px-3 py-4 align-top">
                  <VerdictBadge verdict={s.verdict} />
                </td>
                <td className="px-3 py-4 align-top leading-normal text-ink-2">{s.summary}</td>
                <td className="px-5 py-4 align-top">
                  <MailBadge state={s.mail.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-subtle">판정·근거는 유잇 미션2 정답 JSON(set01–set10) 기준. 팀명이 없는 set03–set10은 임시 표기입니다.</p>
    </section>
  );
}
