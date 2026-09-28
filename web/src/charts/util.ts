/**
 * Chart helpers: scales, number/date formatting, mark paths, text measurement.
 * Pure functions only (no React), so geometry can be memoized cheaply.
 */

/** Surface gap between touching marks (stacked segments, adjacent bars). */
export const GAP = 2;
/** Data-end rounding for bars/columns. */
export const RADIUS = 4;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Round to 2 decimals for compact SVG path strings. */
export const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface NiceScale {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
  /** Fraction digits needed to print a tick. */
  decimals: number;
}

function decimalsOf(step: number): number {
  for (let d = 0; d < 6; d++) {
    const s = step * 10 ** d;
    if (Math.abs(Math.round(s) - s) < 1e-6) return d;
  }
  return 6;
}
const roundTo = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

function buildScale(lo: number, hi: number, step: number): NiceScale {
  const decimals = decimalsOf(step);
  const n = Math.max(1, Math.round((hi - lo) / step));
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(roundTo(lo + i * step, decimals));
  return { lo: roundTo(lo, decimals), hi: roundTo(lo + n * step, decimals), step, ticks, decimals };
}

/**
 * Clean axis bounds: the smallest 1/2/2.5/5 × 10^k step that covers [min, max]
 * in at most `maxIntervals` intervals. Integer data never gets fractional ticks.
 */
export function niceScale(
  min: number,
  max: number,
  o: { zero?: boolean; integer?: boolean; nonNegative?: boolean; maxIntervals?: number } = {},
): NiceScale {
  const maxI = Math.max(1, o.maxIntervals ?? 5);
  let a = Number.isFinite(min) ? min : 0;
  let b = Number.isFinite(max) ? max : 0;
  if (a > b) [a, b] = [b, a];
  if (o.zero) {
    a = Math.min(0, a);
    b = Math.max(0, b);
  }
  if (b - a === 0) {
    if (o.zero) b = a + (o.integer ? Math.min(4, maxI) : 1);
    else {
      const pad = Math.max(o.integer ? 1 : 0.5, Math.abs(b) * 0.05);
      a -= 2 * pad;
      b += 2 * pad;
    }
  }
  if (o.nonNegative && a < 0) a = 0;
  const span = b - a;
  let p = 10 ** Math.floor(Math.log10(span / maxI));
  const mults = [1, 2, 2.5, 5];
  for (let guard = 0; guard < 40; guard++, p *= 10) {
    for (const m of mults) {
      const s = m * p;
      if (o.integer && (s < 1 - 1e-9 || Math.abs(s - Math.round(s)) > 1e-9)) continue;
      const lo = Math.floor(a / s + 1e-9) * s;
      const hi = Math.ceil(b / s - 1e-9) * s;
      if ((hi - lo) / s <= maxI + 1e-9) return buildScale(lo, hi === lo ? lo + s : hi, s);
    }
  }
  return buildScale(a, b, span);
}

/** Interval budget for a plot of inner height `ih` (about one gridline per 34-40 px). */
export const intervalsFor = (ih: number) => clamp(Math.floor(ih / 36), 2, 6);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const formatters = new Map<number, Intl.NumberFormat>();
/** Thousands-comma'd; integers print as integers, fractions to 1 decimal (0 above 100). */
export function fmtNum(v: number, decimals?: number): string {
  if (!Number.isFinite(v)) return '—';
  const d = decimals ?? (Number.isInteger(v) ? 0 : Math.abs(v) >= 100 ? 0 : 1);
  let f = formatters.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { maximumFractionDigits: d });
    formatters.set(d, f);
  }
  return f.format(v);
}

// ---------------------------------------------------------------------------
// Mark paths
// ---------------------------------------------------------------------------

/** Column: rounded data-end (top), square at the baseline. */
export function colPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h));
  x = r2(x); y = r2(y); w = r2(w); h = r2(h); r = r2(r);
  if (r === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${r2(y + h)}V${r2(y + r)}A${r},${r} 0 0 1 ${r2(x + r)},${y}H${r2(x + w - r)}A${r},${r} 0 0 1 ${r2(x + w)},${r2(y + r)}V${r2(y + h)}Z`;
}

/** Horizontal bar: square at the baseline (left), rounded data-end (right). */
export function hbarPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, h / 2, w));
  x = r2(x); y = r2(y); w = r2(w); h = r2(h); r = r2(r);
  if (r === 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y}H${r2(x + w - r)}A${r},${r} 0 0 1 ${r2(x + w)},${r2(y + r)}V${r2(y + h - r)}A${r},${r} 0 0 1 ${r2(x + w - r)},${r2(y + h)}H${x}Z`;
}

/** Column width for a band: thin marks (<= 24 px), a 2 px gap once bands get tight. */
export function columnWidth(band: number): number {
  if (band >= 6) return Math.min(24, band * 0.62);
  return Math.max(band * 0.5, band - GAP);
}

// ---------------------------------------------------------------------------
// Text measurement (canvas; cached; reset when web fonts finish loading)
// ---------------------------------------------------------------------------

