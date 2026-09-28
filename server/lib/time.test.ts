import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  bucketIndex,
  canonicalTz,
  dayNumToYmd,
  isoSec,
  localDateSql,
  localDayNum,
  makeBuckets,
  median,
  offsetSegments,
  ymdToDayNum,
  zonedMidnight,
  zonedWallToUtc,
} from './time';

const day = (ymd: string) => ymdToDayNum(ymd)!;
const iso = (ms: number) => new Date(ms).toISOString();

describe('zonedMidnight', () => {
  it('handles fixed and DST offsets', () => {
    expect(iso(zonedMidnight('UTC', day('2026-09-27')))).toBe('2026-09-27T00:00:00.000Z');
    expect(iso(zonedMidnight('America/New_York', day('2026-07-01')))).toBe('2026-07-01T04:00:00.000Z');
    expect(iso(zonedMidnight('America/New_York', day('2026-12-01')))).toBe('2026-12-01T05:00:00.000Z');
    expect(iso(zonedMidnight('Asia/Kolkata', day('2026-09-27')))).toBe('2026-09-26T18:30:00.000Z');
  });

  it('starts the day at the transition when midnight does not exist', () => {
    // Santiago springs forward from 00:00 to 01:00 on 2026-09-06.
    expect(iso(zonedMidnight('America/Santiago', day('2026-09-06')))).toBe('2026-09-06T04:00:00.000Z');
  });

  it('is exact on DST-end days in zones far east of UTC', () => {
    // Sydney leaves DST at 03:00 AEDT on 2026-04-05; midnight that day is still +11. The old two-step lookup
    // used the offset of "00:00Z", which is already after the change, and returned 14:00Z.
    expect(iso(zonedMidnight('Australia/Sydney', day('2026-04-05')))).toBe('2026-04-04T13:00:00.000Z');
    expect(iso(zonedMidnight('Australia/Sydney', day('2026-04-06')))).toBe('2026-04-05T14:00:00.000Z');
    expect(iso(zonedMidnight('Australia/Lord_Howe', day('2026-04-05')))).toBe('2026-04-04T13:00:00.000Z');
    expect(iso(zonedMidnight('Pacific/Auckland', day('2026-04-05')))).toBe('2026-04-04T11:00:00.000Z');
  });

  it('returns the first instant of every local day across many zones and years', () => {
    for (const tz of ['Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/New_York', 'America/Havana', 'Asia/Beirut', 'Europe/London']) {
      for (let d = day('2025-01-01'); d < day('2027-01-01'); d++) {
        const m = zonedMidnight(tz, d);
        expect(localDayNum(tz, m), `${tz} ${dayNumToYmd(d)}`).toBe(d);
        expect(localDayNum(tz, m - 1000), `${tz} ${dayNumToYmd(d)}`).toBe(d - 1);
      }
    }
  });
});

describe('zonedWallToUtc', () => {
  it('resolves ambiguous times to the first occurrence and gap times forward', () => {
    // New York: 01:30 happens twice on 2026-11-01; 02:30 does not exist on 2026-03-08.
    expect(iso(zonedWallToUtc('America/New_York', Date.UTC(2026, 10, 1, 1, 30)))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(zonedWallToUtc('America/New_York', Date.UTC(2026, 2, 8, 2, 30)))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(zonedWallToUtc('Australia/Sydney', Date.UTC(2026, 3, 5, 0, 30)))).toBe('2026-04-04T13:30:00.000Z');
  });
});

