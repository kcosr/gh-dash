import { z } from 'zod';
import { EVENT_TYPES, type EventType } from '../../shared/api';
import type { Scope } from '../db/filters';
import type { CursorKey } from '../db/lists';
import { canonicalTz, DAY_MS, localDayNum, ymdToDayNum, zonedMidnight, zonedWallToUtc } from '../lib/time';
import { HttpError } from './http';

export const scopeSchema = z.object({
  repos: z.string().optional(),
  visibility: z.enum(['all', 'public', 'private']).optional(),
  who: z.enum(['me', 'others', 'everyone']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  tz: z.string().optional(),
  q: z.string().optional(),
});

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
  format: z.enum(['json', 'md', 'csv']).optional(),
});

export const prQuerySchema = scopeSchema.extend(pageSchema.shape).extend({
  state: z.enum(['open', 'merged', 'closed', 'all']).optional(),
  labels: z.string().optional(),
  comments: z.enum(['any', 'unresolved']).optional(),
  group: z.enum(['day', 'week', 'month', 'repo']).optional(),
});

export const activityQuerySchema = scopeSchema.extend(pageSchema.shape).extend({
  types: z.string().optional(),
});

export const issueQuerySchema = scopeSchema.extend(pageSchema.shape).extend({
  state: z.enum(['open', 'closed', 'all']).optional(),
});

export const listQuerySchema = scopeSchema.extend(pageSchema.shape);

export const statsQuerySchema = scopeSchema.extend({
  bucket: z.enum(['day', 'week', 'month']).optional(),
});

const RELATIVE = /^-(\d{1,4})([dwmy])$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Accepted bounds: 1970-01-01 ≤ from < to ≤ 3000-01-01, spanning at most MAX_RANGE_DAYS. */
const MIN_MS = 0;
const MAX_MS = Date.UTC(3000, 0, 1);
export const MAX_RANGE_DAYS = 7320; // ~20 years

/** UTC ms of the given fields, without Date.UTC's mapping of years 0–99 to 1900–1999. */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

/** Shifts `now` back by a relative offset like '-7d', '-12w', '-3m' or '-1y' (month ends clamp: Mar 31 - 1m = Feb 28). */
function relative(now: number, n: number, unit: string): number {
  if (unit === 'd') return now - n * DAY_MS;
  if (unit === 'w') return now - n * 7 * DAY_MS;
  const d = new Date(now);
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth() - (unit === 'm' ? n : 12 * n);
  const [y, mo] = [Math.floor(months / 12), ((months % 12) + 12) % 12];
  const lastDay = new Date(utc(y, mo + 1, 0)).getUTCDate();
  return utc(y, mo, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** Parses an ISO datetime, rejecting out-of-range fields (2026-02-30, 25:00). Offset-less times are local to `tz`. */
function parseDatetime(v: string, tz: string): number {
  const m = DATETIME.exec(v);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  const frac = m[7] ? Math.floor(Number(m[7]) * 1000) : 0;
  if (ymdToDayNum(`${m[1]}-${m[2]}-${m[3]}`) === null || h > 23 || mi > 59 || s > 59) return NaN;
  const wall = utc(y, mo - 1, d, h, mi, s, frac);
  const zone = m[8];
  if (!zone) return zonedWallToUtc(tz, wall - frac) + frac;
  if (zone.toUpperCase() === 'Z') return wall;
  const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
  const [oh, om] = [Number(z[2]), Number(z[3] ?? 0)];
  if (oh > 23 || om > 59) return NaN;
  return wall - (z[1] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
}

/**
 * Parses a `from`/`to` bound into UTC ms. Date-only values are local days in `tz`; a date-only `to`
 * is inclusive (returns the start of the next day). Datetimes without an offset are local to `tz`.
 * A datetime `to` includes its whole second. Returned `to` values are exclusive.
 */
export function parseBound(value: string, which: 'from' | 'to', tz: string, now: number): number {
  const v = value.trim();
  if (v === 'now') return now;
  const day = ymdToDayNum(v);
  if (day !== null) return zonedMidnight(tz, which === 'from' ? day : day + 1);
  const rel = RELATIVE.exec(v);
  if (rel) return relative(now, Number(rel[1]), rel[2]!);
  const ms = parseDatetime(v, tz);
  if (Number.isNaN(ms)) {
    throw new HttpError(400, `Invalid ${which}: expected YYYY-MM-DD, an ISO datetime, or a relative offset like -7d`);
  }
  return which === 'from' ? ms : Math.floor(ms / 1000) * 1000 + 1000;
}

export function splitList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseScope(q: z.infer<typeof scopeSchema>, defaultTz: string, now = Date.now()): Scope {
  const requested = q.tz?.trim() || defaultTz;
  const tz = canonicalTz(requested);
  if (!tz) throw new HttpError(400, `Invalid tz: ${requested}`);
  const today = localDayNum(tz, now);
  // Whole seconds, like the stored timestamps, so SQL filters and JS bucketing agree.
  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
  const to = sec(q.to ? parseBound(q.to, 'to', tz, now) : zonedMidnight(tz, today + 1));
  const from = sec(q.from ? parseBound(q.from, 'from', tz, now) : q.to ? to - 30 * DAY_MS : zonedMidnight(tz, today - 29));
  if (from < MIN_MS || to > MAX_MS) throw new HttpError(400, '`from` and `to` must be between 1970-01-01 and 2999-12-31');
  if (from >= to) throw new HttpError(400, '`from` must be before `to`');
  if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, `Range too long: at most ${MAX_RANGE_DAYS} days`);
  return {
    repos: splitList(q.repos),
    visibility: q.visibility ?? 'all',
    who: q.who ?? 'everyone',
    from,
    to,
    tz,
    q: q.q?.trim() || null,
  };
}

export function parseTypes(value: string | undefined): EventType[] | null {
  const list = splitList(value);
  if (!list) return null;
  const bad = list.filter((t) => !EVENT_TYPES.includes(t as EventType));
  if (bad.length) throw new HttpError(400, `Unknown event type(s): ${bad.join(', ')}`);
  return list as EventType[];
}

export function encodeCursor(key: CursorKey | null): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null;
}

/** Decodes an opaque cursor, checking it has the shape (`length` keys) of the endpoint's sort key. */
export function decodeCursor(cursor: string | undefined, length: number): CursorKey | null {
  if (!cursor) return null;
  try {
    const key: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(key) &&
      key.length === length &&
      key.every((k) => typeof k === 'string' || typeof k === 'number')
    ) {
      return key as CursorKey;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Invalid cursor');
}
