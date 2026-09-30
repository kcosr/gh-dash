// The MCP protocol, transport-agnostic: `handle` takes one parsed JSON-RPC message (or a batch) with the caller's
// principal and an abort signal, and returns what to send back (null: nothing). /mcp (Streamable HTTP, JSON responses)
// is its only transport today; a stdio relay later forwards lines to /mcp, so nothing here knows about HTTP.
//
// The subset of the 2025 revisions gh-dash needs, stateless: initialize (version negotiation), ping, tools/list,
// tools/call, and the notifications initialized (ignored) and cancelled (aborts a call in flight, such as a waiting
// wait_for_reply). No sessions, resources, prompts, sampling or server-to-client requests. A 2026-07-28 client probing
// with server/discover is refused (over HTTP its MCP-Protocol-Version header already is; here the method isn't found),
// and falls back to initialize, as that revision's clients do.

import { HttpError, parseWith } from '../lib/errors';
import { type CallContext, type McpDeps, type Tool, toolListing } from './tool';

/** Newest first: what initialize offers when the client asks for a version it doesn't know. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** A request the client cancelled (LSP's code; MCP clients drop the response to a request they cancelled anyway). */
export const REQUEST_CANCELLED = -32800;

export type RequestId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse = { jsonrpc: '2.0'; id: RequestId | null } & ({ result: unknown } | { error: JsonRpcError });

type Reply = JsonRpcResponse | JsonRpcResponse[] | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is RequestId => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

export const errorResponse = (id: RequestId | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface McpCoreOptions {
  deps: McpDeps;
  tools: readonly Tool[];
  /** What initialize tells the client about gh-dash: read by agents once, when they connect. */
  instructions?: string;
  log?: (line: string) => void;
}

export class McpCore {
  private readonly tools: Map<string, Tool>;
  private readonly listing: Record<string, unknown>[];
  private readonly log: (line: string) => void;
  /** Calls in flight by principal and request id, for notifications/cancelled (which arrives as another request). */
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly opts: McpCoreOptions) {
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
    this.listing = opts.tools.map(toolListing);
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** One message, or a batch (the 2025-03-26 revision allows them): the responses, in order, or null when there are none. */
  async handle(message: unknown, ctx: CallContext): Promise<Reply> {
    if (!Array.isArray(message)) return this.one(message, ctx);
    if (message.length === 0) return errorResponse(null, INVALID_REQUEST, 'Invalid Request: empty batch');
    const replies = await Promise.all(message.map((m) => this.one(m, ctx)));
    const out = replies.filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }

  private async one(message: unknown, ctx: CallContext): Promise<JsonRpcResponse | null> {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return errorResponse(isObject(message) && isId(message.id) ? message.id : null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 message');
    }
    if (typeof message.method !== 'string') {
      // A response to a request of ours: the server never sends any.
      if ('result' in message || 'error' in message) return null;
      return errorResponse(isId(message.id) ? message.id : null, INVALID_REQUEST, 'Invalid Request: no method');
    }
    const params = message.params === undefined ? {} : message.params;
    if (!('id' in message)) {
      if (isObject(params)) this.notification(message.method, params, ctx);
      return null;
    }
    const id = message.id;
    if (!isId(id)) return errorResponse(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
    if (!isObject(params)) return errorResponse(id, INVALID_PARAMS, 'Invalid params: expected an object');
    try {
      return { jsonrpc: '2.0', id, result: await this.request(id, message.method, params, ctx) };
    } catch (err) {
      if (err instanceof RpcError) return errorResponse(id, err.code, err.message);
      this.log(`[mcp] ${message.method} failed: ${(err as Error).stack ?? err}`);
      return errorResponse(id, INTERNAL_ERROR, 'Internal error');
    }
  }

  private notification(method: string, params: Record<string, unknown>, ctx: CallContext): void {
    if (method !== 'notifications/cancelled' || !isId(params.requestId)) return;
    // Only the principal that made a request may cancel it.
    this.inflight.get(inflightKey(ctx, params.requestId))?.abort(new RpcError(REQUEST_CANCELLED, 'Request cancelled'));
  }

  private async request(id: RequestId, method: string, params: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        // Few enough for one page: `cursor` is ignored.
        return { tools: this.listing };
      case 'tools/call':
        return this.call(id, params, ctx);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private initialize(params: Record<string, unknown>) {
    const asked = params.protocolVersion;
    if (typeof asked !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: protocolVersion must be a string');
    // The client's version when this server speaks it, else the newest (the client decides whether it can go on).
    const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gh-dash', title: 'gh-dash', version: this.opts.deps.config.version },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
    };
  }

  /**
   * Runs a tool. Its failures (bad arguments included, so the model can correct itself) are results with isError, the
   * message as text; an unknown tool is a protocol error. A cancelled call answers REQUEST_CANCELLED, unless the tool
   * returned a result of its own on the way out (wait_for_reply returns what it has).
   */
  private async call(id: RequestId, params: Record<string, unknown>, ctx: CallContext) {
    const { name } = params;
    if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: name must be a string');
    const tool = this.tools.get(name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const raw = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(raw)) throw new RpcError(INVALID_PARAMS, 'Invalid params: arguments must be an object');
    // An id is the call's handle for notifications/cancelled: a second call under it would take the first one's away.
    const key = inflightKey(ctx, id);
    if (this.inflight.has(key)) throw new RpcError(INVALID_REQUEST, `Invalid Request: request id ${JSON.stringify(id)} belongs to a call still in progress`);
    let args: Record<string, unknown>;
    try {
      args = parseWith(tool.input, raw);
    } catch (err) {
      return toolError(`Invalid arguments: ${(err as Error).message}`);
    }

    const cancel = new AbortController();
    this.inflight.set(key, cancel);
    const signal = AbortSignal.any([ctx.signal, cancel.signal]);
    try {
      const out = await tool.run(args, { ...ctx, signal, deps: this.opts.deps });
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    } catch (err) {
      if (err instanceof HttpError) return toolError(err.message);
      if (signal.aborted) throw signal.reason instanceof RpcError ? signal.reason : new RpcError(REQUEST_CANCELLED, 'Request cancelled');
      this.log(`[mcp] ${name} failed: ${(err as Error).stack ?? err}`);
      return toolError('Internal error (logged by gh-dash)');
    } finally {
      this.inflight.delete(key);
    }
  }
}

const inflightKey = (ctx: CallContext, id: RequestId) => `${ctx.principal.id}:${typeof id}:${id}`;

const toolError = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });
