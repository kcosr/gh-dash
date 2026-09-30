// POST /mcp: MCP over Streamable HTTP, JSON responses only (no SSE stream, no sessions). Every request carries an
// agent's token (`Authorization: Bearer ghd_…`), unless the desktop app lets requests without one act as its built-in
// agent; the password / API-key gate doesn't apply here (auth.ts exempts MCP_PATH), and neither unlocks it. The Host allowlist runs first as for every path; a browser's request from any other
// origin is refused (DNS rebinding, CSRF).

import type { Context, Hono } from 'hono';
import type { Principal } from '../../../shared/api';
import { errorResponse, INVALID_REQUEST, type McpCore, PARSE_ERROR, PROTOCOL_VERSIONS } from '../../mcp/core';
import { origin } from '../http';

export const MCP_PATH = '/mcp';

/**
 * Where an MCP client configured without the token looks for OAuth after a 401 (RFC 9728 and RFC 8414 metadata, with
 * or without the /mcp suffix). gh-dash has no OAuth: a JSON 404 says so, where the web app's index.html (or, with a
 * password, the login page) would read as a broken server.
 */
const OAUTH_DISCOVERY = /^\/\.well-known\/(?:oauth-protected-resource|oauth-authorization-server|openid-configuration)(?:\/|$)/;

/** Paths /mcp answers itself, with its own auth: exempt from the password and API-key gate (auth.ts). */
export const isMcpPath = (path: string): boolean => path === MCP_PATH || OAUTH_DISCOVERY.test(path);

export interface McpRouteOptions {
  core: McpCore;
  /** The agent a token belongs to; null for an unknown or revoked token. */
  principalFor: (token: string) => Principal | null;
  /**
   * Who a request without an Authorization header acts as, when tokens aren't required (the desktop app's built-in
   * agent); absent, such a request is refused. A request that sends a token still needs a valid one.
   */
  withoutToken?: () => Principal;
}

const AUTH_HINT = 'send Authorization: Bearer <agent token> (gh-dash Settings → Agents, or the `agents` command)';

const rpcError = (c: Context, status: 400 | 401 | 403 | 405 | 415, message: string, code = INVALID_REQUEST, data?: unknown) =>
  c.json(errorResponse(null, code, message, data), status);

export function installMcp(app: Hono, { core, principalFor, withoutToken }: McpRouteOptions): void {
  app.post(MCP_PATH, async (c) => {
    // A browser always sends Origin on a POST; agents' HTTP clients don't. Only a page of this very server may.
    const from = c.req.header('origin');
    if (from !== undefined && from !== origin(c)) return rpcError(c, 403, 'Forbidden: cross-origin requests are not accepted');

    // No Authorization header at all: the built-in agent, if tokens aren't required. Anything sent is checked, and a
    // bad token is never taken for none.
    const header = c.req.header('authorization') ?? '';
    const sent = header.trim() !== '';
    const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
    const principal = !sent && withoutToken ? withoutToken() : token ? principalFor(token) : null;
    if (!principal) {
      c.header('WWW-Authenticate', sent ? 'Bearer realm="gh-dash", error="invalid_token"' : 'Bearer realm="gh-dash"');
      return rpcError(c, 401, sent ? `Unauthorized: unknown or revoked agent token; ${AUTH_HINT}` : `Unauthorized: ${AUTH_HINT}`);
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

  app.use('/.well-known/*', async (c, next) => {
    if (!OAUTH_DISCOVERY.test(c.req.path)) return next();
    return c.json({ error: `gh-dash has no OAuth: MCP clients ${AUTH_HINT}` }, 404);
  });
}

/**
 * Where MCP isn't served: the desktop socket (the app's windows only: agents reach /mcp through the Local API), and the
 * Local API with its MCP switch off.
 */
export function refuseMcp(app: Hono, message = 'MCP is served on the Local API (Settings → Instance), not on the desktop socket'): void {
  app.all(MCP_PATH, (c) => c.json({ error: message }, 404));
}
