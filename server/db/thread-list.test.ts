import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ThreadAnchor } from '../../shared/api';
import { addManualRepo, GITLAB_HOST, seedDb, seedGitLab } from '../test/seed';
import { createThread, addComment, getPrincipal, getThread, SELF_PRINCIPAL_ID, setThreadStatus, type ThreadTarget } from './comments';
import type { Db } from './db';
import { loadQueryCtx, type QueryCtx, type Scope } from './filters';
import type { Page } from './lists';
import { listThreadItems, type ThreadFilter, type ThreadListResult } from './thread-list';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const C1 = 'c1'.padEnd(40, '0'); // the seed's synced commit "Merge pull request #1"
const C3 = 'c3'.padEnd(40, '0');
const C4 = 'c4'.padEnd(40, '0'); // synced in alice/secret only
const UNSYNCED = 'd'.repeat(40);

const general: ThreadAnchor = { path: null, side: null, startLine: null, endLine: null, snippet: null };
const file = (path: string): ThreadAnchor => ({ ...general, path });
const lines: ThreadAnchor = { path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, snippet: 'a\nb' };

/** Minutes past 10:00 on the seed's last day, in the stored format. */
const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, '0')}:00.000Z`;

let db: Db;
let ctx: QueryCtx;
let me: Principal;
let agent: Principal;

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
const repoId = (key: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', [key])!.id;
const pr = (key: string, number: number): ThreadTarget => ({ repoId: repoId(key), kind: 'pr', number });
const commit = (key: string, oid: string): ThreadTarget => ({ repoId: repoId(key), kind: 'commit', oid });
const add = (target: ThreadTarget, body = 'Why?', minute = 0, anchor: ThreadAnchor = general, author = me) =>
  createThread(db, target, { commitOid: target.kind === 'commit' ? target.oid : HEAD, baseOid: BASE, anchor, body }, author, at(minute));

const FILTER: ThreadFilter = { status: 'open', kind: 'all', sort: 'recent' };
const list = (f: Partial<ThreadFilter> = {}, s: Partial<Scope> = {}, page: Page = null): ThreadListResult =>
  listThreadItems(db, ctx, scope(s), { ...FILTER, ...f }, page);
const ids = (r: ThreadListResult) => r.items.map((t) => t.id);
const bodies = (r: ThreadListResult) => r.items.map((t) => t.comments[0]!.body);

beforeEach(() => {
  db = seedDb();
  ctx = loadQueryCtx(db);
  me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
  agent = getPrincipal(db, db.run("INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'Reviewer', ?)", [at(0)]).lastInsertRowid)!;
});

describe('thread list', () => {
  it('lists the threads of PRs and commits, newest activity first, each as the per-target endpoints give it', () => {
    const a = add(pr('alice/app', 2), 'First', 1, lines);
    const b = add(commit('alice/app', C1), 'Second', 3);
    const c = add(pr('alice/secret', 1), 'Third', 2, file('README.md'), agent);
    addComment(db, a.id, agent, 'A reply', at(5));
    const res = list();
    expect(ids(res)).toEqual([a.id, b.id, c.id]);
    expect(res).toMatchObject({ nextCursor: null, total: 3 });
    for (const item of res.items) {
      const { targetTitle, prState, targetUrl, earlierPush, ...thread } = item;
      expect(thread).toEqual(getThread(db, item.id));
    }
    // Comments come with their authors, oldest first.
    expect(res.items[0]!.comments.map((m) => [m.author.name, m.body])).toEqual([['You', 'First'], ['Reviewer', 'A reply']]);
    expect(res.items[2]!.comments[0]!.author).toEqual(agent);
  });

  it('is empty with no threads', () => {
    expect(list()).toEqual({ items: [], nextCursor: null, total: 0, counts: { open: 0, resolved: 0 } });
  });
});

describe('thread list scope', () => {
  beforeEach(() => {
    add(pr('alice/app', 2), 'app', 1);
    add(pr('alice/secret', 1), 'secret', 2);
    add(pr('alice/old', 1), 'old', 3);
    add(pr('alice/fork', 1), 'fork', 4);
    add(pr('alice/hidden', 1), 'hidden', 5);
  });

  it('applies the default selection: no archived, forked or hidden repos, as /prs does', () => {
    expect(bodies(list())).toEqual(['secret', 'app']);
    expect(bodies(list({}, { repos: null }, null))).toEqual(['secret', 'app']);
    expect(list().counts).toEqual({ open: 2, resolved: 0 });
  });

  it('includes forks when settings.includeForks is on', () => {
    expect(bodies(listThreadItems(db, { ...ctx, includeForks: true }, scope(), FILTER, null))).toEqual(['fork', 'secret', 'app']);
  });

  it('takes explicit repos as they are, and an empty list as none', () => {
    expect(bodies(list({}, { repos: ['old', 'hidden'] }))).toEqual(['hidden', 'old']);
    expect(bodies(list({}, { repos: ['alice/app', 'nope/none'] }))).toEqual(['app']);
    expect(list({}, { repos: [] })).toMatchObject({ items: [], total: 0, counts: { open: 0, resolved: 0 } });
  });

  it('filters by visibility, ownership and source', () => {
    const manual = addManualRepo(db, 'bob/lib');
    db.run('UPDATE repos SET visibility = ? WHERE id = ?', ['private', manual]);
    add({ repoId: manual, kind: 'pr', number: 7 }, 'manual', 6);
    expect(bodies(list({}, { visibility: 'private' }))).toEqual(['manual', 'secret']);
    expect(bodies(list({}, { visibility: 'public' }))).toEqual(['app']);
    expect(bodies(list({}, { ownership: 'mine' }))).toEqual(['secret', 'app']);
    expect(bodies(list({}, { ownership: 'others' }))).toEqual(['manual']);
    expect(bodies(list({}, { source: ['github.com'] }))).toEqual(['manual', 'secret', 'app']);
    expect(list({}, { source: [GITLAB_HOST] }).items).toEqual([]);
  });

  it('lists a GitLab repo\'s threads under its key, and filters them by source', () => {
    const { repoId: gl } = seedGitLab(db);
    const t = add({ repoId: gl, kind: 'pr', number: 2 }, 'mr', 7, lines);
    const res = list({}, { source: [GITLAB_HOST] });
    expect(res.items).toMatchObject([{ id: t.id, kind: 'pr', repo: `${GITLAB_HOST}/platform/app`, number: 2, targetTitle: 'Rework config', prState: 'open' }]);
    expect(list({}, { source: ['github.com'] }).items.map((i) => i.id)).not.toContain(t.id);
    expect(list({}, { source: ['github.com', GITLAB_HOST] }).total).toBe(3);
    // A GitHub repo with the same path and number keeps its own threads.
    expect(list({}, { repos: ['alice/app'] }).items.map((i) => i.number)).toEqual([2]);
  });

  it('hides the threads of a removed repo (and does not count them) until the repo is back', () => {
    const appId = repoId('alice/app');
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE id = ?", [appId]);
    expect(bodies(list())).toEqual(['secret']);
    expect(list({ status: 'all' }, { repos: ['alice/app'] })).toMatchObject({ items: [], total: 0, counts: { open: 0, resolved: 0 } });
    db.run('UPDATE repos SET removed_at = NULL WHERE id = ?', [appId]);
    expect(bodies(list())).toEqual(['secret', 'app']);
  });

  it('is not limited by who or the date range: old threads stay listed', () => {
    const t = add(pr('alice/app', 2), 'ancient', 9);
    db.run("UPDATE comment_threads SET created_at = '2020-01-01T00:00:00.000Z', updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [t.id]);
    expect(bodies(list({}, { who: 'others', from: Date.parse('2026-09-20T00:00:00Z') }))).toEqual(['secret', 'app', 'ancient']);
  });
});

describe('thread list filters', () => {
  beforeEach(() => {
    // A resolved and an open thread on each of a PR and a commit, at distinct times.
    for (const [i, target] of [pr('alice/app', 2), commit('alice/app', C1)].entries()) {
      const done = add(target, `done ${i}`, 1 + i * 2);
      setThreadStatus(db, done.id, 'resolved', at(2 + i * 2));
      add(target, `todo ${i}`, 10 + i);
    }
  });

  it('filters by status; total follows it and counts do not', () => {
    for (const [status, want] of [['open', ['todo 1', 'todo 0']], ['resolved', ['done 1', 'done 0']], ['all', ['todo 1', 'todo 0', 'done 1', 'done 0']]] as const) {
      const res = list({ status });
      expect([status, bodies(res)]).toEqual([status, want]);
      expect(res).toMatchObject({ total: want.length, counts: { open: 2, resolved: 2 } });
    }
  });

  it('filters by kind, and counts follow the kind', () => {
    expect(bodies(list({ kind: 'pr', status: 'all' }))).toEqual(['todo 0', 'done 0']);
    expect(bodies(list({ kind: 'commit', status: 'all' }))).toEqual(['todo 1', 'done 1']);
    expect(list({ kind: 'commit' })).toMatchObject({ total: 1, counts: { open: 1, resolved: 1 } });
  });

  it('counts every status the scope and text filters allow, whatever the status filter', () => {
    add(pr('alice/secret', 1), 'todo secret', 12);
    expect(list({}, { visibility: 'public' }).counts).toEqual({ open: 2, resolved: 2 });
    expect(list({ status: 'resolved' }, { visibility: 'private' })).toMatchObject({ total: 0, counts: { open: 1, resolved: 0 } });
    expect(list({ status: 'resolved' }, { q: 'done 0' })).toMatchObject({ total: 1, counts: { open: 0, resolved: 1 } });
  });

  it('a resolved thread that is reopened moves back, and its activity bumps its place', () => {
    const resolved = list({ status: 'resolved' }).items[0]!;
    setThreadStatus(db, resolved.id, 'open', at(30));
    expect(bodies(list())[0]).toBe(resolved.comments[0]!.body);
    expect(list().counts).toEqual({ open: 3, resolved: 1 });
  });
});

describe('thread list text search', () => {
  it('matches any comment of a thread, and its path, ignoring case', () => {
    const a = add(pr('alice/app', 2), 'Why two constants?', 1, lines);
    addComment(db, a.id, agent, 'Because of the MIGRATION.', at(2));
    add(pr('alice/app', 2), 'Looks fine', 3, file('docs/Guide.md'));
    add(pr('alice/app', 2), 'Nothing here', 4);
    expect(bodies(list({}, {}))).toHaveLength(3);
    expect(bodies(list({}, { q: 'migration' }))).toEqual(['Why two constants?']);
    expect(bodies(list({}, { q: 'WHY TWO' }))).toEqual(['Why two constants?']);
    expect(bodies(list({}, { q: 'src/a.ts' }))).toEqual(['Why two constants?']);
    expect(bodies(list({}, { q: 'guide' }))).toEqual(['Looks fine']);
    expect(bodies(list({}, { q: 'nope' }))).toEqual([]);
    expect(list({}, { q: 'constants' }).total).toBe(1);
  });

  it('takes %, _ and \\ literally', () => {
    add(pr('alice/app', 2), '100% done', 1);
    add(pr('alice/app', 2), 'a_b is a name', 2);
    add(pr('alice/app', 2), 'axb is not', 3);
    add(pr('alice/app', 2), String.raw`C:\temp is a path`, 4);
    add(pr('alice/app', 2), 'plain words', 5);
    add(pr('alice/app', 2), 'in a file', 6, file('dir/100%_x.ts'));
    expect(bodies(list({}, { q: '%' }))).toEqual(['in a file', '100% done']);
    expect(bodies(list({}, { q: '0% d' }))).toEqual(['100% done']);
    expect(bodies(list({}, { q: 'a_b' }))).toEqual(['a_b is a name']);
    expect(bodies(list({}, { q: '_' }))).toEqual(['in a file', 'a_b is a name']);
    expect(bodies(list({}, { q: String.raw`\t` }))).toEqual([String.raw`C:\temp is a path`]);
    expect(bodies(list({}, { q: '\\' }))).toEqual([String.raw`C:\temp is a path`]);
    expect(bodies(list({}, { q: '%_' }))).toEqual(['in a file']);
    expect(bodies(list({}, { q: "'; DROP TABLE comments; --" }))).toEqual([]);
  });
});

describe('thread list order and paging', () => {
  /** Five threads: updatedAt minutes 1, 2, 2, 2, 3 (three tied), ids ascending. */
  const seed = () => [1, 2, 2, 2, 3].map((minute, i) => add(pr('alice/app', 2), `t${i + 1}`, minute));

  /** The ids of each page, following the cursors; every page reports the same total and counts. */
  const walk = (f: Partial<ThreadFilter>, limit: number) => {
    const whole = list(f);
    const pages: number[][] = [];
    let after: Page = { limit, after: null };
    for (let guard = 0; after && guard < 20; guard++) {
      const res = list(f, {}, after);
      pages.push(ids(res));
      expect(res).toMatchObject({ total: whole.total, counts: whole.counts });
      after = res.nextCursor ? { limit, after: res.nextCursor } : null;
    }
    return pages;
  };

  it('orders by updatedAt, ties by id in the same direction: oldest is the exact reverse of recent', () => {
    const [t1, t2, t3, t4, t5] = seed().map((t) => t.id);
    expect(ids(list({ sort: 'recent' }))).toEqual([t5, t4, t3, t2, t1]);
    expect(ids(list({ sort: 'oldest' }))).toEqual([t1, t2, t3, t4, t5]);
  });

  it('pages through ties in both sorts without gaps or repeats', () => {
    const [t1, t2, t3, t4, t5] = seed().map((t) => t.id);
    expect(walk({ sort: 'recent' }, 2)).toEqual([[t5, t4], [t3, t2], [t1]]);
    expect(walk({ sort: 'oldest' }, 2)).toEqual([[t1, t2], [t3, t4], [t5]]);
    // A page boundary inside the tie, and one after it.
    expect(walk({ sort: 'recent' }, 3)).toEqual([[t5, t4, t3], [t2, t1]]);
    expect(walk({ sort: 'oldest' }, 4)).toEqual([[t1, t2, t3, t4], [t5]]);
    expect(walk({ sort: 'recent' }, 1).flat()).toEqual([t5, t4, t3, t2, t1]);
    expect(walk({ sort: 'oldest' }, 5)).toEqual([[t1, t2, t3, t4, t5]]);
  });

  it('gives the cursor of the last thread, the total and counts on every page, and no cursor on the last', () => {
    seed();
    const first = list({ sort: 'recent' }, {}, { limit: 2, after: null });
    expect(first).toMatchObject({ total: 5, counts: { open: 5, resolved: 0 }, nextCursor: [at(2), first.items[1]!.id] });
    expect(list({ sort: 'recent' }, {}, { limit: 2, after: first.nextCursor })).toMatchObject({ total: 5, counts: { open: 5, resolved: 0 } });
    expect(list({}, {}, { limit: 5, after: null }).nextCursor).toBeNull();
    expect(list({}, {}, null).items).toHaveLength(5);
  });

  it('pages within a status and a kind', () => {
    const ts = seed();
    setThreadStatus(db, ts[0]!.id, 'resolved', at(40));
    add(commit('alice/app', C1), 'c', 50);
    expect(walk({ sort: 'oldest', kind: 'pr' }, 3)).toEqual([[ts[1]!.id, ts[2]!.id, ts[3]!.id], [ts[4]!.id]]);
    expect(walk({ status: 'resolved' }, 3)).toEqual([[ts[0]!.id]]);
  });

  it('moves a thread to the front when it gets a reply', () => {
    const ts = seed();
    addComment(db, ts[0]!.id, me, 'again', at(9));
    expect(ids(list())[0]).toBe(ts[0]!.id);
    expect(ids(list({ sort: 'oldest' })).at(-1)).toBe(ts[0]!.id);
  });
});

describe('thread list targets', () => {
  it('names a synced PR thread\'s PR: title, state and url; earlierPush when the head has moved on', () => {
    // The seed's PR heads are 2222… for #2 and 1111… for app#1.
    const head2 = '2'.repeat(40);
    const stale = add(pr('alice/app', 2), 'made on aaaa', 1);
    const current = createThread(db, pr('alice/app', 2), { commitOid: head2, baseOid: BASE, anchor: general, body: 'made on the head' }, me, at(2));
    const merged = add(pr('alice/app', 1), 'merged one', 3);
    const byId = new Map(list({ status: 'all' }).items.map((i) => [i.id, i]));
    expect(byId.get(stale.id)).toMatchObject({ targetTitle: 'Add parser', prState: 'open', targetUrl: 'https://github.com/alice/x/pull/2', earlierPush: true });
    expect(byId.get(current.id)).toMatchObject({ targetTitle: 'Add parser', prState: 'open', earlierPush: false });
    expect(byId.get(merged.id)).toMatchObject({ targetTitle: 'Fix login flow', prState: 'merged', targetUrl: 'https://github.com/alice/x/pull/1', earlierPush: true });
  });

  it('follows the PR row: a new head makes older threads earlier pushes', () => {
    const t = createThread(db, pr('alice/app', 2), { commitOid: '2'.repeat(40), baseOid: BASE, anchor: general, body: 'on the head' }, me, at(1));
    expect(list().items[0]).toMatchObject({ id: t.id, earlierPush: false });
    db.run("UPDATE pull_requests SET head_oid = ? WHERE repo_id = ? AND number = 2", ['9'.repeat(40), repoId('alice/app')]);
    expect(list().items[0]).toMatchObject({ id: t.id, earlierPush: true });
    db.run('UPDATE pull_requests SET head_oid = NULL WHERE repo_id = ? AND number = 2', [repoId('alice/app')]);
    expect(list().items[0]).toMatchObject({ id: t.id, earlierPush: false, targetTitle: 'Add parser' });
  });

  it('lists a thread whose PR is not synced, with nothing known about it', () => {
    const t = add(pr('alice/app', 99), 'orphan', 1, lines);
    expect(list().items[0]).toMatchObject({ id: t.id, kind: 'pr', number: 99, targetTitle: null, prState: null, targetUrl: null, earlierPush: false });
    // The same number in another repo is another PR.
    const other = add(pr('alice/secret', 1), 'secret one', 2);
    expect(list().items.find((i) => i.id === other.id)).toMatchObject({ targetTitle: 'PR 1', prState: 'merged' });
  });

  it('names a synced commit\'s headline and url, and knows nothing of an unsynced one', () => {
    const synced = add(commit('alice/app', C1), 'on c1', 1);
    const unsynced = add(commit('alice/app', UNSYNCED), 'on unsynced', 2);
    // Synced in another repo only.
    const elsewhere = add(commit('alice/app', C4), 'on secret\'s c4', 3);
    const inSecret = add(commit('alice/secret', C4), 'on c4', 4);
    const res = list();
    expect(res.items.find((i) => i.id === synced.id)).toMatchObject({
      kind: 'commit', number: null, targetTitle: 'Merge pull request #1', prState: null, targetUrl: 'https://github.com/c/c1', earlierPush: false,
    });
    expect(res.items.find((i) => i.id === unsynced.id)).toMatchObject({ targetTitle: null, prState: null, targetUrl: null, earlierPush: false });
    expect(res.items.find((i) => i.id === elsewhere.id)).toMatchObject({ targetTitle: null, targetUrl: null });
    expect(res.items.find((i) => i.id === inSecret.id)).toMatchObject({ targetTitle: 'Commit c4', targetUrl: 'https://github.com/c/c4' });
  });

  it('keeps a PR thread\'s target and a commit thread\'s apart, even when a commit is a PR\'s head', () => {
    // A synced commit whose oid is a PR's head: only the commit's own threads name it.
    db.run("UPDATE pull_requests SET head_oid = ? WHERE repo_id = ? AND number = 2", [C3, repoId('alice/app')]);
    const onPr = createThread(db, pr('alice/app', 2), { commitOid: C3, baseOid: BASE, anchor: general, body: 'pr' }, me, at(1));
    const onCommit = add(commit('alice/app', C3), 'commit', 2);
    // ... and a thread of an unsynced PR made on a synced commit is not that commit's.
    const orphan = createThread(db, pr('alice/app', 99), { commitOid: C3, baseOid: BASE, anchor: general, body: 'orphan' }, me, at(3));
    const byId = new Map(list().items.map((i) => [i.id, i]));
    expect(byId.get(orphan.id)).toMatchObject({ targetTitle: null, targetUrl: null, prState: null, earlierPush: false });
    expect(byId.get(onPr.id)).toMatchObject({ targetTitle: 'Add parser', prState: 'open', earlierPush: false });
    expect(byId.get(onCommit.id)).toMatchObject({ targetTitle: 'Refactor parser module', prState: null, earlierPush: false });
  });
});
