import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { docLabels, when } from '../api/labels';
import { assignFile, filePreviewUrl, getBatch, retryFile, type BatchDetail, type FileInfo } from '../api/service';
import { Page } from '../components/Layout';
import { Feedback, Notice, PageHeader, PdfFrame, StateBadge, buttonStyles, cx, inputStyle } from '../components/ui';
import { useEvent } from '../context/EventContext';

type Item = { batch: BatchDetail; file: FileInfo };
type Action = 'assign' | 'outside' | 'hold';

const needs = (f: FileInfo) => f.state === 'unassigned' || f.state === 'error';

export default function Assign() {
  const { dashboard, dashboardError, refresh, revision } = useEvent();
  const [batches, setBatches] = useState<BatchDetail[]>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [showDone, setShowDone] = useState(false);
  const [notice, setNotice] = useState('');
  const saved = (message: string) => {
    setNotice(message);
    refresh();
  };

  // 배정이 끝나지 않은 접수와 최근 접수 3건의 파일을 읽는다.
  const batchIds = useMemo(() => {
    if (!dashboard) return [];
    const open = dashboard.batches.filter((b) => b.pending > 0 || b.state !== 'assigned').map((b) => b.id);
    const recent = dashboard.batches.slice(0, 3).map((b) => b.id);
    return [...new Set([...open, ...recent])];
  }, [dashboard]);

  useEffect(() => {
    let alive = true;
    Promise.all(batchIds.map((id) => getBatch(id))).then(
      (list) => {
        if (!alive) return;
        setBatches(list);
        setError('');
      },
      (err: Error) => alive && setError(err.message),
    );
    return () => {
      alive = false;
    };
  }, [batchIds, revision]);

  const items: Item[] = (batches ?? []).flatMap((batch) => batch.files.map((file) => ({ batch, file })));
  const pending = items.filter((i) => needs(i.file));
  const others = items.filter((i) => !needs(i.file));
  const current = items.find((i) => i.file.id === selected) ?? pending[0];
  const teamName = (id?: string | null) => dashboard?.teams.find((t) => t.id === id)?.name ?? (id ? '알 수 없는 팀' : '');
  const preparing = dashboard?.batches.some((b) => b.state === 'preparing');

  return (
    <Page tone="gray">
      <PageHeader
        title="팀 배정 확인"
        lead="후보가 한 팀이고 근거가 서로 맞을 때만 자동으로 배정합니다. 근거가 모자라거나 부딪히는 파일만 여기 남습니다. 배정을 바꾸면 파일·변경 전후 팀·근거·처리자가 기록됩니다."
      />

      <section aria-label="배정 요약" className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Stat label="접수 묶음" value={dashboard?.batches.length ?? 0} />
        <Stat label="최근 접수 파일" value={items.length} />
        <Stat label="확인 필요" value={pending.length} warn={pending.length > 0} />
      </section>
      {preparing && <p className="text-sm text-muted">파일 판독 중인 접수가 있어 자동으로 새로고침합니다.</p>}
      <Feedback message={notice} />

      {!dashboard || !batches ? (
        <Notice error={dashboardError || error} onRetry={refresh} />
      ) : items.length === 0 ? (
        <p className="rounded-[22px] bg-white px-6 py-10 text-center text-sm text-muted">
          접수된 원본이 없습니다.{' '}
          <Link to="/intake" className="font-bold text-brand-strong underline underline-offset-2">
            원본 접수
          </Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <section aria-labelledby="queue-h" className="min-w-0 flex-[1_1_340px] overflow-hidden rounded-[22px] border border-line bg-white">
            <h2 id="queue-h" className="px-[22px] pb-2.5 pt-[18px] text-base font-extrabold">
              확인할 파일 {pending.length}
            </h2>
            <ul>
              {pending.length === 0 && <li className="border-t border-line-soft px-[22px] py-4 text-sm text-brand-strong">모든 파일의 팀 배정이 끝났습니다.</li>}
              {pending.map((i) => (
                <FileRow key={i.file.id} item={i} active={current?.file.id === i.file.id} onClick={() => setSelected(i.file.id)} teamName={teamName} />
              ))}
            </ul>
            {others.length > 0 && (
              <>
                <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className="w-full border-t border-line px-[22px] py-3 text-left text-xs font-bold text-muted">
                  배정·처리된 파일 {others.length} {showDone ? '접기' : '보기'}
                </button>
                {showDone && (
                  <ul>
                    {others.map((i) => (
                      <FileRow key={i.file.id} item={i} active={current?.file.id === i.file.id} onClick={() => setSelected(i.file.id)} teamName={teamName} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {current && <Detail key={current.file.id + current.batch.revision} item={current} teamName={teamName} onSaved={saved} />}
        </div>
      )}
    </Page>
  );
}

function FileRow({ item, active, onClick, teamName }: { item: Item; active: boolean; onClick: () => void; teamName: (id?: string | null) => string }) {
  const f = item.file;
  return (
    <li className="border-t border-line-soft">
      <button
        type="button"
        aria-current={active}
        onClick={onClick}
        className={cx('flex min-h-16 w-full flex-col items-start gap-1 border-l-[3px] px-[22px] py-3.5 text-left', active ? 'border-brand bg-brand-tint' : 'border-transparent hover:bg-canvas')}
      >
        <span className="break-all font-mono text-[13px] text-ink">{f.name}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <StateBadge state={f.state} />
          {f.kind !== '?' && <span>{docLabels[f.kind] ?? f.kind}</span>}
          {f.team && <span>· {teamName(f.team)}</span>}
          {needs(f) && f.candidates.length > 0 && <span>· 후보 {f.candidates.map(teamName).join(', ')}</span>}
        </span>
      </button>
    </li>
  );
}

function Detail({ item, teamName, onSaved }: { item: Item; teamName: (id?: string | null) => string; onSaved: (message: string) => void }) {
  const { dashboard } = useEvent();
  const { batch, file } = item;
  const teams = dashboard?.teams ?? [];
  const [action, setAction] = useState<Action>('assign');
  const [team, setTeam] = useState(file.team ?? file.candidates[0] ?? '');
  const [exclude, setExclude] = useState<string[]>(file.excluded);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = batch.state !== 'preparing';

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await assignFile(batch.id, file.id, { action, team: action === 'assign' ? team : '', reason: reason.trim(), revision: batch.revision, exclude: action === 'hold' ? exclude : [] });
      onSaved(
        action === 'assign'
          ? `${file.name} → ${teamName(team)} 배정을 기록했습니다. 팀 파일 목록이 확정되면 판정을 시작합니다.`
          : action === 'outside'
            ? `${file.name}을(를) 대상 외로 처리했습니다.`
            : `${file.name}을(를) 보류했습니다. 제외한 팀은 먼저 진행합니다.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError('');
    try {
      await retryFile(batch.id, file.id);
      onSaved(`${file.name} 판독을 다시 시작했습니다.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="detail-h" className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
      <div className="flex flex-col gap-5 rounded-[22px] border border-line bg-white p-[26px]">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <h2 id="detail-h" className="break-all font-mono text-lg font-medium">
            {file.name}
          </h2>
          <span className="rounded-full bg-canvas px-2.5 py-1 text-xs text-ink-2">본문 분류 · {docLabels[file.kind] ?? file.kind}</span>
          <StateBadge state={file.state} />
        </div>
        <p className="text-xs text-subtle">
          접수 {when(batch.created)} · {file.pages ? `${file.pages}쪽` : '판독 전'}
          {batch.base && ' · 보완 접수'}
        </p>
        {file.reason && <p className="text-[15px] leading-relaxed text-ink-2">{file.reason}</p>}
        {file.team && <p className="text-sm">현재 배정: <strong>{teamName(file.team)}</strong></p>}
        {file.candidates.length > 0 && (
          <p className="text-sm text-ink-2">
            후보 팀: {file.candidates.map(teamName).join(', ')}
            {file.excluded.length > 0 && <span className="text-muted"> · 제외 {file.excluded.map(teamName).join(', ')}</span>}
          </p>
        )}

        <PdfFrame url={filePreviewUrl(file, file.page)} title={file.name} height={480} />

        {file.state === 'error' ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink-2">손상된 파일이면 팀에서 다시 받아 접수해 주세요. 일시 오류라면 판독을 다시 시도할 수 있습니다.</span>
            <button type="button" onClick={retry} disabled={busy} className={buttonStyles.outline}>
              판독 다시 시도
            </button>
          </div>
        ) : (
          <fieldset disabled={!editable || busy} className="flex flex-col gap-3.5 border-t border-line-soft pt-4">
            <legend className="sr-only">배정 결정</legend>
            <div role="radiogroup" aria-label="배정 결정" className="flex flex-wrap gap-2">
              {(
                [
                  ['assign', '팀에 배정'],
                  ['hold', '보류 (후보 제외)'],
                  ['outside', '대상 외'],
                ] as Array<[Action, string]>
              ).map(([key, label]) => (
                <label key={key} className={cx('flex min-h-10 cursor-pointer items-center rounded-full border px-4 text-sm', action === key ? 'border-ink bg-ink font-bold text-white' : 'border-line-2')}>
                  <input type="radio" name="action" value={key} checked={action === key} onChange={() => setAction(key)} className="sr-only" />
                  {label}
                </label>
              ))}
            </div>
            {action === 'assign' && (
              <label className="flex max-w-sm flex-col gap-1.5 text-xs text-muted">
                배정할 팀
                <select value={team} onChange={(e) => setTeam(e.target.value)} className={inputStyle}>
                  <option value="">팀 선택</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.rep ? ` · ${t.rep}` : ''}
                      {file.candidates.includes(t.id) ? ' (후보)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'hold' && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs text-muted">관련이 없다고 확인한 팀 (이 팀들은 먼저 진행합니다)</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {teams.map((t) => (
                    <label key={t.id} className="flex min-h-9 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={exclude.includes(t.id)}
                        onChange={(e) => setExclude((list) => (e.target.checked ? [...list, t.id] : list.filter((x) => x !== t.id)))}
                        className="size-4 accent-brand"
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <label className="flex flex-col gap-1.5 text-xs text-muted">
              근거 (원래 접수 경로 등, 2자 이상)
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={cx(inputStyle, 'h-auto py-2.5')} />
            </label>
            <div>
              <button type="button" onClick={submit} disabled={reason.trim().length < 2 || (action === 'assign' && !team)} className={buttonStyles.primary}>
                {action === 'assign' ? `${team ? teamName(team) : '팀'}에 배정` : action === 'hold' ? '보류 저장' : '대상 외 처리'}
              </button>
            </div>
          </fieldset>
        )}
        {batch.state === 'preparing' && <p className="text-xs text-subtle">파일 판독이 끝나면 배정할 수 있습니다.</p>}
        <Feedback error={error} />
      </div>
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={cx('flex flex-col gap-1 rounded-[18px] bg-white px-[22px] py-5', warn && 'outline-2 outline-[#f5c37a] outline')}>
      <span className={cx('text-[13px]', warn ? 'font-bold text-caution' : 'text-muted')}>{label}</span>
      <span className="text-[32px] font-extrabold">{value}</span>
    </div>
  );
}
