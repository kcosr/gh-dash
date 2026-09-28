import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { getSidebarWidth, setSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from '../lib/storage';

/** Keep the preferred width when a smaller window or open drawer temporarily limits it. */
export function useSidebarResize(enabled: boolean, hasDrawer: boolean) {
  const frame = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(getSidebarWidth);
  const [max, setMax] = useState(SIDEBAR_MAX);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number; current: number } | null>(null);
  const width = Math.min(preferred, max);
  const clamp = (value: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(max, value)));

  useLayoutEffect(() => {
    const update = () => {
      const el = frame.current;
      if (!el) return;
      const drawer = hasDrawer ? parseFloat(getComputedStyle(el).getPropertyValue('--drawer-w')) : 0;
      // Leave at least 360px for the main view, within the app's desktop layout.
      setMax(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, el.clientWidth - drawer - 360)));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [hasDrawer]);

  const display = (value: number) => {
    frame.current?.style.setProperty('--side-w', `${value}px`);
    handle.current?.setAttribute('aria-valuenow', String(value));
    handle.current?.setAttribute('aria-valuetext', `${value} pixels`);
  };
  const cancel = () => {
    if (!drag.current) return;
    display(width);
    drag.current = null;
    setDragging(false);
  };
  useEffect(() => { if (!enabled) cancel(); }, [enabled]);

  const save = (value: number) => {
    const next = Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, value)));
    setPreferred(next);
    setSidebarWidth(next);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, width, current: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.current = clamp(d.width + e.clientX - d.x);
    // Update geometry and its accessible value without re-rendering the shell per pointer move.
    display(d.current);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.current !== d.width) save(d.current);
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && drag.current) {
      e.preventDefault();
      e.stopPropagation();
      const id = drag.current.id;
      cancel();
      e.currentTarget.releasePointerCapture(id);
      return;
    }
    if (drag.current) return;
    if ((e.key === 'ArrowRight' || e.key === 'End') && preferred >= max) { e.preventDefault(); return; }
    const step = e.shiftKey ? 40 : 10;
    const next = e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step
      : e.key === 'Home' ? SIDEBAR_MIN : e.key === 'End' ? max : null;
    if (next === null) return;
    e.preventDefault();
    save(next);
  };

  return {
    frame,
    dragging,
    style: { '--side-w': `${width}px` } as CSSProperties,
    separator: <div ref={handle} className="sidebar-resize" role="separator" tabIndex={0}
      aria-label="Sidebar width" aria-orientation="vertical" aria-controls="repository-sidebar"
      aria-valuemin={SIDEBAR_MIN} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
      title="Drag to resize; arrow keys adjust width; double-click to reset"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={onKeyDown}
      onDoubleClick={() => save(SIDEBAR_DEFAULT)} />,
  };
}
