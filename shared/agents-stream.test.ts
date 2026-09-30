import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal, StreamMessage } from './api';
import { qk } from '../web/src/api/hooks';
import {
  STREAM_URL, applyStreamMessage, missedByStream, parseStreamMessage, retryDelay, runStream, sseParser, streamInvalidations,
} from '../web/src/api/stream';
import {
  FOLLOW_KEY, MAX_CHIPS, addChip, getFollowAgents, setFollowAgents, showDiffId, showPatch, showPhrase, showWhat,
} from '../web/src/lib/show';
import type { ShowChip } from '../web/src/lib/show';
import { parseUrlState, patchSearch } from '../web/src/lib/urlState';

const agent: Principal = { id: 3, kind: 'agent', name: 'Claude' };
const OID = 'c'.repeat(40);

const comments = (o: Partial<Extract<StreamMessage, { type: 'comments' }>> = {}): StreamMessage =>
  ({ type: 'comments', repo: 'alice/app', kind: 'pr', number: 7, commitOid: OID, threadId: 5, event: 'replied', by: agent, ...o });

describe('the stream: what a message refetches', () => {
  it("refetches what threadActions does after the same change: the target's threads, the lists, the PR, the feed", () => {
    expect(streamInvalidations(comments({ event: 'edited' }))).toEqual([
      qk.threads('alice/app#7'), ['thread-list'], ['prs'], qk.pr('alice/app', 7), ['activity'],
    ]);
    // Comments came or went: repos' comment counts too.
    for (const event of ['thread_opened', 'replied', 'comment_deleted', 'thread_deleted'] as const) {
      expect(streamInvalidations(comments({ event })), event).toContainEqual(qk.repos);
    }
    for (const event of ['edited', 'resolved', 'reopened'] as const) {
      expect(streamInvalidations(comments({ event })), event).not.toContainEqual(qk.repos);
    }
  });

  it("names a commit's threads by the full oid, and leaves PR lists alone for it", () => {
    expect(streamInvalidations(comments({ kind: 'commit', number: null, event: 'resolved' }))).toEqual([
      qk.threads(`alice/app@${OID}`), ['thread-list'], ['activity'],
    ]);
  });

  it('refetches the agents list on `agents`, nothing on `show`', () => {
    expect(streamInvalidations({ type: 'agents' })).toEqual([qk.agents]);
    expect(streamInvalidations({ type: 'show', id: 'x', agent, target: { repo: 'alice/app', pr: 7 }, message: null, at: '' })).toEqual([]);
  });

  it('marks exactly those queries stale in the cache', () => {
    const qc = new QueryClient();
    const keys = [qk.threads('alice/app#7'), qk.threads('alice/app#8'), qk.threadList({ status: 'open' }), qk.pr('alice/app', 7), qk.pr('alice/app', 8), qk.prs({ state: 'open' }), qk.activity({ limit: 200 }), qk.repos, qk.agents];
    for (const k of keys) qc.setQueryData(k, {});
    applyStreamMessage(qc, comments({ event: 'resolved' }));
    const stale = keys.filter((k) => qc.getQueryState(k)?.isInvalidated);
    expect(stale).toEqual([qk.threads('alice/app#7'), qk.threadList({ status: 'open' }), qk.pr('alice/app', 7), qk.prs({ state: 'open' }), qk.activity({ limit: 200 })]);
  });

  it('after a reconnect refetches everything a missed message could have touched', () => {
    for (const k of [qk.threads('a#1'), qk.threadList({}), qk.prs({}), qk.pr('a', 1), qk.repos, qk.activity({}), qk.agents]) expect(missedByStream(k), String(k[0])).toBe(true);
    for (const k of [qk.diff('a#1'), qk.settings, qk.sync, qk.stats({}), qk.blob('a', 'r', 'p')]) expect(missedByStream(k), String(k[0])).toBe(false);
  });

  it("parses messages, and ignores what it doesn't know", () => {
    expect(parseStreamMessage(JSON.stringify({ type: 'agents' }))).toEqual({ type: 'agents' });
    expect(parseStreamMessage('{"type":"later"}')).toBeNull();
    expect(parseStreamMessage('not json')).toBeNull();
    expect(parseStreamMessage('null')).toBeNull();
  });
});

