import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db';
import { DiffCache, openDiffCache } from './cache';

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-dash-cache-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A cache with a clock that advances 1 ms per call, so access order is deterministic. */
function cache(path = ':memory:') {
  let t = 1_000;
  return new DiffCache(path, () => t++);
}
const put = (c: DiffCache, key: string, bytes: number, repo = 'app') =>
  c.put({ key, kind: 'blob', repo, oid: 'a'.repeat(40), fetchedAt: 1, data: Buffer.alloc(bytes, 1) });
const keys = (c: DiffCache, ...candidates: string[]) => candidates.filter((k) => c.get(k));

describe('DiffCache', () => {
  it('stores, counts and returns entries', () => {
    const c = cache();
    put(c, 'a', 100);
    put(c, 'b', 50);
    expect(c.stats()).toEqual({ entries: 2, bytes: 150 });
    expect(Buffer.from(c.get('a')!)).toEqual(Buffer.alloc(100, 1));
    expect(c.get('nope')).toBeNull();
    put(c, 'a', 10); // replaced
    expect(c.stats()).toEqual({ entries: 2, bytes: 60 });
  });

  it('evicts least recently used entries down to 90% of the cap once over it', () => {
    const c = cache();
    for (const k of ['a', 'b', 'c', 'd']) put(c, k, 100);
    c.get('a'); // a is now the most recently used
    expect(c.evict(400, ['app'])).toBe(0);
    put(c, 'e', 100); // 500 > 400: evict b, c (-> 300 <= 360)
    expect(c.evict(400, ['app'])).toBe(2);
    expect(c.stats()).toEqual({ entries: 3, bytes: 300 });
    // Lowering the cap evicts further on the next pass.
    expect(c.evict(150, ['app'])).toBe(2);
    expect(keys(c, 'a', 'b', 'c', 'd', 'e')).toEqual(['e']);
  });

  it('drops entries of repos that are no longer known', () => {
    const c = cache();
    put(c, 'a', 10, 'app');
    put(c, 'b', 10, 'gone');
    expect(c.evict(1000, ['app', 'other'])).toBe(1);
    expect(keys(c, 'a', 'b')).toEqual(['a']);
    expect(c.evict(1000, [])).toBe(1);
  });

  it('tracks what each PR diff was computed against, and commits by prefix', () => {
    const c = cache();
    const pr = (head: string, baseOid: string, fetchedAt: number) =>
      c.put({ key: `pr/app/1/${head}`, kind: 'pr', repo: 'app', number: 1, oid: head, baseRef: 'main', baseOid, fetchedAt, data: Buffer.from('x') });
    pr('1'.repeat(40), 'b'.repeat(40), 10);
    pr('2'.repeat(40), 'b'.repeat(40), 20);
    c.put({ key: 'pr/app/2/x', kind: 'pr', repo: 'app', number: 2, oid: '3'.repeat(40), fetchedAt: 1, data: Buffer.from('x') });
    expect(c.prEntry('app', 1)).toEqual({ key: `pr/app/1/${'2'.repeat(40)}`, oid: '2'.repeat(40), baseRef: 'main', baseOid: 'b'.repeat(40), fetchedAt: 20 });
    c.dropOthers('app', 1, `pr/app/1/${'2'.repeat(40)}`);
    expect(c.stats().entries).toBe(2);
    // Same head, moved merge base: the entry is replaced in place.
    pr('2'.repeat(40), 'c'.repeat(40), 30);
    expect(c.prEntry('app', 1)).toMatchObject({ oid: '2'.repeat(40), baseOid: 'c'.repeat(40), fetchedAt: 30 });
    expect(c.stats().entries).toBe(2);
    expect(c.prEntry('app', 3)).toBeNull();

    for (const oid of ['abc1234' + '0'.repeat(33), 'abc1299' + '0'.repeat(33)]) {
      c.put({ key: `commit/app/${oid}`, kind: 'commit', repo: 'app', oid, fetchedAt: 1, data: Buffer.from('x') });
    }
    expect(c.findCommit('app', 'abc1234')).toBe('abc1234' + '0'.repeat(33));
    expect(c.findCommit('app', 'abc12')).toBeNull(); // ambiguous
    expect(c.findCommit('other', 'abc1234')).toBeNull();
  });

  it('keeps one diff per branch, replaced in place, apart from the diffs of PRs', () => {
    const c = cache();
    const branch = (key: string, head: string, baseOid: string, fetchedAt: number) =>
      c.put({ key, kind: 'branch', repo: 'app', oid: head, baseRef: 'main', baseOid, fetchedAt, data: Buffer.from('x') });
    branch('branch/app/feature/x', '1'.repeat(40), 'b'.repeat(40), 10);
    branch('branch/app/feature/y', '3'.repeat(40), 'b'.repeat(40), 10);
    c.put({ key: `pr/app/1/${'2'.repeat(40)}`, kind: 'pr', repo: 'app', number: 1, oid: '2'.repeat(40), baseRef: 'feature/x', fetchedAt: 5, data: Buffer.from('x') });
    expect(c.branchEntry('branch/app/feature/x')).toEqual({ key: 'branch/app/feature/x', oid: '1'.repeat(40), baseRef: 'main', baseOid: 'b'.repeat(40), fetchedAt: 10 });
    // A push (or a moved merge base) replaces the entry; there is no other diff of the branch to drop.
    branch('branch/app/feature/x', '4'.repeat(40), 'c'.repeat(40), 20);
    expect(c.branchEntry('branch/app/feature/x')).toMatchObject({ oid: '4'.repeat(40), baseOid: 'c'.repeat(40), fetchedAt: 20 });
    expect(c.stats().entries).toBe(3);
    // PR housekeeping and lookups leave branch entries alone, and the other way round.
    c.dropOthers('app', 1, 'pr/app/1/other');
    expect(c.stats().entries).toBe(2);
    expect(c.prEntry('app', 1)).toBeNull();
    expect(c.branchEntry('branch/app/feature/y')).not.toBeNull();
    expect(c.branchEntry('pr/app/1/x')).toBeNull();
    expect(c.branchEntry('branch/app/nope')).toBeNull();
    expect(c.findCommit('app', '4444444')).toBeNull();
    // They are dropped with their repo, and count against the size cap like the rest.
    expect(c.evict(1000, ['other'])).toBe(2);
  });

  it('gives the disk space back when cleared', () => {
    const path = join(temp(), 'gh-dash-cache.db');
    const c = cache(path);
    for (let i = 0; i < 20; i++) c.put({ key: `k${i}`, kind: 'blob', repo: 'app', oid: 'a', fetchedAt: 1, data: randomBytes(100_000) });
    const size = () => [path, `${path}-wal`].reduce((n, p) => n + (statSync(p, { throwIfNoEntry: false })?.size ?? 0), 0);
    const before = size();
    expect(before).toBeGreaterThan(2_000_000);
    c.clear();
    expect(c.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(size()).toBeLessThan(100_000);
    c.close();
  });

  it('migrates itself, survives reopening, and refuses a database that is not a cache', () => {
    const dir = temp();
    const path = join(dir, 'cache.db');
    const a = cache(path);
    put(a, 'k', 10);
    a.close();
    const b = cache(path);
    expect(b.stats().entries).toBe(1);
    b.close();

    // An older schema is simply dropped: the cache is disposable.
    const old = join(dir, 'old.db');
    const v1 = new DatabaseSync(old);
    v1.exec('CREATE TABLE entries (key TEXT PRIMARY KEY, created_at INTEGER); INSERT INTO entries VALUES (1, 1); PRAGMA user_version = 1');
    v1.close();
    const upgraded = cache(old);
    expect(upgraded.stats()).toEqual({ entries: 0, bytes: 0 });
    put(upgraded, 'k', 10);
    upgraded.close();

    // v2 had today's columns, but keyed entries by the repo's short name: dropped as well.
    const v2 = new DatabaseSync(old);
    v2.exec('PRAGMA user_version = 2');
    v2.close();
    const rekeyed = cache(old);
    expect(rekeyed.stats()).toEqual({ entries: 0, bytes: 0 });
    rekeyed.close();

    const other = join(dir, 'main.db');
    const raw = new DatabaseSync(other);
    raw.exec('CREATE TABLE repos (id INTEGER PRIMARY KEY)');
    raw.close();
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    expect(() => new DiffCache(other)).toThrow(/not a gh-dash diff cache/);
    expect(close).toHaveBeenCalledTimes(1); // the refused file isn't left open
    close.mockRestore();
    const lines: string[] = [];
    const fallback = openDiffCache(other, (l) => lines.push(l));
    expect(fallback.path).toBe(':memory:');
    expect(lines[0]).toContain('caching in memory instead');
  });

  it('still serves reads when it cannot record them', () => {
    const c = cache();
    put(c, 'a', 10);
    (c as unknown as { db: Db }).db.exec('PRAGMA query_only = ON'); // every write now fails, as on a full disk
    expect(c.get('a')).toHaveLength(10);
    expect(() => put(c, 'b', 10)).toThrow();
  });
});