describe('offsetSegments / localDateSql', () => {
  it('finds the exact DST transitions within a range', () => {
    const segs = offsetSegments('America/New_York', Date.parse('2026-01-01T05:00:00Z'), Date.parse('2027-01-01T05:00:00Z'));
    expect(segs.map((s) => [iso(s.start), s.offsetMs / 3_600_000])).toEqual([
      ['2026-01-01T05:00:00.000Z', -5],
      ['2026-03-08T07:00:00.000Z', -4],
      ['2026-11-01T06:00:00.000Z', -5],
    ]);
    expect(offsetSegments('UTC', 0, 400 * 86_400_000)).toHaveLength(1);
  });

  it('computes local dates in SQL that match localDayNum, across DST changes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (at TEXT)');
    for (const tz of ['America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata']) {
      const from = Date.parse('2026-03-01T00:00:00Z');
      const to = Date.parse('2026-12-01T00:00:00Z');
      db.exec('DELETE FROM t');
      const insert = db.prepare('INSERT INTO t VALUES (?)');
      const instants: number[] = [];
      for (let t = from; t < to; t += 17 * 60_000 + 7_000) instants.push(Math.floor(t / 1000) * 1000);
      for (const t of instants) insert.run(isoSec(t));
      const sql = localDateSql('at', offsetSegments(tz, from, to));
      const got = db.prepare(`SELECT ${sql.sql} AS d FROM t ORDER BY at`).all(...sql.params) as { d: string }[];
      expect(got.map((r) => r.d)).toEqual(instants.map((t) => dayNumToYmd(localDayNum(tz, t))));
    }
  });
});

describe('canonicalTz', () => {
  it('canonicalizes spelling and rejects unknown zones', () => {
    expect(canonicalTz('america/new_york')).toBe('America/New_York');
    expect(canonicalTz('UTC')).toBe('UTC');
    expect(canonicalTz('Mars/Olympus')).toBeNull();
  });
});

describe('localDayNum', () => {
  it('maps an instant to the civil day in a zone', () => {
    const t = Date.parse('2026-09-22T23:30:00Z');
    expect(dayNumToYmd(localDayNum('UTC', t))).toBe('2026-09-22');
    expect(dayNumToYmd(localDayNum('Asia/Tokyo', t))).toBe('2026-09-23');
    expect(dayNumToYmd(localDayNum('America/Los_Angeles', t))).toBe('2026-09-22');
  });
});

describe('ymdToDayNum', () => {
  it('rejects impossible dates', () => {
    expect(ymdToDayNum('2026-02-30')).toBeNull();
    expect(ymdToDayNum('2026-9-1')).toBeNull();
    expect(dayNumToYmd(day('2024-02-29'))).toBe('2024-02-29');
  });
});

describe('makeBuckets', () => {
  it('builds Monday-start weeks covering the range', () => {
    const b = makeBuckets('UTC', Date.parse('2026-09-10T00:00:00Z'), Date.parse('2026-09-28T00:00:00Z'), 'week');
    expect(b.keys).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(iso(b.end)).toBe('2026-09-28T00:00:00.000Z');
  });

  it('builds calendar months in the zone', () => {
    const from = zonedMidnight('Europe/Berlin', day('2026-01-15'));
    const to = zonedMidnight('Europe/Berlin', day('2026-04-01'));
    const b = makeBuckets('Europe/Berlin', from, to, 'month');
    expect(b.keys).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(iso(b.starts[2]!)).toBe('2026-02-28T23:00:00.000Z');
  });

  it('has 23- and 25-hour days across DST changes', () => {
    const tz = 'America/New_York';
    const b = makeBuckets(tz, zonedMidnight(tz, day('2026-03-07')), zonedMidnight(tz, day('2026-03-10')), 'day');
    expect(b.keys).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect((b.starts[2]! - b.starts[1]!) / 3_600_000).toBe(23);
  });

  it('finds the bucket of an instant', () => {
    const b = makeBuckets('UTC', Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-09-04T00:00:00Z'), 'day');
    expect(bucketIndex(b, Date.parse('2026-08-31T23:59:59Z'))).toBe(-1);
    expect(bucketIndex(b, Date.parse('2026-09-01T00:00:00Z'))).toBe(0);
    expect(bucketIndex(b, Date.parse('2026-09-03T23:59:59Z'))).toBe(2);
    expect(bucketIndex(b, Date.parse('2026-09-04T00:00:00Z'))).toBe(-1);
  });
});

describe('helpers', () => {
  it('formats second-precision ISO like GitHub', () => {
    expect(isoSec(Date.parse('2026-09-27T18:34:44.987Z'))).toBe('2026-09-27T18:34:44Z');
  });

  it('computes medians', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
