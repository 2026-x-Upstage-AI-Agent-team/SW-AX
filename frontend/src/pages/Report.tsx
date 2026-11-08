import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import { reviewLive } from '../api/backend';
import { useAsync, usePolling } from '../api/client';
import { when } from '../api/labels';
import {
  confirmReport,
  createReport,
  getDraft,
  getReport,
  getSubmission,
  reportFileUrl,
  reviewBody,
  saveReview,
  uploadEditedReport,
  type DraftTeam,
  type ReportView,
} from '../api/service';
import { Page } from '../components/Layout';
import { Feedback, Notice, PageHeader, PdfFrame, StateBadge, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

type Pay = { award_type: string; support_amount: string; gross_amount: string; tax_amount: string; net_amount: string };
const PAY_FIELDS: Array<[keyof Pay, string, boolean]> = [
  ['award_type', '시상구분', false],
  ['support_amount', '지원액(원)', true],
  ['gross_amount', '지급총액', true],
  ['tax_amount', '세액', true],
  ['net_amount', '차인지급액', true],
];

const payOf = (t: DraftTeam): Pay => ({
  award_type: t.award_type ?? '',
  support_amount: t.support_amount ?? '',
  gross_amount: t.recipient?.gross_amount ?? '',
  tax_amount: t.recipient?.tax_amount ?? '',
  net_amount: t.recipient?.net_amount ?? '',
});

export default function Report() {
  const { dashboard, revision, refresh } = useEvent();
  const event = dashboard?.event ?? '';
  const draft = useAsync(() => (event ? getDraft(event) : Promise.resolve({ teams: [] as DraftTeam[] })), [event, revision]);
  const teams = useMemo(() => (draft.data?.teams ?? []).filter((t) => t.submission), [draft.data]);
  const ready = teams.filter((t) => t.pending.length === 0);
  const [order, setOrder] = useState<string[]>([]);
  const [rid, setRid] = useState<string>();

  // 처음에는 준비된 팀을 모두 현황 순서로 넣는다. 새로 준비된 팀은 뒤에 붙인다.
  useEffect(() => {
    setOrder((prev) => {
      const ids = ready.map((t) => t.submission!);
      const kept = prev.filter((id) => ids.includes(id));
      return prev.length ? [...kept, ...ids.filter((id) => !prev.includes(id) && !kept.includes(id))] : ids;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.map((t) => t.submission).join()]);

  const latest = dashboard?.reports[0];
  const activeRid = rid ?? latest?.id;
  const chosen = order.map((id) => teams.find((t) => t.submission === id)).filter((t): t is DraftTeam => !!t);
  const held = teams.filter((t) => t.pending.length > 0);

  const move = (index: number, delta: number) =>
    setOrder((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  const toggle = (sid: string, on: boolean) => setOrder((list) => (on ? [...list, sid] : list.filter((x) => x !== sid)));

  return (
    <Page tone="gray">
      <PageHeader
        title="보고서 확정"
        demo
        lead="담당자가 승인하고 시상구분·지원액을 넣은 팀만 편철합니다. 00 지급내역서의 두 표를 채우고 팀별 01→02→03 원본을 한 번씩 붙인 HWPX와 PDF를 만듭니다."
      />

      {!draft.data ? (
        <Notice error={draft.error} onRetry={draft.reload} />
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="teams-h" className="flex min-w-0 flex-[1_1_420px] flex-col gap-3.5">
            <h2 id="teams-h" className="text-xl font-extrabold">
              ① 팀 순서와 지급 정보
            </h2>
            {teams.length === 0 && <p className="rounded-[20px] bg-white px-5 py-6 text-sm text-muted">판정이 끝난 팀이 없습니다.</p>}
            {ready.map((t) => {
              const index = order.indexOf(t.submission!);
              return (
                <TeamCard
                  key={t.submission}
                  t={t}
                  index={index}
                  count={order.length}
                  onToggle={(on) => toggle(t.submission!, on)}
                  onMove={(d) => move(index, d)}
                  onSaved={refresh}
                />
              );
            })}
            {held.length > 0 && (
              <div className="flex flex-col gap-2.5 rounded-[20px] border border-dashed border-[#cdcfcf] px-5 py-[18px]">
                <strong className="text-sm">편철 전에 할 일 {held.length}팀</strong>
                {held.map((t) => (
                  <HeldTeam key={t.submission} t={t} onSaved={refresh} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="preview-h" className="flex min-w-0 flex-[999_1_580px] flex-col gap-3.5">
            <h2 id="preview-h" className="text-xl font-extrabold">
              ② 미리보기와 생성
            </h2>
            <Tables teams={chosen} />
            <Generate event={event} order={order} disabled={chosen.length === 0} onCreated={(id) => { setRid(id); refresh(); }} />
            {activeRid && <ReportPanel key={activeRid} rid={activeRid} onChanged={(id) => { if (id) setRid(id); refresh(); }} />}
            {dashboard && dashboard.reports.length > 0 && (
              <div className="flex flex-col gap-2 rounded-[20px] bg-white p-5">
                <strong className="text-sm">생성한 버전</strong>
                <ul className="flex flex-col gap-1">
                  {dashboard.reports.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setRid(r.id)}
                        className={cx('flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm', r.id === activeRid ? 'bg-brand-tint font-bold' : 'hover:bg-canvas')}
                      >
                        <span className="font-mono">v{r.version}</span>
                        <StateBadge state={r.state} />
                        <span className="text-xs text-subtle">{when(r.created)}</span>
                        {r.error && <span className="truncate text-xs text-alert-strong">{r.error}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}

function TeamCard({
  t,
  index,
  count,
  onToggle,
  onMove,
  onSaved,
}: {
  t: DraftTeam;
  index: number;
  count: number;
  onToggle: (on: boolean) => void;
  onMove: (delta: number) => void;
  onSaved: () => void;
}) {
  const included = index >= 0;
  return (
    <div className={cx('flex flex-col gap-3.5 rounded-[20px] bg-white p-5', !included && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <label className="flex items-center">
          <input type="checkbox" checked={included} onChange={(e) => onToggle(e.target.checked)} className="size-5 accent-brand" aria-label={`${t.team} 편철에 포함`} />
        </label>
        <span className="w-7 text-2xl font-extrabold text-brand-strong">{included ? index + 1 : '–'}</span>
        <div className="flex flex-1 flex-col">
          <strong className="text-base">{t.team}</strong>
          <span className="text-xs text-subtle">
            {t.rep && `대표 ${t.rep} · `}v{t.version} · 학생 {t.members.length}명
          </span>
        </div>
        <MoveButton label={`${t.team} 위로`} disabled={!included || index === 0} onClick={() => onMove(-1)} dir="up" />
        <MoveButton label={`${t.team} 아래로`} disabled={!included || index === count - 1} onClick={() => onMove(1)} dir="down" />
      </div>
      <PayForm t={t} onSaved={onSaved} />
    </div>
  );
}

function HeldTeam({ t, onSaved }: { t: DraftTeam; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const onlyPay = t.pending.every((p) => p === '시상구분·지원액 입력');
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{t.team}</strong>
        <span className="text-xs text-caution">{t.pending.join(' · ')}</span>
        <span className="flex-auto" />
        {onlyPay || t.pending.includes('시상구분·지원액 입력') ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-xs font-bold text-brand-strong">
            {open ? '접기' : '지급 정보 입력'}
          </button>
        ) : null}
        {t.submission && (
          <Link to={`/teams/${t.submission}`} className="text-xs font-bold text-brand-strong">
            검토 화면 →
          </Link>
        )}
      </div>
      {open && <PayForm t={t} onSaved={onSaved} />}
    </div>
  );
}

/** 팀별 시상구분·지원액·지급액 입력. 검토 저장 API에 기존 검토 내용과 함께 보낸다. */
function PayForm({ t, onSaved }: { t: DraftTeam; onSaved: () => void }) {
  const [pay, setPay] = useState<Pay>(payOf(t));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = JSON.stringify(pay) !== JSON.stringify(payOf(t));

  async function save() {
    if (!t.submission) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const s = await getSubmission(t.submission);
      const clean = (v: string) => v.replace(/\s/g, '');
      await saveReview(
        s.id,
        reviewBody(s, {
          award_type: pay.award_type.trim(),
          support_amount: clean(pay.support_amount),
          recipient: { ...s.fields.recipient, gross_amount: clean(pay.gross_amount), tax_amount: clean(pay.tax_amount), net_amount: clean(pay.net_amount) },
        }),
      );
      setMessage('저장했습니다.');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-2.5">
        {PAY_FIELDS.map(([key, label, numeric]) => (
          <label key={key} className={cx('flex flex-col gap-1.5 text-xs text-muted', key === 'award_type' && 'col-span-2')}>
            {label}
            <input
              type="text"
              inputMode={numeric ? 'numeric' : undefined}
              placeholder="미확인"
              value={pay[key]}
              disabled={!reviewLive || busy}
              onChange={(e) => setPay((p) => ({ ...p, [key]: e.target.value }))}
              className={cx(inputStyle, numeric && 'font-mono')}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={!reviewLive || busy || !dirty} className={cx(buttonStyles.secondary, 'min-h-10')}>
          지급 정보 저장
        </button>
        <span className="text-[11px] text-subtle">금액은 원 단위 정수. 세액은 자동 계산하지 않습니다.</span>
      </div>
      <Feedback error={error} message={message} />
    </div>
  );
}

function Tables({ teams }: { teams: DraftTeam[] }) {
  let serial = 0;
  const rows = teams.flatMap((t) =>
    [...t.members].sort((a, b) => (a.role === '대표' ? -1 : b.role === '대표' ? 1 : 0)).map((m, i) => ({ n: ++serial, m, t, first: i === 0 })),
  );
  const head = 'border-b border-line px-2 py-2.5 font-medium';
  const cell = 'px-2 py-2.5';
  const unknown = (v?: string) => (v ? v : <span className="text-caution">미확인</span>);
  return (
    <>
      <div className="flex flex-col gap-3 rounded-[20px] bg-white p-5">
        <span className="text-[13px] text-muted">편철 순서 · 00 → 팀별 01 → 02 → 03</span>
        <ol aria-label="편철 순서" className="flex flex-wrap gap-2.5">
          <PageThumb code="00" label="지급내역서" accent />
          {teams.flatMap((t) => (['01', '02', '03'] as const).map((c) => <PageThumb key={t.submission + c} code={c} label={t.team} />))}
        </ol>
      </div>

      <div className="flex flex-col gap-3 rounded-[20px] bg-white p-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <strong className="text-base">지급상세 (학생 전체)</strong>
          <span className="text-xs text-subtle">
            학생 {rows.length}행 · 팀 지원액은 대표 행에만 표시
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-muted">
                {['연번', '성명', '학번(학교)', '전공', '팀명', '시상구분', '지원액(원)'].map((h) => (
                  <th key={h} scope="col" className={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center text-muted">
                    편철할 팀을 선택하세요.
                  </td>
                </tr>
              )}
              {rows.map(({ n, m, t, first }) => (
                <tr key={n} className="border-b border-line-soft">
                  <td className={cx(cell, 'font-mono')}>{n}</td>
                  <td className={cell}>
                    {m.name}
                    {m.role === '대표' && <span className="text-muted"> (대표)</span>}
                  </td>
                  <td className={cell}>
                    <span className="font-mono">{m.student_id || '—'}</span>
                    {m.school && <span className="text-muted"> ({m.school})</span>}
                  </td>
                  <td className={cell}>{m.major}</td>
                  <td className={cell}>{t.team}</td>
                  <td className={cell}>{first ? unknown(t.award_type) : ''}</td>
                  <td className={cx(cell, 'font-mono')}>{first ? unknown(t.support_amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-[20px] bg-white p-[22px]">
        <strong className="text-base">지급대상자 상세 (팀 대표)</strong>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-muted">
                {['연번', '성명', '주민번호', '은행', '계좌번호', '예금주', '지급총액', '세액', '차인지급액'].map((h) => (
                  <th key={h} scope="col" className={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((t, i) => {
                const rep = t.members.find((m) => m.role === '대표');
                const r = t.recipient ?? {};
                return (
                  <tr key={t.submission} className="border-b border-line-soft">
                    <td className={cx(cell, 'font-mono')}>{i + 1}</td>
                    <td className={cell}>{rep?.name ?? t.rep}</td>
                    <td className={cx(cell, 'font-mono')}>{unknown(r.rrn_display)}</td>
                    <td className={cell}>{unknown(r.bank_name)}</td>
                    <td className={cx(cell, 'font-mono')}>{unknown(r.account_number)}</td>
                    <td className={cell}>{unknown(r.account_holder)}</td>
                    <td className={cx(cell, 'font-mono')}>{unknown(r.gross_amount)}</td>
                    <td className={cx(cell, 'font-mono')}>{unknown(r.tax_amount)}</td>
                    <td className={cx(cell, 'font-mono')}>{unknown(r.net_amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <span className="text-xs text-subtle">주민번호는 원본의 마스킹 표기 그대로이며 가려진 숫자를 복원하지 않습니다.</span>
      </div>
    </>
  );
}

function Generate({ event, order, disabled, onCreated }: { event: string; order: string[]; disabled: boolean; onCreated: (rid: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true);
    setError('');
    try {
      const r = await createReport(event, order);
      onCreated(r.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-[20px] bg-white p-[22px]">
      <div className="flex flex-wrap items-center gap-3.5">
        <div className="flex flex-[1_1_260px] flex-col gap-1">
          <strong className="text-[15px]">선택한 {order.length}팀으로 보고서 생성</strong>
          <span className="text-[13px] text-muted">같은 내용이면 기존 버전을 다시 씁니다. 지급 정보나 제출본이 바뀌면 새 버전을 만듭니다.</span>
        </div>
        <button type="button" onClick={run} disabled={!reviewLive || disabled || busy} className={buttonStyles.primary}>
          미리보기 생성
        </button>
      </div>
      {!reviewLive && <p className="text-xs text-subtle">예시 데이터에서는 보고서를 만들 수 없습니다. 검토 서비스에 연결해 실행해 주세요.</p>}
      <Feedback error={error} />
    </div>
  );
}

function ReportPanel({ rid, onChanged }: { rid: string; onChanged: (newRid?: string) => void }) {
  const [tick, setTick] = useState(0);
  const report = useAsync<ReportView>(() => getReport(rid), [rid, tick]);
  const r = report.data;
  usePolling(!!r && (r.state === 'queued' || r.state === 'building'), () => setTick((v) => v + 1), 2500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function act(task: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    try {
      const next = await task();
      setTick((v) => v + 1);
      onChanged(next || undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const onEdited = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) act(async () => (await uploadEditedReport(rid, file)).id);
  };

  if (!r) return <Notice error={report.error} onRetry={report.reload} />;
  const ready = r.state === 'preview' || r.state === 'confirmed';
  return (
    <div className="flex flex-col gap-3.5 rounded-[20px] bg-white p-[22px]">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-base">보고서 v{r.version}</strong>
        <StateBadge state={r.state} />
        {r.parent && <span className="text-xs text-muted">편집본 반영</span>}
        <span className="text-xs text-subtle">{r.teams.join(' → ')}</span>
      </div>
      {r.stale && <Feedback error="생성 뒤 지급 정보나 제출본이 바뀌었습니다. 새 보고서를 생성해 주세요." />}
      {r.error && <Feedback error={r.error} />}
      {(r.state === 'queued' || r.state === 'building') && <p className="text-sm text-muted">한글 문서를 만드는 중입니다. 완료되면 미리보기가 열립니다.</p>}
      {ready && <PdfFrame url={reportFileUrl(r.id, 'preview')} title={`보고서 v${r.version} 미리보기`} height={720} />}
      <div className="flex flex-wrap items-center gap-2.5">
        {r.state === 'preview' && (
          <button type="button" disabled={busy || r.stale} onClick={() => act(() => confirmReport(r.id).then(() => undefined))} className={buttonStyles.primary}>
            이 버전으로 확정
          </button>
        )}
        {r.state === 'confirmed' && !r.stale && (
          <>
            <a href={reportFileUrl(r.id, 'hwpx')} download className={buttonStyles.primary}>
              HWPX 내려받기
            </a>
            <a href={reportFileUrl(r.id, 'pdf')} download className={cx(buttonStyles.secondary, 'min-h-12 px-[22px] text-[15px] font-bold')}>
              PDF 내려받기
            </a>
            <label className={cx(buttonStyles.text, 'cursor-pointer')}>
              한글에서 고친 HWPX 올리기
              <input type="file" accept=".hwpx" onChange={onEdited} disabled={busy} className="sr-only" />
            </label>
          </>
        )}
      </div>
      <Feedback error={error} />
    </div>
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
