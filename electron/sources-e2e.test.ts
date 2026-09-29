// Main and its server child agreeing on the GitLab sources' messages: Desktop → ServerChild → the child's message
// handler → a real server (desktop mode, config.json in a temp folder), and back. Only Electron's utilityProcess is
// faked (a process whose parentPort is the handler), and GitLab is the test suite's fake instance.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../server/config';
import { listSources } from '../server/db/sources';
import { mainMessageHandler } from '../server/desktop-child';
import { type RunningServer, startServer } from '../server/start';
import { fakeExec, fakeFs } from '../server/test/credentials';
import { BASE, fakeGitLab, graphql } from '../server/test/gitlab';
import { DESKTOP_ENV, type MainToServer, type ServerToMain } from '../shared/desktop';
import { Desktop } from './desktop';
import { ServerChild } from './server-child';
import type { TokenStore } from './token-store';

const fork = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork } }));

const HOST = 'gitlab.example.com';
const PAT = 'glpat-e2e-alice-token';
const GLAB_PAT = 'glpat-e2e-glab-token';
const user = { id: 'gid://gitlab/User/2', username: 'alice', name: 'Alice A', avatarUrl: null, publicEmail: null, commitEmail: null, emails: { nodes: [] } };
const noFiles = {
  stat: async (p: string): Promise<never> => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); },
  access: async (p: string): Promise<never> => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); },
  readFile: async (p: string): Promise<never> => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); },
};

/** A utilityProcess whose parentPort is the real child's message handler. */
class LoopbackProc extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = null;
  readonly stderr = null;
  handle: ((message: unknown) => Promise<void>) | null = null;
  postMessage(message: MainToServer) {
    // Like parentPort: asynchronous, one at a time.
    setImmediate(() => void this.handle?.(message));
  }
  kill() {
    setImmediate(() => this.emit('exit', 0));
    return true;
  }
}

