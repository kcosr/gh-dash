import { beforeAll, describe, expect, it } from 'vitest';
import { seedDb } from '../test/seed';
import type { Db } from './db';
import { ftsQuery, loadQueryCtx, type QueryCtx, type Scope } from './filters';
import { type CursorKey, getPrDetail, listActivity, listCommits, listIssues, listPrs, listStars } from './lists';

let db: Db;
let ctx: QueryCtx;
beforeAll(() => {
  db = seedDb();
  ctx = loadQueryCtx(db);
});

const scope = (over: Partial<Scope> = {}): Scope => ({
  repos: null,
  visibility: 'all',
  who: 'everyone',
  from: Date.parse('2026-09-01T00:00:00Z'),
  to: Date.parse('2026-09-28T00:00:00Z'),
  tz: 'UTC',
  q: null,
  ...over,
});
const all = { state: 'all', labels: null } as const;
const prIds = (s: Scope, f: Parameters<typeof listPrs>[3] = all) => listPrs(db, ctx, s, f, null).items.map((p) => p.id);

describe('PR filters', () => {
  it('default scope excludes archived, forked and hidden repos; sorts by activityAt desc', () => {
    expect(prIds(scope())).toEqual(['secret#1', 'app#3', 'app#2', 'app#1']);
  });

  it('includes forks when settings.includeForks is on', () => {
    expect(listPrs(db, { ...ctx, includeForks: true }, scope(), all, null).items.map((p) => p.id)).toContain('fork#1');
  });

  it('filters by visibility, who and state', () => {
    expect(prIds(scope({ visibility: 'private' }))).toEqual(['secret#1']);
    expect(prIds(scope({ visibility: 'public' }))).toEqual(['app#3', 'app#2', 'app#1']);
    expect(prIds(scope({ who: 'me' }))).toEqual(['secret#1', 'app#1']);
    expect(prIds(scope({ who: 'others' }))).toEqual(['app#3', 'app#2']);
    expect(prIds(scope(), { state: 'merged', labels: null })).toEqual(['secret#1', 'app#1']);
    expect(prIds(scope(), { state: 'all', labels: ['BUG', 'nope'] })).toEqual(['app#1']);
  });

  it('explicit repos may include archived/hidden repos; empty means none; unknown names are ignored', () => {
    expect(prIds(scope({ repos: ['old', 'hidden'] }))).toEqual(['hidden#1', 'old#1']);
    expect(prIds(scope({ repos: [] }))).toEqual([]);
    expect(prIds(scope({ repos: ['app', 'does-not-exist'] }))).toEqual(['app#3', 'app#2', 'app#1']);
  });

  it('applies the date range to activityAt', () => {
    expect(prIds(scope({ from: Date.parse('2026-09-22T00:00:00Z'), to: Date.parse('2026-09-24T00:00:00Z') }))).toEqual(['app#3', 'app#2']);
  });

  it('facets.byRepo ignores the repos filter but keeps every other filter', () => {
    const res = listPrs(db, ctx, scope({ repos: ['app'], who: 'me' }), all, null);
    expect(res.items.map((p) => p.id)).toEqual(['app#1']);
    expect(res.facets.byRepo).toEqual({ app: 1, secret: 1, old: 1, hidden: 1 });
    expect(listPrs(db, ctx, scope({ visibility: 'private' }), all, null).facets.byRepo).toEqual({ secret: 1 });
  });

  it('searches with FTS (prefix on the last word) and falls back to LIKE without searchable words', () => {
    expect(prIds(scope({ q: 'logi' }))).toEqual(['app#1']);
    expect(prIds(scope({ q: 'sso users' }))).toEqual(['app#1']);
    expect(prIds(scope({ q: 'parser' }))).toEqual(['app#2']);
    expect(prIds(scope({ q: '##' }))).toEqual(['app#1']);
    expect(prIds(scope({ q: 'nothing-matches-this' }))).toEqual([]);
  });

  it('computes isMe from the viewer login case-insensitively', () => {
    const [first] = listPrs(db, ctx, scope({ repos: ['app'] }), { state: 'merged', labels: null }, null).items;
    expect(first!.author).toEqual({ login: 'alice', name: 'Alice', avatarUrl: 'https://avatars.example/alice', isMe: true });
  });
});

