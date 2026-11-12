import { useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LogOut } from 'lucide-react';
import { api } from '../api/client';
import { Feedback, buttonStyles } from './ui';

export default function LogoutButton({ className, onOpen, returnFocus }: {
  className: string;
  onOpen?: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = useId();
  const description = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { csrf_token: csrf } = await api<{ csrf_token: string }>('/api/auth/session');
      if (!csrf) throw new Error('Missing logout token');
      const response = await fetch('/logout', {
        method: 'POST',
        headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrf },
      });
      if (response.status !== 204) throw new Error('Logout failed');
      window.location.replace('/login?logout#/');
    } catch {
      setError('로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" className={className} aria-haspopup="dialog" onClick={() => {
      setError('');
      dialog.current?.showModal();
      onOpen?.();
    }}>
      <LogOut size={17} aria-hidden="true" />로그아웃
    </button>
    {createPortal(
      <dialog ref={dialog} className="logout-dialog" aria-labelledby={title} aria-describedby={description}
        onCancel={event => {
          event.stopPropagation();
          if (busy) event.preventDefault();
        }}
        onClose={event => {
          event.stopPropagation();
          (returnFocus ?? trigger).current?.focus({ preventScroll: true });
        }}>
        <div className="grid gap-2 px-6 pt-6">
          <h2 id={title} className="text-xl font-extrabold">로그아웃 하시겠습니까?</h2>
          <p id={description} className="text-sm text-muted">현재 브라우저에서 로그아웃합니다.</p>
          <Feedback error={error} />
        </div>
        <footer className="flex flex-wrap justify-end gap-2 p-6">
          <button type="button" className={buttonStyles.outline} disabled={busy} onClick={() => dialog.current?.close()}>취소</button>
          <button type="button" className={buttonStyles.primary} disabled={busy} onClick={logout}>
            {busy ? '로그아웃 중…' : '로그아웃'}
          </button>
        </footer>
      </dialog>,
      document.body,
    )}
  </>;
}
