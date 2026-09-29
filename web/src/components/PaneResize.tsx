import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react';
import {
  DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  getDrawerWidth, getSidebarWidth, setDrawerWidth, setSidebarWidth,
} from '../lib/storage';

/** Within the app's desktop layout, the main list keeps at least this much of the window. */
const MAIN_MIN = 360;

interface PaneSpec {
  label: string;
  /** Id of the pane the separator controls. */
  controls: string;
  className: string;
  /** Custom property on the shell holding the pane's width. */
  cssVar: '--side-w' | '--drawer-w';
  min: number;
  /** Largest width that can be saved; the shown width is further limited by the window and the other pane. */
  max: number;
  /** Pointer movement that widens the pane: 1 to the right (a pane on the left edge), -1 to the left. */
  grow: 1 | -1;
}

const SIDEBAR: PaneSpec = {
  label: 'Sidebar width', controls: 'repository-sidebar', className: 'sidebar-resize', cssVar: '--side-w',
  min: SIDEBAR_MIN, max: SIDEBAR_MAX, grow: 1,
};
const DRAWER: PaneSpec = {
  label: 'Details panel width', controls: 'pr-drawer', className: 'drawer-resize', cssVar: '--drawer-w',
  min: DRAWER_MIN, max: DRAWER_MAX, grow: -1,
};

interface PaneState {
  /** Whether the separator is in use (a disabled pane drops any drag in progress). */
  enabled: boolean;
  /** The saved width. The shown width can be smaller while a small window or the other pane limits it. */
  preferred: number;
  /** The width shown now. */
  width: number;
  /** The widest the pane can be right now. */
  limit: number;
  /** Remember a (clamped) width. */
  save: (value: number) => void;
  reset: () => void;
}

/**
 * Pointer and keyboard resizing for one pane: capture-based drag (Escape cancels), arrow keys
 * (Shift for larger steps), Home/End, and double-click to reset. The width lives in a custom
 * property on the shell that is updated directly while dragging, so the shell doesn't re-render
 * for every pointer move.
 */
function usePaneResize(spec: PaneSpec, frame: RefObject<HTMLDivElement | null>, { enabled, preferred, width, limit, save, reset }: PaneState) {
  const handle = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number; current: number } | null>(null);
  const clamp = (value: number) => Math.round(Math.max(spec.min, Math.min(limit, value)));
  const more = spec.grow === 1 ? 'ArrowRight' : 'ArrowLeft';
  const less = spec.grow === 1 ? 'ArrowLeft' : 'ArrowRight';

  const display = (value: number) => {
    frame.current?.style.setProperty(spec.cssVar, `${value}px`);
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
  // The separator can be replaced or removed mid-drag (the details panel remounts for each pull
  // request, and its separator with it); the removed element never gets pointerup or lostpointercapture.
  const cancelLatest = useRef(cancel);
  useLayoutEffect(() => { cancelLatest.current = cancel; });
  const attach = useCallback((el: HTMLDivElement | null) => {
    handle.current = el;
    if (!el) cancelLatest.current();
  }, []);

  const commit = (value: number) => save(Math.round(Math.max(spec.min, Math.min(spec.max, value))));
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
    d.current = clamp(d.width + spec.grow * (e.clientX - d.x));
    // Update geometry and its accessible value without re-rendering the shell per pointer move.
    display(d.current);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.current !== d.width) commit(d.current);
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
    if ((e.key === more || e.key === 'End') && preferred >= limit) { e.preventDefault(); return; }
    const step = e.shiftKey ? 40 : 10;
    const next = e.key === less ? width - step : e.key === more ? width + step
      : e.key === 'Home' ? spec.min : e.key === 'End' ? limit : null;
    if (next === null) return;
    e.preventDefault();
    // Like a pointer drag, stop at what the window and the other pane leave.
    commit(clamp(next));
  };

  return {
    dragging,
    separator: <div ref={attach} className={spec.className} role="separator" tabIndex={0}
      aria-label={spec.label} aria-orientation="vertical" aria-controls={spec.controls}
      aria-valuemin={spec.min} aria-valuemax={limit} aria-valuenow={width} aria-valuetext={`${width} pixels`}
      title="Drag to resize; arrow keys adjust width; double-click to reset"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={onKeyDown}
      onDoubleClick={reset} />,
  };
}

interface Fit { side: number; sideMax: number; drawer: number; drawerMax: number }

/**
 * Share a window's width between the sidebar, the details drawer and the main list, which keeps
 * at least MAIN_MIN. `room` is the window width minus that; the preferences are the saved widths.
 *
 * When both panes don't fit, the sidebar gives way first, down to its minimum, then the drawer.
 * That keeps the drawer the same as before it could be resized, and never lets a width depend on
 * how the layout got there. Each pane's `max` is what it may grow to now, given the other's width.
 */
export function fitPanes(o: { room: number; sidePref: number; drawerPref: number; sideShown: boolean; drawerOpen: boolean }): Fit {
  const drawer = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, o.drawerPref, o.room - (o.sideShown ? SIDEBAR_MIN : 0)));
  const sideMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, o.room - (o.drawerOpen ? drawer : 0)));
  const side = Math.min(o.sidePref, sideMax);
  const drawerMax = Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, o.room - (o.sideShown ? side : 0)));
  return { side, sideMax, drawer, drawerMax };
}

/** The drawer's width before it has been resized: the stylesheet's, which is narrower on small windows. */
function stylesheetDrawerWidth() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--drawer-w'));
  return Number.isFinite(value) ? value : DRAWER_DEFAULT;
}

/**
 * Resizable sidebar and details drawer. Attach `frame` and `style` to the shell (the grid that
 * holds them), and render each pane's `separator` inside or next to the pane.
 *
 * @param sideShown the sidebar is in the desktop layout
 * @param drawerOpen a pull request's details are open (in the compact layout they cover the list instead)
 * @param drawerResizable the drawer is a visible column, so its separator can be used
 */
export function usePanes(sideShown: boolean, drawerOpen: boolean, drawerResizable: boolean) {
  const frame = useRef<HTMLDivElement>(null);
  const [sidePref, setSidePref] = useState(getSidebarWidth);
  // null until resized: the responsive stylesheet default applies.
  const [drawerPref, setDrawerPref] = useState(getDrawerWidth);
  const [room, setRoom] = useState(() => window.innerWidth - MAIN_MIN);
  const [natural, setNatural] = useState(stylesheetDrawerWidth);

  useLayoutEffect(() => {
    const update = () => {
      const el = frame.current;
      if (el) setRoom(el.clientWidth - MAIN_MIN);
      setNatural(stylesheetDrawerWidth());
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const fit = fitPanes({ room, sidePref, drawerPref: drawerPref ?? natural, sideShown, drawerOpen });
  const saveSide = (value: number) => { setSidePref(value); setSidebarWidth(value); };
  const saveDrawer = (value: number | null) => { setDrawerPref(value); setDrawerWidth(value); };
  const side = usePaneResize(SIDEBAR, frame, {
    enabled: sideShown, preferred: sidePref, width: fit.side, limit: fit.sideMax,
    save: saveSide, reset: () => saveSide(SIDEBAR_DEFAULT),
  });
  const drawer = usePaneResize(DRAWER, frame, {
    enabled: drawerResizable, preferred: drawerPref ?? natural, width: fit.drawer, limit: fit.drawerMax,
    save: saveDrawer, reset: () => saveDrawer(null),
  });

  return {
    frame,
    style: { '--side-w': `${fit.side}px`, '--drawer-w': `${fit.drawer}px` } as CSSProperties,
    sidebar: side,
    drawer,
  };
}
