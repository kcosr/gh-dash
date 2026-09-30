import { describe, expect, it } from 'vitest';
import type { StreamMessage } from '../../../shared/api';
import { upsertPr } from '../../db/write';
import { selfPrincipal } from '../../services/comments';
import * as comments from '../../services/comments';
import { addedFile, blobKey, commitDiff, mcpHarness, servePr, sha } from '../../test/mcp';
import { actor, GITLAB_HOST, prRecord, seedDb, seedGitLab } from '../../test/seed';

const HEAD = sha('a');
const BASE = sha('b');
const EARLIER = sha('e');
const FILE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** alice/app#2 at HEAD over BASE: src/a.ts adds three lines at the top; src/gone.ts is removed; src/new.ts is added. */
function setup(db = seedDb()) {
  const h = mcpHarness({ db });
  const app = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
  upsertPr(h.db, app, prRecord(2, {
    state: 'open', createdAt: '2026-09-22T09:00:00Z', author: actor('bob'), title: 'Add parser', headOid: HEAD,
    commits: [{ oid: EARLIER, headline: 'first push', committedAt: '2026-09-22T08:00:00Z', url: 'u', author: actor('bob') }],
  }));
  servePr(h.code, 'alice/app', 2, HEAD, BASE, [
    addedFile('src/a.ts', ['one', 'two', 'three']),
    { path: 'src/gone.ts', previousPath: null, status: 'removed', additions: 0, deletions: 1, patch: '@@ -1,1 +0,0 @@\n-bye' },
    addedFile('src/new.ts', ['fresh'], { status: 'added' }),
    { path: 'src/moved.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-was\n+is\n same' },
  ]);
  const events: StreamMessage[] = [];
  h.bus.subscribe((m) => events.push(m));
  return { ...h, events };
}

