import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { receiptName } from '../api/intake';
import { stateLabel } from '../api/labels';
import { Feedback, buttonStyles } from './ui';

type Impact = {
  team_count: number;
  batch_count: number;
  file_count: number;
  reviews: { id: string; team_name: string; intake_number: number | null; version: number; state: string; verdict: string | null; decision: string | null }[];
  reports: { id: string; version: number; state: string; edited: boolean }[];
  token: string;
};

type Props = {
  kind: '대회' | '묶음' | '원본';
  name: string;
  path: string;
  onDeleted: (impact: Impact) => void;
};

export default function DeleteIntake(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={buttonStyles.danger} aria-haspopup="dialog"
      aria-label={props.name + ' ' + props.kind + ' 삭제'} onClick={() => setOpen(true)}>{props.kind} 삭제</button>
    {open && <DeletionDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

function DeletionDialog({ kind, name, path, onDeleted, onClose }: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [impact, setImpact] = useState<Impact>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    const controller = new AbortController();
    api<Impact>(path + '/deletion-preview', { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setImpact(data); },
      err => { if (!controller.signal.aborted) setError(err.message); },
    );
    return () => controller.abort();
  }, [path, revision]);

  async function remove() {
    if (!impact || deleting) return;
    setDeleting(true);
    try {
      await api<void>(path, { method: 'DELETE', headers: { 'If-Match': '"' + impact.token + '"' } });
    } catch (err) {
      setError((err as Error).message);
      setImpact(undefined);
      setDeleting(false);
      return;
    }
    onClose();
    onDeleted(impact);
  }

  return <dialog ref={dialog} className="deletion-dialog" aria-labelledby={heading}
    onCancel={e => { if (deleting) e.preventDefault(); }} onClose={onClose}>
    <header className="border-b border-line px-5 py-4">
      <h2 id={heading} className="text-xl font-extrabold">{kind} 삭제 확인</h2>
      <p className="file-name mt-1 text-sm text-muted">{name}</p>
    </header>
    <div className="grid gap-4 overflow-y-auto p-5 text-sm">
      <Feedback error={error} />
      {error && <button type="button" className={buttonStyles.outline + ' justify-self-start'} onClick={() => {
        setError(''); setRevision(value => value + 1);
      }}>삭제 목록 다시 조회</button>}
      {!impact && !error && <p role="status">삭제할 자료를 조회하고 있습니다.</p>}
      {impact && <>
        <p>{kind === '대회' && <>등록 팀 {impact.team_count}개 · </>}접수 묶음 {impact.batch_count}건 · 원본 {impact.file_count}개 삭제</p>
        {kind === '원본' && impact.batch_count > 0 && <p className="font-semibold">마지막 원본이므로 이 접수 내역도 삭제됩니다.</p>}
        <section>
          <h3 className="font-bold">팀별 판정 {impact.reviews.length}건</h3>
          {impact.reviews.length ? <ul className="mt-1 divide-y divide-line-soft">
            {impact.reviews.map(r => <li key={r.id} className="py-1.5">
              {receiptName(r.team_name, r.intake_number)} · 제출본 v{r.version} · {stateLabel(r.state)}
              {r.verdict && <> · 판정 {r.verdict}</>}{r.decision && <> · 담당자 {r.decision}</>}
            </li>)}
          </ul> : <p className="mt-1 text-muted">함께 삭제할 판정이 없습니다.</p>}
        </section>
        <section>
          <h3 className="font-bold">지급내역서 {impact.reports.length}건</h3>
          {impact.reports.length ? <ul className="mt-1 divide-y divide-line-soft">
            {impact.reports.map(r => <li key={r.id} className="py-1.5">
              지급내역서 v{r.version}{r.edited && ' · 편집본'} · {r.state === 'confirmed' ? '보고서 확정' : stateLabel(r.state)}
            </li>)}
          </ul> : <p className="mt-1 text-muted">함께 삭제할 보고서가 없습니다.</p>}
        </section>
        <p className="rounded-xl bg-alert-soft px-3 py-2 text-alert-strong">삭제 후 되돌릴 수 없습니다. 원본의 수정본, 판정의 메일 이력, 보고서의 HWPX·PDF도 함께 삭제됩니다.</p>
      </>}
    </div>
    <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
      <button type="button" autoFocus disabled={deleting} className={buttonStyles.outline} onClick={() => dialog.current?.close()}>취소</button>
      <button type="button" disabled={!impact || deleting} className="action bg-alert-strong px-4 text-white" onClick={remove}>
        {deleting ? '삭제 중…' : kind + ' 삭제하기'}
      </button>
    </footer>
  </dialog>;
}
