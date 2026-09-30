// The desktop app's Local API: one TCP port with a switch for the REST API and one for MCP (and whether MCP needs
// agent tokens). Each combination serves exactly its routes; /api/health always. The desktop socket is unchanged.
import { describe, expect, it } from 'vitest';
import { DESKTOP_SECRET_HEADER } from '../../shared/desktop';
import { upsertPr } from '../db/write';
import { BUILT_IN_AGENT, builtInAgent, createAgent, listAgents, revokeAgent, setAgentSources } from '../db/agents';
import { mcpHarness, sha } from '../test/mcp';
import { actor, GITLAB_HOST, prRecord, seedGitLab } from '../test/seed';

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };
/** What a REST-off port answers for everything but /api/health and /mcp. */
const REST_OFF = /The REST API is off on this port/;

function localApi(switches: { restApi: boolean; mcp: boolean; mcpRequireTokens?: boolean; password?: string | null }) {
  return mcpHarness({ config: { desktop: true, listen: true, mcpRequireTokens: true, password: null, ...switches } });
}

const REST_PATHS = ['/api/v1/instance', '/api/v1/prs', '/api/v1/threads', '/api/v1/agents', '/api/docs', '/api/v1/openapi.json', '/', '/login', '/comments', '/settings', '/assets/x.js'];