describe('add_comment', () => {
  it('anchors lines of the head from the patch, and places the new thread there', async () => {
    const h = setup();
    const t = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Why these?', path: 'src/a.ts', start_line: 2, end_line: 3 });
    expect(t).toMatchObject({
      repo: 'alice/app', ref: 'alice/app#2', target: { kind: 'pr', number: 2, title: 'Add parser' }, status: 'open', resolvedBy: null,
      anchor: { commit: HEAD, base: BASE, path: 'src/a.ts', side: 'new', startLine: 2, endLine: 3, snippet: 'two\nthree' },
      placement: { kind: 'line', startLine: 2, endLine: 3, relocated: false },
      openedBy: 'me', counts: { comments: 1 }, lastComment: { by: 'me', excerpt: 'Why these?' },
    });
    expect(h.code.requests.filter((r) => r.startsWith('blob'))).toEqual([]);
    // Recorded as the agent's, and announced.
    expect(h.db.get('SELECT kind, actor_id, thread_id FROM comment_events ORDER BY id DESC LIMIT 1')).toEqual({ kind: 'thread_opened', actor_id: h.agent.id, thread_id: t.id });
    expect(h.events).toMatchObject([{ type: 'comments', repo: 'alice/app', kind: 'pr', number: 2, threadId: t.id, event: 'thread_opened', by: { id: h.agent.id, kind: 'agent' } }]);
    // The user sees it as the agent's in the API.
    const api = await (await h.app.request(`http://localhost/api/v1/threads/${t.id}`)).json();
    expect(api.comments[0].author).toEqual({ id: h.agent.id, kind: 'agent', name: 'Claude' });
  });

  it('reads lines outside the patch from the file at the revision, and checks they exist', async () => {
    const h = setup();
    h.code.blobs.set(blobKey('alice/app', HEAD, 'src/a.ts'), FILE.replace('line 10', 'line 10\r'));
    const t = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Here', path: 'src/a.ts', start_line: 9, end_line: 10 });
    expect(t.anchor).toMatchObject({ startLine: 9, endLine: 10, snippet: 'line 9\nline 10' });
    expect(h.code.requests).toContain(`blob ${blobKey('alice/app', HEAD, 'src/a.ts')}`);
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/a.ts', start_line: 12, end_line: 13 })).toBe(
      `src/a.ts has 12 lines at ${HEAD.slice(0, 7)}: lines 12–13 aren't there`,
    );
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/a.ts', start_line: 5, end_line: 4 })).toBe('end_line must not be before start_line');
  });

  it("anchors the old side at the base, by a renamed file's old path", async () => {
    const h = setup();
    const removed = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Keep?', path: 'src/gone.ts', side: 'old', start_line: 1 });
    expect(removed.anchor).toMatchObject({ side: 'old', startLine: 1, endLine: 1, snippet: 'bye' });
    h.code.blobs.set(blobKey('alice/app', BASE, 'src/old.ts'), 'was\nsame\nthird\n');
    const renamed = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Hm', path: 'src/moved.ts', side: 'old', start_line: 3 });
    expect(renamed.anchor).toMatchObject({ path: 'src/moved.ts', side: 'old', startLine: 3, snippet: 'third' });
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/new.ts', side: 'old', start_line: 1 })).toContain('src/new.ts is new in alice/app#2: it has no old side');
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/gone.ts', start_line: 1 })).toContain('src/gone.ts is deleted in alice/app#2');
  });

  it('comments on a file of the diff, or the whole PR; a path outside the diff is refused', async () => {
    const h = setup();
    expect(await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'File note', path: 'src/a.ts' })).toMatchObject({
      anchor: { commit: HEAD, base: BASE, path: 'src/a.ts' }, placement: { kind: 'file' },
    });
    const general = await h.ok('add_comment', { repo: 'app', pr: 2, body: 'Overall fine.' });
    expect(general).toMatchObject({ anchor: { commit: HEAD, base: BASE }, placement: { kind: 'target' } });
    expect(general.anchor.path).toBeUndefined();
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/zzz.ts', start_line: 1 })).toBe(
      `src/zzz.ts isn't in alice/app#2's diff at ${HEAD.slice(0, 7)} (its files: src/a.ts, src/gone.ts, src/new.ts, src/moved.ts)`,
    );
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', start_line: 1 })).toBe('start_line needs a path');
    expect(await h.fails('add_comment', { repo: 'alice/app', body: 'x' })).toContain('exactly one of pr or commit');
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: '  ' })).toContain('must not be empty');
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 42, body: 'x' })).toContain("alice/app#42 isn't in gh-dash");
  });

  it('comments on an earlier push, and says to push a commit the host has not got', async () => {
    const h = setup();
    h.code.blobs.set(blobKey('alice/app', EARLIER, 'src/a.ts'), 'old one\nold two\n');
    const t = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Back then', path: 'src/a.ts', start_line: 2, at_commit: EARLIER.slice(0, 8) });
    expect(t.anchor).toMatchObject({ commit: EARLIER, base: null, startLine: 2, snippet: 'old two' });
    expect(t.placement).toBeUndefined();
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', at_commit: sha('7') })).toBe(
      `${sha('7')} isn't a commit of alice/app#2 that gh-dash knows. If it's local, push it first (gh-dash sees what the code host has), or comment on the PR head ${HEAD}.`,
    );
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/a.ts', side: 'old', start_line: 1, at_commit: EARLIER })).toContain('leave at_commit out');
  });

  it("falls back to the synced head without the diff, for comments that don't need it", async () => {
    const h = setup();
    h.code.down = 'No GitHub token';
    const t = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'General' });
    expect(t.anchor).toEqual({ commit: HEAD, base: null });
    expect(await h.fails('add_comment', { repo: 'alice/app', pr: 2, body: 'x', path: 'src/a.ts', start_line: 1 })).toContain("gh-dash can't get alice/app#2's diff (No GitHub token");
  });

  it('comments on commits: by short SHA, lines of the commit and of its parent; unknown commits need a push', async () => {
    const h = setup();
    const oid = sha('c');
    const parent = sha('d');
    h.code.commits.set(`alice/app@${oid}`, commitDiff(oid, parent, [addedFile('x.ts', ['x1', 'x2'])]));
    const t = await h.ok('add_comment', { repo: 'alice/app', commit: oid.slice(0, 9), body: 'On x', path: 'x.ts', start_line: 2 });
    expect(t).toMatchObject({ ref: `alice/app@${oid.slice(0, 7)}`, target: { kind: 'commit', oid }, anchor: { commit: oid, base: parent, snippet: 'x2' }, placement: { kind: 'line', startLine: 2 } });
    h.code.blobs.set(blobKey('alice/app', parent, 'x.ts'), 'p1\np2\n');
    expect((await h.ok('add_comment', { repo: 'alice/app', commit: oid, body: 'Before', path: 'x.ts', side: 'old', start_line: 2 })).anchor).toMatchObject({ side: 'old', snippet: 'p2' });
    expect(await h.fails('add_comment', { repo: 'alice/app', commit: sha('9'), body: 'x' })).toBe(`Commit ${sha('9')} isn't on GitHub: if it's local, push it first; else check the SHA`);
    expect(await h.fails('add_comment', { repo: 'alice/app', commit: oid, body: 'x', at_commit: HEAD })).toContain('leave at_commit out');
    // Without the host, a full SHA still takes a comment on the whole commit.
    h.code.down = 'No GitHub token';
    expect((await h.ok('add_comment', { repo: 'alice/app', commit: sha('f'), body: 'Blind' })).anchor).toEqual({ commit: sha('f'), base: null });
    expect(await h.fails('add_comment', { repo: 'alice/app', commit: 'fffffff', body: 'x' })).toContain('give its full SHA');
  });

  it("words a GitLab merge request's ref", async () => {
    const db = seedDb();
    seedGitLab(db);
    const h = setup(db);
    servePr(h.code, `${GITLAB_HOST}/platform/app`, 2, HEAD, BASE, [addedFile('a.ts', ['a'])]);
    expect(await h.ok('add_comment', { repo: `${GITLAB_HOST}/platform/app`, pr: 2, body: 'MR note' })).toMatchObject({ ref: `${GITLAB_HOST}/platform/app!2` });
  });
});

