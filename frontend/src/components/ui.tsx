import type { ReactNode } from 'react';
import type { CheckState, DocCode, DocState, MailState, Verdict } from '../api/review';

export function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

const verdictStyle: Record<Verdict, string> = {
  성공: 'bg-brand-tint text-brand-strong',
  담당자확인: 'bg-caution-tint text-caution',
  재제출요청: 'bg-alert-tint text-alert-strong',
};

export function VerdictBadge({ verdict, size = 'sm' }: { verdict: Verdict; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full font-bold whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
        verdictStyle[verdict],
      )}
    >
      {verdict}
    </span>
  );
}

const mailText: Record<MailState, { label: string; style: string }> = {
  sent: { label: '발송됨', style: 'bg-brand-tint text-brand-strong' },
  waiting: { label: '담당자 확인 대기', style: 'bg-caution-tint text-caution' },
  none: { label: '보낼 안내 없음', style: 'bg-canvas text-muted' },
};

export function MailBadge({ state }: { state: MailState }) {
  const m = mailText[state];
  return <span className={cx('inline-flex rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap', m.style)}>{m.label}</span>;
}

export function DocChips({ docs }: { docs: Record<DocCode, DocState> }) {
  return (
    <ul className="flex gap-1.5" aria-label="접수 서류">
      {(Object.keys(docs) as DocCode[]).map((code) => {
        const state = docs[code];
        if (state === 'missing')
          return (
            <li key={code} className="rounded-lg border border-dashed border-alert-strong px-[7px] py-[3px] font-mono text-xs text-alert-strong">
              {code} 없음
            </li>
          );
        if (state === 'duplicate')
          return (
            <li key={code} className="rounded-lg bg-alert-tint px-2 py-1 font-mono text-xs text-alert-strong">
              {code} ×2
            </li>
          );
        return (
          <li key={code} className="rounded-lg bg-canvas px-2 py-1 font-mono text-xs text-ink">
            {code}
          </li>
        );
      })}
    </ul>
  );
}

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
  if (state === 'check')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 text-caution" aria-label="확인 필요" role="img">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 16.5v.5" />
      </svg>
    );
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 text-subtle" aria-label="확인 불가" role="img">
      <path d="M6 12h12" />
    </svg>
  );
}

export function Notice({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div role={error ? 'alert' : 'status'} className={cx('rounded-2xl px-5 py-4 text-sm', error ? 'bg-alert-soft text-alert-strong' : 'bg-canvas text-muted')}>
      {error ?? '불러오는 중…'}
      {error && onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 font-bold underline underline-offset-2">
          다시 조회
        </button>
      )}
    </div>
  );
}

/** mock 계층에서 오는 화면임을 표시한다. */
export function DemoBadge() {
  return (
    <span className="inline-flex rounded-full border border-line-2 px-2.5 py-1 text-xs text-muted" title="판정·발송 API 연결 전까지 set01–set10 정답 데이터를 보여 줍니다.">
      예시 데이터
    </span>
  );
}

export function PageHeader({ title, lead, side, demo }: { title: string; lead?: ReactNode; side?: ReactNode; demo?: boolean }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div className="flex max-w-3xl flex-[1_1_520px] flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[32px] font-extrabold tracking-[-0.03em] sm:text-4xl">{title}</h1>
          {demo && <DemoBadge />}
        </div>
        {lead && <p className="text-[17px] leading-relaxed text-ink-2">{lead}</p>}
      </div>
      {side}
    </div>
  );
}

export const buttonStyles = {
  primary:
    'inline-flex min-h-12 items-center justify-center rounded-full bg-brand-strong px-6 text-[15px] font-bold text-white hover:bg-brand-deep disabled:opacity-50',
  secondary:
    'inline-flex min-h-11 items-center justify-center rounded-full border border-line-2 bg-white px-[18px] text-sm font-medium text-ink hover:border-muted disabled:opacity-50',
  outline:
    'inline-flex min-h-11 items-center justify-center rounded-full border border-ink bg-white px-[18px] text-sm font-bold text-ink hover:bg-canvas',
  text: 'inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-strong hover:text-brand-deep',
};

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-[22px] border border-line bg-white', className)}>{children}</div>;
}
