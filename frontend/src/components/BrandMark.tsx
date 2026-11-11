import { useId } from 'react';

export default function BrandMark() {
  const maskId = useId();
  return <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 48 48" width="36" height="36" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
      <mask id={maskId} x="-20%" y="-20%" width="140%" height="140%">
        <rect width="48" height="48" fill="white" />
        <path d="M21.5 32.9L34 19.5" stroke="black" strokeWidth="8.4" strokeLinecap="butt" />
      </mask>
      <path d="M15.6 27L21.5 32.9L34 19.5" stroke="var(--mark-check, #059669)" />
      <path d="M10 39L24 9l14 30" stroke="currentColor" mask={`url(#${maskId})`} />
    </svg>
  </span>;
}
