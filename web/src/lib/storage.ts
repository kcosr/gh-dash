/** Browser-local preferences and "last visit". */

const THEME_KEY = 'gh-dash:theme';
const VISIT_KEY = 'gh-dash:lastVisit';
const SIDEBAR_KEY = 'gh-dash:sidebarWidth';
const SIDEBAR_HIDDEN_KEY = 'gh-dash:sidebarHidden';
const DIFF_KEY = 'gh-dash:diffView';
const ADD_SOURCE_KEY = 'gh-dash:addSource';
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

/** Desktop only: narrow screens always start with the sidebar closed. */
export function getSidebarHidden(): boolean {
  return read(SIDEBAR_HIDDEN_KEY) === '1';
}

export function setSidebarHidden(hidden: boolean) {
  write(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
}

export function getTheme(): Theme {
  const t = read(THEME_KEY) ?? document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  write(THEME_KEY, t);
}

/** The source (host) the Add dialog last added to or was set to, offered again where no context decides (All). */
export function getAddSource(): string | null {
  return read(ADD_SOURCE_KEY) || null;
}

export function setAddSource(host: string) {
  write(ADD_SOURCE_KEY, host);
}

/** Diff viewer preferences (desktop; the compact layout is always unified with the file list hidden). */
export interface DiffPrefs {
  split: boolean;
  wrap: boolean;
  /** File list column shown. */
  files: boolean;
}
const DIFF_DEFAULTS: DiffPrefs = { split: false, wrap: false, files: true };

export function getDiffPrefs(): DiffPrefs {
  try {
    const v = JSON.parse(read(DIFF_KEY) ?? '{}') as Partial<Record<keyof DiffPrefs, unknown>>;
    const pick = (k: keyof DiffPrefs) => { const x = v[k]; return typeof x === 'boolean' ? x : DIFF_DEFAULTS[k]; };
    return { split: pick('split'), wrap: pick('wrap'), files: pick('files') };
  } catch {
    return DIFF_DEFAULTS;
  }
}

export function setDiffPrefs(p: DiffPrefs) {
  write(DIFF_KEY, JSON.stringify(p));
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
