import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import type { AwardEvent } from '../api/intake';

export default function WorkspacePicker({ workspaces, current, error, onSelect }: {
  workspaces?: AwardEvent[];
  current?: AwardEvent | null;
  error?: string | null;
  onSelect: (id: string) => void;
}) {
  const listId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const options = list.current;
    (options?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? options?.querySelector('button'))?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const arrows = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (!workspaces?.length || (!arrows && !(open && ['Home', 'End'].includes(event.key)))) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const options = Array.from(list.current?.querySelectorAll('button') ?? []);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') options[0]?.focus();
    else if (event.key === 'End') options.at(-1)?.focus();
    else if (event.key === 'ArrowDown') options[Math.min(index + 1, options.length - 1)]?.focus();
    else options[Math.max(index - 1, 0)]?.focus();
  }

  return <div className="event-picker" ref={picker} onKeyDown={onKeyDown} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="event-picker-trigger" disabled={!workspaces?.length}
      aria-label="워크스페이스 선택" aria-describedby={listId + '-current'} aria-expanded={open} aria-controls={listId} title={error ?? current?.name}
      onClick={() => setOpen(value => !value)}>
      <CalendarDays size={17} aria-hidden="true" />
      <span id={listId + '-current'} className="truncate">{current?.name ?? '워크스페이스 없음'}</span>
      <ChevronDown size={15} className="event-picker-chevron" aria-hidden="true" />
    </button>
    <ul id={listId} ref={list} className="event-picker-list" aria-label="전환할 워크스페이스" hidden={!open}>
      {open && workspaces?.map(item => <li key={item.id}>
        <button type="button" className="event-picker-option" aria-current={item.id === current?.id ? 'true' : undefined}
          onClick={() => {
            close();
            if (item.id !== current?.id) onSelect(item.id);
          }}>
          <span>{item.name}</span>
          {item.id === current?.id && <Check size={15} aria-hidden="true" />}
        </button>
      </li>)}
    </ul>
  </div>;
}
