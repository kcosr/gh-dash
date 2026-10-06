import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { fitPaneWidths, usePaneResize } from '../workbench';
import type { PaneResizeSpec } from '../workbench';
import {
  DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  getDrawerWidth, getSidebarWidth, setDrawerWidth, setSidebarWidth,
} from '../lib/storage';

/** Within the app's desktop layout, the main list keeps at least this much of the window. */
const MAIN_MIN = 360;

const SIDEBAR: PaneResizeSpec = {
  label: 'Sidebar width', controls: 'repository-sidebar', className: 'sidebar-resize', cssVar: '--wb-side-w',
  min: SIDEBAR_MIN, max: SIDEBAR_MAX, grow: 1,
};
const DRAWER: PaneResizeSpec = {
  label: 'Details panel width', controls: 'pr-drawer', className: 'drawer-resize', cssVar: '--wb-drawer-w',
  min: DRAWER_MIN, max: DRAWER_MAX, grow: -1,
};

/** Product bounds and responsive composition; the shared kit owns width fitting and input handling. */
export function fitPanes(o: { room: number; sidePref: number; drawerPref: number; sideShown: boolean; drawerOpen: boolean }) {
  return fitPaneWidths({
    room: o.room,
    sidebar: { min: SIDEBAR_MIN, max: SIDEBAR_MAX, preferred: o.sidePref, shown: o.sideShown },
    drawer: { min: DRAWER_MIN, max: DRAWER_MAX, preferred: o.drawerPref, shown: o.drawerOpen },
  });
}

/** The drawer's width before it has been resized: the stylesheet's, which is narrower on small windows. */
function stylesheetDrawerWidth() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wb-drawer-w'));
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
    style: { '--wb-side-w': `${fit.side}px`, '--wb-drawer-w': `${fit.drawer}px` } as CSSProperties,
    sidebar: side,
    drawer,
  };
}
