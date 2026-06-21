import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface Props {
  /** Render the menu contents. `close` collapses the menu — call it from action
   *  items (buttons) but NOT from controls the user adjusts in place (a filter
   *  select, a checkbox), which should leave the menu open. */
  children: (close: () => void) => ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
}

// Hamburger (☰) button that toggles a dropdown panel. Closes on a second click,
// on Escape, and on a click anywhere outside — mirrors HelpTip's behaviour.
export function HeaderMenu({ children, label = 'Menu' }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="header-menu" ref={rootRef}>
      <button
        type="button"
        className="header-menu-button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open && <div className="header-menu-panel" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}
