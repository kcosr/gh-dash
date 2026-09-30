import { describe, expect, it } from 'vitest';
import { newestFirst } from './branches';
import type { BranchRef } from './types';

const ref = (name: string, committedAt: string | null): BranchRef => ({ name, headOid: 'a'.repeat(40), committedAt });

describe('newestFirst', () => {
  it('orders by the instant of the head commit, latest first, and those without a date last', () => {
    const sorted = [
      ref('old', '2026-01-01T00:00:00Z'),
      ref('undated', null),
      // 12:00+02:00 is 10:00Z: older than 11:30Z, though "12" sorts after "11" as text.
      ref('offset', '2026-09-30T12:00:00+02:00'),
      ref('new', '2026-09-30T11:30:00.000Z'),
    ].sort(newestFirst);
    expect(sorted.map((b) => b.name)).toEqual(['new', 'offset', 'old', 'undated']);
  });

  it('breaks ties by name, so that a list has one order', () => {
    const at = '2026-05-05T00:00:00Z';
    expect([ref('b', at), ref('c', null), ref('a', at), ref('a2', null)].sort(newestFirst).map((b) => b.name)).toEqual(['a', 'b', 'a2', 'c']);
    expect(newestFirst(ref('a', at), ref('a', at))).toBe(0);
  });
});
