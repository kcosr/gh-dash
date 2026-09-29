import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ThreadAnchor } from '../../shared/api';
import { seedDb } from '../test/seed';
import {
  addComment,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  getCommentRef,
  getPrincipal,
  getThread,
  listThreads,
  mayDelete,
  mayEdit,
  SELF_PRINCIPAL_ID,
  setThreadStatus,
  threadRepo,
  type ThreadTarget,
} from './comments';
import type { Db } from './db';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const T0 = '2026-09-29T10:00:00.000Z';
const T1 = '2026-09-29T11:00:00.000Z';

const general: ThreadAnchor = { path: null, side: null, startLine: null, endLine: null, snippet: null };
const lines = (startLine: number, endLine: number, snippet: string, side: 'old' | 'new' = 'new'): ThreadAnchor => ({
  path: 'src/a.ts', side, startLine, endLine, snippet,
});

let db: Db;
let me: Principal;
let agent: Principal;
let app: number;
const pr = (number = 2): ThreadTarget => ({ repoId: app, kind: 'pr', number });
const commit = (oid = COMMIT): ThreadTarget => ({ repoId: app, kind: 'commit', oid });
const open = (target: ThreadTarget, anchor: ThreadAnchor, body = 'Why?', author = me, now = T0) =>
  createThread(db, target, { commitOid: target.kind === 'commit' ? target.oid : HEAD, baseOid: BASE, anchor, body }, author, now);

beforeEach(() => {
  db = seedDb();
  me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
  const id = db.run("INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'Reviewer', ?)", [T0]).lastInsertRowid;
  agent = getPrincipal(db, id)!;
  app = db.get<{ id: number }>("SELECT id FROM repos WHERE name = 'app'")!.id;
});