describe('reply, edit_comment, delete_comment, resolve_thread, reopen_thread', () => {
  /** A thread the user opened on alice/app#2, and one the agent opened. */
  async function threads() {
    const h = setup();
    const theirs = comments.createPrThread(h, selfPrincipal(h.db), 'alice/app', 2, { commitOid: HEAD, body: 'Please rename' });
    const mine = await h.ok('add_comment', { repo: 'alice/app', pr: 2, body: 'Is this right?' });
    return { ...h, theirs, mine };
  }

  it('replies as the agent, leaving the status alone', async () => {
    const h = await threads();
    const t = await h.ok('reply', { thread_id: h.theirs.id, body: 'Renamed in abc123.' });
    expect(t).toMatchObject({ id: h.theirs.id, status: 'open', openedBy: 'you', counts: { comments: 2 }, lastComment: { by: 'me', excerpt: 'Renamed in abc123.' } });
    expect(h.events.at(-1)).toMatchObject({ event: 'replied', threadId: h.theirs.id, by: { id: h.agent.id } });
    expect(await h.fails('reply', { thread_id: 9999, body: 'x' })).toBe('Thread not found');
  });

  it("edits and deletes the agent's own comments only", async () => {
    const h = await threads();
    const replied = comments.reply(h, h.other, h.theirs.id, "Codex's note");
    const codexComment = replied.comments.at(-1)!.id;
    const mineReply = (await h.ok('reply', { thread_id: h.theirs.id, body: 'Typo' })).lastComment.id;
    expect((await h.ok('edit_comment', { comment_id: mineReply, body: 'Fixed' })).lastComment).toMatchObject({ by: 'me', excerpt: 'Fixed' });
    expect(await h.fails('edit_comment', { comment_id: h.theirs.comments[0]!.id, body: 'x' })).toBe('You can only edit your own comments');
    expect(await h.fails('edit_comment', { comment_id: codexComment, body: 'x' })).toBe('You can only edit your own comments');
    expect(await h.fails('delete_comment', { comment_id: h.theirs.comments[0]!.id })).toBe('Only its author can delete this comment');
    const deleted = await h.ok('delete_comment', { comment_id: mineReply });
    expect(deleted).toMatchObject({ deleted: 'comment', thread: { id: h.theirs.id, counts: { comments: 2 } } });
    // Its own thread, all its own: deleting the first comment deletes the thread.
    expect(await h.ok('delete_comment', { comment_id: h.mine.lastComment.id })).toEqual({ deleted: 'thread' });
    expect(await h.fails('get_thread', { id: h.mine.id })).toBe('Thread not found');
  });

  it("won't delete a thread of its own once someone else has written in it", async () => {
    const h = await threads();
    comments.reply(h, selfPrincipal(h.db), h.mine.id, 'Yes, right.');
    expect(await h.fails('delete_comment', { comment_id: h.mine.lastComment.id })).toContain('Deleting the first comment deletes the thread');
  });

  it('resolves and reopens any thread, with a reply first', async () => {
    const h = await threads();
    const resolved = await h.ok('resolve_thread', { thread_id: h.theirs.id, comment: 'Done in the latest push.' });
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'me', counts: { comments: 2 }, lastComment: { by: 'me', excerpt: 'Done in the latest push.' } });
    expect(h.events.slice(-2).map((e) => e.type === 'comments' && e.event)).toEqual(['replied', 'resolved']);
    // Again: nothing changes, and nothing is recorded.
    const before = h.db.get<{ n: number }>('SELECT count(*) AS n FROM comment_events')!.n;
    expect(await h.ok('resolve_thread', { thread_id: h.theirs.id })).toMatchObject({ status: 'resolved' });
    expect(h.db.get<{ n: number }>('SELECT count(*) AS n FROM comment_events')!.n).toBe(before);
    expect(await h.ok('reopen_thread', { thread_id: h.theirs.id })).toMatchObject({ status: 'open', resolvedBy: null });
    // The user resolves: the agent reads it as "you".
    comments.setThreadStatus(h, selfPrincipal(h.db), h.mine.id, 'resolved');
    expect((await h.ok('get_thread', { id: h.mine.id })).resolvedBy).toBe('you');
  });
});
