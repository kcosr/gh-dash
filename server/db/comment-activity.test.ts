import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEvent, Principal, ThreadAnchor } from '../../shared/api';
import { activityCsv } from '../format/csv';
import { eventsMarkdown } from '../format/markdown';
import { seedDb, seedGitLab } from '../test/seed';
import { createAgent } from './agents';
import { addComment, createThread, deleteComment, deleteThread, getPrincipal, SELF_PRINCIPAL_ID, setThreadStatus, type ThreadTarget } from './comments';
import type { Db } from './db';
import { loadQueryCtx, type Scope } from './filters';
import { listActivity } from './lists';
import { computeStats } from './stats';

const HEAD = 'a'.repeat(40);
const C3 = 'c3'.padEnd(40, '0');
const UNSYNCED = 'f'.repeat(40);
const general: ThreadAnchor = { path: null, side: null, startLine: null, endLine: null, snippet: null };
const at = (day: number, rest = '10:00:00.000') => `2026-09-${String(day).padStart(2, '0')}T${rest}Z`;

let db: Db;
let me: Principal;
let claude: Principal;
let app: number;

const scope = (over: Partial<Scope> = {}): Scope => ({
  repos: null, visibility: 'all', ownership: 'all', who: 'everyone',
  from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-10-01T00:00:00Z'), tz: 'UTC', q: null, ...over,
});
const comments = (s: Scope = scope()) => listActivity(db, loadQueryCtx(db), s, ['comment'], null);
const brief = (e: ActivityEvent) => (e.type === 'comment' ? `${e.actor.name} ${e.kind} ${e.comment.threadId}` : e.type);

function open(target: ThreadTarget, body: string, author: Principal, when: string, anchor: ThreadAnchor = general) {
  return createThread(db, target, { commitOid: target.kind === 'commit' ? target.oid : HEAD, baseOid: null, anchor, body }, author, when);
}

beforeEach(() => {
  db = seedDb();
  me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
  const agent = createAgent(db, 'Claude').agent;
  claude = { id: agent.id, kind: 'agent', name: agent.name };
  app = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
});

