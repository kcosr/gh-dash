import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread, ThreadListResponse } from './api';
import { followsDefaultSelection, patchThreadLists, qk, refetchAfterSync, threadActions } from '../web/src/api/hooks';

const thread = (id: number, status: CommentThread['status'] = 'open'): CommentThread => ({
  id, kind: 'pr', repo: 'app', number: 2, commitOid: 'a'.repeat(40), baseOid: null, path: null, side: null, startLine: null, endLine: null,
  snippet: null, status, resolvedAt: null, createdAt: '', updatedAt: '', comments: [],
});

/** A list fetch that read the threads before a change, and answers after it. */
function staleFetch(qc: QueryClient, key: readonly unknown[], answer: CommentThread[]) {
  let release!: () => void;
  const done = qc.fetchQuery({ queryKey: key, queryFn: () => new Promise<CommentThread[]>((r) => { release = () => r(answer); }), staleTime: 0 }).catch(() => null);
  return async () => { release(); await done; };
}

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('thread actions', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const key = qk.threads('app#2');

  it('a list fetch in flight when a thread is deleted does not bring it back', async () => {
    const qc = new QueryClient();
    qc.setQueryData(key, [thread(1), thread(2)]);
    const settle = staleFetch(qc, key, [thread(1), thread(2)]);
    vi.stubGlobal('fetch', reply(null, 204));
    await threadActions(qc, 'app#2').deleteThread(2);
    await settle();
    expect(qc.getQueryData<CommentThread[]>(key)?.map((t) => t.id)).toEqual([1]);
  });

  it('nor undoes a status change', async () => {
    const qc = new QueryClient();
    qc.setQueryData(key, [thread(1)]);
    const settle = staleFetch(qc, key, [thread(1, 'open')]);
    vi.stubGlobal('fetch', reply(thread(1, 'resolved')));
    await threadActions(qc, 'app#2').setStatus(1, 'resolved');
    await settle();
    expect(qc.getQueryData<CommentThread[]>(key)?.map((t) => t.status)).toEqual(['resolved']);
  });

  it('marks the list stale afterwards, so a watched list is fetched again', async () => {
    const qc = new QueryClient();
    qc.setQueryData(key, [thread(1)]);
    vi.stubGlobal('fetch', reply(thread(1, 'resolved')));
    await threadActions(qc, 'app#2').setStatus(1, 'resolved');
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("refetches repos' comment counts when comments come or go, on PRs and commits alike", async () => {
    const qc = new QueryClient();
    const repos = () => qc.getQueryState(qk.repos)?.isInvalidated;
    const fresh = () => qc.setQueryData(qk.repos, { items: [] });
    const commit = `app@${'a'.repeat(64)}`;
    const cases: [string, (a: ReturnType<typeof threadActions>) => Promise<unknown>, unknown, number?][] = [
      ['app#2', (a) => a.create({ body: 'x' } as never), thread(1)],
      [commit, (a) => a.create({ body: 'x' } as never), { ...thread(1), kind: 'commit' }],
      [commit, (a) => a.reply(1, 'x'), thread(1)],
      ['app#2', (a) => a.deleteComment(1, 5), { thread: null }],
      [commit, (a) => a.deleteThread(1), null, 204],
    ];
    for (const [id, act, body, status] of cases) {
      fresh();
      vi.stubGlobal('fetch', reply(body, status));
      await act(threadActions(qc, id));
      expect(repos(), id).toBe(true);
    }
    // A status change or an edit leaves the counts alone.
    fresh();
    vi.stubGlobal('fetch', reply(thread(1, 'resolved')));
    await threadActions(qc, commit).setStatus(1, 'resolved');
    await threadActions(qc, 'app#2').edit(5, 'y');
    expect(repos()).toBe(false);
  });

  it('refetches the Comments list and the tab count after any change, from the diff or the list', async () => {
    const qc = new QueryClient();
    const list = qk.threadList({ status: 'open', limit: 1000 });
    const count = qk.threadList({ source: 'github.com', status: 'open', limit: 1 });
    const stale = () => [list, count].map((k) => qc.getQueryState(k)?.isInvalidated);
    const fresh = () => { for (const k of [list, count]) qc.setQueryData(k, { items: [], total: 0, nextCursor: null, counts: { open: 0, resolved: 0 } }); };
    const commit = `app@${'a'.repeat(40)}`;
    const cases: [string, (a: ReturnType<typeof threadActions>) => Promise<unknown>, unknown, number?][] = [
      ['app#2', (a) => a.setStatus(1, 'resolved'), thread(1, 'resolved')],
      [commit, (a) => a.setStatus(1, 'open'), { ...thread(1), kind: 'commit' }],
      [commit, (a) => a.create({ body: 'x' } as never), { ...thread(1), kind: 'commit' }],
      ['app#2', (a) => a.reply(1, 'x'), thread(1)],
      ['app#2', (a) => a.edit(5, 'y'), thread(1)],
      [commit, (a) => a.deleteThread(1), null, 204],
    ];
    for (const [id, act, body, status] of cases) {
      fresh();
      vi.stubGlobal('fetch', reply(body, status));
      await act(threadActions(qc, id));
      expect(stale(), id).toEqual([true, true]);
    }
  });

  it("gives a target whose threads aren't loaded no partial list (a change from the Comments list)", async () => {
    const qc = new QueryClient();
    vi.stubGlobal('fetch', reply(thread(1, 'resolved')));
    await threadActions(qc, 'app#2').setStatus(1, 'resolved');
    expect(qc.getQueryData(key)).toBeUndefined();
    vi.stubGlobal('fetch', reply(null, 204));
    await threadActions(qc, 'app#2').deleteThread(1);
    expect(qc.getQueryData(key)).toBeUndefined();
    // A loaded one is updated in place.
    qc.setQueryData(key, [thread(1), thread(2)]);
    vi.stubGlobal('fetch', reply(thread(2, 'resolved')));
    await threadActions(qc, 'app#2').setStatus(2, 'resolved');
    expect(qc.getQueryData<CommentThread[]>(key)?.map((t) => t.status)).toEqual(['open', 'resolved']);
  });

  it('refetches the Comments list after a sync, and when the default selection changes', () => {
    const q = (queryKey: readonly unknown[]) => ({ queryKey }) as never;
    expect(refetchAfterSync(q(qk.threadList({ status: 'open' })))).toBe(true);
    expect(followsDefaultSelection(q(qk.threadList({ status: 'open' })))).toBe(true);
    expect(refetchAfterSync(q(qk.threads('app#2')))).toBe(false);
  });

  it("refetches the Activity feed's PR and commit counts when a thread comes or goes or changes status", async () => {
    const qc = new QueryClient();
    const feed = qk.activity({ who: 'everyone', limit: 200 });
    const stale = () => qc.getQueryState(feed)?.isInvalidated;
    const fresh = () => qc.setQueryData(feed, { pages: [], pageParams: [] });
    const commit = `app@${'a'.repeat(40)}`;
    const counted: [string, (a: ReturnType<typeof threadActions>) => Promise<unknown>, unknown, number?][] = [
      ['app#2', (a) => a.create({ body: 'x' } as never), thread(1)],
      [commit, (a) => a.create({ body: 'x' } as never), { ...thread(1), kind: 'commit' }],
      ['app#2', (a) => a.setStatus(1, 'resolved'), thread(1, 'resolved')],
      [commit, (a) => a.setStatus(1, 'open'), { ...thread(1), kind: 'commit' }],
      [commit, (a) => a.deleteThread(1), null, 204],
      ['app#2', (a) => a.deleteComment(1, 5), { thread: null }],
    ];
    for (const [id, act, body, status] of counted) {
      fresh();
      vi.stubGlobal('fetch', reply(body, status));
      await act(threadActions(qc, id));
      expect(stale(), id).toBe(true);
    }
    // A reply, an edit, or deleting a reply leaves the counts (threads, unresolved) as they were.
    const same: [string, (a: ReturnType<typeof threadActions>) => Promise<unknown>, unknown][] = [
      ['app#2', (a) => a.reply(1, 'x'), thread(1)],
      [commit, (a) => a.edit(5, 'y'), thread(1)],
      [commit, (a) => a.deleteComment(1, 6), { thread: thread(1) }],
    ];
    for (const [id, act, body] of same) {
      fresh();
      vi.stubGlobal('fetch', reply(body));
      await act(threadActions(qc, id));
      expect(stale(), id).toBe(false);
    }
  });

  it('patches a status into every cached Comments list at once, and leaves each stale, so another filter refetches', () => {
    const qc = new QueryClient();
    const unresolved = qk.threadList({ status: 'open' });
    const resolved = qk.threadList({ status: 'resolved' });
    const item = { ...thread(1), targetTitle: null, prState: null, targetUrl: 'u', earlierPush: false };
    // Resolved was visited first (empty), then Unresolved; both answers are fresh.
    qc.setQueryData<ThreadListResponse>(resolved, { items: [], total: 0, nextCursor: null, counts: { open: 1, resolved: 0 } });
    qc.setQueryData<ThreadListResponse>(unresolved, { items: [item], total: 1, nextCursor: null, counts: { open: 1, resolved: 0 } });
    patchThreadLists(qc, thread(1, 'resolved'));
    expect(qc.getQueryData<ThreadListResponse>(unresolved)!.items[0]!.status).toBe('resolved');
    // Selecting Resolved again must fetch it: it lacks the thread it has gained.
    expect(qc.getQueryState(resolved)!.isInvalidated).toBe(true);
    expect(qc.getQueryState(unresolved)!.isInvalidated).toBe(true);
  });
});
