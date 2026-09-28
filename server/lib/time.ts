import type { Bucket } from '../../shared/api';

export const DAY_MS = 86_400_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/**
 * The canonical spelling of an IANA zone ("america/new_york" → "America/New_York"), or null if invalid.
 * Callers use it before anything is cached per zone, so case variants can't grow the caches without bound.
 */
export function canonicalTz(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTz(tz: string): boolean {
  return canonicalTz(tz) !== null;
}

function localParts(tz: string, ms: number) {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(tz).formatToParts(ms)) {
    if (p.type in out) out[p.type as keyof typeof out] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at instant `ms` (local = utc + offset). */
export function tzOffsetMs(tz: string, ms: number): number {
  const p = localParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Civil day number (days since 1970-01-01) of instant `ms` in `tz`. */
export function localDayNum(tz: string, ms: number): number {
  const p = localParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
}

const HOUR_MS = 3_600_000;

/**
 * UTC instant of the local wall-clock time `wallMs` (a UTC-based ms value holding local fields) in `tz`.
 * An ambiguous time (DST end) resolves to its first occurrence; a time in a DST gap moves forward by the
 * gap (so a day whose midnight is skipped starts at the transition).
 */
export function zonedWallToUtc(tz: string, wallMs: number): number {
  // The instant lies within wall-14h..wall+12h; every offset in effect around it is a candidate.
  const early = tzOffsetMs(tz, wallMs - 14 * HOUR_MS);
  const late = tzOffsetMs(tz, wallMs + 14 * HOUR_MS);
  const candidates = early === late ? [wallMs - early] : [wallMs - early, wallMs - late].sort((a, b) => a - b);
  for (const c of candidates) if (c + tzOffsetMs(tz, c) === Math.floor(wallMs / 1000) * 1000) return c;
  return candidates[candidates.length - 1]!;
}

/** UTC instant of local midnight starting civil day `dayNum` in `tz`. */
export function zonedMidnight(tz: string, dayNum: number): number {
  return zonedWallToUtc(tz, dayNum * DAY_MS);
}

export function dayNumToYmd(dayNum: number): string {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

export function ymdToDayNum(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** 0 = Monday … 6 = Sunday */
export function weekdayMon0(dayNum: number): number {
  return (new Date(dayNum * DAY_MS).getUTCDay() + 6) % 7;
}

function bucketStartDayNum(dayNum: number, bucket: Bucket): number {
  if (bucket === 'day') return dayNum;
  if (bucket === 'week') return dayNum - weekdayMon0(dayNum);
  const d = new Date(dayNum * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS;
}

function nextBucketDayNum(startDayNum: number, bucket: Bucket): number {
  if (bucket === 'day') return startDayNum + 1;
  if (bucket === 'week') return startDayNum + 7;
  const d = new Date(startDayNum * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY_MS;
}

export interface Buckets {
  /** Bucket start as 'YYYY-MM-DD' (local civil date). */
  keys: string[];
  /** Bucket start instants (UTC ms), ascending. */
  starts: number[];
  /** Exclusive end instant of the last bucket. */
  end: number;
}

/** Buckets covering [fromMs, toMs) in `tz`; the first bucket starts at or before fromMs. */
export function makeBuckets(tz: string, fromMs: number, toMs: number, bucket: Bucket): Buckets {
  const keys: string[] = [];
  const starts: number[] = [];
  let day = bucketStartDayNum(localDayNum(tz, fromMs), bucket);
  let start = zonedMidnight(tz, day);
  do {
    keys.push(dayNumToYmd(day));
    starts.push(start);
    day = nextBucketDayNum(day, bucket);
    start = zonedMidnight(tz, day);
  } while (start < toMs);
  return { keys, starts, end: start };
}

/** Index of the bucket containing `ms`, or -1 when outside all buckets. */
export function bucketIndex(b: Buckets, ms: number): number {
  if (ms < b.starts[0]! || ms >= b.end) return -1;
  let lo = 0;
  let hi = b.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (b.starts[mid]! <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** ISO-8601 UTC with second precision, the format GitHub uses (e.g. 2026-09-27T18:34:44Z). */
export function isoSec(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A stretch of time from `start` (UTC ms, inclusive) to the next segment's start with a constant UTC offset. */
export interface OffsetSegment {
  start: number;
  offsetMs: number;
}

/**
 * The UTC offsets of `tz` over [fromMs, toMs) with the exact (second-precision) instants where they change.
 * Probes once per day, so two transitions less than a day apart would be missed (no real zone does that).
 */
export function offsetSegments(tz: string, fromMs: number, toMs: number): OffsetSegment[] {
  const from = Math.floor(fromMs / 1000) * 1000;
  const last = Math.max(from, Math.floor((toMs - 1) / 1000) * 1000);
  const segments: OffsetSegment[] = [{ start: from, offsetMs: tzOffsetMs(tz, from) }];
  let prev = from;
  while (prev < last) {
    const probe = Math.min(prev + DAY_MS, last);
    const current = segments[segments.length - 1]!.offsetMs;
    const offset = tzOffsetMs(tz, probe);
    if (offset !== current) {
      // Binary search the first second in (prev, probe] that has the new offset.
      let lo = prev;
      let hi = probe;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (tzOffsetMs(tz, mid) === current) lo = mid;
        else hi = mid;
      }
      segments.push({ start: hi, offsetMs: tzOffsetMs(tz, hi) });
    }
    prev = probe;
  }
  return segments;
}

/**
 * SQL expression for the local calendar date ('YYYY-MM-DD') of an ISO-8601 UTC column ('2026-09-27T18:34:44Z'),
 * exact for values inside the range `segments` were computed for (see offsetSegments), including across DST changes.
 */
export function localDateSql(col: string, segments: OffsetSegment[]): { sql: string; params: string[] } {
  const modifier = (s: OffsetSegment) => `${s.offsetMs >= 0 ? '+' : ''}${s.offsetMs / 1000} seconds`;
  if (segments.length === 1) return { sql: `date(${col}, ?)`, params: [modifier(segments[0]!)] };
  const params: string[] = [];
  const whens = segments.slice(1).map((s, i) => {
    params.push(isoSec(s.start), modifier(segments[i]!));
    return `WHEN ${col} < ? THEN ?`;
  });
  params.push(modifier(segments[segments.length - 1]!));
  return { sql: `date(${col}, CASE ${whens.join(' ')} ELSE ? END)`, params };
}
