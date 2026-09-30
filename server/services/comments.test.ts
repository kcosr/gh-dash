import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, StreamMessage } from '../../shared/api';
import { CommentBus } from '../comments/bus';
import { createAgent } from '../db/agents';
import type { Db } from '../db/db';
import { HttpError } from '../lib/errors';
import { seedDb } from '../test/seed';
import {
  type CommentDeps,
  createCommitThread,
  createPrThread,
  deleteComment,
  deleteThread,
  editComment,
  getThread,
  listTargetThreads,
  reply,
  resolveTarget,
  selfPrincipal,
  setThreadStatus,
} from './comments';

const HEAD = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);

let db: Db;
let deps: CommentDeps;
let heard: StreamMessage[];
let me: Principal;
let claude: Principal;
let codex: Principal;

beforeEach(() => {
  db = seedDb();
  const bus = new CommentBus();
  heard = [];
  bus.subscribe((m) => heard.push(m));
  deps = { db, bus };
  me = selfPrincipal(db);
  const principal = (name: string): Principal => ({ id: createAgent(db, name).agent.id, kind: 'agent', name });
  claude = principal('Claude');
  codex = principal('Codex');
});

/** The status and message of what `fn` throws. */
function failure(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error('did not throw');
}

const events = () => db.all<{ kind: string; actor_id: number; thread_id: number }>('SELECT kind, actor_id, thread_id FROM comment_events ORDER BY id');
const told = () => heard.map((m) => (m.type === 'comments' ? [m.event, m.by.name, m.threadId] : [m.type]));

