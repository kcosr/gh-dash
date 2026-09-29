import { beforeAll, describe, expect, it } from 'vitest';
import { addManualRepo, seedDb } from '../test/seed';
import { activityCsv, commitsCsv, prsCsv } from '../format/csv';
import { eventsMarkdown, prsMarkdown } from '../format/markdown';
import { createThread, getPrincipal, SELF_PRINCIPAL_ID, setThreadStatus } from './comments';
import type { Db } from './db';
import { ftsQuery, loadQueryCtx, type QueryCtx, type Scope } from './filters';
import { COMMIT_SELECT, type CursorKey, getPrDetail, listActivity, listCommits, listIssues, listPrs, listStars } from './lists';

let db: Db;
let ctx: QueryCtx;
beforeAll(() => {
  db = seedDb();
  ctx = loadQueryCtx(db);
});

const scope = (over: Partial<Scope> = {}): Scope => ({
  repos: null,
  visibility: 'all',
  ownership: 'all',
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
  it('the default selection excludes archived, forked and hidden repos; sorts by activityAt desc', () => {
    expect(prIds(scope())).toEqual(['alice/secret#1', 'alice/app#3', 'alice/app#2', 'alice/app#1']);
  });

  it('includes forks when settings.includeForks is on', () => {
    expect(listPrs(db, { ...ctx, includeForks: true }, scope(), all, null).items.map((p) => p.id)).toContain('alice/fork#1');
  });

  it('filters by visibility, who and state', () => {
    expect(prIds(scope({ visibility: 'private' }))).toEqual(['alice/secret#1']);
    expect(prIds(scope({ visibility: 'public' }))).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(prIds(scope({ who: 'me' }))).toEqual(['alice/secret#1', 'alice/app#1']);
    expect(prIds(scope({ who: 'others' }))).toEqual(['alice/app#3', 'alice/app#2']);
    expect(prIds(scope(), { state: 'merged', labels: null })).toEqual(['alice/secret#1', 'alice/app#1']);
    expect(prIds(scope(), { state: 'all', labels: ['BUG', 'nope'] })).toEqual(['alice/app#1']);
  });

  it('explicit repos may include archived/hidden repos; empty means none; unknown names are ignored', () => {
    expect(prIds(scope({ repos: ['old', 'hidden'] }))).toEqual(['alice/hidden#1', 'alice/old#1']);
    expect(prIds(scope({ repos: [] }))).toEqual([]);
    expect(prIds(scope({ repos: ['app', 'does-not-exist'] }))).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
  });

  it('applies the date range to activityAt', () => {
    expect(prIds(scope({ from: Date.parse('2026-09-22T00:00:00Z'), to: Date.parse('2026-09-24T00:00:00Z') }))).toEqual(['alice/app#3', 'alice/app#2']);
  });

  it('facets.byRepo ignores the repos filter but keeps every other filter', () => {
    const res = listPrs(db, ctx, scope({ repos: ['app'], who: 'me' }), all, null);
    expect(res.items.map((p) => p.id)).toEqual(['alice/app#1']);
    expect(res.facets.byRepo).toEqual({ 'alice/app': 1, 'alice/secret': 1, 'alice/old': 1, 'alice/hidden': 1 });
    expect(listPrs(db, ctx, scope({ visibility: 'private' }), all, null).facets.byRepo).toEqual({ 'alice/secret': 1 });
  });

  it('searches with FTS (prefix on the last word) and falls back to LIKE without searchable words', () => {
    expect(prIds(scope({ q: 'logi' }))).toEqual(['alice/app#1']);
    expect(prIds(scope({ q: 'sso users' }))).toEqual(['alice/app#1']);
    expect(prIds(scope({ q: 'parser' }))).toEqual(['alice/app#2']);
    expect(prIds(scope({ q: '##' }))).toEqual(['alice/app#1']);
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
    const tie = listPrs(db, ctx, scope({ repos: ['app', 'secret'] }), all, { limit: 1, after: ['2026-09-24T02:00:00Z', 'alice/app', 0] });
    expect(tie.items[0]!.id).toBe('alice/secret#1');
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

describe('repo keys', () => {
  it('name repos by key; a bare name selects the owned repo, never a namesake added by hand', () => {
    const d = seedDb();
    const bob = addManualRepo(d, 'bob/app');
    d.run(`INSERT INTO pull_requests (repo_id, number, title, state, created_at, updated_at, activity_at, url)
      VALUES (?, 7, 'Namesake', 'open', '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z', 'u')`, [bob]);
    const c = loadQueryCtx(d);
    const ids = (repos: string[] | null) => listPrs(d, c, scope({ repos }), all, null).items.map((p) => p.id);
    expect(ids(['app'])).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(ids(['alice/app'])).toEqual(ids(['app']));
    expect(ids(['ALICE/App'])).toEqual(ids(['app']));
    expect(ids(['bob/app'])).toEqual(['bob/app#7']);
    expect(ids(['app', 'bob/app'])).toEqual(['bob/app#7', 'alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(ids(null)).toContain('bob/app#7');
    expect(listPrs(d, c, scope(), all, null).facets.byRepo).toMatchObject({ 'alice/app': 3, 'bob/app': 1 });
    expect(getPrDetail(d, c, 'bob/app', 7)).toMatchObject({ id: 'bob/app#7', repo: 'bob/app' });

    // ownership: mine = repos you own, others = repos added by hand; like visibility, it narrows facets too.
    const own = (ownership: Scope['ownership'], repos: string[] | null = null) => listPrs(d, c, scope({ repos, ownership }), all, null);
    expect(own('mine').items.map((p) => p.id)).not.toContain('bob/app#7');
    expect(own('others').items.map((p) => p.id)).toEqual(['bob/app#7']);
    expect(own('others').facets.byRepo).toEqual({ 'bob/app': 1 });
    expect(own('mine', ['app', 'bob/app']).items.map((p) => p.id)).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(own('all').total).toBe(own('mine').total + own('others').total);
  });
});

describe('PR comment threads', () => {
  const own = seedDb();
  const you = getPrincipal(own, SELF_PRINCIPAL_ID)!;
  const repoId = (name: string) => own.get<{ id: number }>('SELECT id FROM repos WHERE name = ?', [name])!.id;
  const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };
  const open = (repo: string, target: { kind: 'pr'; number: number } | { kind: 'commit'; oid: string }) =>
    createThread(own, { repoId: repoId(repo), ...target }, { commitOid: 'a'.repeat(40), baseOid: null, anchor: general, body: 'x' }, you);
  open('app', { kind: 'pr', number: 2 });
  setThreadStatus(own, open('app', { kind: 'pr', number: 2 }).id, 'resolved', you);
  setThreadStatus(own, open('app', { kind: 'pr', number: 3 }).id, 'resolved', you);
  // Neither the same number in another repo nor a commit thread counts.
  open('secret', { kind: 'pr', number: 2 });
  open('app', { kind: 'commit', oid: 'a'.repeat(40) });
  const ownCtx = loadQueryCtx(own);

  it('counts them on list items and the detail', () => {
    const counts = Object.fromEntries(listPrs(own, ownCtx, scope(), all, null).items.map((p) => [p.id, p.comments]));
    expect(counts).toEqual({
      'alice/secret#1': { threads: 0, unresolved: 0 },
      'alice/app#3': { threads: 1, unresolved: 0 },
      'alice/app#2': { threads: 2, unresolved: 1 },
      'alice/app#1': { threads: 0, unresolved: 0 },
    });
    expect(getPrDetail(own, ownCtx, 'alice/app', 2)!.comments).toEqual({ threads: 2, unresolved: 1 });
    // Activity events carry the same counts.
    const events = listActivity(own, ownCtx, scope(), ['pr'], null).items;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      if (e.type === 'pr') expect([e.pr.id, e.pr.comments]).toEqual([e.pr.id, counts[e.pr.id]]);
    }
  });

  it('filters to PRs with threads, or unresolved ones, in items, totals and facets', () => {
    const any = listPrs(own, ownCtx, scope({ repos: ['app'] }), { ...all, comments: 'any' }, null);
    expect(any.items.map((p) => p.id)).toEqual(['alice/app#3', 'alice/app#2']);
    expect(any.total).toBe(2);
    expect(any.facets.byRepo).toEqual({ 'alice/app': 2 });
    const unresolved = listPrs(own, ownCtx, scope(), { ...all, comments: 'unresolved' }, null);
    expect(unresolved.items.map((p) => p.id)).toEqual(['alice/app#2']);
  });
});

describe('commit comment threads, and counts on activity events', () => {
  const own = seedDb();
  const you = getPrincipal(own, SELF_PRINCIPAL_ID)!;
  const repoId = (name: string) => own.get<{ id: number }>('SELECT id FROM repos WHERE name = ?', [name])!.id;
  const oid = (short: string) => short.padEnd(40, '0');
  const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };
  const open = (repo: string, target: { kind: 'pr'; number: number } | { kind: 'commit'; oid: string }, commitOid: string) =>
    createThread(own, { repoId: repoId(repo), ...target }, { commitOid, baseOid: null, anchor: general, body: 'x' }, you);
  // c3: two commit threads, one resolved; c2: one open; c1 (landed via PR #1) and c4 (in secret): see below.
  open('app', { kind: 'commit', oid: oid('c3') }, oid('c3'));
  setThreadStatus(own, open('app', { kind: 'commit', oid: oid('c3') }, oid('c3')).id, 'resolved', you);
  open('app', { kind: 'commit', oid: oid('c2') }, oid('c2'));
  // Not commit c3's: a PR's thread made on the revision c3, a thread on the same oid in another repo, and one on an
  // oid that is no commit here.
  open('app', { kind: 'pr', number: 2 }, oid('c3'));
  open('secret', { kind: 'commit', oid: oid('c3') }, oid('c3'));
  open('app', { kind: 'commit', oid: oid('f0') }, oid('f0'));
  // c4 exists in secret only: app's thread on that oid isn't counted there.
  open('secret', { kind: 'commit', oid: oid('c4') }, oid('c4'));
  open('app', { kind: 'commit', oid: oid('c4') }, oid('c4'));
  setThreadStatus(own, open('app', { kind: 'pr', number: 3 }, oid('c3')).id, 'resolved', you);
  const ownCtx = loadQueryCtx(own);
  const wide = scope({ repos: ['app', 'secret'] });

  it('counts commit threads on the commits list', () => {
    const counts = Object.fromEntries(listCommits(own, ownCtx, wide, null).items.map((c) => [`${c.repo}@${c.oid.slice(0, 2)}`, c.comments]));
    expect(counts).toEqual({
      'alice/app@c3': { threads: 2, unresolved: 1 },
      'alice/app@c2': { threads: 1, unresolved: 1 },
      'alice/app@c1': { threads: 0, unresolved: 0 },
      'alice/secret@c4': { threads: 1, unresolved: 1 },
    });
  });

  it('puts the same counts on the PRs and commits of activity events, zero when none', () => {
    const events = listActivity(own, ownCtx, wide, null, null).items;
    const prs = Object.fromEntries(listPrs(own, ownCtx, wide, all, null).items.map((p) => [p.id, p.comments]));
    const commits = Object.fromEntries(listCommits(own, ownCtx, wide, null).items.map((c) => [c.oid, c.comments]));
    const seen = { pr: 0, commit: 0 };
    for (const e of events) {
      if (e.type === 'pr') {
        seen.pr++;
        expect([e.pr.id, e.pr.comments]).toEqual([e.pr.id, prs[e.pr.id]]);
      } else if (e.type === 'commit') {
        seen.commit++;
        expect([e.commit.oid, e.commit.comments]).toEqual([e.commit.oid, commits[e.commit.oid]]);
      } else {
        expect(JSON.stringify(e)).not.toContain('"comments"');
      }
    }
    // Direct pushes c2 and c3 (c1 and c4 landed via PRs), and the PR events, some with threads and some without.
    expect(seen.commit).toBe(2);
    expect(seen.pr).toBeGreaterThan(2);
    expect(events.filter((e) => e.type === 'commit').map((e) => e.type === 'commit' && e.commit.comments)).toEqual([
      { threads: 2, unresolved: 1 },
      { threads: 1, unresolved: 1 },
    ]);
    expect(events.filter((e) => e.type === 'pr').map((e) => e.type === 'pr' && [e.pr.id, e.pr.comments.threads])).toContainEqual(['alice/app#2', 1]);
    // A page of events counts its own rows only, whatever precedes it.
    const page = listActivity(own, ownCtx, wide, ['commit'], { limit: 1, after: null });
    expect(page.items.map((e) => e.type === 'commit' && e.commit.comments.threads)).toEqual([2]);
    const next = listActivity(own, ownCtx, wide, ['commit'], { limit: 1, after: page.nextCursor });
    expect(next.items.map((e) => e.type === 'commit' && e.commit.comments.threads)).toEqual([1]);
  });

  it('counts each PR event\'s PR once per event: opened and merged carry the same numbers', () => {
    const events = listActivity(own, ownCtx, scope({ repos: ['app'] }), ['pr'], null).items.filter((e) => e.type === 'pr' && e.pr.number === 1);
    expect(events.length).toBeGreaterThan(1);
    expect(new Set(events.map((e) => e.type === 'pr' && JSON.stringify(e.pr.comments))).size).toBe(1);
  });

  it('does not change what the exports say', () => {
    const events = listActivity(own, ownCtx, wide, null, null).items;
    const stripped = JSON.parse(JSON.stringify(events, (k, v) => (k === 'comments' ? undefined : v))) as typeof events;
    const md = { tz: 'UTC', now: Date.parse('2026-09-28T00:00:00Z'), from: wide.from, to: wide.to };
    expect(eventsMarkdown('Activity', events, md)).toBe(eventsMarkdown('Activity', stripped, md));
    expect(activityCsv(events, () => 'github')).toBe(activityCsv(stripped, () => 'github'));
    expect(activityCsv(events, () => 'github')).toContain('alice/app');
    const commits = listCommits(own, ownCtx, wide, null).items;
    expect(commitsCsv(commits)).not.toContain('threads');
    const prs = listPrs(own, ownCtx, wide, all, null).items;
    expect(prsCsv(prs)).not.toContain('unresolved');
    expect(prsMarkdown(prs, { state: 'all', who: 'everyone', group: 'repo' }, md)).not.toContain('unresolved');
  });

  it('finds commit threads through the target index, for the page\'s rows and for the commits list', () => {
    const plan = (where: string) =>
      own
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT ${COMMIT_SELECT} FROM commits c JOIN repos r ON r.id = c.repo_id WHERE ${where}`, ['[1,2,3]'])
        .map((r) => r.detail);
    for (const detail of [plan('c.id IN (SELECT value FROM json_each(?))'), plan("r.removed_at IS NULL AND c.id IN (SELECT value FROM json_each(?)) ORDER BY c.committed_at DESC")]) {
      const searches = detail.filter((d) => d.includes('comment_threads_target'));
      // Both counts (all, and open) search the index on the whole key; neither scans the threads table.
      expect(searches).toHaveLength(2);
      for (const d of searches) expect(d).toMatch(/^SEARCH t USING (COVERING )?INDEX comment_threads_target \(repo_id=\? AND pr_number=\? AND commit_oid=\?\)$/);
      expect(detail.some((d) => d.startsWith('SCAN t'))).toBe(false);
    }
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
    expect(res.items.map((i) => i.id)).toEqual(['alice/app#11', 'alice/app#10']);
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
      'star:alice/app', // erin 09-27
      'issue:opened:alice/app', // #11 09-26
      'commit:alice/app', // c3 09-25
      'star:alice/app', // dave 09-25
      'release:alice/app', // 09-23 15:00
      'pr:closed:alice/app', // #3 09-23 08:00
      'commit:alice/app', // c2 09-22 23:30
      'issue:closed:alice/app', // #10 09-22 12:00
      'pr:opened:alice/app', // #2 09-22 09:00
      'pr:merged:alice/app', // #1 09-21
      'pr:opened:alice/app', // #1 09-20 10:00
      'star:alice/app', // carol 09-20 00:00
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
    expect(res.facets.byRepo).toEqual({ 'alice/app': 5, 'alice/secret': 2, 'alice/old': 2, 'alice/fork': 2, 'alice/hidden': 2 });
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
