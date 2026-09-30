import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal, StreamMessage } from './api';
import { qk } from '../web/src/api/hooks';
import {
  STREAM_URL, applyStreamMessage, missedByStream, parseStreamMessage, retryDelay, runStream, sseParser, streamInvalidations,
} from '../web/src/api/stream';
import {
  FOLLOW_KEY, MAX_CHIPS, addChip, getFollowAgents, noteShow, openShown, setFollowAgents, showDiffId, showPatch, showPhrase, showWhat,
} from '../web/src/lib/show';
import type { OpenDeps, OpenPlace } from '../web/src/lib/show';
import type { ShowChip } from '../web/src/lib/show';
import { parseUrlState, patchSearch } from '../web/src/lib/urlState';

const agent: Principal = { id: 3, kind: 'agent', name: 'Claude' };
const OID = 'c'.repeat(40);

const comments = (o: Partial<Extract<StreamMessage, { type: 'comments' }>> = {}): StreamMessage =>
  ({ type: 'comments', repo: 'alice/app', kind: 'pr', number: 7, branch: null, commitOid: OID, threadId: 5, event: 'replied', by: agent, ...o });

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

  it("reaches a branch group whole: a branch's thread, or a PR's from a branch, refetches every thread list of the repo, its PRs and the branches with no PR", () => {
    const branch = comments({ kind: 'branch', number: null, branch: 'fix/login', event: 'resolved' });
    expect(streamInvalidations(branch)).toEqual([qk.threadsIn('alice/app'), ['thread-list'], ['prs'], qk.prsIn('alice/app'), ['branch-list'], ['activity']]);
    // A PR from a branch of the same repo: its branch's review lists the thread too, and the other PRs from it.
    expect(streamInvalidations(comments({ branch: 'fix/login', event: 'replied' }))).toEqual([
      qk.threadsIn('alice/app'), ['thread-list'], ['prs'], qk.prsIn('alice/app'), ['branch-list'], ['activity'], qk.repos,
    ]);
  });

  it("marks the branch's list, its PRs' lists and details stale, and no other repo's", () => {
    const qc = new QueryClient();
    const keys = [
      qk.threads('alice/app~fix/login'), qk.threads('alice/app#7'), qk.threads('alice/app#8'), qk.threads(`alice/app@${OID}`), qk.threads('alice/lib#7'),
      qk.pr('alice/app', 7), qk.pr('alice/lib', 7), qk.branches('alice/app', ''), qk.branchList({ who: 'me' }),
    ];
    for (const k of keys) qc.setQueryData(k, {});
    applyStreamMessage(qc, comments({ kind: 'branch', number: null, branch: 'fix/login', event: 'thread_opened' }));
    const stale = keys.filter((k) => qc.getQueryState(k)?.isInvalidated);
    // The branches with no PR count its threads; a repo's branch list (from the host or the sync) has none to count.
    expect(stale).toEqual([
      qk.threads('alice/app~fix/login'), qk.threads('alice/app#7'), qk.threads('alice/app#8'), qk.threads(`alice/app@${OID}`), qk.pr('alice/app', 7),
      qk.branchList({ who: 'me' }),
    ]);
  });

  it('refetches the agents list on `agents`, nothing on `show`', () => {
    expect(streamInvalidations({ type: 'agents' })).toEqual([qk.agents]);
    expect(streamInvalidations({ type: 'show', id: 'x', agent, target: { repo: 'alice/app', pr: 7 }, message: null, at: '' })).toEqual([]);
  });

  it("refetches what names comments' authors too once an agent is deleted: they're by \"Deleted agent #<id>\" now", () => {
    const qc = new QueryClient();
    const keys = [qk.threads('alice/app#7'), qk.threadList({ status: 'open' }), qk.activity({ limit: 200 }), qk.pr('alice/app', 7), qk.prs({ state: 'open' }), qk.repos, qk.agents];
    for (const k of keys) qc.setQueryData(k, {});
    applyStreamMessage(qc, { type: 'agents' });
    expect(keys.filter((k) => qc.getQueryState(k)?.isInvalidated)).toEqual([qk.agents]);
    applyStreamMessage(qc, { type: 'agents', deleted: 4 });
    expect(keys.filter((k) => qc.getQueryState(k)?.isInvalidated)).toEqual([qk.threads('alice/app#7'), qk.threadList({ status: 'open' }), qk.activity({ limit: 200 }), qk.agents]);
    expect(parseStreamMessage(JSON.stringify({ type: 'agents', deleted: 4 }))).toEqual({ type: 'agents', deleted: 4 });
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
    for (const k of [qk.threads('a#1'), qk.threadList({}), qk.prs({}), qk.pr('a', 1), qk.branchList({}), qk.repos, qk.activity({}), qk.agents]) expect(missedByStream(k), String(k[0])).toBe(true);
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

  it("doesn't pile up abort listeners over a long outage (one per wait, gone when the wait ends)", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const ctl = new AbortController();
    // Abort listeners on the signal: added less removed.
    let listening = 0;
    const add = ctl.signal.addEventListener.bind(ctl.signal);
    const remove = ctl.signal.removeEventListener.bind(ctl.signal);
    ctl.signal.addEventListener = ((type: string, fn: EventListener, o?: AddEventListenerOptions) => { if (type === 'abort') listening++; add(type, fn, o); }) as typeof ctl.signal.addEventListener;
    ctl.signal.removeEventListener = ((type: string, fn: EventListener) => { if (type === 'abort') listening--; remove(type, fn); }) as typeof ctl.signal.removeEventListener;
    const run = runStream({ onMessage: () => {}, onReconnect: () => {} }, ctl.signal, { fetch: fetchFn as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(24 * 30_000);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(24);
    expect(listening).toBeLessThanOrEqual(1);
    ctl.abort();
    await run;
    expect(listening).toBe(0);
    vi.useRealTimers();
  });

  it('retries a busy server (503) like a gateway error, after its Retry-After when longer', async () => {
    expect(retryDelay(0, 503)).toBe(1000);
    expect(retryDelay(2, 503)).toBe(4000);
    expect(retryDelay(0, 503, 20)).toBe(20_000);
    expect(retryDelay(4, 503, 2)).toBe(16_000);
    // Never longer than a 4xx's wait.
    expect(retryDelay(0, 503, 3600)).toBe(5 * 60_000);
    vi.useFakeTimers();
    const enc = new TextEncoder();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"Too many streams"}', { status: 503, headers: { 'retry-after': '5' } }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"type":"agents"}\n\n'));
          init.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockImplementation(hang);
    const got: string[] = [];
    const ctl = new AbortController();
    const run = runStream({ onMessage: (m) => got.push(m.type), onReconnect: () => {} }, ctl.signal, { fetch: fetchFn as typeof fetch });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(got).toEqual(['agents']);
    ctl.abort();
    await run;
    vi.useRealTimers();
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
    // A branch, as the diff param names it: its name may hold '#' or '@'.
    expect(showDiffId({ repo: 'alice/app', branch: 'fix/a#1' })).toBe('alice/app~fix/a#1');
    const none = { diff: null, only: null };
    expect(showPatch({ repo: 'alice/app', branch: 'fix/login', threadId: 5, path: 'src/a.ts' }, none)).toEqual({ diff: 'alice/app~fix/login', thread: 5, file: 'src/a.ts', only: null });
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
    expect(patchSearch('?state=open', 'prs', showPatch({ repo: 'alice/app', branch: 'fix/login', threadId: 5 }, { diff: null, only: null })!)).toBe('?state=open&diff=alice/app~fix/login&thread=5');
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
    expect(w({ repo: 'alice/app', branch: 'fix/login', threadId: 5 }, { path: 'src/host.ts', startLine: 42, endLine: 42 })).toBe('host.ts:42 on app branch fix/login');
    expect(w({ repo: 'alice/app', branch: 'fix/login' })).toBe('app branch fix/login');
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

describe('show: opening, and giving up when superseded', () => {
  /** A window at `search` on `pathname`; the threads refetch waits until `release()`. */
  function windowAt(search: string, pathname = '/comments') {
    let at = { pathname, search };
    const place = (): OpenPlace => ({ s: parseUrlState(at.search, 'comments'), ...at });
    const releases: (() => void)[] = [];
    const d: OpenDeps & { go: (search: string, pathname?: string) => void; release: () => Promise<void> } = {
      place,
      set: vi.fn((patch) => { at = { ...at, search: patchSearch(at.search, 'comments', patch) }; }),
      navigate: vi.fn(),
      refetchThreads: vi.fn(() => new Promise<void>((r) => releases.push(r))),
      nudge: vi.fn(),
      go: (next, p = at.pathname) => { at = { pathname: p, search: next }; },
      release: async () => { releases.shift()?.(); await new Promise((r) => setTimeout(r, 0)); },
    };
    return d;
  }
  const OPEN = '?diff=alice/app%237&thread=1';

  it('opens another diff at once, and the one already open after refetching its threads (then goes there again)', async () => {
    const d = windowAt('?status=all');
    expect(await openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 })).toBe(true);
    expect(d.set).toHaveBeenCalledWith({ diff: 'alice/app#7', thread: 5, file: null, only: null });
    expect(d.refetchThreads).not.toHaveBeenCalled();
    const e = windowAt(OPEN);
    const p = openShown(e, { repo: 'alice/app', pr: 7, threadId: 5 });
    expect(e.set).not.toHaveBeenCalled();
    await e.release();
    expect(await p).toBe(true);
    expect(e.refetchThreads).toHaveBeenCalledWith('alice/app#7');
    expect(e.set).toHaveBeenCalledWith({ diff: 'alice/app#7', thread: 5, file: null, only: null });
    expect(e.nudge).toHaveBeenCalledTimes(1);
    // A repo alone: its page, in the context.
    const f = windowAt('?source=github.com&state=open', '/prs');
    expect(await openShown(f, { repo: 'alice/app' })).toBe(true);
    expect(f.navigate).toHaveBeenCalledWith('/repos/alice/app?source=github.com');
  });

  it('gives up when the window moved on during the wait (not when the diff only reported its file)', async () => {
    const d = windowAt(OPEN);
    const p = openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 });
    d.go('?diff=alice/app%239');
    await d.release();
    expect(await p).toBe(false);
    expect(d.set).not.toHaveBeenCalled();
    const e = windowAt(OPEN, '/comments');
    const q = openShown(e, { repo: 'alice/app', pr: 7, threadId: 5 });
    e.go(OPEN, '/activity');
    await e.release();
    expect(await q).toBe(false);
    // The diff reporting the file in view as it scrolls is not moving on.
    const f = windowAt(OPEN);
    const r = openShown(f, { repo: 'alice/app', pr: 7, threadId: 5 });
    f.go(`${OPEN}&file=src/a.ts`);
    await f.release();
    expect(await r).toBe(true);
  });

  it('gives way to a newer open', async () => {
    const d = windowAt(OPEN);
    const older = openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 });
    const newer = openShown(d, { repo: 'alice/app', pr: 8, threadId: 6 });
    expect(await newer).toBe(true);
    await d.release();
    expect(await older).toBe(false);
    expect(d.set).toHaveBeenCalledTimes(1);
    expect(d.set).toHaveBeenCalledWith({ diff: 'alice/app#8', thread: 6, file: null, only: null });
  });

  it('asks again whether it may open automatically, and gives way to a newer show, after the wait', async () => {
    let may = true;
    const d = windowAt(OPEN);
    const p = openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 }, () => may);
    may = false; // you started typing, or turned following off
    await d.release();
    expect(await p).toBe(false);
    may = true;
    const q = openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 }, () => may);
    noteShow(); // another show came, offered as a chip
    await d.release();
    expect(await q).toBe(false);
    expect(d.set).not.toHaveBeenCalled();
    // An Open you clicked isn't cancelled by a chip arriving meanwhile.
    const r = openShown(d, { repo: 'alice/app', pr: 7, threadId: 5 });
    noteShow();
    await d.release();
    expect(await r).toBe(true);
  });
});
