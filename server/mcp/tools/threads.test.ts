import { describe, expect, it } from 'vitest';
import * as comments from '../../services/comments';
import { selfPrincipal } from '../../services/comments';
import { addedFile, mcpHarness, serveBranch, servePr, sha } from '../../test/mcp';
import { GITLAB_HOST, seedDb, seedGitLab } from '../../test/seed';
import { placeThreads } from '../placement';

const HEAD = sha('a');
const OID = sha('c');

/**
 * Threads, oldest activity first:
 *  1 the user's, on alice/app#2 src/a.ts line 2          (waiting on the agent)
 *  2 the agent's, on alice/app#2, the user replied        (waiting on the agent)
 *  3 the agent's, on alice/app#2 src/lib/x.ts             (waiting on the user)
 *  4 Codex's, on commit c… of alice/app                   (waiting on both)
 *  5 the user's, on the GitLab MR !2, resolved by the agent
 */
function setup() {
  const db = seedDb();
  seedGitLab(db);
  const h = mcpHarness({ db });
  const self = selfPrincipal(db);
  const deps = { db, bus: h.bus };
  const at = (id: number, time: string) => db.run('UPDATE comment_threads SET updated_at = ? WHERE id = ?', [time, id]);
  const t1 = comments.createPrThread(deps, self, 'alice/app', 2, { commitOid: HEAD, path: 'src/a.ts', side: 'new', startLine: 2, endLine: 2, snippet: 'two', body: 'Why two?' });
  const t2 = comments.createPrThread(deps, h.agent, 'alice/app', 2, { commitOid: HEAD, body: 'I changed the parser: fine?' });
  comments.reply(deps, self, t2.id, 'Mostly. See the tests.');
  const t3 = comments.createPrThread(deps, h.agent, 'alice/app', 2, { commitOid: HEAD, path: 'src/lib/x.ts', body: 'Is lib/x still used?' });
  const t4 = comments.createCommitThread(deps, h.other, 'alice/app', OID, { body: 'Nice commit' });
  const t5 = comments.createPrThread(deps, self, `${GITLAB_HOST}/platform/app`, 2, { commitOid: HEAD, body: 'Config?' });
  comments.setThreadStatus(deps, h.agent, t5.id, 'resolved');
  [t1, t2, t3, t4, t5].forEach((t, i) => at(t.id, `2026-09-28T1${i}:00:00.000Z`));
  servePr(h.code, 'alice/app', 2, HEAD, sha('b'), [addedFile('src/a.ts', ['one', 'two']), addedFile('src/lib/x.ts', ['x'])]);
  return { ...h, t1, t2, t3, t4, t5 };
}

type Item = { id: number } & Record<string, any>;
const ids = (r: Record<string, any>) => (r.items as Item[]).map((t) => t.id);

