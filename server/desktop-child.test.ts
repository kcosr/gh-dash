import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../shared/api';
import { DESKTOP_ENV, type ServerToMain } from '../shared/desktop';
import { CommentBus } from './comments/bus';
import { writeConfigFile } from './config-file';
import { agentForToken, agentSourceIds, builtInAgent, listAgents, principalForToken } from './db/agents';
import { createThread, getPrincipal, getThread } from './db/comments';
import { openDb } from './db/db';
import { getMeta } from './db/meta';
import { ensureSource, listSources, tryClaimViewer } from './db/sources';
import { mainMessageHandler, type ParentPort, runDesktopChild } from './desktop-child';
import { GitHubDiffSources } from './github/diff-source';
import { SourceRegistry, type SourceRuntime } from './sources/registry';
import type { RunningServer } from './start';
import type { SyncManager } from './sync/manager';
import { fakeExec, fakeFs } from './test/credentials';
import { fakeGitHub, type Reply } from './test/github';
import { BASE, fakeGitLab, graphql } from './test/gitlab';
import { testTokens } from './test/tokens';

const dirs: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const viewer = (login: string): Reply => ({
  body: { data: { viewer: { id: `U_${login}`, login, name: null, avatarUrl: null, repos: { totalCount: 3 }, privateRepos: { totalCount: 1 } } } },
});

