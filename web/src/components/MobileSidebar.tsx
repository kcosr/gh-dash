import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayScope, useFocusTrap, useLayer, useOverlayOwner } from '../workbench';
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
export function MobileSidebar({ onClose, focusSearch }: { onClose: () => void; focusSearch: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ui = useUI();
  const layers = useLayer(true, onClose, true, box);
  const owner = useOverlayOwner(box);
  useFocusTrap(box, true, { initialFocus: focusSearch ? undefined : close, owner, layers });
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  return createPortal(
    <OverlayScope layers={layers} owner={owner}>
    <div ref={box} id="mobile-sidebar" className="mobile-sidebar" role="dialog" aria-modal="true"
      aria-labelledby="mobile-sidebar-title" inert={!!ui.prompt || ui.paletteOpen || !!ui.exportTab || ui.addRepo || !!ui.confirm}>
      <div className="mobile-sidebar-head">
        <h2 id="mobile-sidebar-title">Repositories</h2>
        <button ref={close} type="button" className="wb-btn" onClick={onClose} aria-label="Close sidebar"><Icon name="x" />Close</button>
      </div>
      <Sidebar onNavigate={onClose} />
    </div>
    </OverlayScope>,
    document.body,
  );
}