let dir: string;
let server: RunningServer;
let desktop: Desktop;
let child: ServerChild;
const stores = new Map<string, Pick<TokenStore, 'has' | 'save' | 'remove' | 'load' | 'secureStorage'>>();
const store = (host: string) => {
  if (!stores.has(host)) {
    let saved: string | null = null;
    stores.set(host, { has: () => saved !== null, save: async (t) => ((saved = t), true), remove: () => void (saved = null), load: async () => saved, secureStorage: async () => 'available' });
  }
  return stores.get(host)! as unknown as TokenStore;
};
const configPath = () => join(dir, 'config.json');
const config = () => JSON.parse(readFileSync(configPath(), 'utf8'));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-e2e-'));
  stores.clear();
  const env = { HOME: dir, PATH: '/usr/bin', [DESKTOP_ENV.desktop]: '1', [DESKTOP_ENV.config]: configPath(), [DESKTOP_ENV.dataDir]: join(dir, 'data') };
  const loaded = loadServerConfig(env);
  const api = fakeGitLab({
    '/api/graphql': graphql({ CredentialCheck: () => ({ currentUser: user, metadata: { version: '19.3.3-ee', enterprise: true }, personal: { count: 3 } }) }),
    '/api/v4/personal_access_tokens/self': (req) =>
      [`Bearer ${PAT}`, `Bearer ${GLAB_PAT}`].includes(req.headers.Authorization!)
        ? { body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: req.headers.Authorization === `Bearer ${PAT}` ? ['read_api'] : ['api'], expires_at: '2027-01-31' } }
        : { status: 401, body: { message: '401 Unauthorized' } },
  });
  const glab = fakeExec((args) => (args.includes(HOST) ? `${GLAB_PAT}\n` : ''));
  server = await startServer({
    config: { ...loaded.config, webDir: '/nonexistent', port: 0 },
    env: loaded.env,
    tcp: false,
    log: () => {},
    tokenOptions: { fs: noFiles, exec: async () => { throw new Error('gh must not run in tests'); }, fetchImpl: async () => { throw new Error('no network in tests'); } },
    sourceOptions: { platform: 'linux', fs: fakeFs({ '/usr/bin/glab': { exec: true } }), exec: glab.exec, fetchImpl: api.fetchImpl, sleep: async () => {} },
  });
  // A first sync would go on to fetch projects: here it is enough that it was asked for.
  vi.spyOn(server.sync, 'startOrQueue').mockResolvedValue('started');
  fork.mockReset().mockImplementation(() => {
    const proc = new LoopbackProc();
    const post = (message: ServerToMain) => setImmediate(() => proc.emit('message', message));
    proc.handle = mainMessageHandler(server, post, () => proc.emit('exit', 0));
    post({ type: 'ready', apiUrl: null });
    return proc;
  });
  child = new ServerChild({ script: 'desktop.mjs', env: () => ({}), log: () => {} });
  expect(await child.start()).toEqual({ ok: true, apiUrl: null });
  desktop = new Desktop({
    child,
    tokens: store('github.com'),
    sourceTokens: store,
    configPath: configPath(),
    dataDir: join(dir, 'data'),
    version: '1',
    restart: () => child.restart(),
    log: () => {},
    env: {},
    findGlab: async () => '/usr/bin/glab',
  });
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GitLab sources, main and server child together', () => {
  it('tests, adds with a pasted token, switches to glab, and removes a source', async () => {
    // A rejected token: nothing saved anywhere.
    const rejected = await desktop.addSource({ kind: 'gitlab', url: `${BASE}/`, method: 'app', token: 'glpat-wrong-token', remember: true });
    expect(rejected).toMatchObject({ saved: false, check: { ok: false, host: HOST, account: { error: expect.stringContaining('401') } } });
    expect(server.sources.byHost(HOST)).toBeNull();
    expect(listSources(server.db).map((s) => s.host)).toEqual(['github.com']);

    // Added: in config.json, loaded without a restart, the token handed over and remembered, the first sync asked for.
    const added = await desktop.addSource({ kind: 'gitlab', url: `${BASE}/`, method: 'app', token: PAT, remember: true });
    expect(added).toMatchObject({ saved: true, remembered: true, check: { ok: true, url: BASE, account: { login: 'alice', scopes: ['read_api'], canWrite: false } } });
    expect(config()).toEqual({ sources: [{ kind: 'gitlab', url: BASE, tokenSource: 'app' }] });
    const runtime = server.sources.byHost(HOST)!;
    expect(runtime).toMatchObject({ configured: true, config: { tokenChoice: 'app' } });
    expect(await runtime.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    await vi.waitFor(() => expect(server.sync.startOrQueue).toHaveBeenCalledWith({ source: HOST }));
    expect(await store(HOST).load()).toBe(PAT);
    expect((await desktop.state()).sources).toEqual([{ host: HOST, url: BASE, tokenRemembered: true }]);

    // Change token → glab: tested first, then the source's provider is rebuilt and the pasted token forgotten.
    const switched = await desktop.setSourceCredential(HOST, { method: 'glab' });
    expect(switched).toMatchObject({ saved: true, check: { account: { source: 'glab', canWrite: true } } });
    expect(config().sources).toEqual([{ kind: 'gitlab', url: BASE, tokenSource: 'glab' }]);
    expect(await server.sources.byHost(HOST)!.tokens.get()).toMatchObject({ token: GLAB_PAT, source: 'glab' });
    expect(store(HOST).has()).toBe(false);

    // Remove: out of config.json, then gone from the database.
    const state = await desktop.removeSource(HOST);
    expect(state.sources).toEqual([]);
    expect(server.sources.byHost(HOST)).toBeNull();
    expect(listSources(server.db).map((s) => s.host)).toEqual(['github.com']);
    expect(config()).toEqual({});
  });

  it("answers a request the child can't do with the child's reason", async () => {
    await expect(child.setSourceToken('nowhere.example.com', PAT)).rejects.toThrow("nowhere.example.com isn't a GitLab source here.");
    await expect(child.deleteSource('github.com')).rejects.toThrow("github.com is built in and can't be removed.");
  });
});
