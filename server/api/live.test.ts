import { describe, expect, it, vi } from 'vitest';
import type { Agent, StreamMessage } from '../../shared/api';
import { CommentBus } from '../comments/bus';
import { type Config, loadConfig } from '../config';
import { createAgent, revokeAgent } from '../db/agents';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { seedDb } from '../test/seed';
import { testTokens } from '../test/tokens';
import { createApp } from './app';

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
    revokeAgent(db, agent.id, '2026-09-29T12:00:00.000Z');
    const res = await app.request('/api/v1/agents');
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain('hash');
    const { items } = JSON.parse(text) as { items: Agent[] };
    expect(items.map((a) => [a.name, a.tokenPrefix?.slice(0, 4) ?? null, a.revokedAt])).toEqual([
      ['Claude', null, '2026-09-29T12:00:00.000Z'],
      ['Codex', 'ghd_', null],
    ]);
  });

  it('never makes, changes or revokes one over HTTP', async () => {
    const { app, db } = makeApp();
    const { agent } = createAgent(db, 'Claude');
    for (const [method, path] of [['POST', '/api/v1/agents'], ['PATCH', `/api/v1/agents/${agent.id}`], ['DELETE', `/api/v1/agents/${agent.id}`], ['POST', `/api/v1/agents/${agent.id}/token`]]) {
      const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{"name":"x"}' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(await (await app.request('/api/v1/agents')).json()).toMatchObject({ items: [{ name: 'Claude', revokedAt: null }] });
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
      type: 'comments', repo: 'alice/app', kind: 'commit', number: null, commitOid: 'c'.repeat(40), threadId: thread.id, event: 'thread_opened', by: { id: 1, kind: 'self', name: 'You' },
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
      'eventId', 'threadId', 'live', 'by', 'target', 'commitOid', 'path', 'side', 'startLine', 'endLine', 'excerpt',
    ]);
    expect(Object.keys(schemas.Agent!.properties!)).toEqual(['id', 'name', 'tokenPrefix', 'createdAt', 'lastUsedAt', 'revokedAt']);
    expect(schemas.CommentThread!.properties).toHaveProperty('resolvedBy');
    const types = doc.paths['/api/v1/activity']!.get!.parameters!.find((p) => p.name === 'types')!;
    expect(types.description).toContain('comment');
  });
});
