/** Browser-local preferences and "last visit". */

const THEME_KEY = 'gh-dash:theme';
const VISIT_KEY = 'gh-dash:lastVisit';
const SIDEBAR_KEY = 'gh-dash:sidebarWidth';
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 268;

export type Theme = 'light' | 'dark';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function getSidebarWidth(): number {
  const value = Number(read(SIDEBAR_KEY));
  return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? Math.round(value) : SIDEBAR_DEFAULT;
}

export function setSidebarWidth(value: number) {
  write(SIDEBAR_KEY, String(value));
}

export function getTheme(): Theme {
  const t = read(THEME_KEY) ?? document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  write(THEME_KEY, t);
}

/**
 * Previous app load. Captured once at module load (before we overwrite it with
 * "now"), so it's stable for the whole session and survives StrictMode double renders.
 */
export const LAST_VISIT: Date | null = (() => {
  const prev = read(VISIT_KEY);
  write(VISIT_KEY, new Date().toISOString());
  const d = prev ? new Date(prev) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
})();

export function isNewSinceLastVisit(at: string | Date): boolean {
  if (!LAST_VISIT) return false;
  const t = at instanceof Date ? at : new Date(at);
  return t > LAST_VISIT;
}
