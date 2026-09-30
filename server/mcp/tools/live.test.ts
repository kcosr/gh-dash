import { describe, expect, it } from 'vitest';
import type { StreamMessage } from '../../../shared/api';
import * as comments from '../../services/comments';
import { selfPrincipal } from '../../services/comments';
import { mcpHarness, sha } from '../../test/mcp';

const HEAD = sha('a');

function setup() {
  const h = mcpHarness();
  const deps = { db: h.db, bus: h.bus };
  const self = selfPrincipal(h.db);
  const mine = comments.createPrThread(deps, h.agent, 'alice/app', 2, { commitOid: HEAD, body: 'Does this read well?' });
  const other = comments.createPrThread(deps, self, 'alice/app', 3, { commitOid: HEAD, body: 'Elsewhere' });
  /** The user replies through the HTTP API, as the web app does. */
  const userReplies = (threadId: number, body: string) =>
    h.app.request(`http://localhost/api/v1/threads/${threadId}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    });
  const lastEvent = () => h.db.get<{ id: number }>('SELECT max(id) AS id FROM comment_events')!.id;
  return { ...h, deps, self, mine, other, userReplies, lastEvent };
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('wait_for_reply', () => {
  it('returns at once with what others did after the cursor, and a cursor to go on from', async () => {
    const h = setup();
    const cursor = h.lastEvent();
    await h.userReplies(h.mine.id, 'Yes, but shorten the second paragraph.');
    comments.reply(h.deps, h.agent, h.mine.id, 'Will do.');
    comments.setThreadStatus(h.deps, h.self, h.mine.id, 'resolved');
    const got = await h.ok('wait_for_reply', { thread_ids: [h.mine.id], after: cursor });
    expect(got.events).toEqual([
      { id: cursor + 1, kind: 'replied', threadId: h.mine.id, commentId: expect.any(Number), ref: 'alice/app#2', by: 'you', at: expect.any(String), excerpt: 'Yes, but shorten the second paragraph.', threadStatus: 'resolved' },
      { id: cursor + 3, kind: 'resolved', threadId: h.mine.id, ref: 'alice/app#2', by: 'you', at: expect.any(String), excerpt: 'Does this read well?', threadStatus: 'resolved' },
    ]);
    expect(got.cursor).toBe(cursor + 3);
  });

  it('waits for the next event by someone else in scope, and wakes at once', async () => {
    const h = setup();
    const started = Date.now();
    const waiting = h.ok('wait_for_reply', { repo: 'alice/app', pr: 2, timeout_s: 20 });
    await later(30);
    // Not these: its own reply, and the user's on another PR.
    comments.reply(h.deps, h.agent, h.mine.id, 'Also: see line 3.');
    await h.userReplies(h.other.id, 'Unrelated');
    await later(30);
    await h.userReplies(h.mine.id, 'Looks good now.');
    const got = await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(got.events).toMatchObject([{ kind: 'replied', by: 'you', excerpt: 'Looks good now.', threadStatus: 'open' }]);
    expect(got.cursor).toBe(h.lastEvent());
  });

  it('times out with no events and the cursor it started from', async () => {
    const h = setup();
    const cursor = h.lastEvent();
    const started = Date.now();
    comments.reply(h.deps, h.agent, h.mine.id, 'Mine does not count.');
    expect(await h.ok('wait_for_reply', { thread_ids: [h.mine.id], timeout_s: 1, after: cursor })).toEqual({ events: [], cursor });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('sees a thread deleted, and a thread opened, by the user', async () => {
    const h = setup();
    const cursor = h.lastEvent();
    const opened = comments.createPrThread(h.deps, h.self, 'alice/app', 2, { commitOid: HEAD, body: 'One more thing' });
    comments.deleteThread(h.deps, h.self, h.mine.id);
    const got = await h.ok('wait_for_reply', { repo: 'alice/app', after: cursor });
    expect(got.events.map((e: { kind: string; threadId: number; threadStatus: string }) => [e.kind, e.threadId, e.threadStatus])).toEqual([
      ['thread_opened', opened.id, 'open'],
      ['thread_deleted', h.mine.id, 'deleted'],
    ]);
    // A deleted thread may still be waited on (its events are there); one that never was is an error.
    expect((await h.ok('wait_for_reply', { thread_ids: [h.mine.id], after: cursor })).events).toHaveLength(1);
    expect(await h.fails('wait_for_reply', { thread_ids: [9999] })).toBe('Thread 9999 not found');
    expect(await h.fails('wait_for_reply', { pr: 2 })).toContain('pr and commit need repo');
    expect(await h.fails('wait_for_reply', { timeout_s: 301 })).toContain('timeout_s');
  });

  it("scopes to a commit's own threads by a short SHA, and pages past 50 events", async () => {
    const h = setup();
    const oid = sha('c');
    const onCommit = comments.createCommitThread(h.deps, h.agent, 'alice/app', oid, { body: 'On the commit' });
    const cursor = h.lastEvent();
    for (let i = 0; i < 51; i++) comments.reply(h.deps, h.self, onCommit.id, `Reply ${i}`);
    await h.userReplies(h.mine.id, 'On the PR');
    const first = await h.ok('wait_for_reply', { repo: 'alice/app', commit: oid.slice(0, 7), after: cursor });
    expect(first.events).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.events[0]).toMatchObject({ ref: `alice/app@${oid.slice(0, 7)}`, excerpt: 'Reply 0' });
    const rest = await h.ok('wait_for_reply', { repo: 'alice/app', commit: oid.slice(0, 7), after: first.cursor, timeout_s: 1 });
    expect(rest.events.map((e: { excerpt: string }) => e.excerpt)).toEqual(['Reply 50']);
    expect(rest.more).toBeUndefined();
    expect(await h.fails('wait_for_reply', { repo: 'alice/app', commit: 'fffffff' })).toContain('give its full SHA');
  });

  it('stops waiting on notifications/cancelled, from another request', async () => {
    const h = setup();
    const res = h.post({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'wait_for_reply', arguments: { timeout_s: 60 } } });
    await later(30);
    const note = await h.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w1', reason: 'user gave up' } });
    expect(note.status).toBe(202);
    const body = await (await res).json();
    expect(body).toMatchObject({ id: 'w1', result: { structuredContent: { events: [], cursor: h.lastEvent() } } });
  });

  it('stays cancellable when another call reuses its request id', async () => {
    const h = setup();
    const res = h.post({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'wait_for_reply', arguments: { timeout_s: 60 } } });
    await later(30);
    const dup = await (await h.post({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'whoami', arguments: {} } })).json();
    expect(dup).toMatchObject({ id: 'w1', error: { code: -32600, message: expect.stringContaining('still in progress') } });
    await h.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w1' } });
    expect(await (await res).json()).toMatchObject({ id: 'w1', result: { structuredContent: { events: [] } } });
  });

  it('stops waiting when the request goes away', async () => {
    const h = setup();
    const gone = new AbortController();
    let settled = false;
    const listeners = () => (h.bus as unknown as { subscribers: Set<unknown> }).subscribers.size;
    const before = listeners();
    const res = Promise.resolve(
      h.app.request('http://localhost/mcp', {
        method: 'POST',
        signal: gone.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_reply', arguments: { timeout_s: 60 } } }),
      }),
    ).finally(() => (settled = true));
    await later(30);
    expect(listeners()).toBe(before + 1);
    gone.abort();
    await res.catch(() => {});
    await later(10);
    expect(settled).toBe(true);
    expect(listeners()).toBe(before);
  });
});

describe('show', () => {
  /** Reads a stream's text until it holds `text` (false when it ends first). */
  async function until(reader: ReadableStreamDefaultReader<Uint8Array>, text: string) {
    const decoder = new TextDecoder();
    let got = '';
    while (!got.includes(text)) {
      const { value, done } = await reader.read();
      if (done) return null;
      got += decoder.decode(value);
    }
    return got;
  }

  it('reaches the windows listening on GET /stream, and says how many', async () => {
    const h = setup();
    expect(await h.ok('show', { thread_id: h.mine.id })).toEqual({ windows: 0, note: 'No gh-dash window is open: nothing was shown' });
    const window = new AbortController();
    const stream = await h.app.request('http://localhost/api/v1/stream', { signal: window.signal });
    const reader = stream.body!.getReader();
    await later(10);
    expect(await h.ok('show', { thread_id: h.mine.id, message: 'The wording I asked about' })).toEqual({ windows: 1 });
    const text = await until(reader, '"type":"show"');
    const data = JSON.parse(text!.split('\n').find((l) => l.startsWith('data: ') && l.includes('"show"'))!.slice(6)) as StreamMessage;
    expect(data).toEqual({
      type: 'show', id: expect.any(String), agent: { id: h.agent.id, kind: 'agent', name: 'Claude' },
      target: { repo: 'alice/app', pr: 2, threadId: h.mine.id }, message: 'The wording I asked about', at: expect.any(String),
    });
    window.abort();
  });

  it('shows a diff at a file, by PR or commit', async () => {
    const h = setup();
    const seen: StreamMessage[] = [];
    h.bus.subscribe((m) => seen.push(m), { window: true });
    h.bus.subscribe(() => {});
    expect(await h.ok('show', { repo: 'app', pr: 2, path: 'src/a.ts' })).toEqual({ windows: 1 });
    const oid = h.db.get<{ oid: string }>("SELECT oid FROM commits WHERE oid LIKE 'c3%'")!.oid;
    expect(await h.ok('show', { repo: 'alice/app', commit: oid.slice(0, 8) })).toEqual({ windows: 1 });
    expect(seen.map((m) => m.type === 'show' && m.target)).toEqual([{ repo: 'alice/app', pr: 2, path: 'src/a.ts' }, { repo: 'alice/app', commit: oid }]);
    expect(await h.fails('show', { repo: 'alice/app', commit: 'abcdef1' })).toContain('give its full SHA');
    expect(await h.fails('show', { repo: 'alice/app', pr: 77 })).toBe("alice/app#77 isn't in gh-dash");
    expect(await h.fails('show', { repo: 'alice/app' })).toContain('exactly one of pr or commit');
    expect(await h.fails('show', { thread_id: h.mine.id, path: 'x' })).toContain('thread_id goes alone');
    expect(await h.fails('show', {})).toContain('give thread_id, or repo');
  });
});
