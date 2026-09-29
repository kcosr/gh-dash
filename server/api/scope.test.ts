import { describe, expect, it } from 'vitest';
import { HttpError } from './http';
import { decodeCursor, encodeCursor, parseBound, parseScope, parseTypes } from './scope';

const NOW = Date.parse('2026-09-27T15:30:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseBound', () => {
  it('treats date-only values as local days, with an inclusive `to`', () => {
    expect(iso(parseBound('2026-09-01', 'from', 'UTC', NOW))).toBe('2026-09-01T00:00:00.000Z');
    expect(iso(parseBound('2026-09-01', 'to', 'UTC', NOW))).toBe('2026-09-02T00:00:00.000Z');
    expect(iso(parseBound('2026-09-01', 'from', 'America/Los_Angeles', NOW))).toBe('2026-09-01T07:00:00.000Z');
    expect(iso(parseBound('2026-09-01', 'to', 'Asia/Tokyo', NOW))).toBe('2026-09-01T15:00:00.000Z');
  });

  it('supports relative offsets from now', () => {
    expect(iso(parseBound('-7d', 'from', 'UTC', NOW))).toBe('2026-09-20T15:30:00.000Z');
    expect(iso(parseBound('-2w', 'from', 'UTC', NOW))).toBe('2026-09-13T15:30:00.000Z');
    expect(iso(parseBound('-3m', 'from', 'UTC', NOW))).toBe('2026-06-27T15:30:00.000Z');
    expect(iso(parseBound('-1y', 'from', 'UTC', NOW))).toBe('2025-09-27T15:30:00.000Z');
    expect(parseBound('now', 'to', 'UTC', NOW)).toBe(NOW);
  });

  it('parses ISO datetimes; `to` includes its whole second; offset-less times are local to tz', () => {
    expect(iso(parseBound('2026-09-01T10:00:00Z', 'from', 'UTC', NOW))).toBe('2026-09-01T10:00:00.000Z');
    expect(iso(parseBound('2026-09-01T10:00:00+02:00', 'to', 'UTC', NOW))).toBe('2026-09-01T08:00:01.000Z');
    expect(iso(parseBound('2026-09-01T10:00', 'from', 'Europe/Berlin', NOW))).toBe('2026-09-01T08:00:00.000Z');
  });

  it('clamps relative months and years to the end of shorter months', () => {
    expect(iso(parseBound('-1m', 'from', 'UTC', Date.parse('2026-03-31T12:00:00Z')))).toBe('2026-02-28T12:00:00.000Z');
    expect(iso(parseBound('-13m', 'from', 'UTC', Date.parse('2026-01-31T12:00:00Z')))).toBe('2024-12-31T12:00:00.000Z');
    expect(iso(parseBound('-1y', 'from', 'UTC', Date.parse('2028-02-29T12:00:00Z')))).toBe('2027-02-28T12:00:00.000Z');
  });

  it('rejects datetimes with out-of-range fields instead of rolling them over', () => {
    for (const bad of ['2026-02-30T10:00:00Z', '2026-13-45T99:99', '2026-09-01T24:00', '2026-09-01T10:60:00Z', '2026-09-01T10:00:00+25:00']) {
      expect(() => parseBound(bad, 'from', 'UTC', NOW), bad).toThrow(HttpError);
    }
    expect(iso(parseBound('2026-09-01T10:00:00.250-04:00', 'from', 'UTC', NOW))).toBe('2026-09-01T14:00:00.250Z');
    expect(iso(parseBound('2026-09-01T10:00:00+0200', 'from', 'UTC', NOW))).toBe('2026-09-01T08:00:00.000Z');
  });

  it('rejects garbage with a 400', () => {
    for (const bad of ['yesterday', '2026-13-01', '-7x', '7d', '2026-09-01T']) {
      expect(() => parseBound(bad, 'from', 'UTC', NOW)).toThrow(HttpError);
    }
  });
});

