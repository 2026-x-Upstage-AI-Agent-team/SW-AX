import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { cx } from './ui';

export function ProgressTrack({ label }: { label: string }) {
  return <div role="progressbar" aria-label={label} className="h-1 overflow-hidden rounded-full bg-brand-tint">
    <div className="workflow-progress-segment h-full" />
  </div>;
}

export default function WorkflowProgress({ title, description, tone, action }: {
  title: string;
  description: string;
  tone: 'working' | 'complete' | 'attention';
  action?: ReactNode;
}) {
  const Icon = tone === 'working' ? LoaderCircle : tone === 'complete' ? CircleCheck : CircleAlert;
  return <section className="surface grid gap-3 p-[clamp(16px,2.5vw,22px)]">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="status" className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl', tone === 'attention' ? 'bg-caution-tint text-caution' : 'bg-brand-tint text-brand-strong')}>
          <Icon size={21} className={tone === 'working' ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-ink">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        </div>
      </div>
      {action}
    </div>
    {tone === 'working' && <ProgressTrack label={title} />}
  </section>;
}
