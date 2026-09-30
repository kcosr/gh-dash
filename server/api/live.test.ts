import type { Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, StreamMessage } from '../../shared/api';
import { CommentBus } from '../comments/bus';
import { type Config, loadConfig } from '../config';
import { createAgent, deleteAgent, setAgentEnabled } from '../db/agents';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { seedDb } from '../test/seed';
import { testTokens } from '../test/tokens';
import { createApp } from './app';
import { MAX_STREAMS } from './routes/stream';

function makeApp(over: Partial<Config> = {}) {
  const db = seedDb();
  const config = { ...loadConfig({}), webDir: '/nonexistent', ...over };
  const tokens = testTokens();
  const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources: new GitHubDiffSources({ tokens }), log: () => {} });
  const bus = new CommentBus();
  const app = createApp({ db, config, sync, diffs, tokens, bus });
  return { app, db, bus };
}

/** Reads a stream's text until it holds `text` (false when the stream ends first). */
function textReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    get text() {
      return text;
    },
    async until(wanted: string): Promise<boolean> {
      while (!text.includes(wanted)) {
        const { value, done } = await reader.read();
        if (done) return false;
        text += decoder.decode(value);
      }
      return true;
    },
  };
}

describe('GET /agents', () => {
  it('lists the agents without their tokens', async () => {
    const { app, db } = makeApp();
    expect(await (await app.request('/api/v1/agents')).json()).toEqual({ items: [] });
    const { agent, token } = createAgent(db, 'Claude', '2026-09-29T10:00:00.000Z');
    createAgent(db, 'Codex', '2026-09-29T11:00:00.000Z');
    setAgentEnabled(db, agent.id, false, '2026-09-29T12:00:00.000Z');
    const res = await app.request('/api/v1/agents');
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain('hash');
    const { items } = JSON.parse(text) as { items: Agent[] };
    expect(items.map((a) => [a.name, a.tokenPrefix?.slice(0, 4) ?? null, a.disabledAt])).toEqual([
      ['Claude', 'ghd_', '2026-09-29T12:00:00.000Z'],
      ['Codex', 'ghd_', null],
    ]);
  });

  it('leaves deleted agents out', async () => {
    const { app, db } = makeApp();
    const { agent } = createAgent(db, 'Claude');
    createAgent(db, 'Codex');
    deleteAgent(db, agent.id);
    const { items } = (await (await app.request('/api/v1/agents')).json()) as { items: Agent[] };
    expect(items.map((a) => a.name)).toEqual(['Codex']);
  });

  it('says which sources each reaches: null for every one', async () => {
    const { app, db } = makeApp();
    createAgent(db, 'Claude');
    createAgent(db, 'Codex', undefined, null, ['github.com']);
    const { items } = (await (await app.request('/api/v1/agents')).json()) as { items: Agent[] };
    expect(items.map((a) => [a.name, a.sources])).toEqual([['Claude', null], ['Codex', ['github.com']]]);
  });

  it('never makes, changes, disables or deletes one over HTTP', async () => {
    const { app, db } = makeApp();
    const { agent } = createAgent(db, 'Claude');
    for (const [method, path] of [
      ['POST', '/api/v1/agents'], ['PATCH', `/api/v1/agents/${agent.id}`], ['DELETE', `/api/v1/agents/${agent.id}`], ['POST', `/api/v1/agents/${agent.id}/token`],
      ['PUT', `/api/v1/agents/${agent.id}/sources`], ['PATCH', `/api/v1/agents/${agent.id}/sources`], ['POST', `/api/v1/agents/${agent.id}/disable`],
      ['POST', `/api/v1/agents/${agent.id}/enable`], ['PUT', `/api/v1/agents/${agent.id}/enabled`], ['GET', `/api/v1/agents/${agent.id}/footprint`],
    ]) {
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' || method === 'GET' ? undefined : '{"name":"x"}' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await (await app.request('/api/v1/agents')).json()).toMatchObject({ items: [{ name: 'Claude', disabledAt: null, sources: null }] });
  });
});

describe('GET /stream', () => {
  it("relays the bus's messages as server-sent events, and stops listening when the client goes", async () => {
    const { app, bus } = makeApp();
    const client = new AbortController();
    const res = await app.request('/api/v1/stream', { signal: client.signal });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(['content-type', 'cache-control', 'x-accel-buffering', 'connection'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', connection: 'close',
    });
    const stream = textReader(res.body!);
    expect(await stream.until(': connected\n\n')).toBe(true);
    expect(bus.windows).toBe(1);

    // A write through the API reaches the stream once it has committed.
    const created = await app.request('/api/v1/commits/app/' + 'c'.repeat(40) + '/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"body":"Nit"}' });
    const thread = (await created.json()) as { id: number };
    expect(await stream.until('}\n\n')).toBe(true);
    const data = stream.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as StreamMessage);
    expect(data).toEqual([{
      type: 'comments', repo: 'alice/app', kind: 'commit', number: null, branch: null, commitOid: 'c'.repeat(40), threadId: thread.id, event: 'thread_opened', by: { id: 1, kind: 'self', name: 'You' },
    }]);
    const show: StreamMessage = { type: 'show', id: 's1', agent: { id: 2, kind: 'agent', name: 'Claude' }, target: { repo: 'alice/app', pr: 2 }, message: null, at: '2026-09-29T10:00:00.000Z' };
    expect(bus.emit(show)).toBe(1);
    expect(await stream.until('"type":"show"')).toBe(true);

    client.abort();
    await vi.waitFor(() => expect(bus.windows).toBe(0));
  });

  it('keeps an idle stream open with a comment line every 25 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { app, bus } = makeApp();
      const client = new AbortController();
      const stream = textReader((await app.request('/api/v1/stream', { signal: client.signal })).body!);
      expect(await stream.until(': connected\n\n')).toBe(true);
      vi.advanceTimersByTime(25_000);
      expect(await stream.until(': ping\n\n')).toBe(true);
      vi.advanceTimersByTime(25_000);
      expect(await stream.until(': ping\n\n: ping\n\n')).toBe(true);
      client.abort();
      await vi.waitFor(() => expect(bus.windows).toBe(0));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends when the bus closes (the server shutting down)', async () => {
    const { app, bus } = makeApp();
    const stream = textReader((await app.request('/api/v1/stream')).body!);
    expect(await stream.until(': connected')).toBe(true);
    bus.close();
    expect(await stream.until('never')).toBe(false);
    // One that opens after that ends at once.
    const late = textReader((await app.request('/api/v1/stream')).body!);
    expect(await late.until('never')).toBe(false);
    expect(bus.windows).toBe(0);
  });

  it('serves at most 32 streams at once, and asks the rest to come back later', async () => {
    const { app, bus } = makeApp();
    const windows = await Promise.all(Array.from({ length: MAX_STREAMS }, async () => {
      const client = new AbortController();
      const res = await app.request('/api/v1/stream', { signal: client.signal });
      expect(res.status).toBe(200);
      return { client, stream: textReader(res.body!) };
    }));
    expect(bus.windows).toBe(MAX_STREAMS);
    const refused = await app.request('/api/v1/stream');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('15');
    expect(await refused.json()).toEqual({ error: 'Too many live streams open (32); try again later' });
    expect(bus.windows).toBe(MAX_STREAMS);
    // One goes: another may come.
    windows[0]!.client.abort();
    await vi.waitFor(() => expect(bus.windows).toBe(MAX_STREAMS - 1));
    const next = new AbortController();
    expect((await app.request('/api/v1/stream', { signal: next.signal })).status).toBe(200);
    for (const w of [...windows, { client: next }]) w.client.abort();
    await vi.waitFor(() => expect(bus.windows).toBe(0));
  });

  it('answers HEAD with the headers alone, holding no stream (so HEADs never use up the 32)', async () => {
    const { app, bus } = makeApp();
    for (let i = 0; i < MAX_STREAMS + 5; i++) {
      const res = await app.request('/api/v1/stream', { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    }
    expect(bus.windows).toBe(0);
    const client = new AbortController();
    expect((await app.request('/api/v1/stream', { signal: client.signal })).status).toBe(200);
    expect(bus.windows).toBe(1);
    client.abort();
    await vi.waitFor(() => expect(bus.windows).toBe(0));
  });

  it('cuts off a window that stops reading, drops what it held, and stops counting it for show', async () => {
    const { app, bus } = makeApp();
    const stream = textReader((await app.request('/api/v1/stream')).body!);
    expect(await stream.until(': connected')).toBe(true);
    // Unread from here on: each message is ~1 KB, the budget 256 KB.
    const show = (i: number): StreamMessage => ({
      type: 'show', id: `s${i}`, agent: { id: 2, kind: 'agent', name: 'Claude' }, target: { repo: 'alice/app', pr: 2 }, message: 'x'.repeat(1000), at: '2026-09-29T10:00:00.000Z',
    });
    const reached: number[] = [];
    for (let i = 0; i < 1000; i++) reached.push(bus.emit(show(i)));
    const took = reached.indexOf(0);
    expect(took).toBeGreaterThan(200);
    expect(took).toBeLessThan(260);
    expect(reached.slice(0, took).every((n) => n === 1)).toBe(true);
    expect(reached.slice(took).every((n) => n === 0)).toBe(true);
    expect(bus.windows).toBe(0);
    // The client's read fails at once: the queue was dropped, not left to drain.
    await expect(stream.until('never')).rejects.toThrow('The client fell too far behind');
  });

  it('closes the connection of a window that stops reading, over a real socket, without logging an error', async () => {
    const { app, bus } = makeApp();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
      let closed = false;
      let text = '';
      socket.on('close', () => (closed = true));
      socket.on('error', () => {});
      socket.write('GET /api/v1/stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
      // Read the headers, then stop reading altogether.
      await new Promise<void>((resolve) => socket.once('data', () => resolve()));
      socket.pause();
      expect(bus.windows).toBe(1);
      const big: StreamMessage = {
        type: 'show', id: 'big', agent: { id: 2, kind: 'agent', name: 'Claude' }, target: { repo: 'alice/app', pr: 2, path: 'p'.repeat(16 * 1024) }, message: null, at: '2026-09-29T10:00:00.000Z',
      };
      // Past the kernel's socket buffers, then the stream's budget.
      let taken = 0;
      for (let i = 0; i < 2000 && bus.windows > 0; i++) {
        taken += bus.emit(big);
        await new Promise((r) => setImmediate(r));
      }
      expect(bus.windows).toBe(0);
      // Reading again, the client gets what was already on its way, then the end: the rest was dropped.
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => (text += chunk));
      socket.resume();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
      const received = text.split('"id":"big"').length - 1;
      // The stream held about 16 of them (256 KB): those never went out.
      expect(received).toBeLessThanOrEqual(taken - 10);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('needs what any /api GET needs', async () => {
    const { app } = makeApp({ apiKey: 'k'.repeat(32) });
    expect((await app.request('/api/v1/stream')).status).toBe(401);
    expect((await app.request('/api/v1/agents')).status).toBe(401);
    const client = new AbortController();
    const ok = await app.request('/api/v1/stream', { headers: { authorization: `Bearer ${'k'.repeat(32)}` }, signal: client.signal });
    expect(ok.status).toBe(200);
    client.abort();
  });
});

describe('OpenAPI', () => {
  it('documents the agents, the stream, comment events and who resolved a thread', async () => {
    const { app } = makeApp();
    type Doc = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }>; parameters?: { name: string; description: string }[] }>>; components: { schemas: Record<string, { properties?: Record<string, unknown>; oneOf?: { properties: { type: { enum: string[] } } }[] }> } };
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as Doc;
    expect(Object.keys(doc.paths['/api/v1/agents']!)).toEqual(['get']);
    expect(Object.keys(doc.paths['/api/v1/stream']!.get!.responses['200']!.content!)).toEqual(['text/event-stream']);
    const { schemas } = doc.components;
    expect(schemas.ActivityEvent!.oneOf!.map((v) => v.properties.type.enum[0])).toEqual(['commit', 'pr', 'issue', 'release', 'star', 'comment']);
    expect(Object.keys(schemas.CommentActivity!.properties!)).toEqual([
      'eventId', 'threadId', 'commentId', 'live', 'by', 'target', 'commitOid', 'path', 'side', 'startLine', 'endLine', 'excerpt', 'view',
    ]);
    expect(Object.keys(schemas.Agent!.properties!)).toEqual(['id', 'name', 'tokenPrefix', 'createdAt', 'lastUsedAt', 'disabledAt', 'builtIn', 'sources']);
    expect(schemas.CommentThread!.properties).toHaveProperty('resolvedBy');
    const types = doc.paths['/api/v1/activity']!.get!.parameters!.find((p) => p.name === 'types')!;
    expect(types.description).toContain('comment');
  });
});