describe('the Local API: each switch serves its routes', () => {
  it('REST API and MCP on (a config from before the switches): everything, as always', async () => {
    const h = localApi({ restApi: true, mcp: true });
    expect((await h.app.request('http://127.0.0.1/api/health')).status).toBe(200);
    for (const path of ['/api/v1/instance', '/api/docs', '/api/v1/openapi.json']) expect((await h.app.request(`http://127.0.0.1${path}`)).status, path).toBe(200);
    expect((await h.post(PING)).status).toBe(200);
    const instance = await (await h.app.request('http://127.0.0.1:4780/api/v1/instance')).json();
    expect(instance).toMatchObject({ apiUrl: 'http://127.0.0.1:4780', mcpUrl: 'http://127.0.0.1:4780/mcp' });
  });

  it('REST API off, MCP on: agents alone; the API, its docs, the web app and the sign-in answer a JSON 404', async () => {
    const h = localApi({ restApi: false, mcp: true, password: 'longenough' });
    expect(await (await h.app.request('http://127.0.0.1/api/health')).json()).toMatchObject({ ok: true });
    expect((await h.post(PING)).status).toBe(200);
    for (const path of REST_PATHS) {
      const res = await h.app.request(`http://127.0.0.1${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toMatch(/json/);
      expect((await res.json()).error, path).toMatch(REST_OFF);
    }
    // No sign-in and no session cookie, even with a password in config.json.
    const login = await h.app.request('http://127.0.0.1/login', { method: 'POST', body: new URLSearchParams({ password: 'longenough' }) });
    expect(login.status).toBe(404);
    expect(login.headers.get('set-cookie')).toBeNull();
    // The Host allowlist still comes first.
    expect((await h.app.request('http://evil.example/mcp', { method: 'POST' })).status).toBe(421);
  });

  it('REST API on, MCP off: /mcp answers 404 saying where to turn it on; the rest as usual', async () => {
    const h = localApi({ restApi: true, mcp: false });
    const res = await h.post(PING);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/MCP is off on this port.*Settings/);
    expect((await h.app.request('http://127.0.0.1/api/v1/instance')).status).toBe(200);
    expect(await (await h.app.request('http://127.0.0.1:4780/api/v1/instance')).json()).toMatchObject({ apiUrl: 'http://127.0.0.1:4780', mcpUrl: null });
  });

  it('both off: /api/health alone', async () => {
    const h = localApi({ restApi: false, mcp: false });
    expect((await h.app.request('http://127.0.0.1/api/health')).status).toBe(200);
    expect((await h.post(PING)).status).toBe(404);
    for (const path of REST_PATHS) expect((await h.app.request(`http://127.0.0.1${path}`)).status, path).toBe(404);
  });

  it("leaves the desktop socket as it was: the REST API for the app's windows, never MCP", async () => {
    const secret = 's'.repeat(64);
    const h = mcpHarness({ config: { desktop: true, listen: true, restApi: false, mcp: true }, transport: { kind: 'desktop', secret } });
    const headers = { [DESKTOP_SECRET_HEADER]: secret };
    expect((await h.app.request('http://gh-dash/api/v1/instance', { headers })).status).toBe(200);
    expect((await h.app.request('http://gh-dash/mcp', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(PING) })).status).toBe(404);
  });
});

describe('MCP without agent tokens', () => {
  /** alice/app#2, for a comment. */
  function withPr() {
    const h = localApi({ restApi: false, mcp: true, mcpRequireTokens: false });
    const repo = h.db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    upsertPr(h.db, repo, prRecord(2, { state: 'open', createdAt: '2026-09-22T09:00:00Z', author: actor('bob'), title: 'Add parser', headOid: sha('a') }));
    return h;
  }
  /** No Authorization header at all. */
  const none = { authorization: null };

  it('acts as the built-in agent "Agent" when no token is sent; a sent token must still be valid', async () => {
    const h = withPr();
    const who = await h.call('whoami', {}, none);
    expect(who.data).toMatchObject({ agent: { name: BUILT_IN_AGENT } });
    // With its own token, an agent is itself.
    expect((await h.call('whoami')).data).toMatchObject({ agent: { name: 'Claude' } });
    // A bad, malformed, revoked or blank token is refused, never taken for none.
    revokeAgent(h.db, h.other.id);
    for (const authorization of ['Bearer ghd_nope', `Bearer ${h.otherToken}`, 'Basic abc', 'Bearer', '', '   ', 'Bearer   ']) {
      const res = await h.post(PING, { authorization });
      expect(res.status, authorization).toBe(401);
    }
    // Origin is checked all the same.
    expect((await h.post(PING, { ...none, origin: 'http://evil.example' })).status).toBe(403);
  });

  it("writes as Agent, made once, listed once it has done something, its name reserved", async () => {
    const h = withPr();
    expect(listAgents(h.db).map((a) => a.name)).toEqual(['Claude', 'Codex']);
    await h.call('whoami', {}, none);
    await h.call('whoami', {}, none);
    expect(h.db.all(`SELECT name FROM principals WHERE kind = 'agent' AND name = ?`, [BUILT_IN_AGENT])).toHaveLength(1);
    // Made, not listed yet: it hasn't written anything.
    expect(listAgents(h.db).map((a) => a.name)).toEqual(['Claude', 'Codex']);
    const made = await h.call('add_comment', { repo: 'alice/app', pr: 2, body: 'From an agent without a token.' }, none);
    expect(made.error).toBeUndefined();
    const listed = listAgents(h.db);
    expect(listed.map((a) => [a.name, a.builtIn, a.tokenPrefix])).toEqual([['Claude', false, expect.any(String)], ['Codex', false, expect.any(String)], [BUILT_IN_AGENT, true, null]]);
    const thread = h.db.get<{ name: string }>('SELECT p.name FROM comments c JOIN principals p ON p.id = c.author_id ORDER BY c.id DESC LIMIT 1');
    expect(thread?.name).toBe(BUILT_IN_AGENT);
    expect(() => createAgent(h.db, 'agent')).toThrow(/built-in agent/);
  });

  it('keeps the built-in agent to the sources it is limited to, from the next request', async () => {
    const h = withPr();
    const gitlab = seedGitLab(h.db);
    const gl = `${GITLAB_HOST}/platform/app`;
    expect((await h.call('list_repos', {}, none)).data!.total).toBe(6);
    setAgentSources(h.db, builtInAgent(h.db).id, [GITLAB_HOST]);
    expect((await h.call('whoami', {}, none)).data).toMatchObject({ agent: { name: BUILT_IN_AGENT, scoped: true }, sources: [{ host: GITLAB_HOST }] });
    expect((await h.call('list_repos', {}, none)).data).toMatchObject({ repos: [{ key: gl }], total: 1 });
    expect((await h.call('add_comment', { repo: 'alice/app', pr: 2, body: 'Out of reach' }, none)).error).toBe(
      "Repository alice/app isn't tracked in gh-dash (list_repos lists the ones that are)",
    );
    expect(h.db.get('SELECT count(*) AS n FROM comment_threads')).toEqual({ n: 0 });
    // Listed now, with its sources; agents with tokens are as they were.
    expect(listAgents(h.db).map((a) => [a.name, a.sources])).toEqual([['Claude', null], ['Codex', null], [BUILT_IN_AGENT, [GITLAB_HOST]]]);
    expect((await h.call('list_repos')).data!.total).toBe(6);
    expect(gitlab.repoId).toBeGreaterThan(0);
  });

  it("takes a token the user chose like a generated one", async () => {
    const h = localApi({ restApi: true, mcp: true });
    const mine = 'my-own-agent-token-0123456789';
    createAgent(h.db, 'Mine', undefined, mine);
    expect((await h.post(PING, { authorization: `Bearer ${mine}` })).status).toBe(200);
    expect((await h.call('whoami', {}, { authorization: `Bearer ${mine}` })).data).toMatchObject({ agent: { name: 'Mine' } });
    expect((await h.post(PING, { authorization: `Bearer ${mine}x` })).status).toBe(401);
  });

  it('still answers when older agents hold the built-in names (no 500)', async () => {
    const h = localApi({ restApi: false, mcp: true, mcpRequireTokens: false });
    for (const name of ['Agent', 'Agent (no token)']) h.db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', ?, '2026-09-01T00:00:00.000Z')`, [name]);
    const res = await h.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, none);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { structuredContent: { agent: { name: 'Agent (no token) 2' } } } });
  });

  it('is refused where tokens are required (the default, and the headless server)', async () => {
    const h = localApi({ restApi: true, mcp: true });
    const res = await h.post(PING, none);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="gh-dash"');
    const headless = mcpHarness();
    expect((await headless.post(PING, none)).status).toBe(401);
  });
});
