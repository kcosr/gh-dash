import { describe, expect, it } from 'vitest';
import { DESKTOP_SECRET_HEADER } from '../../shared/desktop';
import { mcpHarness } from '../test/mcp';

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const PING = { jsonrpc: '2.0', id: 2, method: 'ping' };

describe('POST /mcp', () => {
  it('answers JSON-RPC with JSON, and a notification with 202 and no body', async () => {
    const { post } = mcpHarness();
    const res = await post(INIT);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe('');
    // A batch (2025-03-26) gets an array.
    expect(await (await post([PING, { ...PING, id: 3 }])).json()).toMatchObject([{ id: 2 }, { id: 3 }]);
  });

  it('needs a known agent token, and says how to get one', async () => {
    const { post, token } = mcpHarness();
    const none = await post(PING, { authorization: '' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="gh-dash"');
    expect(await none.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { message: expect.stringContaining('Authorization: Bearer <agent token>') } });
    for (const authorization of ['Bearer ghd_revoked', `Basic ${token}`, token, `Bearer ${token} x`, `Bearer ${token.slice(0, -1)}x`]) {
      const res = await post(PING, { authorization });
      expect(res.status, authorization).toBe(401);
    }
    const bad = await post(PING, { authorization: 'Bearer ghd_revoked' });
    expect(bad.headers.get('www-authenticate')).toBe('Bearer realm="gh-dash", error="invalid_token"');
    expect((await post(PING, { authorization: `bearer  ${token}` })).status).toBe(200);
  });

  it("refuses a browser page of any other origin, before looking at the token", async () => {
    const { post } = mcpHarness();
    for (const origin of ['http://evil.example', 'http://localhost:5173', 'null', 'https://localhost']) {
      const res = await post(PING, { origin, authorization: '' });
      expect(res.status, origin).toBe(403);
    }
    // Its own origin (as the Host header names it) is fine.
    expect((await post(PING, { origin: 'http://localhost', host: 'localhost' })).status).toBe(200);
    expect((await post(PING, { origin: 'http://127.0.0.1:4780', host: '127.0.0.1:4780' })).status).toBe(200);
  });

  it('checks the media type, the JSON and MCP-Protocol-Version', async () => {
    const { post } = mcpHarness();
    expect((await post(PING, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(PING, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    const parse = await post('{"jsonrpc":', {});
    expect(parse.status).toBe(400);
    expect(await parse.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body must be JSON' } });
    expect((await post(PING, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
    expect((await post(PING, { 'mcp-protocol-version': '2024-11-05' })).status).toBe(200);
    const modern = await post(PING, { 'mcp-protocol-version': '2026-07-28' });
    expect(modern.status).toBe(400);
    expect(await modern.json()).toMatchObject({ error: { message: 'Unsupported MCP-Protocol-Version: 2026-07-28', data: { supported: expect.arrayContaining(['2025-11-25']) } } });
  });

  it('refuses bodies over 1 MB', async () => {
    const { post } = mcpHarness();
    const res = await post({ ...PING, params: { pad: 'x'.repeat(1024 * 1024) } });
    expect(res.status).toBe(413);
  });

  it('has no stream and no sessions: GET and DELETE are 405 with Allow', async () => {
    const { app, token } = mcpHarness();
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await app.request('http://localhost/mcp', { method, headers: { authorization: `Bearer ${token}` } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    // Not the web app's index.html, even without the token.
    const bare = await app.request('http://localhost/mcp');
    expect(bare.status).toBe(405);
    expect(bare.headers.get('content-type')).toMatch(/^application\/json/);
  });
});

describe('/mcp and the password or API key', () => {
  for (const over of [{ password: 'pw' }, { apiKey: 'k3y' }, { password: 'pw', apiKey: 'k3y' }]) {
    it(`lets an agent token through /mcp and nowhere else (${Object.keys(over).join(' + ')})`, async () => {
      const { app, post, token } = mcpHarness({ config: over });
      const res = await post(PING);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect((await app.request('http://localhost/mcp')).status).toBe(405);
      // The agent's token is no API key, and the API key is no agent token.
      expect((await app.request('http://localhost/api/v1/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      if ('apiKey' in over) {
        expect((await post(PING, { authorization: 'Bearer k3y' })).status).toBe(401);
        expect((await app.request('http://localhost/api/v1/me', { headers: { authorization: 'Bearer k3y' } })).status).toBe(200);
      }
      // A path next to it is still the UI's.
      const ui = await app.request('http://localhost/mcp/x', { headers: { authorization: `Bearer ${token}` } });
      expect(ui.status).toBe('password' in over ? 303 : 200);
    });
  }
});

describe('/mcp on the desktop socket', () => {
  it("isn't served there: the secret still guards the path, and with it the answer is where to go", async () => {
    const secret = 's'.repeat(64);
    const { app, token } = mcpHarness({ transport: { kind: 'desktop', secret } });
    const send = (headers: Record<string, string>) =>
      app.request('http://gh-dash/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(PING) });
    expect((await send({ authorization: `Bearer ${token}` })).status).toBe(403);
    const inside = await send({ authorization: `Bearer ${token}`, [DESKTOP_SECRET_HEADER]: secret });
    expect(inside.status).toBe(404);
    expect(await inside.json()).toEqual({ error: expect.stringContaining('Local API') });
  });
});
