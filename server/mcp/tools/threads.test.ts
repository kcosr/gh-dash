import { describe, expect, it } from 'vitest';
import * as comments from '../../services/comments';
import { selfPrincipal } from '../../services/comments';
import { addedFile, mcpHarness, servePr, sha } from '../../test/mcp';
import { GITLAB_HOST, seedDb, seedGitLab } from '../../test/seed';

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
    expect(await h.fails('list_threads', { pr: 2 })).toContain('pr and commit need repo');
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