describe('cursor pagination', () => {
  it('walks every item exactly once with stable ordering', () => {
    const expected = prIds(scope({ repos: ['app', 'secret', 'old', 'hidden'] }));
    const seen: string[] = [];
    let after: CursorKey | null = null;
    let pages = 0;
    do {
      const page = listPrs(db, ctx, scope({ repos: ['app', 'secret', 'old', 'hidden'] }), all, { limit: 2, after });
      expect(page.total).toBe(expected.length);
      seen.push(...page.items.map((p) => p.id));
      after = page.nextCursor;
      pages++;
    } while (after);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it('breaks activityAt ties by repo then number', () => {
    const tie = listPrs(db, ctx, scope({ repos: ['app', 'secret'] }), all, { limit: 1, after: ['2026-09-24T02:00:00Z', 'app', 0] });
    expect(tie.items[0]!.id).toBe('secret#1');
  });
});

describe('PR detail', () => {
  it('includes commits and closing issues', () => {
    const pr = getPrDetail(db, ctx, 'app', 1)!;
    expect(pr.commits).toEqual([
      { oid: 'p1', headline: 'fix login', committedAt: '2026-09-20T09:00:00Z', url: 'u', author: expect.objectContaining({ login: 'alice', isMe: true }) },
    ]);
    expect(pr.closingIssues).toEqual([{ number: 10, title: 'Issue 10', state: 'closed', url: 'https://github.com/alice/app/issues/10' }]);
    expect(getPrDetail(db, ctx, 'app', 999)).toBeNull();
  });
});

describe('commits, issues, stars', () => {
  it('who=me matches the viewer login or a configured email', () => {
    const mine = listCommits(db, ctx, scope({ who: 'me' }), null).items;
    expect(mine.map((c) => c.headline).sort()).toEqual(['Commit c4', 'Merge pull request #1', 'Tweak config']);
    expect(mine.every((c) => c.author.isMe)).toBe(true);
    expect(listCommits(db, ctx, scope({ who: 'others' }), null).items.map((c) => c.author.login)).toEqual(['bob']);
  });

  it('issues are dated by close time when closed', () => {
    const res = listIssues(db, ctx, scope({ from: Date.parse('2026-09-20T00:00:00Z') }), 'all', null);
    expect(res.items.map((i) => i.id)).toEqual(['app#11', 'app#10']);
    expect(res.items[1]!.closedBy?.isMe).toBe(true);
    expect(listIssues(db, ctx, scope(), 'open', null).total).toBe(1);
  });

  it('stars are never "me" and have no searchable text', () => {
    expect(listStars(db, ctx, scope(), null).items.map((s) => s.user.login)).toEqual(['erin', 'dave', 'carol']);
    expect(listStars(db, ctx, scope({ who: 'me' }), null).total).toBe(0);
    expect(listStars(db, ctx, scope({ who: 'others' }), null).total).toBe(3);
    expect(listStars(db, ctx, scope({ q: 'erin' }), null).total).toBe(0);
  });
});

describe('activity', () => {
  const kinds = (s: Scope, types: Parameters<typeof listActivity>[3] = null) =>
    listActivity(db, ctx, s, types, null).items.map((e) => `${e.type}${'kind' in e ? `:${e.kind}` : ''}:${e.repo}`);

  it('unions events newest first; commit events exclude commits that came from PRs', () => {
    expect(kinds(scope({ repos: ['app'], from: Date.parse('2026-09-20T00:00:00Z') }))).toEqual([
      'star:app', // erin 09-27
      'issue:opened:app', // #11 09-26
      'commit:app', // c3 09-25
      'star:app', // dave 09-25
      'release:app', // 09-23 15:00
      'pr:closed:app', // #3 09-23 08:00
      'commit:app', // c2 09-22 23:30
      'issue:closed:app', // #10 09-22 12:00
      'pr:opened:app', // #2 09-22 09:00
      'pr:merged:app', // #1 09-21
      'pr:opened:app', // #1 09-20 10:00
      'star:app', // carol 09-20 00:00
    ]);
  });

  it('uses the closer as the actor of issue close events', () => {
    const closed = listActivity(db, ctx, scope({ who: 'me' }), ['issue'], null).items;
    expect(closed.map((e) => (e.type === 'issue' ? `${e.kind}:${e.issue.number}:${e.actor.login}` : ''))).toEqual([
      'opened:11:alice',
      'closed:10:alice',
    ]);
  });

  it('facets: byType ignores types, byRepo ignores repos', () => {
    const res = listActivity(db, ctx, scope({ repos: ['secret'] }), ['pr'], { limit: 50, after: null });
    expect(res.items.map((e) => e.type)).toEqual(['pr', 'pr']);
    expect(res.facets.byType).toEqual({ pr: 2 });
    // app#3 was opened exactly at `from` (inclusive), so app has 5 PR events.
    const byType = listActivity(db, ctx, scope({ repos: ['app'] }), ['pr'], null).facets.byType;
    expect(byType).toEqual({ commit: 2, pr: 5, issue: 3, release: 1, star: 3 });
    expect(res.facets.byRepo).toEqual({ app: 5, secret: 2, old: 2, fork: 2, hidden: 2 });
  });

  it('facets.byDay counts the listed events per local day in the request tz, with every filter applied', () => {
    const range = { repos: ['app'], from: Date.parse('2026-09-20T00:00:00Z'), to: Date.parse('2026-09-28T00:00:00Z') };
    const utc = listActivity(db, ctx, scope(range), null, { limit: 5, after: null });
    expect(utc.facets.byDay).toEqual({ '2026-09-27': 1, '2026-09-26': 1, '2026-09-25': 2, '2026-09-23': 2, '2026-09-22': 3, '2026-09-21': 1, '2026-09-20': 2 });
    expect(utc.total).toBe(12);
    // Tokyo: the 15:00Z release lands on the 24th and the 23:30Z commit on the 23rd.
    const tokyo = listActivity(db, ctx, scope({ ...range, tz: 'Asia/Tokyo' }), null, null);
    expect(tokyo.facets.byDay).toEqual({ '2026-09-27': 1, '2026-09-26': 1, '2026-09-25': 2, '2026-09-24': 1, '2026-09-23': 2, '2026-09-22': 2, '2026-09-21': 1, '2026-09-20': 2 });
    // `types` applies to byDay (unlike byType); byDay always sums to total.
    const prs = listActivity(db, ctx, scope(range), ['pr'], null);
    expect(prs.facets.byDay).toEqual({ '2026-09-23': 1, '2026-09-22': 1, '2026-09-21': 1, '2026-09-20': 1 });
    expect(prs.total).toBe(4);
    expect(prs.facets.byType).toEqual(utc.facets.byType);
    for (const res of [utc, tokyo, prs, listActivity(db, ctx, scope({ who: 'me' }), null, null)]) {
      expect(Object.values(res.facets.byDay!).reduce((a, b) => a + b, 0)).toBe(res.total);
    }
  });

  it('paginates the union with cursors', () => {
    const full = listActivity(db, ctx, scope(), null, null).items;
    const walked: typeof full = [];
    let after: CursorKey | null = null;
    do {
      const page = listActivity(db, ctx, scope(), null, { limit: 3, after });
      walked.push(...page.items);
      after = page.nextCursor;
    } while (after);
    expect(walked).toEqual(full);
  });
});

describe('ftsQuery', () => {
  it('never produces a query SQLite rejects, whatever the input', () => {
    expect(ftsQuery('a\u0000b')).toBe('"a" "b"*');
    const alphabet = ['a', 'Z', '9', 'é', '日', '"', "'", '*', '^', ':', '(', ')', '-', '+', '\\', '%', '_', ' ', '\u0000', '\t', '\n', 'NEAR', 'OR', 'AND', 'NOT', '{', '}', '😀'];
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 300; i++) {
      const q = Array.from({ length: 1 + rand(12) }, () => alphabet[rand(alphabet.length)]).join('');
      expect(() => listPrs(db, ctx, scope({ q }), all, null), JSON.stringify(q)).not.toThrow();
      expect(() => listActivity(db, ctx, scope({ q }), null, { limit: 5, after: null }), JSON.stringify(q)).not.toThrow();
    }
  });

  it('quotes terms, keeps phrases, prefixes the last bare word', () => {
    expect(ftsQuery('login flow')).toBe('"login" "flow"*');
    expect(ftsQuery('"exact phrase" gh-dash')).toBe('"exact phrase" "gh-dash"*');
    expect(ftsQuery('say "hi')).toBe('"say" "hi"');
    expect(ftsQuery('OR AND NOT (')).toBe('"OR" "AND" "NOT"*');
    expect(ftsQuery(' -- ## ')).toBeNull();
  });
});
