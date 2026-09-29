import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../lib/layers';

/**
 * A button with a `.pop.menu` portaled to the end of <body>, right-aligned under it. Focus moves into the menu on open
 * (to the checked item, else the first) and back to the button on close, so keyboard users can reach the items:
 * arrow keys, Home and End move between them; Escape, Tab and a click outside close it.
 */
export function MenuButton({ className, label, title, button, menuLabel, menuClass, width = 220, align = 'end', children }: {
  className: string;
  /** The button's accessible name. */
  label: string;
  title?: string;
  button: ReactNode;
  menuLabel: string;
  menuClass?: string;
  /** The menu's width, for aligning its right edge with the button's. */
  width?: number;
  /** Which of the button's edges the menu lines up with: its right (default) or its left. */
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); btn.current?.focus({ preventScroll: true }); };
  useLayer(open, close);
  useEffect(() => {
    if (open) (menu.current?.querySelector<HTMLElement>('.opt[aria-checked="true"]') ?? menu.current?.querySelector<HTMLElement>('.opt'))?.focus();
  }, [open]);
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Continue normal tab order from the trigger when leaving the portaled menu.
    if (e.key === 'Tab') { close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('.opt') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const r = btn.current?.getBoundingClientRect();
  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && r && createPortal(
        <>
          <div className="pop-scrim" onClick={close} />
          <div ref={menu} className={`pop menu${menuClass ? ` ${menuClass}` : ''}`} role="menu" aria-label={menuLabel}
            style={{ top: r.bottom + 4, left: align === 'end' ? Math.max(8, r.right - width) : Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), minWidth: width }}
            onKeyDown={onMenuKey}>
            {children(close)}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