/** A fetch that never answers, until aborted. */
const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

describe('the stream: server-sent events', () => {
  it('dispatches each event at its blank line, joining data lines, across chunks of any size', () => {
    const got: string[] = [];
    const feed = sseParser((d) => got.push(d));
    const text = ': ping\n\ndata: {"a":1}\n\nevent: x\nid: 4\ndata:one\ndata: two\n\nretry: 10\n\n';
    for (const ch of text) feed(ch);
    expect(got).toEqual(['{"a":1}', 'one\ntwo']);
  });

  it('takes CRLF and CR line ends, also split between chunks', () => {
    const got: string[] = [];
    const feed = sseParser((d) => got.push(d));
    feed('data: a\r');
    feed('\n\r');
    feed('\ndata: b\r\r');
    // A CR at the end may be half a CRLF: the event waits for what follows.
    expect(got).toEqual(['a']);
    feed('data: c\n\n');
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('waits longer after an answer that will not change soon than after a drop', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelay(n, null))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(retryDelay(0, 502)).toBe(1000);
    expect(retryDelay(0, 404)).toBe(5 * 60_000);
    expect(retryDelay(3, 401)).toBe(5 * 60_000);
  });

  it('reads messages from the stream, reconnects after a drop, and says so', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    const answer = (chunks: string[]) => new Response(new ReadableStream({
      start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(answer(['data: {"type":"agents"}\n', '\n']))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(answer([`data: ${JSON.stringify(comments())}\n\n`]))
      .mockImplementation(hang);
    const got: string[] = [];
    let reconnects = 0;
    const ctl = new AbortController();
    const run = runStream({ onMessage: (m) => got.push(m.type), onReconnect: () => { reconnects++; } }, ctl.signal, { fetch: fetchFn as typeof fetch });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn.mock.calls[0]![0]).toBe(STREAM_URL);
    expect(got).toEqual(['agents', 'comments']);
    expect(reconnects).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    ctl.abort();
    await run;
    vi.useRealTimers();
  });

  it('counts the first connection as a reconnect when resumed (a tab back from the background)', async () => {
    const enc = new TextEncoder();
    // A stream that stays open until the request is aborted, as fetch's does.
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(': ping\n\n'));
        init.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const seen: boolean[] = [];
    for (const resumed of [false, true]) {
      const ctl = new AbortController();
      const run = runStream({ onMessage: () => {}, onReconnect: () => { seen.push(resumed); } }, ctl.signal, { resumed, fetch: fetchFn as typeof fetch });
      await new Promise((r) => setTimeout(r, 20));
      ctl.abort();
      await run;
    }
    expect(seen).toEqual([true]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("leaves a server without the stream alone for a while (an older one's 404, or its app page)", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValue(new Response('{"error":"Not found"}', { status: 404 }));
    const ctl = new AbortController();
    const run = runStream({ onMessage: () => {}, onReconnect: () => {} }, ctl.signal, { fetch: fetchFn as typeof fetch });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    ctl.abort();
    await run;
    vi.useRealTimers();
  });
});

describe('show: where a chip leads', () => {
  it('opens the diff at the thread, or at the file, as the Comments list does', () => {
    expect(showDiffId({ repo: 'alice/app', pr: 7 })).toBe('alice/app#7');
    expect(showDiffId({ repo: 'gitlab.example.com/alice/app', commit: OID })).toBe(`gitlab.example.com/alice/app@${OID}`);
    expect(showDiffId({ repo: 'alice/app' })).toBeNull();
    const none = { diff: null, only: null };
    expect(showPatch({ repo: 'alice/app', pr: 7, threadId: 5 }, none)).toEqual({ diff: 'alice/app#7', thread: 5, file: null, only: null });
    expect(showPatch({ repo: 'alice/app', commit: OID, path: 'src/a.ts' }, none)).toEqual({ diff: `alice/app@${OID}`, thread: null, file: 'src/a.ts', only: null });
    expect(showPatch({ repo: 'alice/app' }, none)).toBeNull();
  });

  it("keeps the open diff's file filter, not another diff's", () => {
    expect(showPatch({ repo: 'alice/app', pr: 7, threadId: 5 }, { diff: 'alice/app#7', only: 'unresolved' })?.only).toBe('unresolved');
    expect(showPatch({ repo: 'alice/app', pr: 7, threadId: 5 }, { diff: 'alice/app#8', only: 'unresolved' })?.only).toBeNull();
  });

  it('as a URL over the view you are on, which closing the diff returns to', () => {
    const search = '?status=all&diff=alice/app%238&file=README.md&only=commented';
    const next = patchSearch(search, 'comments', showPatch({ repo: 'alice/app', pr: 7, threadId: 5 }, parseUrlState(search, 'comments'))!);
    expect(next).toBe('?status=all&diff=alice/app%237&thread=5');
    expect(patchSearch(next, 'comments', { diff: null })).toBe('?status=all');
    expect(patchSearch('?state=open', 'prs', showPatch({ repo: 'alice/app', pr: 7, path: 'a b.ts' }, { diff: null, only: null })!)).toBe('?state=open&diff=alice/app%237&file=a%20b.ts');
  });

  it('names the place: the thread\'s lines when known, the file, a thread, or the PR or commit', () => {
    const o = { label: 'app', prRef: '#' };
    const w = (t: Parameters<typeof showWhat>[0], thread: Parameters<typeof showWhat>[1]['thread'] = null) => showPhrase(showWhat(t, { ...o, thread }));
    expect(w({ repo: 'alice/app', pr: 7, threadId: 5 }, { path: 'src/host.ts', startLine: 42, endLine: 44 })).toBe('host.ts:42–44 on app#7');
    expect(showWhat({ repo: 'alice/app', pr: 7, threadId: 5 }, { ...o, thread: { path: 'src/host.ts', startLine: 42, endLine: 44 } }).path).toBe('src/host.ts:42–44');
    expect(w({ repo: 'alice/app', pr: 7, threadId: 5 }, { path: null, startLine: null, endLine: null })).toBe('a comment on app#7');
    expect(w({ repo: 'alice/app', pr: 7, threadId: 5 })).toBe('a thread on app#7');
    expect(w({ repo: 'alice/app', pr: 7, path: 'src/a.ts' })).toBe('a.ts on app#7');
    expect(w({ repo: 'alice/app', pr: 7, path: 'README.md' })).toBe('README.md on app#7');
    expect(w({ repo: 'alice/app', commit: OID })).toBe('app@ccccccc');
    expect(showPhrase(showWhat({ repo: 'g/alice/app', pr: 3 }, { label: 'alice/app', prRef: '!' }))).toBe('alice/app!3');
    expect(w({ repo: 'alice/app' })).toBe('app');
  });

  it('stacks a few chips, newest last, one per show', () => {
    const chip = (id: string): ShowChip => ({ id, agent, target: { repo: 'a', pr: 1 }, message: null, at: '', opened: false });
    let list: ShowChip[] = [];
    for (const id of ['a', 'b', 'c', 'd']) list = addChip(list, chip(id));
    expect(list.map((c) => c.id)).toEqual(['b', 'c', 'd']);
    expect(MAX_CHIPS).toBe(3);
    expect(addChip(list, chip('c')).map((c) => c.id)).toEqual(['b', 'd', 'c']);
  });
});

describe('show: following agents', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is off until turned on, and kept in the browser', () => {
    expect(getFollowAgents()).toBe(false);
    setFollowAgents(true);
    expect(store.get(FOLLOW_KEY)).toBe('1');
    expect(getFollowAgents()).toBe(true);
    setFollowAgents(false);
    expect(store.has(FOLLOW_KEY)).toBe(false);
    expect(getFollowAgents()).toBe(false);
  });

  it('reads as off without storage (private mode)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} });
    expect(() => setFollowAgents(true)).not.toThrow();
    expect(getFollowAgents()).toBe(false);
  });
});
