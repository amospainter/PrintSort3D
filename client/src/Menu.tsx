import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

interface MenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  triggerLabel?: string;
}

// A small generic dropdown used for both the per-card "⋮" quick actions (Library) and
// anywhere else a click-to-open action list is needed. Deliberately not attached to a
// <Link>-aware library — the trigger stops event propagation itself so it works safely
// nested inside a card that's also a react-router Link (see Library.tsx), without pulling
// in a portal/positioning dependency for what's a handful of short menus.
export function Menu({ trigger, children, align = 'end', triggerLabel }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="menu-trigger"
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={(e) => {
          stop(e);
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className={`menu-panel menu-panel--${align}`} onClick={stop}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onSelect,
  children,
  disabled,
}: {
  onSelect: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="menu-item"
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect();
      }}
    >
      {children}
    </button>
  );
}
