import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal, ThreadAnchor } from '../../shared/api';
import { seedDb } from '../test/seed';
import { createAgent } from './agents';
import { commentEventsAfter, lastCommentEventId } from './comment-events';
import { addComment, createThread, deleteComment, deleteThread, getPrincipal, listThreads, SELF_PRINCIPAL_ID, setThreadStatus, type ThreadTarget } from './comments';
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

  it("names a branch thread's target by its branch, and keeps it out of the scope of the commit it was made on", () => {
    const onBranch = createThread(db, { repoId: app, kind: 'branch', branch: 'fix/login' }, { commitOid: C3, baseOid: null, anchor: general, body: 'On the branch' }, me);
    const onPr = createThread(db, { repoId: app, kind: 'pr', number: 2 }, { commitOid: C3, baseOid: null, anchor: general, body: 'On the PR', prBranch: 'fix/login' }, me);
    const onCommit = open({ repoId: app, kind: 'commit', oid: C3 }, 'On the commit', me);
    expect(commentEventsAfter(db, 0).map((e) => [e.threadId, e.target])).toEqual([
      [onBranch.id, { kind: 'branch', branch: 'fix/login' }],
      [onPr.id, { kind: 'pr', number: 2 }],
      [onCommit.id, { kind: 'commit', oid: C3 }],
    ]);
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, commitOid: C3 } }))).toEqual([`You thread_opened ${onCommit.id}`]);
    // The seed's PR 2 is from a branch the sync hasn't said is this repo's: it shares nothing, so its scope is its own threads'.
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, prNumber: 2 } }))).toEqual([`You thread_opened ${onPr.id}`]);
    // From this repo, it shares the branch's threads: those made on the branch, and its own.
    db.run("UPDATE pull_requests SET head_ref = 'fix/login', cross_repo = 0 WHERE repo_id = ? AND number = 2", [app]);
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, prNumber: 2 } }))).toEqual([`You thread_opened ${onBranch.id}`, `You thread_opened ${onPr.id}`]);
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, branch: 'fix/login' } }))).toEqual([`You thread_opened ${onBranch.id}`, `You thread_opened ${onPr.id}`]);
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

