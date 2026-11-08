import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAsync } from '../api/client';
import { listReportTeams, listSubmissions, type Submission } from '../api/review';
import { Page } from '../components/Layout';
import { Notice, PageHeader, buttonStyles, cx } from '../components/ui';

type Payment = { award: string; support: string; gross: string; tax: string };
const FIELDS: Array<[keyof Payment, string, boolean]> = [
  ['award', '시상구분', false],
  ['support', '지원액(원)', true],
  ['gross', '지급총액', true],
  ['tax', '세액 · 차인지급액', true],
];
const emptyPayment: Payment = { award: '', support: '', gross: '', tax: '' };

export default function Report() {
  const ready = useAsync(listReportTeams, []);
  const all = useAsync(listSubmissions, []);
  const [order, setOrder] = useState<Submission[]>([]);
  const [pay, setPay] = useState<Record<string, Payment>>({});

  useEffect(() => {
    if (ready.data) setOrder(ready.data);
  }, [ready.data]);

  const held = (all.data?.length ?? 0) - order.length;
  const blanks = order.reduce((n, t) => n + FIELDS.filter(([k]) => !(pay[t.id]?.[k] ?? '').trim()).length, 0);

  const move = (index: number, delta: number) =>
    setOrder((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  const update = (id: string, key: keyof Payment, value: string) =>
    setPay((p) => ({ ...p, [id]: { ...emptyPayment, ...p[id], [key]: value } }));

  let serial = 0;
  const rows = order.flatMap((t) =>
    Array.from({ length: t.memberCount ?? 1 }, (_, i) => ({
      n: ++serial,
      name: i === 0 ? '○○○ (대표)' : '○○○',
      team: t.teamName,
      award: pay[t.id]?.award.trim() || '미확인',
      support: pay[t.id]?.support.trim() || '미확인',
      first: i === 0,
    })),
  );

  return (
    <Page tone="gray">
      <PageHeader title="보고서 확정" demo lead="성공 판정을 받은 제출본만 묶습니다. 시상구분과 금액은 서류에서 추측하지 않고 직접 입력합니다." />

      <ol aria-label="진행 단계" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {['팀 순서·금액 입력', '미리보기 확인', 'HWPX · PDF 내려받기'].map((label, i) => (
          <li key={label} className={cx('flex items-center gap-3 rounded-2xl bg-white px-[18px] py-4', i === 0 && 'outline-2 outline-brand outline')}>
            <span className={cx('flex size-7 items-center justify-center rounded-full text-[13px] font-bold', i === 0 ? 'bg-brand-strong text-white' : 'bg-line text-ink-2')}>{i + 1}</span>
            <span className={cx('text-sm', i === 0 ? 'font-bold' : 'text-ink-2')}>{label}</span>
          </li>
        ))}
      </ol>

      {!ready.data ? (
        <Notice error={ready.error} onRetry={ready.reload} />
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="teams-h" className="flex min-w-0 flex-[1_1_400px] flex-col gap-3.5">
            <h2 id="teams-h" className="text-xl font-extrabold">
              팀 순서와 지급 정보
            </h2>
            {order.map((t, index) => (
              <div key={t.id} className="flex flex-col gap-3.5 rounded-[20px] bg-white p-5">
                <div className="flex items-center gap-3">
                  <span className="w-7 text-2xl font-extrabold text-brand-strong">{index + 1}</span>
                  <div className="flex flex-1 flex-col">
                    <strong className="text-base">{t.teamName}</strong>
                    <span className="font-mono text-xs text-subtle">
                      {t.id} · v{t.version} · 성공
                    </span>
                  </div>
                  <MoveButton label={`${t.teamName} 위로`} disabled={index === 0} onClick={() => move(index, -1)} dir="up" />
                  <MoveButton label={`${t.teamName} 아래로`} disabled={index === order.length - 1} onClick={() => move(index, 1)} dir="down" />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  {FIELDS.map(([key, label, numeric]) => (
                    <label key={key} className="flex flex-col gap-1.5 text-xs text-muted">
                      {label}
                      <input
                        type="text"
                        inputMode={numeric ? 'numeric' : undefined}
                        placeholder="미확인"
                        value={pay[t.id]?.[key] ?? ''}
                        onChange={(e) => update(t.id, key, e.target.value)}
                        className={cx('h-11 rounded-xl border border-line-2 bg-white px-3 text-sm text-ink', numeric && 'font-mono')}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-col gap-1.5 rounded-[20px] border border-dashed border-[#cdcfcf] px-5 py-[18px]">
              <strong className="text-sm">보류 {held}팀</strong>
              <span className="text-[13px] leading-relaxed text-muted">재제출요청·담당자확인 팀은 보완본이 성공하면 여기에 추가됩니다.</span>
              <Link to="/" className="text-[13px] font-bold text-brand-strong">
                업무 현황에서 보기 →
              </Link>
            </div>
          </section>

          <section aria-labelledby="preview-h" className="flex min-w-0 flex-[999_1_580px] flex-col gap-3.5">
            <h2 id="preview-h" className="text-xl font-extrabold">
              미리보기
            </h2>

            <div className="flex flex-col gap-3 rounded-[20px] bg-white p-5">
              <span className="text-[13px] text-muted">편철 순서 · 00 → 팀별 01 → 02 → 03</span>
              <ol aria-label="편철 순서" className="flex flex-wrap gap-2.5">
                <PageThumb code="00" label="지급내역서" accent />
                {order.flatMap((t) => (['01', '02', '03'] as const).map((c) => <PageThumb key={t.id + c} code={c} label={t.teamName} />))}
              </ol>
            </div>

            <div className="flex flex-col gap-3 rounded-[20px] bg-white p-[22px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-base">00 상금 지급내역서 · 지급상세</strong>
                <span className="text-xs text-subtle">학생 한 명당 한 행 · 대표 먼저</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-[13px]">
                  <thead>
                    <tr className="text-left text-muted">
                      {['연번', '성명', '학번(학교)', '전공', '팀명', '시상구분', '지원액(원)'].map((h) => (
                        <th key={h} scope="col" className="border-b border-line px-2 py-2.5 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.n} className="border-b border-line-soft">
                        <td className="px-2 py-2.5 font-mono">{r.n}</td>
                        <td className="px-2 py-2.5">{r.name}</td>
                        <td className="px-2 py-2.5 text-subtle">[학번] ([학교])</td>
                        <td className="px-2 py-2.5 text-subtle">[전공]</td>
                        <td className="px-2 py-2.5">{r.team}</td>
                        <td className={cx('px-2 py-2.5', r.award === '미확인' && 'text-caution')}>{r.first ? r.award : ''}</td>
                        <td className={cx('px-2 py-2.5', r.support === '미확인' && 'text-caution')}>{r.first ? r.support : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span className="text-xs text-subtle">
                팀 지원액은 팀당 한 번만 합산해 대표 행에만 표시합니다. 학생 {rows.length}행 · 대표 {order.length}행.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3.5 rounded-[20px] bg-white p-[22px]">
              <div className="flex flex-[1_1_260px] flex-col gap-1">
                <strong className="text-[15px]">{blanks > 0 ? `입력 대기 ${blanks}칸` : '입력 완료'}</strong>
                <span className="text-[13px] text-muted">보고서 생성 API가 연결되면 HWPX와 같은 내용의 PDF를 받을 수 있습니다.</span>
              </div>
              <button type="button" disabled className={buttonStyles.primary}>
                HWPX 내려받기
              </button>
              <button type="button" disabled className={cx(buttonStyles.secondary, 'min-h-12 px-[22px] text-[15px] font-bold')}>
                PDF 내려받기
              </button>
            </div>
          </section>
        </div>
      )}
    </Page>
  );
}

function MoveButton({ label, disabled, onClick, dir }: { label: string; disabled: boolean; onClick: () => void; dir: 'up' | 'down' }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="flex size-11 items-center justify-center rounded-xl border border-line-2 bg-white disabled:opacity-40">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d={dir === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
      </svg>
    </button>
  );
}

function PageThumb({ code, label, accent }: { code: string; label: string; accent?: boolean }) {
  return (
    <li className="flex w-[76px] flex-col items-center gap-1.5">
      <div className={cx('flex h-[86px] w-16 flex-col gap-1 rounded-md border border-line-2 p-2', accent ? 'bg-brand-tint' : 'bg-white')}>
        <span className={cx('font-mono text-sm', accent ? 'text-brand-strong' : 'text-ink')}>{code}</span>
        <span className="h-[3px] bg-line" />
        <span className="h-[3px] w-[65%] bg-line" />
        <span className="h-[3px] bg-line" />
      </div>
      <span className="text-center text-[11px] text-muted">{label}</span>
    </li>
  );
}