describe('parseScope', () => {
  it('defaults to the last 30 local days through the end of today', () => {
    const s = parseScope({}, 'America/New_York', NOW);
    expect(iso(s.from)).toBe('2026-08-29T04:00:00.000Z');
    expect(iso(s.to)).toBe('2026-09-28T04:00:00.000Z');
    expect(s).toMatchObject({ repos: null, visibility: 'all', ownership: 'all', who: 'everyone', tz: 'America/New_York', q: null });
    expect(parseScope({ ownership: 'others' }, 'UTC', NOW).ownership).toBe('others');
  });

  it('distinguishes omitted, empty and listed repos', () => {
    expect(parseScope({}, 'UTC', NOW).repos).toBeNull();
    expect(parseScope({ repos: '' }, 'UTC', NOW).repos).toEqual([]);
    expect(parseScope({ repos: ' app, secret ,' }, 'UTC', NOW).repos).toEqual(['app', 'secret']);
  });

  it('uses the request tz over the server default and validates it', () => {
    expect(parseScope({ tz: 'Asia/Tokyo', from: '2026-09-01' }, 'UTC', NOW).from).toBe(Date.parse('2026-08-31T15:00:00Z'));
    expect(() => parseScope({ tz: 'Mars/Olympus' }, 'UTC', NOW)).toThrow(/Invalid tz/);
  });

  it('rejects inverted ranges and fills a missing `from` from `to`', () => {
    expect(() => parseScope({ from: '2026-09-10', to: '2026-09-01' }, 'UTC', NOW)).toThrow(/before/);
    const s = parseScope({ to: '2026-09-10' }, 'UTC', NOW);
    expect(s.to - s.from).toBe(30 * 86_400_000);
  });

  it('canonicalizes tz and keeps bounds whole seconds', () => {
    const s = parseScope({ tz: 'america/new_york', from: '-7d', to: 'now' }, 'UTC', NOW + 123);
    expect(s.tz).toBe('America/New_York');
    expect(s.from % 1000).toBe(0);
    expect(s.to % 1000).toBe(0);
  });

  it('rejects bounds outside 1970–2999 and ranges longer than ~20 years', () => {
    expect(() => parseScope({ from: '1969-12-31' }, 'UTC', NOW)).toThrow(/between/);
    expect(() => parseScope({ from: '-999y' }, 'UTC', NOW)).toThrow(/between/);
    expect(() => parseScope({ from: '2026-01-01', to: '9999-12-31' }, 'UTC', NOW)).toThrow(/between/);
    expect(() => parseScope({ from: '2000-01-01' }, 'UTC', NOW)).toThrow(/too long/);
    expect(parseScope({ from: '2010-01-01' }, 'UTC', NOW).from).toBe(Date.parse('2010-01-01T00:00:00Z'));
  });

  it('reads source as lower-cased hosts; absent or empty is every source', () => {
    expect(parseScope({}, 'UTC', NOW).source).toBeNull();
    expect(parseScope({ source: '' }, 'UTC', NOW).source).toBeNull();
    expect(parseScope({ source: ' , ' }, 'UTC', NOW).source).toBeNull();
    expect(parseScope({ source: 'GitLab.Example.com, github.com,gitlab.example.com' }, 'UTC', NOW).source).toEqual(['gitlab.example.com', 'github.com']);
  });

  it('blank q is no filter', () => {
    expect(parseScope({ q: '   ' }, 'UTC', NOW).q).toBeNull();
  });
});

describe('types and cursors', () => {
  it('validates event types', () => {
    expect(parseTypes(undefined)).toBeNull();
    expect(parseTypes('pr,star')).toEqual(['pr', 'star']);
    expect(() => parseTypes('pr,nope')).toThrow(/nope/);
  });

  it('round-trips cursors and rejects malformed or mismatched ones', () => {
    const c = encodeCursor(['2026-09-01T00:00:00Z', 'app', 3])!;
    expect(decodeCursor(c, 3)).toEqual(['2026-09-01T00:00:00Z', 'app', 3]);
    expect(() => decodeCursor(c, 2)).toThrow(/cursor/);
    expect(() => decodeCursor('not-base64!', 3)).toThrow(/cursor/);
    expect(decodeCursor(undefined, 3)).toBeNull();
    expect(encodeCursor(null)).toBeNull();
  });
});
