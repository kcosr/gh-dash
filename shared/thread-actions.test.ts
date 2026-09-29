import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread } from './api';
import { qk, threadActions } from '../web/src/api/hooks';

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
});