describe('comment threads', () => {
  it('has the dashboard user as principal 1', () => {
    expect(me).toEqual({ id: 1, kind: 'self', name: 'You' });
  });

  it('opens threads at every anchor level with their first comment', () => {
    const t = open(pr(), lines(3, 4, 'const a = 1;\nconst b = 2;'));
    expect(t).toEqual({
      id: t.id, kind: 'pr', repo: 'alice/app', number: 2, commitOid: HEAD, baseOid: BASE,
      path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, snippet: 'const a = 1;\nconst b = 2;',
      status: 'open', resolvedAt: null, createdAt: T0, updatedAt: T0,
      comments: [{ id: expect.any(Number), author: me, body: 'Why?', createdAt: T0, editedAt: null }],
    });
    expect(open(pr(), { ...general, path: 'src/a.ts' })).toMatchObject({ path: 'src/a.ts', side: null, startLine: null });
    expect(open(commit(), general, 'Nice', agent)).toMatchObject({ kind: 'commit', number: null, commitOid: COMMIT, comments: [{ author: agent }] });
  });

  it('refuses anchors that mix levels', () => {
    const bad: ThreadAnchor[] = [
      { ...general, side: 'new' },
      { path: 'a', side: 'new', startLine: 1, endLine: 1, snippet: null },
      { path: 'a', side: null, startLine: 1, endLine: 1, snippet: 'x' },
      { path: null, side: 'old', startLine: 1, endLine: 1, snippet: 'x' },
      lines(0, 0, ''),
      lines(5, 4, ''),
    ];
    for (const anchor of bad) expect(() => open(pr(), anchor), JSON.stringify(anchor)).toThrow(/CHECK constraint/);
    expect(listThreads(db, pr())).toEqual([]);
  });

  it('lists a target\'s threads oldest first, keeping PRs, commits and repos apart', () => {
    const a = open(pr(), general);
    const b = open(pr(), lines(1, 1, 'x'));
    open(pr(3), general);
    const c = open(commit(), general);
    open(commit('d'.repeat(40)), general);
    const secret = db.get<{ id: number }>("SELECT id FROM repos WHERE name = 'secret'")!.id;
    open({ repoId: secret, kind: 'pr', number: 2 }, general);
    expect(listThreads(db, pr()).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(listThreads(db, commit()).map((t) => t.id)).toEqual([c.id]);
    // A commit thread whose oid is some PR's head is still not that PR's.
    expect(listThreads(db, { repoId: app, kind: 'commit', oid: HEAD })).toEqual([]);
  });

  it("names a thread's repo and whether the sync removed it", () => {
    const t = open(pr(), general);
    expect(threadRepo(db, t.id)).toEqual({ repoId: app, removed: false });
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE id = ?", [app]);
    expect(threadRepo(db, t.id)).toEqual({ repoId: app, removed: true });
    expect(threadRepo(db, 9999)).toBeNull();
  });

  it('outlives the PR row (a transfer re-creates it) but not the repo', () => {
    const t = open(pr(), general);
    db.run("DELETE FROM pull_requests WHERE number = 2 AND repo_id = ?", [app]);
    expect(getThread(db, t.id)).not.toBeNull();
    db.run('DELETE FROM repos WHERE id = ?', [app]);
    expect(getThread(db, t.id)).toBeNull();
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM comments')!.n).toBe(0);
  });

  it('adds replies in order and leaves the status alone', () => {
    const t = open(pr(), general);
    setThreadStatus(db, t.id, 'resolved', T0);
    const after = addComment(db, t.id, agent, 'Because.', T1)!;
    expect(after.comments.map((c) => [c.author.name, c.body])).toEqual([['You', 'Why?'], ['Reviewer', 'Because.']]);
    expect(after).toMatchObject({ status: 'resolved', updatedAt: T1 });
    expect(addComment(db, 9999, me, 'x')).toBeNull();
  });

  it('edits a comment, marking when', () => {
    const t = open(pr(), general);
    const edited = editComment(db, t.comments[0]!.id, 'Why not?', T1)!;
    expect(edited.comments[0]).toMatchObject({ body: 'Why not?', createdAt: T0, editedAt: T1 });
    expect(edited.updatedAt).toBe(T1);
    expect(editComment(db, 9999, 'x')).toBeNull();
  });

  it('deletes a reply alone, but the first comment takes the thread and its replies along', () => {
    const t = open(pr(), general);
    const reply = addComment(db, t.id, agent, 'One', T0)!.comments[1]!;
    const other = addComment(db, t.id, me, 'Two', T0)!.comments[2]!;
    expect(getCommentRef(db, reply.id)).toEqual({ threadId: t.id, authorId: agent.id, first: false });
    expect(getCommentRef(db, t.comments[0]!.id)).toMatchObject({ first: true });
    const left = deleteComment(db, reply.id, T1)!;
    expect(left.thread!.comments.map((c) => c.id)).toEqual([t.comments[0]!.id, other.id]);
    expect(left.thread!.updatedAt).toBe(T1);
    expect(deleteComment(db, t.comments[0]!.id)).toEqual({ thread: null });
    expect(getThread(db, t.id)).toBeNull();
    expect(getCommentRef(db, other.id)).toBeNull();
    expect(deleteComment(db, other.id)).toBeNull();
  });

  it('resolves and reopens threads', () => {
    const t = open(pr(), general);
    expect(setThreadStatus(db, t.id, 'resolved', T1)).toMatchObject({ status: 'resolved', resolvedAt: T1, updatedAt: T1 });
    // Resolving again keeps the original time.
    expect(setThreadStatus(db, t.id, 'resolved', '2026-09-30T00:00:00.000Z')).toMatchObject({ resolvedAt: T1, updatedAt: T1 });
    expect(setThreadStatus(db, t.id, 'open', T1)).toMatchObject({ status: 'open', resolvedAt: null });
    expect(setThreadStatus(db, 9999, 'open')).toBeNull();
  });

  it('deletes threads', () => {
    const t = open(pr(), general);
    expect(deleteThread(db, t.id)).toBe(true);
    expect(deleteThread(db, t.id)).toBe(false);
    expect(listThreads(db, pr())).toEqual([]);
  });

  it('never reuses the id of a deleted thread or comment (ids live on in URLs and clients)', () => {
    const t = open(pr(), general);
    const reply = addComment(db, t.id, me, 'x')!.comments[1]!;
    deleteComment(db, reply.id);
    deleteThread(db, t.id);
    const next = open(pr(), general);
    expect(next.id).toBeGreaterThan(t.id);
    expect(next.comments[0]!.id).toBeGreaterThan(reply.id);
  });

  it('lets authors edit their own words only, and the dashboard user delete anything', () => {
    expect(mayEdit(me, me.id)).toBe(true);
    expect(mayEdit(me, agent.id)).toBe(false);
    expect(mayEdit(agent, me.id)).toBe(false);
    expect(mayDelete(me, agent.id)).toBe(true);
    expect(mayDelete(agent, agent.id)).toBe(true);
    expect(mayDelete(agent, me.id)).toBe(false);
  });
});
