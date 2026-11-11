import { useEffect, useId, useRef } from 'react';
import { ChevronDown, Grid2X2, LogOut, UserRound } from 'lucide-react';
import { Link } from 'react-router';
import { isDemoBackend } from '../api/backend';

export default function AccountMenu({ login, open, onOpenChange, compact = false }: {
  login: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, onOpenChange]);

  return <div ref={menu} className={compact ? 'account-menu account-menu--drawer' : 'account-menu'}
    onBlur={event => {
      if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
    }}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      trigger.current?.focus();
    }}>
    <button ref={trigger} type="button" className={compact ? 'icon-button' : 'toolbar-account'}
      aria-label="계정 메뉴" aria-controls={id} aria-expanded={open} onClick={() => {
        trigger.current?.focus({ preventScroll: true });
        onOpenChange(!open);
      }}>
      {compact ? <UserRound size={20} aria-hidden="true" /> : <>
        <span className="toolbar-avatar"><UserRound size={17} aria-hidden="true" /></span>
        <span className="truncate">{login}</span>
        <ChevronDown size={14} className="account-menu-chevron" aria-hidden="true" />
      </>}
    </button>
    <div id={id} className="surface account-menu-panel" role="group" aria-label="계정 메뉴" hidden={!open}>
      <p className="account-menu-login" title={login}>{login}</p>
      <Link to="/" className="account-menu-item" onClick={() => onOpenChange(false)}>
        <Grid2X2 size={17} aria-hidden="true" />업무 선택
      </Link>
      {!isDemoBackend && <a href="/logout" className="account-menu-item" onClick={() => onOpenChange(false)}>
        <LogOut size={17} aria-hidden="true" />로그아웃
      </a>}
    </div>
  </div>;
}