describe('list_threads', () => {
  it('lists open threads everywhere, newest activity first, placed on the current diff', async () => {
    const h = setup();
    const all = await h.ok<{ items: Item[]; total: number; counts: object; nextCursor: string | null }>('list_threads');
    expect(ids(all)).toEqual([h.t4.id, h.t3.id, h.t2.id, h.t1.id]);
    expect(all).toMatchObject({ total: 4, counts: { open: 4, resolved: 1 }, nextCursor: null });
    const one = all.items.find((t) => t.id === h.t1.id)!;
    expect(one).toEqual({
      id: h.t1.id, repo: 'alice/app', ref: 'alice/app#2', target: { kind: 'pr', number: 2, title: 'Add parser' }, status: 'open', resolvedBy: null,
      anchor: { commit: HEAD, base: null, path: 'src/a.ts', side: 'new', startLine: 2, endLine: 2, snippet: 'two' },
      placement: { kind: 'line', startLine: 2, endLine: 2, relocated: false },
      openedBy: 'you', counts: { comments: 1 }, lastComment: { id: expect.any(Number), by: 'you', at: expect.any(String), excerpt: 'Why two?' },
      updatedAt: '2026-09-28T10:00:00.000Z',
    });
    expect(all.items.find((t) => t.id === h.t2.id)).toMatchObject({ openedBy: 'me', lastComment: { by: 'you' }, placement: { kind: 'target' } });
    // A thread on the whole commit needs no diff.
    expect(all.items.find((t) => t.id === h.t4.id)).toMatchObject({ ref: `alice/app@${OID.slice(0, 7)}`, openedBy: 'agent:Codex', placement: { kind: 'target' } });
  });

  it("filters by who it waits on and who opened it, from the agent's side", async () => {
    const h = setup();
    const list = async (args: Record<string, unknown>) => ids(await h.ok('list_threads', args));
    expect(await list({ waiting_on: 'me' })).toEqual([h.t4.id, h.t2.id, h.t1.id]);
    expect(await list({ waiting_on: 'you' })).toEqual([h.t4.id, h.t3.id]);
    expect(await list({ author: 'me' })).toEqual([h.t3.id, h.t2.id]);
    expect(await list({ author: 'you', status: 'all' })).toEqual([h.t5.id, h.t1.id]);
    expect(await list({ author: 'agents' })).toEqual([h.t4.id, h.t3.id, h.t2.id]);
    // Another agent sees the same threads from its own side.
    const theirs = await h.call('list_threads', { waiting_on: 'me' }, { authorization: `Bearer ${h.otherToken}` });
    expect(ids(theirs.data as { items: Item[] })).toEqual([h.t3.id, h.t2.id, h.t1.id]);
  });

  it('narrows to a repo, PR, commit, file or directory, time and words', async () => {
    const h = setup();
    const list = async (args: Record<string, unknown>) => ids(await h.ok('list_threads', args));
    expect(await list({ repo: 'alice/app', pr: 2 })).toEqual([h.t3.id, h.t2.id, h.t1.id]);
    expect(await list({ repo: 'app', commit: OID.slice(0, 7) })).toEqual([h.t4.id]);
    expect(await list({ repo: `${GITLAB_HOST}/platform/app`, status: 'resolved' })).toEqual([h.t5.id]);
    expect(await list({ path: 'src/a.ts' })).toEqual([h.t1.id]);
    expect(await list({ path: 'src/lib/' })).toEqual([h.t3.id]);
    expect(await list({ path: 'src' })).toEqual([h.t3.id, h.t1.id]);
    expect(await list({ path: 'SRC' })).toEqual([]);
    expect(await list({ since: '2026-09-28T11:30:00Z' })).toEqual([h.t4.id, h.t3.id]);
    expect(await list({ q: 'parser' })).toEqual([h.t2.id]);
    const resolved = await h.ok('list_threads', { status: 'resolved' });
    expect(resolved.items[0]).toMatchObject({ ref: `${GITLAB_HOST}/platform/app!2`, status: 'resolved', resolvedBy: 'me' });
    expect(await h.fails('list_threads', { pr: 2 })).toContain('pr, branch and commit need repo');
    expect(await h.fails('list_threads', { since: 'yesterday' })).toContain('since: expected an ISO date');
    expect(await h.fails('list_threads', { repo: 'alice/nope' })).toContain("alice/nope isn't tracked");
  });

  it('pages with the cursor and gives whole conversations on request', async () => {
    const h = setup();
    const first = await h.ok('list_threads', { limit: 3 });
    expect(ids(first)).toEqual([h.t4.id, h.t3.id, h.t2.id]);
    const rest = await h.ok('list_threads', { limit: 3, cursor: first.nextCursor });
    expect(ids(rest)).toEqual([h.t1.id]);
    expect(rest.nextCursor).toBeNull();
    expect(await h.fails('list_threads', { cursor: 'nope' })).toBe('Invalid cursor');
    const full = await h.ok('list_threads', { repo: 'alice/app', pr: 2, include_comments: true, limit: 2 });
    expect(full.items[1].comments.map((c: { by: string; body: string }) => `${c.by}: ${c.body}`)).toEqual(['me: I changed the parser: fine?', 'you: Mostly. See the tests.']);
    expect(full.items[1].lastComment).toBeUndefined();
  });

  it('cuts long snippets in the list, not in get_thread', async () => {
    const h = setup();
    const long = Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const t = comments.createPrThread({ db: h.db, bus: h.bus }, selfPrincipal(h.db), 'alice/app', 2, {
      commitOid: HEAD, path: 'src/a.ts', side: 'new', startLine: 1, endLine: 100, snippet: long, body: 'Big',
    });
    const listed = (await h.ok('list_threads', { repo: 'alice/app', pr: 2 })).items.find((x: Item) => x.id === t.id);
    expect(listed.anchor.snippet).toHaveLength(401);
    expect((await h.ok('get_thread', { id: t.id })).anchor.snippet).toBe(long);
  });
});

