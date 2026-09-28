import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayer } from '../lib/layers';
import { Icon } from './Icon';
import { Sidebar } from './Sidebar';
import { useUI } from './ui';

export function useCompactSidebar() {
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}

/** Full-screen repository controls, with nested prompts still above this layer. */
export function MobileSidebar({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const ui = useUI();
  useLayer(true, onClose);
  useEffect(() => {
    close.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected && opener.offsetParent !== null) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  return createPortal(
    <div ref={box} id="mobile-sidebar" className="mobile-sidebar" role="dialog" aria-modal="true"
      aria-labelledby="mobile-sidebar-title" inert={!!ui.prompt || ui.paletteOpen || !!ui.exportTab}
      onKeyDown={(e) => {
        // Scope the trap to this panel; portaled prompts have their own focus handling.
        if (e.key !== 'Tab') return;
        const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]') ?? [])]
          .filter((el) => el.offsetParent !== null);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }}>
      <div className="mobile-sidebar-head">
        <h2 id="mobile-sidebar-title">Repositories</h2>
        <button ref={close} type="button" className="btn" onClick={onClose} aria-label="Close sidebar"><Icon name="x" />Close</button>
      </div>
      <Sidebar onNavigate={onClose} />
    </div>,
    document.body,
  );
}
