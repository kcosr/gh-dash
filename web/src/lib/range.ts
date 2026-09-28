/** Date-range presets -> explicit from/to dates (browser timezone). */
import { addDays, dayDiff, fmtDate, fmtRange, isoDate, parseDateOnly, startOfDay } from './time';

export type RangeId = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'lm' | 'ytd' | 'custom';
export type PresetId = Exclude<RangeId, 'custom'>;

export const RANGE_IDS: RangeId[] = ['today', '7d', '30d', '90d', 'mtd', 'lm', 'ytd', 'custom'];

export const RANGES: { id: PresetId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'mtd', label: 'This month' },
  { id: 'lm', label: 'Last month' },
  { id: 'ytd', label: 'This year' },
];

/** Inclusive [first day, last day] at local midnight. */
export function presetBounds(id: PresetId, now = new Date()): [Date, Date] {
  const t = startOfDay(now);
  switch (id) {
    case 'today': return [t, t];
    case '7d': return [addDays(t, -6), t];
    case '30d': return [addDays(t, -29), t];
    case '90d': return [addDays(t, -89), t];
    case 'mtd': return [new Date(t.getFullYear(), t.getMonth(), 1), t];
    case 'lm': return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
    case 'ytd': return [new Date(t.getFullYear(), 0, 1), t];
  }
}

export function rangeHint(id: PresetId, now = new Date()): string {
  const [a, b] = presetBounds(id, now);
  return dayDiff(a, b) === 0 ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
}

export interface ResolvedRange {
  id: RangeId;
  /** 'YYYY-MM-DD' inclusive bounds, as sent to the API. */
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
  /** Button label: "Last 30 days", or "Sep 1 – Sep 12" for custom. */
  label: string;
  /** Lower-case phrase for sentences: "last 30 days". */
  phrase: string;
  /** "Aug 29 – Sep 27, 2026" */
  text: string;
  days: number;
}

export function resolveRange(range: RangeId, from: string | null, to: string | null, now = new Date()): ResolvedRange {
  let a: Date, b: Date, label: string;
  if (range === 'custom' && from && to) {
    a = parseDateOnly(from);
    b = parseDateOnly(to);
    if (a > b) [a, b] = [b, a];
    label = dayDiff(a, b) === 0 ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
  } else {
    const id = range === 'custom' ? '30d' : range;
    [a, b] = presetBounds(id, now);
    label = RANGES.find((r) => r.id === id)!.label;
  }
  const text = fmtRange(a, b);
  return {
    id: range,
    from: isoDate(a),
    to: isoDate(b),
    fromDate: a,
    toDate: b,
    label,
    phrase: range === 'custom' ? text : label.toLowerCase(),
    text,
    days: dayDiff(a, b) + 1,
  };
}

/** "vs prior 30 days" wording for KPI deltas. */
export function prevLabel(range: RangeId, days: number): string {
  switch (range) {
    case 'today': return 'yesterday';
    case '7d': return 'prior 7 days';
    case '30d': return 'prior 30 days';
    case '90d': return 'prior 90 days';
    case 'lm': return 'the month before';
    default: return days === 1 ? 'the day before' : `prior ${days} days`;
  }
}
