import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../shared/api';
import { HttpError } from '../lib/errors';
import { mcpHarness } from '../test/mcp';
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, LATEST_PROTOCOL_VERSION, McpCore, METHOD_NOT_FOUND, REQUEST_CANCELLED } from './core';
import { TOOLS } from './index';
import { readTool, type McpDeps, writeTool } from './tool';

const me: Principal = { id: 2, kind: 'agent', name: 'Claude' };
const other: Principal = { id: 3, kind: 'agent', name: 'Codex' };
const deps = { config: { version: '9.9.9' } } as unknown as McpDeps;

/** A core with test tools: `echo` returns its arguments, `wait` waits for its signal, `boom` throws. */
function core(log: string[] = []) {
  const echo = readTool({
    name: 'echo',
    title: 'Echo',
    description: 'Returns its arguments.',
    input: z.object({ text: z.string(), n: z.number().int().default(1) }).strict(),
    run: (args, { principal }) => ({ ...args, by: principal.name }),
  });
  const wait = readTool({
    name: 'wait',
    title: 'Wait',
    description: 'Waits until cancelled, then says so.',
    input: z.object({ answer: z.boolean().default(false) }).strict(),
    run: ({ answer }, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => (answer ? resolve({ cancelled: true }) : reject(new DOMException('aborted', 'AbortError')))),
      ),
  });
  const boom = writeTool({
    name: 'boom',
    title: 'Boom',
    description: 'Fails.',
    input: z.object({ http: z.boolean().default(false) }).strict(),
    run: ({ http }) => {
      if (http) throw new HttpError(404, 'Thread 7 not found');
      throw new Error('kaboom');
    },
  }, { destructiveHint: true });
  return new McpCore({ deps, tools: [echo, wait, boom], instructions: 'Be nice.', log: (l) => log.push(l) });
}

