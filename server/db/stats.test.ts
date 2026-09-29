import { beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, ymdToDayNum, zonedMidnight } from '../lib/time';
import { seedDb } from '../test/seed';
import type { Db } from './db';
import { loadQueryCtx, type QueryCtx, type Scope } from './filters';
import { computeStats, defaultBucket } from './stats';
import { upsertCommit, upsertOwned, upsertStar } from './write';

let db: Db;
let ctx: QueryCtx;
beforeAll(() => {
  db = seedDb();
  ctx = loadQueryCtx(db);
});

/** Local days `from`..`to` inclusive in `tz`. */
function scope(from: string, to: string, over: Partial<Scope> = {}): Scope {
  const tz = over.tz ?? 'UTC';
  return {
    repos: null,
    visibility: 'all',
    who: 'everyone',
    q: null,
    tz,
    from: zonedMidnight(tz, ymdToDayNum(from)!),
    to: zonedMidnight(tz, ymdToDayNum(to)! + 1),
    ...over,
  };
}

describe('computeStats', () => {
  it('zero-fills day buckets over the whole range and counts each metric', () => {
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26'));
    expect(s.range).toEqual({
      from: '2026-09-20T00:00:00Z', to: '2026-09-27T00:00:00Z', prevFrom: '2026-09-13T00:00:00Z', prevTo: '2026-09-20T00:00:00Z', bucket: 'day', tz: 'UTC',
    });
    expect(s.series.map((b) => b.start)).toEqual(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
    const col = (k: keyof (typeof s.series)[number]) => s.series.map((b) => b[k]);
    expect(col('commits')).toEqual([0, 1, 1, 0, 1, 1, 0]);
    expect(col('commitsMine')).toEqual([0, 1, 1, 0, 1, 0, 0]);
    expect(col('prsOpened')).toEqual([1, 0, 1, 0, 1, 0, 0]);
    expect(col('prsMerged')).toEqual([0, 1, 0, 0, 1, 0, 0]);
    expect(col('prsMergedMine')).toEqual([0, 1, 0, 0, 1, 0, 0]);
    expect(col('issuesOpened')).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(col('issuesClosed')).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(col('releases')).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(col('stars')).toEqual([1, 0, 0, 0, 0, 1, 0]);
    expect(col('medianHoursToMerge')).toEqual([null, 24, null, null, 2, null, null]);
    expect(s.commitCalendar.map((d) => d.count)).toEqual([0, 1, 1, 0, 1, 1, 0]);
  });

  it('computes tiles with the previous equal-length period and 12-slice sparks', () => {
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26'));
    expect(s.tiles.prsMerged).toMatchObject({ value: 2, previous: 0 });
    expect(s.tiles.commits).toMatchObject({ value: 4, previous: 0 });
    expect(s.tiles.newStars).toMatchObject({ value: 2, previous: 0 });
    expect(s.tiles.issuesClosed).toMatchObject({ value: 1, previous: 0 });
    expect(s.tiles.activeRepos).toMatchObject({ value: 2, previous: 0 });
    expect(s.tiles.medianHoursToMerge).toMatchObject({ value: 13, previous: null });
    for (const tile of Object.values(s.tiles)) expect(tile.spark).toHaveLength(12);
    expect(s.tiles.commits.spark.reduce((a, b) => a + b, 0)).toBe(4);

    const later = computeStats(db, ctx, scope('2026-09-27', '2026-10-03'));
    expect(later.tiles.prsMerged).toMatchObject({ value: 0, previous: 2 });
    expect(later.tiles.medianHoursToMerge).toMatchObject({ value: null, previous: 13 });
  });

  it('buckets in the requested timezone', () => {
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26', { tz: 'Asia/Tokyo' }));
    expect(s.range.from).toBe('2026-09-19T15:00:00Z');
    // c2 (2026-09-22T23:30Z) is the morning of the 23rd in Tokyo.
    expect(s.commitCalendar.filter((d) => d.count).map((d) => d.date)).toEqual(['2026-09-21', '2026-09-23', '2026-09-24', '2026-09-25']);
  });

  it('uses Monday-start weeks and the default bucket rule', () => {
    const s = computeStats(db, ctx, scope('2026-09-10', '2026-09-26'), 'week');
    expect(s.series.map((b) => b.start)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(s.series.map((b) => b.commits)).toEqual([0, 0, 4]);
    expect(defaultBucket(0, 45 * DAY_MS)).toBe('day');
    expect(defaultBucket(0, 46 * DAY_MS)).toBe('week');
    expect(defaultBucket(0, 190 * DAY_MS)).toBe('week');
    expect(defaultBucket(0, 191 * DAY_MS)).toBe('month');
  });

  it('derives cumulative stars from the current stargazer count of in-scope public repos', () => {
    // app has 5 stargazers now; erin starred at 09-27T00:00 (after the range), dave on 09-25, carol on 09-20.
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26'));
    expect(s.stars.map((d) => d.total)).toEqual([3, 3, 3, 3, 3, 4, 4]);
    expect(s.stars.map((d) => d.added)).toEqual([1, 0, 0, 0, 0, 1, 0]);
    const privateOnly = computeStats(db, ctx, scope('2026-09-20', '2026-09-26', { visibility: 'private' }));
    expect(privateOnly.stars.every((d) => d.total === 0)).toBe(true);
  });

  it('keeps cumulative stars to public repos: internal ones are left out, and filterable on their own', () => {
    const d = seedDb();
    const corp = upsertOwned(d, {
      nodeId: 'R_corp', name: 'corp', nameWithOwner: 'alice/corp', owner: 'alice', description: null, url: 'https://github.com/alice/corp',
      visibility: 'internal', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 7, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T00:00:00Z',
    }, '2026-09-27T00:00:00Z');
    upsertStar(d, corp, { login: 'zoe', name: null, avatarUrl: null, starredAt: '2026-09-22T00:00:00Z' });
    const s = computeStats(d, loadQueryCtx(d), scope('2026-09-20', '2026-09-26'));
    expect(s.stars.map((b) => b.total)).toEqual([3, 3, 3, 3, 3, 4, 4]);
    expect(s.tiles.newStars.value).toBe(3);
    const internal = computeStats(d, loadQueryCtx(d), scope('2026-09-20', '2026-09-26', { visibility: 'internal' }));
    expect(internal.byRepo.map((r) => [r.repo, r.stars])).toEqual([['corp', 1]]);
    expect(internal.stars.every((b) => b.total === 0)).toBe(true);
  });

  it('stars are never "me"', () => {
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26', { who: 'me' }));
    expect(s.stars).toHaveLength(7);
    expect(s.stars.every((d) => d.total === 0 && d.added === 0)).toBe(true);
    expect(s.tiles.newStars.value).toBe(0);
    expect(s.tiles.commits.value).toBe(3);
  });

  it('ranks repos and contributors, merging all of the viewer identities', () => {
    const s = computeStats(db, ctx, scope('2026-09-20', '2026-09-26'));
    expect(s.byRepo).toEqual([
      { repo: 'app', commits: 3, prsMerged: 1, issues: 2, releases: 1, stars: 2, total: 9 },
      { repo: 'secret', commits: 1, prsMerged: 1, issues: 0, releases: 0, stars: 0, total: 2 },
    ]);
    expect(s.contributors).toEqual([
      { actor: { login: 'Alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice', isMe: true }, commits: 3, prsMerged: 2, total: 5 },
      { actor: { login: 'bob', name: 'Bob', avatarUrl: 'https://avatars.example/bob', isMe: false }, commits: 1, prsMerged: 0, total: 1 },
    ]);
    expect(computeStats(db, ctx, scope('2026-09-20', '2026-09-26', { who: 'others' })).contributors.map((c) => c.actor.login)).toEqual(['bob']);
  });
});

describe('contributors', () => {
  const person = (login: string | null, email: string | null, name: string) => ({ login, email, name, avatarUrl: `https://avatars.example/${name}` });
  const commit = (oid: string, at: string, author: ReturnType<typeof person>) => ({
    oid: oid.padEnd(40, '0'), headline: oid, body: '', author, committedAt: at, url: `https://github.com/c/${oid}`, additions: 1, deletions: 0, prNumber: null,
  });
  function db2() {
    const d = seedDb();
    const lab = upsertOwned(d, {
      nodeId: 'R_lab', name: 'lab', nameWithOwner: 'alice/lab', owner: 'alice', description: null, url: 'https://github.com/alice/lab',
      visibility: 'public', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 0, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T00:00:00Z',
    }, '2026-09-27T00:00:00Z');
    upsertCommit(d, lab, commit('x1', '2026-09-21T01:00:00Z', person('ALICE', 'alice@home.example', 'Alice Home')));
    upsertCommit(d, lab, commit('x2', '2026-09-21T02:00:00Z', person(null, 'alice@env.example', 'Alice (laptop)')));
    upsertCommit(d, lab, commit('x3', '2026-09-21T03:00:00Z', person('carol', 'carol@a.example', 'Carol A')));
    upsertCommit(d, lab, commit('x4', '2026-09-22T03:00:00Z', person('carol', 'carol@b.example', 'Carol B')));
    upsertCommit(d, lab, commit('x5', '2026-09-21T04:00:00Z', person(null, 'dan@x.example', 'Dan (laptop)')));
    upsertCommit(d, lab, commit('x6', '2026-09-23T04:00:00Z', person(null, 'dan@x.example', 'Dan')));
    upsertCommit(d, lab, commit('x7', '2026-09-23T05:00:00Z', person(null, 'dan@y.example', 'Dan')));
    return d;
  }
  const rows = (s: ReturnType<typeof computeStats>) => s.contributors.map((c) => [c.actor.login, c.actor.name, c.actor.isMe, c.commits, c.prsMerged, c.total]);

  it('merges every "me" identity into one viewer row; others by login, else by email, showing their latest name', () => {
    const d = db2();
    const s = computeStats(d, loadQueryCtx(d, ['alice@env.example']), scope('2026-09-20', '2026-09-26'));
    expect(rows(s)).toEqual([
      // c1, c2 (settings email), c4, x1 (login in other case), x2 (GH_DASH_MY_EMAILS) + merges app#1, secret#1
      ['Alice', 'Alice A', true, 5, 2, 7],
      ['carol', 'Carol B', false, 2, 0, 2],
      [null, 'Dan', false, 2, 0, 2],
      ['bob', 'Bob', false, 1, 0, 1],
      [null, 'Dan', false, 1, 0, 1],
    ]);
    expect(s.contributors[0]!.actor.avatarUrl).toBe('https://avatars.example/alice');
    // who=me: exactly one row; who=others: no "me" identity at all.
    expect(rows(computeStats(d, loadQueryCtx(d, ['alice@env.example']), scope('2026-09-20', '2026-09-26', { who: 'me' })))).toEqual([['Alice', 'Alice A', true, 5, 2, 7]]);
    const others = computeStats(d, loadQueryCtx(d, ['alice@env.example']), scope('2026-09-20', '2026-09-26', { who: 'others' }));
    expect(others.contributors.some((c) => c.actor.isMe || c.actor.login?.toLowerCase() === 'alice')).toBe(false);
  });

  it('without the env email that address is just another person', () => {
    const d = db2();
    const s = computeStats(d, loadQueryCtx(d), scope('2026-09-20', '2026-09-26'));
    expect(rows(s)).toContainEqual(['Alice', 'Alice A', true, 4, 2, 6]);
    expect(rows(s)).toContainEqual([null, 'Alice (laptop)', false, 1, 0, 1]);
  });
});