const FONT_STACK = '"Inter Variable", Inter, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
let ctx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

export function textWidth(s: string, size = 11, weight = 400): number {
  const key = `${size}|${weight}|${s}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try {
      ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      ctx = null;
    }
  }
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
    w = ctx.measureText(s).width;
  } else {
    w = s.length * size * 0.56;
  }
  widthCache.set(key, w);
  return w;
}

export function clearTextCache() {
  widthCache.clear();
}

/** Longest prefix + "…" that fits `maxW`; returns the input when it already fits. */
export function truncate(s: string, maxW: number, size = 11, weight = 400): string {
  if (textWidth(s, size, weight) <= maxW) return s;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(chars.slice(0, mid).join('').trimEnd() + '…', size, weight) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : chars.slice(0, lo).join('').trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Dates ('YYYY-MM-DD', calendar dates; no timezone math)
// ---------------------------------------------------------------------------

export const DAY_MS = 864e5;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface DayInfo {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  /** Days since the epoch. */
  num: number;
  /** 0 = Monday … 6 = Sunday */
  wd: number;
}

export function parseDay(iso: string): DayInfo {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const num = Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / DAY_MS);
  const wd = (new Date(num * DAY_MS).getUTCDay() + 6) % 7;
  return { y, m, d, num, wd };
}

/** "Sep 21" */
export function formatShortDate(iso: string): string {
  const p = parseDay(iso);
  if (!Number.isFinite(p.num)) return iso;
  return `${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Sun, Sep 21" (or "Sun, Sep 21, 2025" with `withYear`). */
export function formatLongDate(iso: string, withYear = false): string {
  const p = parseDay(iso);
  if (!Number.isFinite(p.num)) return iso;
  return `${WEEKDAYS[p.wd]}, ${MONTHS[p.m - 1]} ${p.d}${withYear ? `, ${p.y}` : ''}`;
}

// ---------------------------------------------------------------------------
// Axis labels
// ---------------------------------------------------------------------------

export interface AxisLabel {
  i: number;
  x: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  w: number;
  strong?: boolean;
}

const extent = (l: AxisLabel): [number, number] =>
  l.anchor === 'start' ? [l.x, l.x + l.w] : l.anchor === 'end' ? [l.x - l.w, l.x] : [l.x - l.w / 2, l.x + l.w / 2];

const NICE_EVERY = [1, 2, 3, 4, 6, 7, 14, 28, 56, 91, 182, 364];

/**
 * Labels for a band axis (one label slot per column): every k-th column counted back from the most
 * recent one (k snapped to 1/2/3/4/6/7/14/28… so daily axes step by whole weeks), clamped inside
 * [0, width]. `strongIndex` is always labeled and wins collisions.
 */
export function bandLabels(
  texts: string[],
  center: (i: number) => number,
  band: number,
  width: number,
  strongIndex: number | null = null,
  minGap = 12,
  minEvery = 1,
): AxisLabel[] {
  const n = texts.length;
  if (!n) return [];
  const widths = texts.map((t) => textWidth(t, 11));
  const maxW = Math.max(...widths);
  const need = Math.max(minEvery, Math.ceil((maxW + minGap) / Math.max(band, 0.01)), 1);
  const every = NICE_EVERY.find((e) => e >= need) ?? need;
  const make = (i: number, strong = false): AxisLabel => {
    const w = widths[i];
    return { i, x: clamp(center(i), w / 2 + 1, width - w / 2 - 1), text: texts[i], anchor: 'middle', w, strong };
  };
  // Walk back from the most recent column; edge clamping can pull a label into its neighbor,
  // so keep a label only if it clears the one after it.
  const kept: AxisLabel[] = [];
  for (let i = n - 1; i >= 0; i -= every) {
    const l = make(i);
    const next = kept[kept.length - 1];
    if (!next || extent(l)[1] + 8 <= extent(next)[0]) kept.push(l);
  }
  let out = kept.reverse();
  if (strongIndex != null && strongIndex >= 0 && strongIndex < n) {
    const s = make(strongIndex, true);
    const [a, b] = extent(s);
    out = out.filter((l) => {
      if (l.i === strongIndex) return false;
      const [c, d] = extent(l);
      return d + 8 <= a || c - 8 >= b;
    });
    out.push(s);
  }
  return out;
}

/** Drop middle labels that collide with a neighbor (first and last are kept). */
export function dropCollisions(labels: AxisLabel[], gap = 10): AxisLabel[] {
  if (labels.length <= 1) return labels;
  const out: AxisLabel[] = [labels[0]];
  const last = labels[labels.length - 1];
  for (let k = 1; k < labels.length - 1; k++) {
    const l = labels[k];
    const prev = out[out.length - 1];
    if (extent(l)[0] >= extent(prev)[1] + gap && extent(l)[1] + gap <= extent(last)[0]) out.push(l);
  }
  const prev = out[out.length - 1];
  if (extent(last)[0] >= extent(prev)[1] + gap) out.push(last);
  else if (out.length > 1) out[out.length - 1] = last;
  else return [last]; // first and last collide: keep the most recent
  return out;
}