describe('main → server messages', () => {
  function setup() {
    const gh = fakeGitHub({
      '/graphql': (req: { headers: Record<string, string> }) => (req.headers.Authorization === 'bearer github_pat_good' ? viewer('alice') : { status: 401, body: { message: 'Bad credentials' } }),
    } as never);
    const tokens = testTokens(null, { fetchImpl: gh.fetchImpl });
    const server = { tokens, close: vi.fn(async () => {}) };
    const posted: ServerToMain[] = [];
    const exit = vi.fn();
    return { handle: mainMessageHandler(server, (m) => posted.push(m), exit), tokens, server, posted, exit, gh };
  }

  it('validates a pasted token and reports whether GitHub accepted it', async () => {
    const { handle, posted, tokens } = setup();
    await handle({ type: 'set-token', id: 1, choice: 'app', token: 'github_pat_good' });
    expect(posted).toEqual([{ type: 'token-result', id: 1, ok: true, account: expect.objectContaining({ source: 'app', choice: 'app', login: 'alice', kind: 'fine-grained', error: null }) }]);
    await handle({ type: 'set-token', id: 2, choice: 'app', token: 'github_pat_bad' });
    expect(posted[1]).toEqual({ type: 'token-result', id: 2, ok: false, account: expect.objectContaining({ source: 'app', login: null, error: 'Bad credentials' }) });
    expect(tokens.getChoice()).toBe('app');
  });

  it('switches source without forgetting the app token, and signs out', async () => {
    const { handle, posted } = setup();
    await handle({ type: 'set-token', id: 1, choice: 'app', token: 'github_pat_good' });
    await handle({ type: 'set-token', id: 2, choice: null });
    expect(posted[1]).toMatchObject({ id: 2, ok: true, account: { source: 'none', choice: null, error: null } });
    // `token` absent: the pasted token is still there when switching back.
    await handle({ type: 'set-token', id: 3, choice: 'app' });
    expect(posted[2]).toMatchObject({ id: 3, ok: true, account: { source: 'app', login: 'alice' } });
    await handle({ type: 'set-token', id: 4, choice: 'app', token: null });
    expect(posted[3]).toMatchObject({ id: 4, ok: false, account: { source: 'none', error: 'No token has been entered in the app' } });
  });

  it('reloads the sources from config.json and names the configured ones, or says why it could not', async () => {
    const posted: ServerToMain[] = [];
    const runtimes = [{ host: 'github.com', config: null }, { host: 'gitlab.example.com', config: {} }, { host: 'gitlab2.example.com', config: null }] as SourceRuntime[];
    const reloadSources = vi.fn(() => runtimes);
    const handle = mainMessageHandler({ tokens: testTokens(), close: async () => {}, reloadSources }, (m) => posted.push(m), vi.fn());
    await handle({ type: 'reload-sources', id: 5 });
    expect(posted).toEqual([{ type: 'sources-result', id: 5, ok: true, error: null, sources: ['gitlab.example.com'] }]);
    reloadSources.mockImplementation(() => { throw new Error('config.json: sources.0.url: github.com is built in; configure it with tokenSource'); });
    await handle({ type: 'reload-sources', id: 6 });
    expect(posted[1]).toEqual({ type: 'sources-result', id: 6, ok: false, error: 'config.json: sources.0.url: github.com is built in; configure it with tokenSource', sources: [] });
  });

  it('closes everything and exits 0 on shutdown; ignores anything else', async () => {
    const { handle, server, exit, posted } = setup();
    await handle({ type: 'bogus' });
    await handle(null);
    expect(posted).toEqual([]);
    await handle({ type: 'shutdown' });
    expect(server.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('main → server messages for GitLab sources', () => {
  const HOST = 'gitlab.example.com';
  const PAT = 'glpat-test-alice';
  const SELF = '/api/v4/personal_access_tokens/self';
  const user = { id: 'gid://gitlab/User/2', username: 'alice', name: 'Alice A', avatarUrl: null, publicEmail: null, commitEmail: null, emails: { nodes: [] } };

  function setup() {
    const db = openDb(':memory:');
    const api = fakeGitLab({
      '/api/graphql': graphql({ CredentialCheck: () => ({ currentUser: user, metadata: { version: '19.3.3-ee', enterprise: true }, personal: { count: 3 } }) }),
      [SELF]: (req) =>
        req.headers.Authorization === `Bearer ${PAT}`
          ? { body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, expires_at: '2026-12-31' } }
          : { status: 401, body: { message: '401 Unauthorized' } },
    });
    const glab = fakeExec(() => '');
    const tokens = testTokens();
    const sources = new SourceRegistry({
      db,
      env: { HOME: '/home/alice', PATH: '/usr/bin' },
      github: { tokens: tokens.credentials, diffs: new GitHubDiffSources({ tokens, log: () => {} }) },
      log: () => {},
      seams: { fetchImpl: api.fetchImpl, sleep: async () => {}, exec: glab.exec, fs: fakeFs({ '/usr/bin/glab': { exec: true } }), platform: 'linux' },
    });
    const sync = { startOrQueue: vi.fn(async () => 'started' as const) } as unknown as SyncManager;
    const diffs = { evict: vi.fn() } as unknown as RunningServer['diffs'];
    const posted: ServerToMain[] = [];
    const handle = mainMessageHandler({ tokens, close: async () => {}, sources, sync, db, diffs }, (m) => posted.push(m), vi.fn());
    return { db, api, glab, sources, sync, diffs, posted, handle };
  }
  const configured = (tokenChoice: 'app' | 'glab') => ({ glabPath: null, sources: [{ kind: 'gitlab' as const, host: HOST, baseUrl: BASE, tokenChoice, tokenFile: null, tokenEnv: null, from: 'file' as const }] });

  it('tests a draft source with a pasted token, saving nothing', async () => {
    const { handle, posted, sources, db, api } = setup();
    await handle({ type: 'test-source', id: 1, draft: { url: `${BASE}/`, method: 'app', token: PAT } });
    expect(posted).toEqual([{
      type: 'source-test-result', id: 1,
      check: {
        ok: true, host: HOST, url: BASE, conflict: null,
        account: expect.objectContaining({ source: 'app', login: 'alice', kind: 'personal', scopes: ['api'], canWrite: true, expiresAt: '2026-12-31T00:00:00.000Z', instance: { version: '19.3.3-ee', enterprise: true }, error: null }),
      },
    }]);
    expect(api.requests).toEqual(['graphql CredentialCheck', SELF]);
    expect(sources.list().map((r) => r.host)).toEqual(['github.com']);
    expect(listSources(db)).toHaveLength(1);
    // A rejected token and a missing one are answers, not failures.
    await handle({ type: 'test-source', id: 2, draft: { url: BASE, method: 'app', token: 'glpat-wrong-token' } });
    expect(posted[1]).toMatchObject({ id: 2, check: { ok: false, account: { error: expect.stringContaining('401') } } });
    await handle({ type: 'test-source', id: 3, draft: { url: BASE, method: 'glab' } });
    expect(posted[2]).toMatchObject({ id: 3, check: { ok: false, account: { source: 'none', error: expect.stringContaining(`glab has no token for ${HOST}`) } } });
  });

  it('says when the data on that host is another account\'s, and refuses what can\'t be a GitLab source', async () => {
    const { handle, posted, sources, db } = setup();
    sources.apply(configured('app'));
    tryClaimViewer(db, sources.byHost(HOST)!.id, { id: 'gid://gitlab/User/9', login: 'bob', name: null, avatarUrl: null, emails: [] });
    await handle({ type: 'test-source', id: 1, draft: { url: BASE, method: 'app', token: PAT } });
    expect(posted[0]).toMatchObject({ check: { ok: false, conflict: `This dashboard's data from ${HOST} belongs to bob, but this token is for alice.` } });
    await handle({ type: 'test-source', id: 2, draft: { url: 'https://github.com', method: 'glab' } });
    await handle({ type: 'test-source', id: 3, draft: { url: 'gitlab.example.com', method: 'glab' } });
    await handle({ type: 'test-source', id: 4, draft: { url: BASE, method: 'file' } });
    expect(posted.slice(1)).toEqual([
      { type: 'request-failed', id: 2, message: 'github.com is built in: connect it under GitHub.' },
      { type: 'request-failed', id: 3, message: 'Invalid GitLab URL: expected something like https://gitlab.example.com' },
      { type: 'request-failed', id: 4, message: 'Choose the token file first.' },
    ]);
  });

  it('sets a source\'s app token and answers with its account; an unknown source is a failure', async () => {
    const { handle, posted, sources } = setup();
    sources.apply(configured('app'));
    await handle({ type: 'set-token', id: 1, source: HOST, token: PAT });
    expect(posted[0]).toEqual({ type: 'token-result', id: 1, ok: true, account: expect.objectContaining({ source: 'app', login: 'alice', canWrite: true }) });
    expect(await sources.byHost(HOST)!.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    await handle({ type: 'set-token', id: 2, source: HOST, token: null });
    expect(posted[1]).toMatchObject({ id: 2, ok: false, account: { source: 'none', error: 'No token has been entered in the app' } });
    await handle({ type: 'set-token', id: 3, source: 'nowhere.example.com', token: PAT });
    expect(posted[2]).toEqual({ type: 'request-failed', id: 3, message: "nowhere.example.com isn't a GitLab source here." });
  });

  it('deletes a source main took out of config.json, refuses a configured one, and starts a sync', async () => {
    const { handle, posted, sources, db, diffs, sync } = setup();
    sources.apply(configured('glab'));
    await handle({ type: 'delete-source', id: 1, source: HOST });
    expect(posted[0]).toEqual({ type: 'request-failed', id: 1, message: `GitLab (${HOST}) is still configured on this server. Remove it in Settings (desktop app) or from config.json first.` });
    sources.apply({ glabPath: null, sources: [] });
    await handle({ type: 'delete-source', id: 2, source: HOST });
    expect(posted[1]).toEqual({ type: 'source-deleted', id: 2, repos: 0 });
    expect(sources.byHost(HOST)).toBeNull();
    expect(listSources(db).map((r) => r.host)).toEqual(['github.com']);
    expect(diffs.evict).toHaveBeenCalled();
    await handle({ type: 'sync-source', id: 3, source: HOST });
    expect(posted[2]).toEqual({ type: 'sync-started', id: 3, result: 'started' });
    expect(sync.startOrQueue).toHaveBeenCalledWith({ source: HOST });
  });
});

describe('main → server messages for agents', () => {
  function setup() {
    const db = openDb(':memory:');
    const bus = new CommentBus();
    const heard: StreamMessage[] = [];
    bus.subscribe((m) => heard.push(m));
    const posted: ServerToMain[] = [];
    const handle = mainMessageHandler({ tokens: testTokens(), close: async () => {}, db, bus }, (m) => posted.push(m), vi.fn());
    return { db, handle, posted, heard };
  }

  it('adds, regenerates, disables and enables agents, answering with the token when there is a new one, and tells the windows', async () => {
    const { db, handle, posted, heard } = setup();
    await handle({ type: 'add-agent', id: 1, name: 'Claude' });
    const added = posted[0] as Extract<ServerToMain, { type: 'agent-result' }>;
    expect(added).toEqual({ type: 'agent-result', id: 1, agent: expect.objectContaining({ id: 2, name: 'Claude', disabledAt: null }), token: expect.stringMatching(/^ghd_/) });
    expect(principalForToken(db, added.token!)).toMatchObject({ id: 2, kind: 'agent' });

    await handle({ type: 'regenerate-agent-token', id: 2, agent: 2 });
    const regenerated = posted[1] as Extract<ServerToMain, { type: 'agent-result' }>;
    expect(regenerated).toMatchObject({ type: 'agent-result', id: 2, agent: { id: 2 } });
    expect(regenerated.token).not.toBe(added.token);
    expect(principalForToken(db, added.token!)).toBeNull();

    await handle({ type: 'set-agent-enabled', id: 3, agent: 2, enabled: false });
    expect(posted[2]).toEqual({
      type: 'agent-result', id: 3, agent: expect.objectContaining({ id: 2, tokenPrefix: regenerated.token!.slice(0, 8), disabledAt: expect.any(String) }), token: null,
    });
    expect(principalForToken(db, regenerated.token!)).toBeNull();
    expect(agentForToken(db, regenerated.token!)).toMatchObject({ disabled: true });
    // Enabled: the same token again.
    await handle({ type: 'set-agent-enabled', id: 4, agent: 2, enabled: true });
    expect(posted[3]).toEqual({ type: 'agent-result', id: 4, agent: expect.objectContaining({ id: 2, disabledAt: null }), token: null });
    expect(principalForToken(db, regenerated.token!)).toMatchObject({ id: 2 });
    expect(heard).toEqual([{ type: 'agents' }, { type: 'agents' }, { type: 'agents' }, { type: 'agents' }]);
  });

  it("says what an agent wrote, then deletes it, keeping its comments under its new name, and tells the windows which", async () => {
    const { db, handle, posted, heard } = setup();
    await handle({ type: 'add-agent', id: 1, name: 'Claude' });
    const { token } = posted[0] as Extract<ServerToMain, { type: 'agent-result' }>;
    db.run(`INSERT INTO repos (source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at)
      VALUES (1, 'alice/app', 'R_app', 'app', 'alice/app', 'alice', 'https://github.com/alice/app', 'public', '2026-09-01T00:00:00Z')`);
    const repoId = db.get<{ id: number }>("SELECT id FROM repos WHERE key = 'alice/app'")!.id;
    const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };
    const thread = createThread(db, { repoId, kind: 'pr', number: 2 }, { commitOid: 'a'.repeat(40), baseOid: null, anchor: general, body: 'Hm' }, getPrincipal(db, 2)!);
    await handle({ type: 'agent-footprint', id: 2, agent: 2 });
    expect(posted[1]).toEqual({ type: 'agent-footprint', id: 2, footprint: { comments: 1, threads: 1, openThreads: 1, opened: 1 } });
    await handle({ type: 'delete-agent', id: 3, agent: 2 });
    expect(posted[2]).toEqual({
      type: 'agent-deleted', id: 3, deleted: { id: 2, name: 'Claude', deletedAs: 'Deleted agent #2', footprint: { comments: 1, threads: 1, openThreads: 1, opened: 1 } },
    });
    expect(agentForToken(db, token!)).toBeNull();
    expect(listAgents(db)).toEqual([]);
    expect(getThread(db, thread.id)!.comments[0]!.author).toEqual({ id: 2, kind: 'agent', name: 'Deleted agent #2' });
    // Asking what it wrote changes nothing, and tells no one.
    expect(heard).toEqual([{ type: 'agents' }, { type: 'agents', deleted: 2 }]);
    // Gone: not found again, for anything.
    await handle({ type: 'delete-agent', id: 4, agent: 2 });
    await handle({ type: 'agent-footprint', id: 5, agent: 2 });
    await handle({ type: 'set-agent-enabled', id: 6, agent: 2, enabled: true });
    await handle({ type: 'regenerate-agent-token', id: 7, agent: 2 });
    await handle({ type: 'set-agent-sources', id: 8, agent: 2, sources: null });
    expect(posted.slice(3).map((m) => m.type === 'request-failed' && m.message)).toEqual(Array(5).fill('There is no agent with id 2.'));
    expect(heard).toHaveLength(2);
  });

  it('uses a token the user chose, checked there, and never tells anyone but main', async () => {
    const { db, handle, posted } = setup();
    const mine = 'my-own-agent-token-0123456789';
    await handle({ type: 'add-agent', id: 1, name: 'Claude', token: mine });
    expect(posted[0]).toMatchObject({ type: 'agent-result', id: 1, agent: { tokenPrefix: 'my-o' }, token: mine });
    expect(principalForToken(db, mine)).toMatchObject({ name: 'Claude' });
    await handle({ type: 'add-agent', id: 2, name: 'Codex', token: mine });
    await handle({ type: 'add-agent', id: 3, name: 'Codex', token: 'too short' });
    await handle({ type: 'regenerate-agent-token', id: 4, agent: 2, token: 'a-second-token-of-my-own-000' });
    expect(posted.slice(1)).toEqual([
      { type: 'request-failed', id: 2, message: "That token is already another agent's" },
      { type: 'request-failed', id: 3, message: expect.stringContaining('24 to 256') },
      expect.objectContaining({ type: 'agent-result', id: 4, token: 'a-second-token-of-my-own-000' }),
    ]);
  });

  it('limits agents to sources, the built-in one too (made if need be), or lets them reach every one, and tells the windows', async () => {
    const { db, handle, posted, heard } = setup();
    const gitlab = ensureSource(db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' }).id;
    await handle({ type: 'add-agent', id: 1, name: 'Work', sources: ['gitlab.example.com'] });
    expect(posted[0]).toMatchObject({ type: 'agent-result', id: 1, agent: { id: 2, sources: ['gitlab.example.com'] }, token: expect.stringMatching(/^ghd_/) });
    expect(agentSourceIds(db, 2)).toEqual([gitlab]);
    await handle({ type: 'set-agent-sources', id: 2, agent: 2, sources: ['github.com', 'gitlab.example.com'] });
    expect(posted[1]).toEqual({ type: 'agent-result', id: 2, agent: expect.objectContaining({ id: 2, sources: ['github.com', 'gitlab.example.com'] }), token: null });
    await handle({ type: 'set-agent-sources', id: 3, agent: 2, sources: null });
    expect(agentSourceIds(db, 2)).toBeNull();
    // The built-in agent, before any request made it.
    expect(getMeta(db, 'builtInAgentId')).toBeNull();
    await handle({ type: 'set-agent-sources', id: 4, agent: 'built-in', sources: ['github.com'] });
    expect(posted[3]).toMatchObject({ type: 'agent-result', id: 4, agent: { name: 'Agent', builtIn: true, sources: ['github.com'] }, token: null });
    expect(agentSourceIds(db, builtInAgent(db).id)).toEqual([1]);
    expect(heard).toEqual([{ type: 'agents' }, { type: 'agents' }, { type: 'agents' }, { type: 'agents' }]);
    // Refused: an unknown host (naming the sources), no source, no such agent; nothing changes then.
    await handle({ type: 'set-agent-sources', id: 5, agent: 2, sources: ['gitlab.nope'] });
    await handle({ type: 'set-agent-sources', id: 6, agent: 9, sources: null });
    await handle({ type: 'set-agent-sources', id: 7, agent: 1, sources: ['github.com'] });
    await handle({ type: 'add-agent', id: 8, name: 'Codex', sources: [] });
    expect(posted.slice(4)).toEqual([
      { type: 'request-failed', id: 5, message: "gitlab.nope isn't a source here (the sources: github.com, gitlab.example.com)" },
      { type: 'request-failed', id: 6, message: 'There is no agent with id 9.' },
      { type: 'request-failed', id: 7, message: 'There is no agent with id 1.' },
      { type: 'request-failed', id: 8, message: expect.stringContaining('at least one source') },
    ]);
    expect(agentSourceIds(db, 2)).toBeNull();
    expect(heard).toHaveLength(4);
  });

  it("answers request-failed with the reason, and changes nothing", async () => {
    const { db, handle, posted, heard } = setup();
    await handle({ type: 'add-agent', id: 1, name: 'Claude' });
    await handle({ type: 'add-agent', id: 2, name: 'CLAUDE' });
    await handle({ type: 'add-agent', id: 3, name: '  ' });
    await handle({ type: 'regenerate-agent-token', id: 4, agent: 9 });
    await handle({ type: 'set-agent-enabled', id: 5, agent: 1, enabled: false });
    await handle({ type: 'delete-agent', id: 6, agent: 1 });
    await handle({ type: 'agent-footprint', id: 7, agent: 1 });
    await handle({ type: 'add-agent', id: 8, name: 'Deleted agent #3' });
    // The built-in agent has no token to disable, and stays.
    const builtIn = builtInAgent(db).id;
    await handle({ type: 'set-agent-enabled', id: 9, agent: builtIn, enabled: false });
    await handle({ type: 'delete-agent', id: 10, agent: builtIn });
    expect(posted.slice(1)).toEqual([
      { type: 'request-failed', id: 2, message: 'There is already an agent called Claude (id 2); regenerate its token instead' },
      { type: 'request-failed', id: 3, message: 'An agent needs a name' },
      { type: 'request-failed', id: 4, message: 'There is no agent with id 9.' },
      { type: 'request-failed', id: 5, message: 'There is no agent with id 1.' },
      { type: 'request-failed', id: 6, message: 'There is no agent with id 1.' },
      { type: 'request-failed', id: 7, message: 'There is no agent with id 1.' },
      { type: 'request-failed', id: 8, message: 'Names like "Deleted agent #3" are kept for deleted agents; give yours another name' },
      { type: 'request-failed', id: 9, message: expect.stringContaining('Agent is built in: it has no token') },
      { type: 'request-failed', id: 10, message: expect.stringContaining("Agent is built in and can't be deleted") },
    ]);
    expect(heard).toEqual([{ type: 'agents' }]);
    // Without a database (a server that can't), it says so.
    const bare: ServerToMain[] = [];
    await mainMessageHandler({ tokens: testTokens(), close: async () => {} }, (m) => bare.push(m), vi.fn())({ type: 'add-agent', id: 6, name: 'X' });
    expect(bare).toEqual([{ type: 'request-failed', id: 6, message: "This server can't manage agents" }]);
  });
});

describe('runDesktopChild', () => {
  function fakePort() {
    let listener: ((e: { data: unknown }) => void) | null = null;
    const posted: ServerToMain[] = [];
    const port: ParentPort = {
      on: (_event, l) => { listener = l; },
      postMessage: (m) => posted.push(m as ServerToMain),
    };
    return { port, posted, send: (data: unknown) => listener!({ data }) };
  }
  function desktopEnv(): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), 'ghd-'));
    dirs.push(dir);
    return {
      HOME: dir,
      [DESKTOP_ENV.desktop]: '1',
      [DESKTOP_ENV.config]: join(dir, 'config.json'),
      [DESKTOP_ENV.dataDir]: join(dir, 'data'),
      // What main passes: a unix socket path, or a named pipe on Windows.
      [DESKTOP_ENV.socket]: process.platform === 'win32' ? `\\\\.\\pipe\\ghd-test-${randomBytes(8).toString('hex')}` : join(dir, 's'),
      [DESKTOP_ENV.secret]: 'e'.repeat(64),
    };
  }

  it('starts on the socket, says ready, then answers messages sent while it started', async () => {
    const { port, posted, send } = fakePort();
    const exit = vi.fn();
    const env = desktopEnv();
    const starting = runDesktopChild(port, env, exit);
    send({ type: 'set-token', id: 7, choice: null, token: null });
    const server = (await starting)!;
    running.push(server);
    expect(server.config).toMatchObject({ desktop: true, listen: false, dbPath: join(env[DESKTOP_ENV.dataDir]!, 'gh-dash.db') });
    expect(server.socketPath).toBe(env[DESKTOP_ENV.socket]);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual([
      { type: 'ready', apiUrl: null, mcpUrl: null },
      { type: 'token-result', id: 7, ok: true, account: expect.objectContaining({ source: 'none', choice: null }) },
    ]);
    send({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('adds a GitLab source main wrote to config.json, without a restart', async () => {
    const { port, posted, send } = fakePort();
    const exit = vi.fn();
    const env = desktopEnv();
    const server = (await runDesktopChild(port, env, exit))!;
    running.push(server);
    expect(server.sources.list().map((r) => r.host)).toEqual(['github.com']);
    writeConfigFile(env[DESKTOP_ENV.config]!, { sources: [{ kind: 'gitlab', url: 'https://gitlab.example.com/gitlab' }] });
    send({ type: 'reload-sources', id: 8 });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ type: 'sources-result', id: 8, ok: true, error: null, sources: ['gitlab.example.com'] });
    // The desktop app chooses the method later: nothing is chosen yet, so nothing is asked of GitLab.
    const gl = server.sources.byHost('gitlab.example.com')!;
    expect(gl.config).toMatchObject({ baseUrl: 'https://gitlab.example.com/gitlab', tokenChoice: null });
    expect(await gl.tokens.get()).toMatchObject({ token: null, source: 'none', error: null });
    send({ type: 'shutdown' });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('reports a bad config as fatal and exits 1', async () => {
    const { port, posted } = fakePort();
    const exit = vi.fn();
    const env = desktopEnv();
    writeFileSync(env[DESKTOP_ENV.config]!, '{"port": "nope"}');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDesktopChild(port, env, exit)).toBeNull();
    expect(posted).toEqual([{ type: 'fatal', message: expect.stringContaining(`${env[DESKTOP_ENV.config]}: port:`) }]);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    const missing = fakePort();
    expect(await runDesktopChild(missing.port, { ...env, [DESKTOP_ENV.socket]: '' }, vi.fn())).toBeNull();
    expect(missing.posted).toEqual([{ type: 'fatal', message: `${DESKTOP_ENV.socket} and ${DESKTOP_ENV.secret} must be set by the desktop app` }]);
    vi.restoreAllMocks();
  });
});