const ctx = (principal = me, signal = new AbortController().signal) => ({ principal, sources: null, signal });
const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('MCP core', () => {
  it('negotiates the protocol version at initialize', async () => {
    const c = core();
    const init = await c.handle(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }), ctx());
    expect(init).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gh-dash', title: 'gh-dash', version: '9.9.9' },
        instructions: 'Be nice.',
      },
    });
    // A version it doesn't speak (older or newer): it offers its newest.
    for (const v of ['2024-10-07', '2026-07-28']) {
      expect(await c.handle(req(2, 'initialize', { protocolVersion: v }), ctx())).toMatchObject({ result: { protocolVersion: LATEST_PROTOCOL_VERSION } });
    }
    expect(await c.handle(req(3, 'initialize', {}), ctx())).toMatchObject({ error: { code: INVALID_PARAMS } });
  });

  it('answers ping, ignores notifications and responses, and says what it does not know', async () => {
    const c = core();
    expect(await c.handle(req('a', 'ping'), ctx())).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
    expect(await c.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx())).toBeNull();
    expect(await c.handle({ jsonrpc: '2.0', id: 5, result: {} }, ctx())).toBeNull();
    // A 2026-07-28 client's probe: "method not found" sends it to initialize.
    expect(await c.handle(req(2, 'server/discover', { _meta: {} }), ctx())).toMatchObject({ id: 2, error: { code: METHOD_NOT_FOUND } });
    expect(await c.handle(req(3, 'resources/list'), ctx())).toMatchObject({ error: { code: METHOD_NOT_FOUND, message: 'Method not found: resources/list' } });
    expect(await c.handle({ id: 4, method: 'ping' }, ctx())).toMatchObject({ id: 4, error: { code: INVALID_REQUEST } });
    expect(await c.handle('ping', ctx())).toMatchObject({ id: null, error: { code: INVALID_REQUEST } });
    expect(await c.handle({ jsonrpc: '2.0', id: null, method: 'ping' }, ctx())).toMatchObject({ id: null, error: { code: INVALID_REQUEST } });
    expect(await c.handle({ jsonrpc: '2.0', id: 6 }, ctx())).toMatchObject({ id: 6, error: { code: INVALID_REQUEST } });
    expect(await c.handle(req(7, 'ping', [1]), ctx())).toMatchObject({ id: 7, error: { code: INVALID_PARAMS } });
  });

  it('answers a batch in order, leaving out notifications', async () => {
    const c = core();
    const out = await c.handle([req(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(2, 'nope')], ctx());
    expect(out).toMatchObject([{ id: 1, result: {} }, { id: 2, error: { code: METHOD_NOT_FOUND } }]);
    expect(await c.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctx())).toBeNull();
    expect(await c.handle([], ctx())).toMatchObject({ error: { code: INVALID_REQUEST } });
  });

  it('lists tools with JSON Schema inputs and annotations', async () => {
    const out = (await core().handle(req(1, 'tools/list'), ctx())) as { result: { tools: Record<string, unknown>[] } };
    expect(out.result.tools.map((t) => t.name)).toEqual(['echo', 'wait', 'boom']);
    expect(out.result.tools[0]).toEqual({
      name: 'echo',
      title: 'Echo',
      description: 'Returns its arguments.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, n: { type: 'integer', default: 1, minimum: expect.any(Number), maximum: expect.any(Number) } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    expect(out.result.tools[2]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });

  it("publishes every gh-dash tool's input as a valid JSON Schema of an object", async () => {
    const ajv = new Ajv2020({ strict: true, strictRequired: false });
    const names = new Set<string>();
    for (const tool of TOOLS) {
      const listed = (await new McpCore({ deps, tools: [tool] }).handle(req(1, 'tools/list'), ctx())) as { result: { tools: Record<string, any>[] } };
      const t = listed.result.tools[0]!;
      expect(t.name).toMatch(/^[a-z_]{3,30}$/);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.inputSchema.$schema).toBeUndefined();
      expect(() => ajv.compile(t.inputSchema)).not.toThrow();
      expect(t.annotations.openWorldHint).toBe(false);
    }
  });

  it('calls a tool: structuredContent, with the same JSON as text', async () => {
    const out = await core().handle(req(1, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), ctx());
    expect(out).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"text":"hi","n":1,"by":"Claude"}' }], structuredContent: { text: 'hi', n: 1, by: 'Claude' } },
    });
  });

  it("reports a tool's failures and bad arguments as tool errors, an unknown tool as a protocol error", async () => {
    const log: string[] = [];
    const c = core(log);
    const result = async (params: unknown) => ((await c.handle(req(1, 'tools/call', params), ctx())) as { result: unknown }).result;
    expect(await result({ name: 'boom', arguments: { http: true } })).toEqual({ content: [{ type: 'text', text: 'Thread 7 not found' }], isError: true });
    expect(await result({ name: 'boom' })).toEqual({ content: [{ type: 'text', text: 'Internal error (logged by gh-dash)' }], isError: true });
    expect(log.join('\n')).toContain('kaboom');
    expect(await result({ name: 'echo', arguments: { text: 1 } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Invalid arguments: text: /) }] });
    expect(await result({ name: 'echo', arguments: { text: 'a', extra: 1 } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('extra') }] });
    expect(await c.handle(req(2, 'tools/call', { name: 'nope' }), ctx())).toMatchObject({ error: { code: INVALID_PARAMS, message: 'Unknown tool: nope' } });
    expect(await c.handle(req(3, 'tools/call', { name: 'echo', arguments: [] }), ctx())).toMatchObject({ error: { code: INVALID_PARAMS } });
    expect(await c.handle(req(4, 'tools/call', {}), ctx())).toMatchObject({ error: { code: INVALID_PARAMS } });
  });

  it('cancels a call in flight on notifications/cancelled from the same principal only', async () => {
    const c = core();
    const waiting = c.handle(req(7, 'tools/call', { name: 'wait', arguments: {} }), ctx());
    let settled = false;
    void waiting.then(() => (settled = true));
    // Another agent's cancel, or one for another id, doesn't reach it.
    expect(await c.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, ctx(other))).toBeNull();
    await c.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '7' } }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    await c.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'user' } }, ctx());
    expect(await waiting).toMatchObject({ id: 7, error: { code: REQUEST_CANCELLED } });
  });

  it('refuses a call under the id of one still in progress, which stays cancellable', async () => {
    const c = core();
    const waiting = c.handle(req(7, 'tools/call', { name: 'wait', arguments: {} }), ctx());
    // Even with bad arguments: nothing about the first call changes.
    for (const args of [{ text: 'hi' }, { text: 1 }]) {
      expect(await c.handle(req(7, 'tools/call', { name: 'echo', arguments: args }), ctx())).toMatchObject({
        id: 7,
        error: { code: INVALID_REQUEST, message: 'Invalid Request: request id 7 belongs to a call still in progress' },
      });
    }
    // Another principal's id 7, or this one's "7", is another call.
    expect(await c.handle(req(7, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), ctx(other))).toMatchObject({ result: { structuredContent: { by: 'Codex' } } });
    expect(await c.handle(req('7', 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), ctx())).toMatchObject({ result: {} });
    await c.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, ctx());
    expect(await waiting).toMatchObject({ id: 7, error: { code: REQUEST_CANCELLED } });
    // Done: the id is free again.
    expect(await c.handle(req(7, 'tools/call', { name: 'echo', arguments: { text: 'again' } }), ctx())).toMatchObject({ result: { structuredContent: { text: 'again' } } });
  });

  it('refuses the second of two calls with one id in a batch', async () => {
    const c = core();
    const batch = c.handle([req(1, 'tools/call', { name: 'wait', arguments: {} }), req(1, 'tools/call', { name: 'echo', arguments: { text: 'x' } })], ctx());
    await new Promise((r) => setTimeout(r, 10));
    await c.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, ctx());
    expect(await batch).toMatchObject([{ id: 1, error: { code: REQUEST_CANCELLED } }, { id: 1, error: { code: INVALID_REQUEST } }]);
  });

  it('stops a call when its transport aborts; a tool may answer on its way out', async () => {
    const c = core();
    const closed = new AbortController();
    const waiting = c.handle(req(1, 'tools/call', { name: 'wait', arguments: { answer: true } }), ctx(me, closed.signal));
    closed.abort();
    expect(await waiting).toMatchObject({ id: 1, result: { structuredContent: { cancelled: true } } });
    const failing = new AbortController();
    const other = c.handle(req(2, 'tools/call', { name: 'wait', arguments: {} }), ctx(me, failing.signal));
    failing.abort();
    expect(await other).toMatchObject({ id: 2, error: { code: REQUEST_CANCELLED } });
  });

  it('says internal error, not the exception, when a method itself fails', async () => {
    const log: string[] = [];
    const broken = new McpCore({ deps: { config: null } as unknown as McpDeps, tools: [], log: (l) => log.push(l) });
    expect(await broken.handle(req(1, 'initialize', { protocolVersion: '2025-06-18' }), ctx())).toMatchObject({ error: { code: INTERNAL_ERROR, message: 'Internal error' } });
    expect(log).toHaveLength(1);
  });

  it("gives the app's tools in order, and the instructions at initialize", async () => {
    const { rpc } = mcpHarness();
    const init = await rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: LATEST_PROTOCOL_VERSION, instructions: expect.stringContaining('nothing is posted') });
    const list = await rpc('tools/list');
    expect((list.result!.tools as { name: string }[]).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
});