describe('comment services', () => {
  it('writes as the principal named, records it and tells the bus once it has committed', () => {
    const t = createPrThread(deps, claude, 'app', 2, { commitOid: HEAD, path: 'src/a.ts', side: 'new', startLine: 1, endLine: 1, snippet: 'x', body: 'Why?' });
    expect(t.comments[0]!.author).toEqual(claude);
    expect(heard).toEqual([{ type: 'comments', repo: 'alice/app', kind: 'pr', number: 2, commitOid: HEAD, threadId: t.id, event: 'thread_opened', by: claude }]);
    const c = createCommitThread(deps, me, 'alice/app', COMMIT.toUpperCase(), { body: 'Nit' });
    expect(c).toMatchObject({ kind: 'commit', commitOid: COMMIT, number: null });
    expect(heard[1]).toMatchObject({ kind: 'commit', number: null, commitOid: COMMIT, event: 'thread_opened', by: me });

    const r = reply(deps, me, t.id, 'Because.').comments[1]!;
    editComment(deps, me, r.id, 'Because!');
    setThreadStatus(deps, claude, t.id, 'resolved');
    // Nothing changes, so nothing is recorded or told.
    setThreadStatus(deps, me, t.id, 'resolved');
    expect(getThread(deps, t.id).resolvedBy).toEqual(claude);
    setThreadStatus(deps, me, t.id, 'open');
    deleteComment(deps, me, r.id);
    deleteThread(deps, me, c.id);
    expect(told()).toEqual([
      ['thread_opened', 'Claude', t.id],
      ['thread_opened', 'You', c.id],
      ['replied', 'You', t.id],
      ['edited', 'You', t.id],
      ['resolved', 'Claude', t.id],
      ['reopened', 'You', t.id],
      ['comment_deleted', 'You', t.id],
      ['thread_deleted', 'You', c.id],
    ]);
    expect(events().map((e) => [e.kind, e.actor_id, e.thread_id])).toEqual(told().map(([kind, name, thread]) => [kind, name === 'You' ? me.id : claude.id, thread]));
    // A deleted thread's message still says what it was on.
    expect(heard.at(-1)).toMatchObject({ repo: 'alice/app', kind: 'commit', commitOid: COMMIT, threadId: c.id });
  });

  it('lets an agent edit and delete its own comments only, and resolve or reopen any thread', () => {
    const t = createPrThread(deps, me, 'app', 2, { commitOid: HEAD, body: 'Why?' });
    const mine = reply(deps, claude, t.id, 'Because.').comments[1]!;
    const yours = t.comments[0]!;
    expect(failure(() => editComment(deps, claude, yours.id, 'Hacked'))).toEqual({ status: 403, message: 'You can only edit your own comments' });
    expect(failure(() => editComment(deps, codex, mine.id, 'Hacked'))).toEqual({ status: 403, message: 'You can only edit your own comments' });
    expect(failure(() => deleteComment(deps, codex, mine.id))).toEqual({ status: 403, message: 'Only its author can delete this comment' });
    expect(editComment(deps, claude, mine.id, 'Because!').comments[1]!.body).toBe('Because!');
    expect(setThreadStatus(deps, codex, t.id, 'resolved').resolvedBy).toEqual(codex);
    expect(setThreadStatus(deps, claude, t.id, 'open').status).toBe('open');
    expect(deleteComment(deps, claude, mine.id).thread!.comments).toHaveLength(1);
    // The dashboard's user may delete an agent's words, but not change them.
    const again = reply(deps, claude, t.id, 'Nit').comments[1]!;
    expect(failure(() => editComment(deps, me, again.id, 'Not a nit'))).toMatchObject({ status: 403 });
    expect(deleteComment(deps, me, again.id).thread!.comments).toHaveLength(1);
  });

  it("lets an agent delete a thread, or its first comment, only when every comment in it is the agent's", () => {
    const own = createPrThread(deps, claude, 'app', 2, { commitOid: HEAD, body: 'Mine' });
    reply(deps, claude, own.id, 'Still mine');
    const mixed = createPrThread(deps, claude, 'app', 2, { commitOid: HEAD, body: 'Mine' });
    reply(deps, me, mixed.id, 'Mine too');
    const notMine = createPrThread(deps, me, 'app', 2, { commitOid: HEAD, body: 'Yours' });
    const refused = { status: 403, message: 'Only a thread whose comments are all yours can be deleted' };
    expect(failure(() => deleteThread(deps, claude, mixed.id))).toEqual(refused);
    expect(failure(() => deleteThread(deps, claude, notMine.id))).toEqual(refused);
    expect(failure(() => deleteComment(deps, claude, mixed.comments[0]!.id))).toEqual({
      status: 403, message: 'Deleting the first comment deletes the thread. Only a thread whose comments are all yours can be deleted',
    });
    expect(failure(() => deleteComment(deps, claude, notMine.comments[0]!.id))).toEqual({ status: 403, message: 'Only its author can delete this comment' });
    expect(deleteComment(deps, claude, own.comments[0]!.id)).toEqual({ thread: null });
    const solo = createCommitThread(deps, codex, 'app', COMMIT, { body: 'Solo' });
    deleteThread(deps, codex, solo.id);
    // The dashboard's user may delete any thread.
    deleteThread(deps, me, mixed.id);
    expect(listTargetThreads(deps, { repo: 'app', kind: 'pr', number: 2 }).map((t) => t.id)).toEqual([notMine.id]);
    expect(told().filter(([e]) => e === 'thread_deleted')).toEqual([['thread_deleted', 'Claude', own.id], ['thread_deleted', 'Codex', solo.id], ['thread_deleted', 'You', mixed.id]]);
  });

  it('validates as the HTTP API does, and tells nobody of what fails', () => {
    const t = createPrThread(deps, me, 'app', 2, { commitOid: HEAD, body: 'Why?' });
    heard.length = 0;
    expect(failure(() => createPrThread(deps, claude, 'app', 0, { commitOid: HEAD, body: 'x' }))).toEqual({ status: 400, message: 'Invalid PR number' });
    expect(failure(() => createPrThread(deps, claude, 'app', 2, { commitOid: 'abc', body: 'x' }))).toMatchObject({ status: 400, message: expect.stringContaining('commitOid') });
    expect(failure(() => createPrThread(deps, claude, 'app', 2, { commitOid: HEAD, side: 'new', body: 'x' }))).toMatchObject({ status: 400, message: 'a line thread needs a path' });
    expect(failure(() => createPrThread(deps, claude, 'app', 99, { commitOid: HEAD, body: 'x' }))).toEqual({ status: 404, message: 'Pull request not found' });
    expect(failure(() => createPrThread(deps, claude, 'nope', 2, { commitOid: HEAD, body: 'x' }))).toEqual({ status: 404, message: 'Repository not found' });
    expect(failure(() => createCommitThread(deps, claude, 'app', COMMIT, { commitOid: HEAD, body: 'x' }))).toEqual({ status: 400, message: "commitOid must be the commit's own oid" });
    expect(failure(() => createCommitThread(deps, claude, 'app', 'c0ffee', { body: 'x' }))).toMatchObject({ status: 400 });
    expect(failure(() => reply(deps, claude, t.id, '   '))).toEqual({ status: 400, message: 'body: must not be empty' });
    expect(failure(() => reply(deps, claude, 9999, 'x'))).toEqual({ status: 404, message: 'Thread not found' });
    expect(failure(() => editComment(deps, claude, 9999, 'x'))).toEqual({ status: 404, message: 'Comment not found' });
    expect(failure(() => setThreadStatus(deps, claude, t.id, 'done' as never))).toMatchObject({ status: 400 });
    // A removed repo's threads are out of reach, by any id.
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE key = 'alice/app'");
    expect(failure(() => getThread(deps, t.id))).toEqual({ status: 404, message: 'Thread not found' });
    expect(failure(() => deleteComment(deps, me, t.comments[0]!.id))).toEqual({ status: 404, message: 'Comment not found' });
    expect(failure(() => resolveTarget(deps, { repo: 'app', kind: 'pr', number: 2 }))).toEqual({ status: 404, message: 'Repository not found' });
    expect(heard).toEqual([]);
    expect(events()).toHaveLength(1);
  });

  it('tells nobody of an edit that keeps the words', () => {
    const t = createPrThread(deps, claude, 'app', 2, { commitOid: HEAD, body: 'Why?' });
    heard.length = 0;
    expect(editComment(deps, claude, t.comments[0]!.id, 'Why?').comments[0]!.editedAt).toBeNull();
    expect(heard).toEqual([]);
    editComment(deps, claude, t.comments[0]!.id, 'Why not?');
    expect(told()).toEqual([['edited', 'Claude', t.id]]);
  });

  it('works without a bus', () => {
    const t = createPrThread({ db }, me, 'app', 2, { commitOid: HEAD, body: 'Why?' });
    expect(reply({ db }, claude, t.id, 'Because.').comments).toHaveLength(2);
  });
});
