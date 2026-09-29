// The official SDK's clients against the app over real HTTP: the 1.x client (what most MCP hosts embed today) and the
// 2.x client negotiating (a 2026-07-28 probe first, then the fallback to initialize).

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpHarness } from '../test/mcp';
import { TOOLS } from './index';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});

/** Serves the app on a free port; `seen` records each request as "<HTTP method> <JSON-RPC method or ids> <status>". */
async function serve(h = mcpHarness()) {
  const seen: string[] = [];
  const fetch = async (req: Request) => {
    const body = req.method === 'POST' ? await req.clone().text() : '';
    const res = await h.app.fetch(req);
    let what = '';
    try {
      const msg = JSON.parse(body) as { method?: string } | { method?: string }[];
      what = (Array.isArray(msg) ? msg : [msg]).map((m) => m.method ?? 'response').join(',');
    } catch {
      // not JSON
    }
    seen.push(`${req.method} ${what} ${res.status}`.replace(/ +/g, ' '));
    return res;
  };
  const server = createAdaptorServer({ fetch }) as Server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  return { h, url, seen };
}

const auth = (token: string) => ({ requestInit: { headers: { Authorization: `Bearer ${token}` } } });

describe('the MCP SDK 1.x client', () => {
  it('connects, lists the tools and calls one', async () => {
    const { h, url, seen } = await serve();
    const client = new Client({ name: 'interop', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, auth(h.token)));
    // It asks for the stream after initialized: 405 says there is none.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['POST initialize 200', 'POST notifications/initialized 202', 'GET 405']);
    expect(client.getServerVersion()).toMatchObject({ name: 'gh-dash', version: h.config.version });
    expect(client.getInstructions()).toContain('gh-dash');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.find((t) => t.name === 'find_pr')!.annotations).toMatchObject({ readOnlyHint: true });
    const res = await client.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ agent: { id: h.agent.id, name: 'Claude' } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual(res.structuredContent);
    const bad = await client.callTool({ name: 'get_thread', arguments: { id: 12345 } });
    expect(bad).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Thread 12345 not found' }] });
    await client.ping();
    await client.close();
  });

  it('fails to connect with a wrong token', async () => {
    const { url } = await serve();
    const client = new Client({ name: 'interop', version: '1.0.0' });
    await expect(client.connect(new StreamableHTTPClientTransport(url, auth('ghd_nope')))).rejects.toThrow(/401|Unauthorized/);
  });
});

describe('the MCP SDK 2.x client', () => {
  it("probes with server/discover, falls back to initialize, and works", async () => {
    const { h, url, seen } = await serve();
    const client = new ClientV2({ name: 'interop', version: '2.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new TransportV2(url, auth(h.token)));
    expect(seen.slice(0, 3)).toEqual(['POST server/discover 400', 'POST initialize 200', 'POST notifications/initialized 202']);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOLS.length);
    const res = await client.callTool({ name: 'resolve_repo', arguments: { remote_url: 'git@github.com:alice/app.git' } });
    expect(res.structuredContent).toEqual({ key: 'alice/app', provider: 'github', url: 'https://github.com/alice/app', tracked: true });
    expect(h.logs).toEqual([]);
    await client.close();
  });
});