describe('comment events in the activity feed', () => {
  it('lists them newest first with the actor, what they are on and where, and whether the thread is still there', () => {
    const line = { path: 'src/a.ts', side: 'new' as const, startLine: 3, endLine: 4, snippet: 'a\nb' };
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why **two**?', me, at(20), line);
    addComment(db, t.id, claude, 'Because.', at(21));
    setThreadStatus(db, t.id, 'resolved', claude, at(22));
    const c = open({ repoId: app, kind: 'commit', oid: C3 }, 'Nit', claude, at(23));
    deleteThread(db, c.id, me, at(24));

    const { items, total, facets } = comments();
    expect(items.map(brief)).toEqual([`You thread_deleted ${c.id}`, `Claude thread_opened ${c.id}`, `Claude resolved ${t.id}`, `Claude replied ${t.id}`, `You thread_opened ${t.id}`]);
    expect(total).toBe(5);
    expect(facets.byType).toMatchObject({ comment: 5 });
    expect(items[4]).toEqual({
      type: 'comment', kind: 'thread_opened', at: at(20), repo: 'alice/app',
      actor: { login: null, name: 'You', avatarUrl: null, isMe: true },
      comment: {
        eventId: expect.any(Number), threadId: t.id, commentId: t.comments[0]!.id, live: true, by: me, target: { kind: 'pr', number: 2, title: 'Add parser' }, commitOid: HEAD,
        path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, excerpt: 'Why two?', view: { kind: 'pr', number: 2 },
      },
    });
    expect(items[2]).toMatchObject({ actor: { name: 'Claude', isMe: false }, comment: { by: claude, excerpt: 'Why two?' } });
    // The commit thread is gone; its events still say what it was on.
    // What was said went with it.
    expect(items[0]).toMatchObject({ comment: { live: false, target: { kind: 'commit', oid: C3, title: 'Refactor parser module' }, path: null, excerpt: null } });
    expect(items[1]).toMatchObject({ comment: { live: false, excerpt: null } });
    // The comment each is about: the reply's own, none for a status change or a deleted thread.
    const reply = db.get<{ id: number }>('SELECT id FROM comments WHERE thread_id = ? ORDER BY id DESC LIMIT 1', [t.id])!.id;
    expect(items.map((e) => e.type === 'comment' && e.comment.commentId)).toEqual([null, c.comments[0]!.id, null, reply, t.comments[0]!.id]);
  });

  it("titles a commit the sync doesn't hold from a synced PR that lists it, else leaves it null", () => {
    const pc = 'd'.repeat(40);
    db.run('UPDATE pr_commits SET oid = ? WHERE oid = ?', [pc, 'p1']);
    open({ repoId: app, kind: 'commit', oid: pc }, 'On a PR commit', me, at(20));
    open({ repoId: app, kind: 'commit', oid: UNSYNCED }, 'On nothing known', me, at(21));
    // A PR thread never takes a commit's headline, and an unsynced PR has no title.
    open({ repoId: app, kind: 'pr', number: 99 }, 'On a dropped PR', me, at(22));
    expect(comments().items.map((e) => e.type === 'comment' && e.comment.target)).toEqual([
      { kind: 'pr', number: 99, title: null },
      { kind: 'commit', oid: UNSYNCED, title: null },
      { kind: 'commit', oid: pc, title: 'fix login' },
    ]);
  });

  it('counts the dashboard user as me and every agent as others', () => {
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', me, at(20));
    addComment(db, t.id, claude, 'Because.', at(21));
    expect(comments(scope({ who: 'me' })).items.map(brief)).toEqual([`You thread_opened ${t.id}`]);
    expect(comments(scope({ who: 'others' })).items.map(brief)).toEqual([`Claude replied ${t.id}`]);
  });

  it('matches q against the words and the file, as a plain substring', () => {
    open({ repoId: app, kind: 'pr', number: 2 }, 'Retry the 50% case', me, at(20), { path: 'src/net/retry.ts', side: 'new', startLine: 1, endLine: 1, snippet: 'x' });
    open({ repoId: app, kind: 'pr', number: 2 }, 'Typo here', me, at(21), { ...general, path: 'README.md' });
    const q = (text: string) => comments(scope({ q: text })).items.map((e) => e.type === 'comment' && e.comment.excerpt);
    expect(q('retry')).toEqual(['Retry the 50% case']);
    expect(q('readme')).toEqual(['Typo here']);
    expect(q('50%')).toEqual(['Retry the 50% case']);
    expect(q('0% c')).toEqual(['Retry the 50% case']);
    expect(q('%')).toEqual(['Retry the 50% case']);
    // Not the PR's title (other event types have their own words).
    expect(q('parser')).toEqual([]);
  });

  it('keeps an event in its own second at the bounds of the range, milliseconds and all', () => {
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'At midnight', me, '2026-09-20T00:00:00.500Z');
    addComment(db, t.id, me, 'Just before', '2026-09-19T23:59:59.900Z');
    const day20 = scope({ from: Date.parse('2026-09-20T00:00:00Z'), to: Date.parse('2026-09-21T00:00:00Z') });
    const day19 = scope({ from: Date.parse('2026-09-19T00:00:00Z'), to: Date.parse('2026-09-20T00:00:00Z') });
    expect(comments(day20).items.map(brief)).toEqual([`You thread_opened ${t.id}`]);
    expect(comments(day19).items.map(brief)).toEqual([`You replied ${t.id}`]);
    expect(comments(day20).facets.byDay).toEqual({ '2026-09-20': 1 });
  });

  it('follows the repo scope: explicit repos, the default selection, sources, and removed repos', () => {
    const secret = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/secret'")!.id;
    const hidden = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/hidden'")!.id;
    const { repoId: gitlab } = seedGitLab(db);
    open({ repoId: app, kind: 'pr', number: 2 }, 'app', me, at(20));
    open({ repoId: secret, kind: 'pr', number: 1 }, 'secret', me, at(21));
    open({ repoId: hidden, kind: 'pr', number: 1 }, 'hidden', me, at(22));
    open({ repoId: gitlab, kind: 'pr', number: 1 }, 'gitlab', me, at(23));
    const repos = (s: Scope) => comments(s).items.map((e) => e.repo);
    expect(repos(scope())).toEqual(['gitlab.example.com/platform/app', 'alice/secret', 'alice/app']);
    expect(repos(scope({ repos: ['alice/hidden', 'app'] }))).toEqual(['alice/hidden', 'alice/app']);
    expect(repos(scope({ source: ['gitlab.example.com'] }))).toEqual(['gitlab.example.com/platform/app']);
    expect(repos(scope({ visibility: 'private' }))).toEqual(['alice/secret']);
    // byRepo ignores the selection (the default one too), as for every other type.
    expect(comments(scope({ repos: ['app'] })).facets.byRepo).toEqual({ 'alice/app': 1, 'alice/secret': 1, 'alice/hidden': 1, 'gitlab.example.com/platform/app': 1 });
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE id = ?", [secret]);
    expect(repos(scope())).toEqual(['gitlab.example.com/platform/app', 'alice/app']);
  });

  it('joins the other event types in one feed, pages with the cursor, and is left out by types', () => {
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', me, at(22, '09:30:00.000'));
    for (let i = 0; i < 3; i++) addComment(db, t.id, claude, `Reply ${i}`, at(22, '09:30:00.000'));
    const ctx = loadQueryCtx(db);
    const s = scope({ repos: ['app'], from: Date.parse('2026-09-22T00:00:00Z'), to: Date.parse('2026-09-23T00:00:00Z') });
    const everything = listActivity(db, ctx, s, null, null).items;
    expect(everything.map((e) => (e.type === 'comment' ? `${e.kind}` : `${e.type}`))).toEqual([
      'commit', 'issue', 'thread_opened', 'replied', 'replied', 'replied', 'pr',
    ]);
    const pages: string[] = [];
    let after = null;
    do {
      const page = listActivity(db, ctx, s, null, { limit: 2, after });
      pages.push(...page.items.map((e) => (e.type === 'comment' ? `${e.kind}:${e.comment.eventId}` : e.type)));
      after = page.nextCursor;
    } while (after);
    expect(pages).toEqual(everything.map((e) => (e.type === 'comment' ? `${e.kind}:${e.comment.eventId}` : e.type)));
    expect(listActivity(db, ctx, s, ['pr', 'commit', 'issue'], null).items.some((e) => e.type === 'comment')).toBe(false);
    expect(listActivity(db, ctx, s, ['pr'], null).facets.byType).toEqual({ commit: 1, issue: 1, pr: 1, comment: 4 });
  });

  it('reads as a line in the Markdown and CSV exports', () => {
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why **two**?', me, at(20), { path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, snippet: 'a\nb' });
    setThreadStatus(db, t.id, 'resolved', claude, at(21));
    open({ repoId: app, kind: 'commit', oid: C3 }, '=cmd', claude, at(22), { ...general, path: 'README.md' });
    const events = comments().items;
    const md = eventsMarkdown('Activity', events, { tz: 'UTC', now: Date.parse(at(29)), from: Date.parse(at(1)), to: Date.parse(at(29)) });
    expect(md).toContain('- 10:00 · **You** opened a thread on alice/app#2 (Add parser), src/a.ts:3–4: Why two?');
    expect(md).toContain('- 10:00 · **Claude** resolved a thread on alice/app#2 (Add parser), src/a.ts:3–4: Why two?');
    expect(md).toContain('- 10:00 · **Claude** opened a thread on alice/app@c300000 (Refactor parser module), README.md: =cmd');
    const csv = activityCsv(events).split('\r\n');
    expect(csv).toContain(`${at(20)},comment,thread_opened,alice/app,You,Why two?,#2,`);
    expect(csv).toContain(`${at(21)},comment,resolved,alice/app,Claude,Why two?,#2,`);
    // A formula-looking comment is kept from being evaluated, as every other title is.
    expect(csv).toContain(`${at(22)},comment,thread_opened,alice/app,Claude,'=cmd,c300000,`);
  });

  it('reads sensibly in the exports once the words are gone', () => {
    const line = { path: 'src/a.ts', side: 'new' as const, startLine: 3, endLine: 3, snippet: 'a' };
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', me, at(20), line);
    const reply = addComment(db, t.id, claude, 'Secret', at(21))!.comments[1]!;
    deleteComment(db, reply.id, claude, at(22));
    const gone = open({ repoId: app, kind: 'commit', oid: C3 }, 'Also secret', claude, at(23));
    deleteThread(db, gone.id, me, at(24));
    const events = comments().items;
    const md = eventsMarkdown('Activity', events, { tz: 'UTC', now: Date.parse(at(29)), from: Date.parse(at(1)), to: Date.parse(at(29)) });
    expect(md).not.toContain('ecret');
    expect(md).toContain('- 10:00 · **Claude** deleted a comment on alice/app#2 (Add parser), src/a.ts:3\n');
    expect(md).toContain('- 10:00 · **Claude** replied to a thread on alice/app#2 (Add parser), src/a.ts:3\n');
    expect(md).toContain('- 10:00 · **You** deleted a thread on alice/app@c300000 (Refactor parser module)\n');
    expect(md).toContain('- 10:00 · **You** opened a thread on alice/app#2 (Add parser), src/a.ts:3: Why?\n');
    const csv = activityCsv(events);
    expect(csv).not.toContain('ecret');
    expect(csv.split('\r\n')).toContain(`${at(22)},comment,comment_deleted,alice/app,Claude,,#2,`);
  });

  it("names a branch thread's events by the branch, with no title, in the feed and its exports", () => {
    const line = { path: 'src/a.ts', side: 'new' as const, startLine: 3, endLine: 4, snippet: 'a\nb' };
    // Made on the synced commit C3: the branch's thread doesn't take the commit's headline.
    const t = createThread(db, { repoId: app, kind: 'branch', branch: 'fix/login' }, { commitOid: C3, baseOid: null, anchor: line, body: 'Why **two**?' }, me, at(20));
    setThreadStatus(db, t.id, 'resolved', claude, at(21));
    const gone = createThread(db, { repoId: app, kind: 'branch', branch: 'fix/a]b' }, { commitOid: C3, baseOid: null, anchor: general, body: 'Gone' }, claude, at(22));
    deleteThread(db, gone.id, me, at(23));
    const events = comments().items;
    expect(events.map((e) => e.type === 'comment' && [e.kind, e.comment.target, e.comment.live])).toEqual([
      ['thread_deleted', { kind: 'branch', branch: 'fix/a]b', title: null }, false],
      ['thread_opened', { kind: 'branch', branch: 'fix/a]b', title: null }, false],
      ['resolved', { kind: 'branch', branch: 'fix/login', title: null }, true],
      ['thread_opened', { kind: 'branch', branch: 'fix/login', title: null }, true],
    ]);
    expect(events[3]).toMatchObject({ comment: { commitOid: C3, path: 'src/a.ts', startLine: 3, endLine: 4, excerpt: 'Why two?' } });
    const md = eventsMarkdown('Activity', events, { tz: 'UTC', now: Date.parse(at(29)), from: Date.parse(at(1)), to: Date.parse(at(29)) });
    expect(md).toContain('- 10:00 · **You** opened a thread on alice/app branch fix/login, src/a.ts:3–4: Why two?\n');
    expect(md).toContain('- 10:00 · **Claude** resolved a thread on alice/app branch fix/login, src/a.ts:3–4: Why two?\n');
    expect(md).toContain('- 10:00 · **You** deleted a thread on alice/app branch fix/a\\]b\n');
    const csv = activityCsv(events).split('\r\n');
    expect(csv).toContain(`${at(20)},comment,thread_opened,alice/app,You,Why two?,fix/login,`);
    expect(csv).toContain(`${at(23)},comment,thread_deleted,alice/app,You,,fix/a]b,`);
    // Each opens where its thread is shown now: the branch's review, nowhere once deleted, and the merged PR once a merge
    // of the branch ends the line of work it is in (the events still say what it was made on).
    expect(events.map((e) => e.type === 'comment' && e.comment.view)).toEqual([null, null, { kind: 'branch', branch: 'fix/login' }, { kind: 'branch', branch: 'fix/login' }]);
    db.run("UPDATE pull_requests SET head_ref = 'fix/login', cross_repo = 0, state = 'merged', merged_at = ? WHERE repo_id = ? AND number = 2", [at(25), app]);
    expect(comments().items.map((e) => e.type === 'comment' && [e.comment.target.kind, e.comment.view])).toEqual([
      ['branch', null], ['branch', null], ['branch', { kind: 'pr', number: 2 }], ['branch', { kind: 'pr', number: 2 }],
    ]);
  });

  it('leaves the insights (stats) as they were', () => {
    const ctx = loadQueryCtx(db);
    const before = computeStats(db, ctx, scope());
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', me, at(20));
    addComment(db, t.id, claude, 'Because.', at(21));
    expect(computeStats(db, ctx, scope())).toEqual(before);
  });
});
