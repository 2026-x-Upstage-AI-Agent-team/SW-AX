import type { ReactNode } from 'react';
import { CircleAlert, FileText, LoaderCircle } from 'lucide-react';
import { stateLabel } from '../api/labels';
import type { DocKey, Ref, Verdict } from '../api/service';

export function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

const verdictStyle: Record<Verdict, string> = {
  성공: 'bg-brand-tint text-brand-strong',
  담당자확인: 'bg-caution-tint text-caution',
  재제출요청: 'bg-alert-tint text-alert-strong',
};

const pill = 'inline-flex items-center rounded-md font-semibold whitespace-nowrap';

export function VerdictBadge({ verdict, size = 'sm' }: { verdict: Verdict; size?: 'sm' | 'md' }) {
  return <span className={cx(pill, size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]', verdictStyle[verdict])}>{verdict}</span>;
}

/** 서비스 상태 값(queued, polling, failed …)을 한국어 배지로 */
export function StateBadge({ state, size = 'sm' }: { state: string; size?: 'sm' | 'md' }) {
  const tone =
    ['failed', 'error', 'invalid', 'access', 'ownership'].includes(state)
      ? 'bg-alert-tint text-alert-strong'
      : ['uncertain', 'paused', 'unassigned', 'review', 'waiting', 'blocked'].includes(state)
        ? 'bg-caution-tint text-caution'
        : ['sent', 'local', 'done', 'assigned', 'confirmed', 'preview', 'received'].includes(state)
          ? 'bg-brand-tint text-brand-strong'
          : 'bg-canvas text-ink-2';
  return <span className={cx(pill, size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]', tone)}>{stateLabel(state)}</span>;
}

/** 01·02·03 부수를 칩으로. 0부는 없음, 2부 이상은 중복으로 표시 */
export function DocChips({ documents }: { documents?: Partial<Record<DocKey, Ref[]>> }) {
  if (!documents) return <span className="text-xs text-subtle">—</span>;
  return (
    <ul className="flex flex-wrap gap-1.5 text-[13px] font-semibold tabular-nums" aria-label="접수 서류">
      {(['01', '02', '03'] as const).map((code) => {
        const n = documents[code]?.length ?? 0;
        if (n === 0)
          return (
            <li key={code} className="rounded-lg border border-dashed border-alert-strong px-[7px] py-[3px] text-alert-strong">
              {code} 없음
            </li>
          );
        if (n > 1)
          return (
            <li key={code} className="rounded-lg bg-alert-tint px-2 py-1 text-alert-strong">
              {code} ×{n}
            </li>
          );
        return (
          <li key={code} className="rounded-lg bg-canvas px-2 py-1 text-ink">
            {code}
          </li>
        );
      })}
      {(documents['?']?.length ?? 0) > 0 && (
        <li className="rounded-lg bg-caution-tint px-2 py-1 text-caution">기타 {documents['?']!.length}</li>
      )}
    </ul>
  );
}

export type CheckState = 'pass' | 'fail' | 'check';
export const checkState = (passed: boolean | null): CheckState => (passed === true ? 'pass' : passed === false ? 'fail' : 'check');

export function CheckIcon({ state }: { state: CheckState }) {
  if (state === 'pass')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-strong" aria-label="통과" role="img">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  if (state === 'fail')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="shrink-0 text-alert-strong" aria-label="문제" role="img">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    );
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 text-caution" aria-label="확인 필요" role="img">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </svg>
  );
}


export function Notice({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div role={error ? 'alert' : 'status'} className={cx('flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm', error ? 'bg-alert-soft text-alert-strong' : 'bg-canvas text-muted')}>
      <p className="flex items-center gap-2 font-medium">
        {error ? <CircleAlert size={18} className="shrink-0" aria-hidden="true" /> : <LoaderCircle size={18} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
        {error ?? '불러오는 중…'}
      </p>
      {error && onRetry && (
        <button type="button" onClick={onRetry} className="action action-outline">
          다시 조회
        </button>
      )}
    </div>
  );
}

/** 저장·처리 결과 한 줄 */
export function Feedback({ error, message }: { error?: string; message?: string }) {
  if (error)
    return (
      <p role="alert" className="rounded-xl bg-alert-soft px-4 py-3 text-sm text-alert-strong">
        {error}
      </p>
    );
  if (message)
    return (
      <p role="status" className="rounded-xl bg-brand-tint px-4 py-3 text-sm text-brand-deep">
        {message}
      </p>
    );
  return null;
}

export function PageHeader({ title, lead, side }: { title: string; lead?: ReactNode; side?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
      <div className="flex min-w-0 max-w-3xl flex-auto flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="page-title">{title}</h1>
        </div>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {side}
    </header>
  );
}

export const buttonStyles = {
  primary: 'action action-primary',
  secondary: 'action action-secondary',
  outline: 'action action-outline',
  text: 'action action-text',
  danger: 'action action-danger',
};

export const inputStyle = 'h-11 w-full rounded-xl border border-line-2 bg-white px-3 text-sm text-ink disabled:bg-canvas disabled:text-subtle';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('surface', className)}>{children}</div>;
}

/** 검토용 PDF 미리보기. 판독 중에는 준비 상태를 표시한다. */
export function PdfFrame({ url, title, height = 640, emptyMessage = '검토용 PDF가 아직 없습니다.', children }: {
  url: string; title: string; height?: number; emptyMessage?: string; children?: ReactNode;
}) {
  if (!url)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-2 bg-canvas px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-2"><FileText size={20} aria-hidden="true" className="shrink-0" />{emptyMessage}</p>
        {children}
      </div>
    );
  return <iframe title={title} src={url} loading="lazy" className="w-full rounded-xl border border-line bg-white" style={{ height }} />;
}
