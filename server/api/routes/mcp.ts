// POST /mcp: MCP over Streamable HTTP, JSON responses only (no SSE stream, no sessions). Every request carries an
// agent's token (`Authorization: Bearer ghd_…`); the password / API-key gate doesn't apply here (auth.ts exempts
// MCP_PATH), and neither unlocks it. The Host allowlist runs first as for every path; a browser's request from any other
// origin is refused (DNS rebinding, CSRF).

import type { Context, Hono } from 'hono';
import type { Principal } from '../../../shared/api';
import { errorResponse, INVALID_REQUEST, type McpCore, PARSE_ERROR, PROTOCOL_VERSIONS } from '../../mcp/core';
import { origin } from '../http';

export const MCP_PATH = '/mcp';

export interface McpRouteOptions {
  core: McpCore;
  /** The agent a token belongs to; null for an unknown or revoked token. */
  principalFor: (token: string) => Principal | null;
}

const AUTH_HINT = 'send Authorization: Bearer <agent token> (gh-dash Settings → Agents, or the `agents` command)';

const rpcError = (c: Context, status: 400 | 401 | 403 | 405 | 415, message: string, code = INVALID_REQUEST, data?: unknown) =>
  c.json(errorResponse(null, code, message, data), status);

export function installMcp(app: Hono, { core, principalFor }: McpRouteOptions): void {
  app.post(MCP_PATH, async (c) => {
    // A browser always sends Origin on a POST; agents' HTTP clients don't. Only a page of this very server may.
    const from = c.req.header('origin');
    if (from !== undefined && from !== origin(c)) return rpcError(c, 403, 'Forbidden: cross-origin requests are not accepted');

    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const principal = token ? principalFor(token) : null;
    if (!principal) {
      c.header('WWW-Authenticate', token ? 'Bearer realm="gh-dash", error="invalid_token"' : 'Bearer realm="gh-dash"');
      return rpcError(c, 401, token ? `Unauthorized: unknown or revoked agent token; ${AUTH_HINT}` : `Unauthorized: ${AUTH_HINT}`);
    }

    const type = c.req.header('content-type')?.split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return rpcError(c, 415, 'Unsupported Media Type: send application/json');
    // Absent: 2025-03-26 (or the initialize request, which doesn't send it yet). Any version this server speaks is fine
    // on any request: it answers every one alike.
    const version = c.req.header('mcp-protocol-version');
    if (version !== undefined && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return rpcError(c, 400, `Unsupported MCP-Protocol-Version: ${version.slice(0, 40)}`, INVALID_REQUEST, { supported: PROTOCOL_VERSIONS, requested: version.slice(0, 40) });
    }

    let message: unknown;
    try {
      message = JSON.parse(await c.req.text());
    } catch {
      return rpcError(c, 400, 'Parse error: the body must be JSON', PARSE_ERROR);
    }
    // The request's own signal aborts when the client goes away: a waiting tool stops with it.
    const reply = await core.handle(message, { principal, signal: c.req.raw.signal });
    return reply === null ? c.body(null, 202) : c.json(reply);
  });

  // No server-initiated stream (GET) and no sessions to end (DELETE).
  app.all(MCP_PATH, (c) => {
    c.header('Allow', 'POST');
    return rpcError(c, 405, `Method Not Allowed: ${c.req.method} ${MCP_PATH}; MCP clients POST JSON-RPC messages here`);
  });
}

/** The desktop socket serves the app's windows only: agents reach /mcp through the Local API (TCP). */
export function refuseMcp(app: Hono): void {
  app.all(MCP_PATH, (c) => c.json({ error: 'MCP is served on the Local API (Settings → Instance), not on the desktop socket' }, 404));
}
