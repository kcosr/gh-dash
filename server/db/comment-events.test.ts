import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ThreadAnchor } from '../../shared/api';
import { seedDb } from '../test/seed';
import { createAgent } from './agents';
import { commentEventsAfter, lastCommentEventId } from './comment-events';
import { addComment, createThread, deleteComment, deleteThread, getPrincipal, SELF_PRINCIPAL_ID, setThreadStatus, type ThreadTarget } from './comments';
import type { Db } from './db';

const HEAD = 'a'.repeat(40);
const C3 = 'c3'.padEnd(40, '0');
const general: ThreadAnchor = { path: null, side: null, startLine: null, endLine: null, snippet: null };

let db: Db;
let me: Principal;
let claude: Principal;
let app: number;
let secret: number;

const open = (target: ThreadTarget, body: string, author: Principal) =>
  createThread(db, target, { commitOid: target.kind === 'commit' ? target.oid : HEAD, baseOid: null, anchor: general, body }, author);
const brief = (items: ReturnType<typeof commentEventsAfter>) => items.map((e) => `${e.by.name} ${e.kind} ${e.threadId}`);

beforeEach(() => {
  db = seedDb();
  me = getPrincipal(db, SELF_PRINCIPAL_ID)!;
  claude = getPrincipal(db, createAgent(db, 'Claude').agent.id)!;
  const id = (key: string) => db.get<{ id: number }>('SELECT id FROM repos WHERE key = ?', [key])!.id;
  app = id('alice/app');
  secret = id('alice/secret');
});

describe('comment events after a cursor', () => {
  it('starts from the newest id, and lists what came after it, oldest first', () => {
    expect(lastCommentEventId(db)).toBe(0);
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', claude);
    const cursor = lastCommentEventId(db);
    expect(cursor).toBeGreaterThan(0);
    const reply = addComment(db, t.id, me, 'Because.')!.comments[1]!;
    setThreadStatus(db, t.id, 'resolved', me);
    const items = commentEventsAfter(db, cursor);
    expect(items).toEqual([
      {
        id: cursor + 1, at: expect.any(String), kind: 'replied', threadId: t.id, commentId: reply.id, by: me, repo: 'alice/app',
        target: { kind: 'pr', number: 2 }, path: null, startLine: null, endLine: null, excerpt: 'Because.', threadStatus: 'resolved',
      },
      expect.objectContaining({ id: cursor + 2, kind: 'resolved', commentId: null, excerpt: 'Why?', threadStatus: 'resolved' }),
    ]);
    expect(commentEventsAfter(db, cursor, { limit: 1 })).toHaveLength(1);
    expect(commentEventsAfter(db, lastCommentEventId(db))).toEqual([]);
  });

  it("leaves out the asker's own events, other scopes and removed repos", () => {
    const pr = open({ repoId: app, kind: 'pr', number: 2 }, 'On the PR', me);
    const other = open({ repoId: app, kind: 'pr', number: 3 }, 'Another PR', me);
    const commit = open({ repoId: app, kind: 'commit', oid: C3 }, 'On the commit', me);
    // A PR thread made on the revision C3 is the PR's, not the commit's.
    const prOnC3 = createThread(db, { repoId: app, kind: 'pr', number: 2 }, { commitOid: C3, baseOid: null, anchor: general, body: 'PR at C3' }, me);
    const elsewhere = open({ repoId: secret, kind: 'pr', number: 1 }, 'Elsewhere', me);
    addComment(db, pr.id, claude, 'Mine');
    expect(brief(commentEventsAfter(db, 0, { exceptActor: claude.id, scope: { repoId: app, prNumber: 2 } }))).toEqual([
      `You thread_opened ${pr.id}`, `You thread_opened ${prOnC3.id}`,
    ]);
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, commitOid: C3 } }))).toEqual([`You thread_opened ${commit.id}`]);
    expect(brief(commentEventsAfter(db, 0, { scope: { threadIds: [other.id, elsewhere.id] } }))).toEqual([`You thread_opened ${other.id}`, `You thread_opened ${elsewhere.id}`]);
    expect(commentEventsAfter(db, 0, { scope: { repoId: secret } })).toHaveLength(1);
    db.run("UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE id = ?", [secret]);
    expect(commentEventsAfter(db, 0, { scope: { repoId: secret } })).toEqual([]);
    expect(commentEventsAfter(db, 0)).toHaveLength(5);
  });

  it('says when the thread is gone, and no longer what deleted comments said', () => {
    const t = open({ repoId: app, kind: 'pr', number: 2 }, 'Why?', claude);
    const reply = addComment(db, t.id, me, 'Oops, a secret')!.comments[1]!;
    deleteComment(db, reply.id, me);
    expect(commentEventsAfter(db, 0).map((e) => [e.kind, e.excerpt, e.threadStatus])).toEqual([
      ['thread_opened', 'Why?', 'open'], ['replied', null, 'open'], ['comment_deleted', null, 'open'],
    ]);
    deleteThread(db, t.id, me);
    expect(commentEventsAfter(db, 0).map((e) => [e.kind, e.excerpt, e.threadStatus])).toEqual([
      ['thread_opened', null, null], ['replied', null, null], ['comment_deleted', null, null], ['thread_deleted', null, null],
    ]);
  });
});