describe('threads of a branch and of the PRs from it', () => {
  const BHEAD = sha('d');
  const BASE = sha('b');
  const HEAD3 = sha('e');
  const line = (startLine: number, snippet: string) => ({ path: 'src/a.ts', side: 'new' as const, startLine, endLine: startLine, snippet });

  /**
   * alice/app's PRs 2 and 3 are both open from branch "feature" of this repo, and the branch is pushed (its head BHEAD; PR
   * 2's is HEAD, PR 3's diff isn't served at all). PR 2's diff has src/a.ts as one, two; the branch's as zero, one, two.
   *  b1 the user's, on the branch, made at BHEAD: src/a.ts line 3 "two"
   *  p2 Codex's, on PR 2, made at HEAD:            src/a.ts line 2 "two"
   *  p3 the agent's, on PR 3, made at HEAD3:        src/a.ts line 1 "one"
   *  o  the user's, on branch "other": not shared with these
   *  c  Codex's, on a commit
   */
  function group() {
    const h = mcpHarness();
    const deps = { db: h.db, bus: h.bus };
    const self = selfPrincipal(h.db);
    h.db.run("UPDATE pull_requests SET cross_repo = 0 WHERE repo_id = (SELECT id FROM repos WHERE key = 'alice/app') AND number IN (2, 3)");
    // PR 3 is closed in the seed: open it, so it shares from the branch's current line of work like PR 2.
    h.db.run("UPDATE pull_requests SET state = 'open', closed_at = NULL WHERE repo_id = (SELECT id FROM repos WHERE key = 'alice/app') AND number = 3");
    servePr(h.code, 'alice/app', 2, HEAD, BASE, [addedFile('src/a.ts', ['one', 'two'])]);
    serveBranch(h.code, 'alice/app', 'feature', BHEAD, BASE, [addedFile('src/a.ts', ['zero', 'one', 'two'])]);
    const b1 = comments.createBranchThread(deps, self, 'alice/app', 'feature', { commitOid: BHEAD, baseOid: BASE, ...line(3, 'two'), body: 'Why two?' });
    const p2 = comments.createPrThread(deps, h.other, 'alice/app', 2, { commitOid: HEAD, ...line(2, 'two'), body: 'Same on the PR' });
    const p3 = comments.createPrThread(deps, h.agent, 'alice/app', 3, { commitOid: HEAD3, ...line(1, 'one'), body: 'On the other PR' });
    const o = comments.createBranchThread(deps, self, 'alice/app', 'other', { commitOid: BHEAD, body: 'Elsewhere' });
    const c = comments.createCommitThread(deps, h.other, 'alice/app', sha('c'), { body: 'On a commit' });
    return { ...h, deps, self, b1, p2, p3, o, c };
  }
  const byId = (r: Record<string, any>) => new Map((r.items as Item[]).map((t) => [t.id, t]));

  it("lists a PR's own threads with its branch's, and its branch's other PRs', all placed on the PR's diff", async () => {
    const h = group();
    const got = await h.ok('list_threads', { repo: 'alice/app', pr: 2 });
    expect(ids(got).sort()).toEqual([h.b1.id, h.p2.id, h.p3.id].sort());
    expect(got.total).toBe(3);
    const items = byId(got);
    // The branch's thread, made at another revision, is found again in the PR's diff by its text.
    expect(items.get(h.b1.id)).toMatchObject({
      ref: 'alice/app branch feature', target: { kind: 'branch', branch: 'feature' }, openedBy: 'you',
      anchor: { commit: BHEAD, base: BASE, path: 'src/a.ts', side: 'new', startLine: 3, endLine: 3, snippet: 'two' },
      placement: { kind: 'line', startLine: 2, endLine: 2, relocated: true },
    });
    expect(items.get(h.b1.id)!.target.title).toBeUndefined();
    expect(items.get(h.p2.id)).toMatchObject({ ref: 'alice/app#2', placement: { kind: 'line', startLine: 2, endLine: 2, relocated: false } });
    // The other PR's diff isn't served: its own thread is placed on this PR's, not left unknown.
    expect(items.get(h.p3.id)).toMatchObject({ ref: 'alice/app#3', target: { kind: 'pr', number: 3 }, placement: { kind: 'line', startLine: 1, endLine: 1, relocated: true } });
    // Only the PR's diff was read, none of the branch's or the other PR's.
    expect(h.code.requests.filter((r) => r.startsWith('branch') || r.startsWith('compare'))).toEqual([]);
    expect(h.code.requests.filter((r) => r === 'pr alice/app#3')).toEqual([]);
  });

  it("lists a branch's threads with its PRs', placed on the branch's diff", async () => {
    const h = group();
    const got = await h.ok('list_threads', { repo: 'app', branch: 'feature' });
    expect(ids(got).sort()).toEqual([h.b1.id, h.p2.id, h.p3.id].sort());
    const items = byId(got);
    expect(items.get(h.b1.id)).toMatchObject({ placement: { kind: 'line', startLine: 3, endLine: 3, relocated: false } });
    // Made at HEAD, found again in the branch's diff (BHEAD), where the lines moved down.
    expect(items.get(h.p2.id)).toMatchObject({ ref: 'alice/app#2', placement: { kind: 'line', startLine: 3, endLine: 3, relocated: true } });
    expect(items.get(h.p3.id)).toMatchObject({ placement: { kind: 'line', startLine: 2, endLine: 2, relocated: true } });
    expect(h.code.requests.filter((r) => r.startsWith('pr '))).toEqual([]);
    // The filters work within it, and threads made on the branch alone answer to `waiting_on` as any.
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'feature', waiting_on: 'you' })).sort()).toEqual([h.p2.id, h.p3.id].sort());
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'feature', author: 'you' }))).toEqual([h.b1.id]);
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'refs/heads/other' }))).toEqual([h.o.id]);
  });

  it("places each thread of a wider list on its own target's diff, commit threads on their commit", async () => {
    const h = group();
    const items = byId(await h.ok('list_threads', { repo: 'alice/app' }));
    expect(items.get(h.b1.id)).toMatchObject({ placement: { kind: 'line', startLine: 3, relocated: false } });
    expect(items.get(h.p2.id)).toMatchObject({ placement: { kind: 'line', startLine: 2, relocated: false } });
    // PR 3 has no diff to place on, nor has branch "other" (it's on the whole branch: nothing to place).
    expect(items.get(h.p3.id)).toMatchObject({ placement: { kind: 'unknown', reason: expect.stringContaining('no diff') } });
    expect(items.get(h.o.id)).toMatchObject({ target: { kind: 'branch', branch: 'other' }, placement: { kind: 'target' } });
    expect(items.get(h.c.id)).toMatchObject({ placement: { kind: 'target' } });
  });

  it("keeps a commit thread on its commit when the rest are placed on a PR's diff", async () => {
    const h = group();
    const oid = sha('c');
    const onCommit = comments.createCommitThread(h.deps, h.self, 'alice/app', oid, { ...line(1, 'x'), body: 'Line of the commit' });
    h.code.commits.set(`alice/app@${oid}`, { title: 'c', baseOid: null, headOid: oid, files: [addedFile('src/a.ts', ['x'])], totalFiles: 1, additions: 1, deletions: 0, url: 'u' });
    const placed = await placeThreads(h, [h.b1, onCommit], new AbortController().signal, { against: { repo: 'alice/app', kind: 'pr', number: 2 } });
    expect(placed.get(h.b1.id)).toEqual({ kind: 'line', startLine: 2, endLine: 2, relocated: true });
    expect(placed.get(onCommit.id)).toEqual({ kind: 'line', startLine: 1, endLine: 1, relocated: false });
    expect(h.code.requests).toContain(`commit alice/app@${oid}`);
  });

  it("says unknown when the branch's diff isn't there, and names a branch as the thread's target in get_thread", async () => {
    const h = group();
    h.code.branches.clear();
    const got = await h.ok('get_thread', { id: h.b1.id });
    expect(got).toMatchObject({ ref: 'alice/app branch feature', target: { kind: 'branch', branch: 'feature' }, placement: { kind: 'unknown', reason: expect.stringContaining('no diff: Branch feature not found') } });
    // The PR's own list places on the PR's diff: the branch being gone changes nothing there.
    expect((await h.ok('list_threads', { repo: 'alice/app', pr: 2 })).items.find((t: Item) => t.id === h.b1.id).placement).toMatchObject({ kind: 'line', startLine: 2 });
    const asBranch = await h.ok('list_threads', { repo: 'alice/app', branch: 'feature' });
    expect(asBranch.items.every((t: Item) => t.placement.kind === 'unknown')).toBe(true);
  });

  it('gives one of pr, branch or commit, with a repo, and not the default branch or a bad name', async () => {
    const h = group();
    expect(await h.fails('list_threads', { branch: 'feature' })).toContain('pr, branch and commit need repo');
    expect(await h.fails('list_threads', { repo: 'alice/app', pr: 2, branch: 'feature' })).toContain('give only one of pr, branch or commit');
    expect(await h.fails('list_threads', { repo: 'alice/app', branch: 'feature', commit: sha('c') })).toContain('give only one of pr, branch or commit');
    expect(await h.fails('list_threads', { repo: 'alice/app', pr: 2, commit: sha('c') })).toContain('give only one of pr, branch or commit');
    expect(await h.fails('list_threads', { repo: 'alice/app', branch: 'main' })).toBe('main is the default branch: branches are compared against it');
    expect(await h.fails('list_threads', { repo: 'alice/app', branch: 'a b' })).toContain('expected a git branch name');
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'nothing-here' }))).toEqual([]);
  });

  it("ends a branch's line of work at the merge of a PR from it: the next PR's list, and the branch's, start afresh", async () => {
    const h = group();
    const dated = (t: { id: number }, time: string) => h.db.run('UPDATE comment_threads SET created_at = ? WHERE id = ?', [time, t.id]);
    dated(h.b1, '2026-09-01T00:00:00.000Z');
    dated(h.p3, '2026-09-02T00:00:00.000Z');
    dated(h.p2, '2026-09-03T00:00:00.000Z');
    const app = "(SELECT id FROM repos WHERE key = 'alice/app')";
    h.db.run(`UPDATE pull_requests SET state = 'merged', merged_at = '2026-09-02T12:00:00Z', closed_at = '2026-09-02T12:00:00Z' WHERE repo_id = ${app} AND number = 3`);
    // PR 3 keeps what was made until its merge; PR 2 and the branch see what came after it.
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', pr: 3 })).sort()).toEqual([h.b1.id, h.p3.id].sort());
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', pr: 2 }))).toEqual([h.p2.id]);
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'feature' }))).toEqual([h.p2.id]);
  });

  it('places a branch thread of an earlier line of work on the merged PR that shows it, and says so', async () => {
    const h = group();
    h.db.run("UPDATE comment_threads SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?", [h.b1.id]);
    h.db.run("UPDATE pull_requests SET state = 'merged', merged_at = '2026-09-02T12:00:00Z', closed_at = '2026-09-02T12:00:00Z' WHERE number = 3 AND repo_id = (SELECT id FROM repos WHERE key = 'alice/app')");
    servePr(h.code, 'alice/app', 3, HEAD3, BASE, [addedFile('src/a.ts', ['zero', 'one', 'two'])]);
    const listed = byId(await h.ok('list_threads', { repo: 'alice/app' }));
    // Its own target is the branch, but the branch's review starts after the merge: PR 3's diff is where it is, and is read.
    expect(listed.get(h.b1.id)).toMatchObject({
      ref: 'alice/app branch feature', target: { kind: 'branch', branch: 'feature' }, shownIn: 'alice/app#3', placement: { kind: 'line', startLine: 3, endLine: 3, relocated: true },
    });
    expect(h.code.requests.filter((r) => r.startsWith('branch') || r.startsWith('compare'))).toEqual([]);
    expect(await h.ok('get_thread', { id: h.b1.id })).toMatchObject({ shownIn: 'alice/app#3', placement: { kind: 'line', startLine: 3, relocated: true } });
    // Threads of the current line of work, and PR and commit threads, are shown where they are made.
    for (const t of [h.p2, h.p3, h.o, h.c]) expect(listed.get(t.id)!.shownIn, `thread ${t.id}`).toBeUndefined();
    // The merged PR's own list has it too, on its diff, and the branch's review no longer does.
    expect(byId(await h.ok('list_threads', { repo: 'alice/app', pr: 3 })).get(h.b1.id)).toMatchObject({ shownIn: 'alice/app#3', placement: { kind: 'line', startLine: 3 } });
    expect(ids(await h.ok('list_threads', { repo: 'alice/app', branch: 'feature' }))).not.toContain(h.b1.id);
  });

  it("names the diff a scoped list placed a thread on, not the one that shows it elsewhere", async () => {
    const h = group();
    const app = "(SELECT id FROM repos WHERE key = 'alice/app')";
    // PR 2 was closed, then PR 3 merged: the branch thread made before both is in each one's line of work, and shown in 3's.
    h.db.run("UPDATE comment_threads SET created_at = '2026-09-01T00:00:00.000Z' WHERE id = ?", [h.b1.id]);
    h.db.run(`UPDATE pull_requests SET state = 'closed', closed_at = '2026-09-01T12:00:00Z' WHERE repo_id = ${app} AND number = 2`);
    h.db.run(`UPDATE pull_requests SET state = 'merged', merged_at = '2026-09-02T12:00:00Z', closed_at = '2026-09-02T12:00:00Z' WHERE repo_id = ${app} AND number = 3`);
    servePr(h.code, 'alice/app', 3, HEAD3, BASE, [addedFile('src/a.ts', ['zero', 'one', 'two'])]);
    // Listed with PR 2: on PR 2's diff (line 2), and named so; PR 3's diff has it on line 3.
    expect(byId(await h.ok('list_threads', { repo: 'alice/app', pr: 2 })).get(h.b1.id)).toMatchObject({ shownIn: 'alice/app#2', placement: { kind: 'line', startLine: 2 } });
    expect(byId(await h.ok('list_threads', { repo: 'alice/app', pr: 3 })).get(h.b1.id)).toMatchObject({ shownIn: 'alice/app#3', placement: { kind: 'line', startLine: 3 } });
    // Unscoped, each is where it is shown.
    expect(byId(await h.ok('list_threads', { repo: 'alice/app' })).get(h.b1.id)).toMatchObject({ shownIn: 'alice/app#3', placement: { kind: 'line', startLine: 3 } });
    // A PR's own thread listed with the PR is on it, and says nothing more.
    expect(byId(await h.ok('list_threads', { repo: 'alice/app', pr: 2 })).get(h.p2.id)!.shownIn).toBeUndefined();
  });
});
