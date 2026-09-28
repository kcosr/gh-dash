/** Remembers the window's size and position in userData/window-state.json. */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Absent: let the OS place (center) the window. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW: WindowState = { width: 1440, height: 900, maximized: false };
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;
/** How much of the title bar must be on a screen for a saved position to be reused. */
const VISIBLE = 64;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A saved state, fitted to the current displays: the size is clamped to the largest work area, and the position is
 * dropped when the window's top edge would no longer be on any display (monitor unplugged, resolution changed).
 */
export function fitWindowState(saved: unknown, workAreas: Rect[]): WindowState {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const maxW = Math.max(MIN_WIDTH, ...workAreas.map((a) => a.width));
  const maxH = Math.max(MIN_HEIGHT, ...workAreas.map((a) => a.height));
  const width = Math.round(Math.min(Math.max(num(s.width) ? s.width : DEFAULT_WINDOW.width, MIN_WIDTH), maxW));
  const height = Math.round(Math.min(Math.max(num(s.height) ? s.height : DEFAULT_WINDOW.height, MIN_HEIGHT), maxH));
  const state: WindowState = { width, height, maximized: s.maximized === true };
  if (num(s.x) && num(s.y)) {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const titleBarVisible = workAreas.some(
      (a) => y >= a.y && y + 24 <= a.y + a.height && Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= VISIBLE,
    );
    if (titleBarVisible) Object.assign(state, { x, y });
  }
  return state;
}

export function loadWindowState(path: string, workAreas: Rect[]): WindowState {
  let saved: unknown = null;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* first launch or unreadable: defaults */
  }
  return fitWindowState(saved, workAreas);
}

export function saveWindowState(path: string, state: WindowState): void {
  try {
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch {
    /* not worth failing a quit over */
  }
}