describe("events in a PR's or a branch's scope follow its view's branch groups", () => {
  /** An hour of the seed's last day as a code host gives times (whole seconds)... */
  const hostTime = (hour: number) => `2026-09-29T${String(hour).padStart(2, '0')}:00:00Z`;
  /** ... and as gh-dash writes its own (milliseconds). */
  const at = (hour: number, ms = 0) => `2026-09-29T${String(hour).padStart(2, '0')}:00:00.${String(ms).padStart(3, '0')}Z`;

  /** PR `number` of alice/app from branch `head`: from the same repo unless `crossRepo` says otherwise; `endHour`: when it ended. */
  function prFrom(number: number, head: string, state: 'open' | 'merged' | 'closed', endHour: number | null = null, crossRepo: 0 | 1 | null = 0) {
    const end = endHour === null ? null : hostTime(endHour);
    db.run(
      `INSERT INTO pull_requests (repo_id, number, title, state, created_at, updated_at, merged_at, closed_at, activity_at, url, head_ref, cross_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [app, number, `PR ${number}`, state, hostTime(0), end ?? hostTime(0), state === 'merged' ? end : null, end, end ?? hostTime(0), 'u', head, crossRepo],
    );
  }
  const onBranch = (name: string, body: string, time: string) =>
    createThread(db, { repoId: app, kind: 'branch', branch: name }, { commitOid: HEAD, baseOid: null, anchor: general, body }, me, time);
  const onPr = (number: number, prBranch: string | null, body: string, time: string) =>
    createThread(db, { repoId: app, kind: 'pr', number }, { commitOid: HEAD, baseOid: null, anchor: general, body, prBranch }, me, time);
  /** The threads whose events a scope gives, and the threads of the view it stands for (listThreads: the same rules). */
  const scoped = (scope: { prNumber: number } | { branch: string }) =>
    [...new Set(commentEventsAfter(db, 0, { scope: { repoId: app, ...scope } }).map((e) => e.threadId))].sort((a, b) => a - b);
  const viewed = (target: ThreadTarget) => listThreads(db, target).map((t) => t.id).sort((a, b) => a - b);
  const ids = (...threads: { id: number }[]) => threads.map((t) => t.id).sort((a, b) => a - b);

  it("gives a PR's own threads and its branch group's: made on the branch, on the PR, and on the branch's other PRs", () => {
    prFrom(10, 'fix/login', 'open');
    prFrom(11, 'fix/login', 'closed', 3);
    const mine = onPr(10, 'fix/login', 'On #10', at(1));
    const branch = onBranch('fix/login', 'On the branch', at(2));
    const sibling = onPr(11, 'fix/login', 'On #11', at(2));
    const elsewhere = onBranch('other', 'Another branch', at(2));
    onPr(3, 'feature', 'Another PR', at(2));
    // A reply and a resolve on a shared thread are the PR's events too.
    addComment(db, branch.id, claude, 'From the agent');
    setThreadStatus(db, sibling.id, 'resolved', me);
    expect(brief(commentEventsAfter(db, 0, { scope: { repoId: app, prNumber: 10 } }))).toEqual([
      `You thread_opened ${mine.id}`, `You thread_opened ${branch.id}`, `You thread_opened ${sibling.id}`, `Claude replied ${branch.id}`, `You resolved ${sibling.id}`,
    ]);
    expect(scoped({ prNumber: 10 })).toEqual(ids(mine, branch, sibling));
    expect(scoped({ prNumber: 11 })).toEqual(ids(mine, branch, sibling));
    expect(scoped({ branch: 'fix/login' })).toEqual(ids(mine, branch, sibling));
    expect(scoped({ branch: 'other' })).toEqual(ids(elsewhere));
    expect(scoped({ prNumber: 10 })).toEqual(viewed({ repoId: app, kind: 'pr', number: 10 }));
  });

  it('keeps its own threads to itself when it is from a fork, or the sync has not said, and unsynced', () => {
    onBranch('fix/x', 'On the branch', at(1));
    prFrom(40, 'fix/x', 'open', null, 1);
    prFrom(41, 'fix/x', 'open', null, null);
    const fork = onPr(40, null, 'On the fork PR', at(2));
    const unknown = onPr(41, null, 'On the unknown PR', at(2));
    const dropped = onPr(42, null, 'On a PR the sync dropped', at(2));
    expect(scoped({ prNumber: 40 })).toEqual(ids(fork));
    expect(scoped({ prNumber: 41 })).toEqual(ids(unknown));
    expect(scoped({ prNumber: 42 })).toEqual(ids(dropped));
    // Neither is in the branch's.
    expect(scoped({ branch: 'fix/x' })).toHaveLength(1);
  });

  it("splits at merges as the views do: a merged PR's group ends at its merge, the branch's next line starts after it", () => {
    prFrom(50, 'edge', 'merged', 4);
    const atMerge = onBranch('edge', 'At the merge', at(4, 0));
    const after = onBranch('edge', 'Just after', at(4, 1));
    const before = onBranch('edge', 'Just before', at(3, 999));
    const own = onPr(50, null, 'On #50 after its merge', at(5));
    prFrom(51, 'edge', 'open');
    const next = onPr(51, 'edge', 'On #51', at(6));
    expect(scoped({ prNumber: 50 })).toEqual(ids(atMerge, before, own));
    expect(scoped({ prNumber: 51 })).toEqual(ids(after, next));
    expect(scoped({ branch: 'edge' })).toEqual(ids(after, next));
    for (const number of [50, 51]) expect(scoped({ prNumber: number })).toEqual(viewed({ repoId: app, kind: 'pr', number }));
    expect(scoped({ branch: 'edge' })).toEqual(viewed({ repoId: app, kind: 'branch', branch: 'edge' }));
  });

  it('splits a branch merged again and again into its lines of work, whatever the PRs that ended them', () => {
    prFrom(60, 'multi', 'merged', 2);
    prFrom(61, 'multi', 'closed', 4);
    prFrom(62, 'multi', 'merged', 6);
    prFrom(63, 'multi', 'open');
    prFrom(64, 'multi', 'closed', null);
    for (const [hour, body] of [[1, 'First'], [3, 'Second, before #61 closed'], [5, 'Second, after'], [7, 'Third']] as const) onBranch('multi', body, at(hour));
    for (const number of [60, 61, 62, 63, 64]) expect(scoped({ prNumber: number }), `PR ${number}`).toEqual(viewed({ repoId: app, kind: 'pr', number }));
    expect(scoped({ prNumber: 60 })).toHaveLength(1);
    expect(scoped({ prNumber: 62 })).toHaveLength(2);
    expect(scoped({ prNumber: 63 })).toHaveLength(1);
    expect(scoped({ branch: 'multi' })).toEqual(viewed({ repoId: app, kind: 'branch', branch: 'multi' }));
    expect(scoped({ branch: 'multi' })).toHaveLength(1);
  });

  it("keeps the events of a deleted thread in the group it was made in, by when it was opened", () => {
    prFrom(60, 'multi', 'merged', 2);
    prFrom(63, 'multi', 'open');
    const first = onBranch('multi', 'In the first line of work', at(1));
    const third = onBranch('multi', 'In the third', at(7));
    const prThird = onPr(63, 'multi', 'On #63', at(8));
    addComment(db, third.id, claude, 'Reply', at(9));
    for (const t of [first, third, prThird]) deleteThread(db, t.id, me);
    // Nothing of them is left to list, yet their events are in the scopes their threads were.
    expect(viewed({ repoId: app, kind: 'branch', branch: 'multi' })).toEqual([]);
    const kinds = (scope: { prNumber: number } | { branch: string }) =>
      commentEventsAfter(db, 0, { scope: { repoId: app, ...scope } }).map((e) => `${e.kind} ${e.threadId}`);
    expect(kinds({ prNumber: 60 })).toEqual([`thread_opened ${first.id}`, `thread_deleted ${first.id}`]);
    expect(kinds({ prNumber: 63 })).toEqual([
      `thread_opened ${third.id}`, `thread_opened ${prThird.id}`, `replied ${third.id}`, `thread_deleted ${third.id}`, `thread_deleted ${prThird.id}`,
    ]);
    expect(kinds({ branch: 'multi' })).toEqual(kinds({ prNumber: 63 }));
  });

  it("keeps a deleted thread where its view had it last: a PR thread the sync took the branch from stays out of the branch's, all its events", () => {
    prFrom(70, 'topic', 'open');
    prFrom(71, 'topic', 'open');
    const kept = onBranch('topic', 'On the branch', at(1));
    const t = onPr(70, 'topic', 'On #70', at(2));
    addComment(db, t.id, me, 'Before');
    // #70 was merged before the thread was made, and the sync learns it: the thread is #70's alone.
    db.run('UPDATE comment_threads SET branch = NULL WHERE id = ?', [t.id]);
    addComment(db, t.id, me, 'After');
    expect(scoped({ prNumber: 71 })).toEqual(ids(kept));
    deleteThread(db, t.id, me);
    // Its opening event still says "topic", but the thread's last state, which deleting logs, doesn't.
    expect(db.all('SELECT kind, branch FROM comment_events WHERE thread_id = ? ORDER BY id', [t.id])).toEqual([
      { kind: 'thread_opened', branch: 'topic' }, { kind: 'replied', branch: 'topic' }, { kind: 'replied', branch: null }, { kind: 'thread_deleted', branch: null },
    ]);
    expect(scoped({ prNumber: 71 })).toEqual(ids(kept));
    expect(scoped({ branch: 'topic' })).toEqual(ids(kept));
    // It is #70's own, still, with every event.
    expect(commentEventsAfter(db, 0, { scope: { repoId: app, prNumber: 70 } }).filter((e) => e.threadId === t.id)).toHaveLength(4);
  });

  it("keeps a deleted thread the sync gave a branch (a backfill) in the group with all its events, the older ones too", () => {
    prFrom(80, 'topic', 'open');
    prFrom(81, 'topic', 'open');
    // Made before the sync knew where PR 80 was from, so the thread had no branch, and its early events say so.
    const t = onPr(80, null, 'On #80', at(2));
    addComment(db, t.id, me, 'Early');
    db.run("UPDATE comment_threads SET branch = 'topic' WHERE id = ?", [t.id]);
    addComment(db, t.id, me, 'Late');
    expect(scoped({ prNumber: 81 })).toEqual(ids(t));
    const events = () => commentEventsAfter(db, 0, { scope: { repoId: app, branch: 'topic' } }).map((e) => `${e.kind} ${e.threadId}`);
    const live = events();
    expect(live).toEqual([`thread_opened ${t.id}`, `replied ${t.id}`, `replied ${t.id}`]);
    deleteThread(db, t.id, me);
    // Nothing of it drops out of the group when it is deleted: the older events join the newer ones.
    expect(events()).toEqual([...live, `thread_deleted ${t.id}`]);
    expect(scoped({ prNumber: 81 })).toEqual(ids(t));
    expect(scoped({ prNumber: 80 })).toEqual(ids(t));
  });

  it("follows a PR thread's branch as it is now: taken away by the sync once the PR's merge is known, its earlier events go too", () => {
    prFrom(70, 'topic', 'open');
    const kept = onBranch('topic', 'On the branch', at(1));
    const t = onPr(70, 'topic', 'On #70', at(2));
    prFrom(71, 'topic', 'open');
    expect(scoped({ prNumber: 71 })).toEqual(ids(kept, t));
    // #70 was merged before the thread was made, and the sync has now learned it: the thread is #70's alone.
    db.run("UPDATE comment_threads SET branch = NULL WHERE id = ?", [t.id]);
    addComment(db, t.id, me, 'After');
    expect(scoped({ prNumber: 71 })).toEqual(ids(kept));
    expect(scoped({ branch: 'topic' })).toEqual(ids(kept));
    expect(scoped({ prNumber: 70 })).toEqual(ids(kept, t));
  });
});
