/** Date/time formatting helpers. Everything is in the browser's timezone. */

export const DAY = 864e5;
const LOCALE = 'en-US';

export type DateLike = string | number | Date;

export const toDate = (x: DateLike): Date => (x instanceof Date ? x : new Date(x));

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateOnly(s: string | null | undefined): s is string {
  if (!s) return false;
  const m = DATE_ONLY.exec(s);
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

/** 'YYYY-MM-DD' -> local midnight (NOT UTC, which `new Date('2026-09-01')` would give). */
export function parseDateOnly(s: string): Date {
  const m = DATE_ONLY.exec(s);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** Monday-start week. */
export const startOfWeek = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Whole calendar days from a to b (b - a), DST-safe. */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
}

// Reused formatters: Date#toLocaleDateString(locale, options) builds a new Intl.DateTimeFormat on
// every call, which dominated re-rendering long lists (several calls per row).
const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, o);
const F_DATE = dtf({ month: 'short', day: 'numeric' });
const F_DATE_Y = dtf({ month: 'short', day: 'numeric', year: 'numeric' });
const F_TIME = dtf({ hour: 'numeric', minute: '2-digit' });
const F_WEEKDAY = dtf({ weekday: 'long' });
const F_MONTH_YEAR = dtf({ month: 'long', year: 'numeric' });
const F_SHORT_DAY = dtf({ weekday: 'short', month: 'short', day: 'numeric' });
const F_MONTH = dtf({ month: 'short' });

export const fmtDate = (x: DateLike) => F_DATE.format(toDate(x));
export const fmtDateY = (x: DateLike) => F_DATE_Y.format(toDate(x));
export const fmtTime = (x: DateLike) => F_TIME.format(toDate(x));
export const fmtDateTime = (x: DateLike) => `${fmtDateY(x)}, ${fmtTime(x)}`;
export const fmtWeekday = (x: DateLike) => F_WEEKDAY.format(toDate(x));
export const fmtMonthYear = (x: DateLike) => F_MONTH_YEAR.format(toDate(x));
export const fmtShortDay = (x: DateLike) => F_SHORT_DAY.format(toDate(x));
/** "Sep" */
export const fmtMonth = (x: DateLike) => F_MONTH.format(toDate(x));

/** "Sep 3" in the current year, "Sep 3, 2025" otherwise. */
export function fmtDateSmart(x: DateLike, now = new Date()): string {
  const d = toDate(x);
  return d.getFullYear() === now.getFullYear() ? fmtDate(d) : fmtDateY(d);
}

/** "Aug 29 – Sep 27, 2026" (inclusive bounds). */
export function fmtRange(a: Date, b: Date): string {
  if (dayDiff(a, b) === 0) return fmtDateY(a);
  return a.getFullYear() === b.getFullYear() ? `${fmtDate(a)} – ${fmtDateY(b)}` : `${fmtDateY(a)} – ${fmtDateY(b)}`;
}

/** Compact relative time: "5h ago", "3d ago". */
export function rel(x: DateLike, now = Date.now()): string {
  const m = (now - toDate(x).getTime()) / 6e4;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  if (d < 30) return `${Math.round(d / 7)}w ago`;
  if (d < 365) return `${Math.max(1, Math.round(d / 30))}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** Wordier relative time for status text: "12 min ago", "3 h ago", "2 days ago". */
export function relLong(x: DateLike, now = Date.now()): string {
  const m = (now - toDate(x).getTime()) / 6e4;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Relative future time: "in 18 min". */
export function relFuture(x: DateLike, now = Date.now()): string {
  const m = (toDate(x).getTime() - now) / 6e4;
  if (m < 1) return 'any moment';
  if (m < 60) return `in ${Math.round(m)} min`;
  const h = m / 60;
  if (h < 24) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** Duration: "45 min", "26 h", "3.2 days". */
export function dur(ms: number): string {
  const h = ms / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

/** Hours -> [value, unit] for tiles: "29" "h", "3.2" "d", "40" "m". */
export function fmtHours(h: number): [string, string] {
  if (h < 1) return [String(Math.max(1, Math.round(h * 60))), 'm'];
  if (h < 36) return [String(Math.round(h)), 'h'];
  return [(h / 24).toFixed(1), 'd'];
}

/** "Today" / "Yesterday" / "Monday" relative to now. */
export function dayName(d: Date, now = new Date()): string {
  const diff = dayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return fmtWeekday(d);
}

export const nf = new Intl.NumberFormat(LOCALE);
export const fmtNum = (n: number) => nf.format(n);
export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
