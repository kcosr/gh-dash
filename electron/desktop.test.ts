import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus, SourceAccount, SourceCheck, TokenChoice } from '../shared/api';
import type { SourceTestDraft } from '../shared/desktop';
import { Desktop } from './desktop';
import type { ServerChild, StartResult } from './server-child';
import type { TokenStore } from './token-store';

const account = (over: Partial<AccountStatus> = {}): AccountStatus => ({
  source: 'none', choice: null, locked: false, login: null, name: null, avatarUrl: null, dbLogin: null, mismatch: false, kind: null,
  expiresAt: null, scopes: null, repos: null, error: null, gh: { available: true, path: '/usr/bin/gh', login: 'me' }, tokenFile: null, checkedAt: null,
  ...over,
});

let dir: string;
let configPath: string;
let child: ReturnType<typeof fakeChild>;
let tokens: ReturnType<typeof fakeTokens>;
let restart: ReturnType<typeof vi.fn<() => Promise<StartResult>>>;
let desktop: Desktop;
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
/** Fake child validation: tokens starting with ghp_ and gh are fine. */
const validate = async (choice: TokenChoice | null, token?: string | null) => {
  const ok = choice === 'gh' || (choice === 'app' && !!token?.startsWith('ghp_'));
  return { ok, account: account({ choice, source: ok ? (choice === 'gh' ? 'gh-cli' : 'app') : 'none', error: ok ? null : 'Bad credentials' }) };
};

const fakeChild = () => {
  /** Every set-token the child got, in order (setToken and sendSetToken both send one). */
  const sent: [TokenChoice | null, string | null | undefined][] = [];
  const send = (choice: TokenChoice | null, token?: string | null) => (sent.push([choice, token]), validate(choice, token));
  return { status: 'running', apiUrl: null as string | null, lastError: null as string | null, sent, setToken: vi.fn(send), sendSetToken: vi.fn(send) };
};
function fakeTokens() {
  let stored: string | null = null;
  return {
    secureStorage: vi.fn(async () => 'available' as const),
    has: vi.fn(() => stored !== null),
    load: vi.fn(async () => stored),
    save: vi.fn(async (t: string) => ((stored = t), true)),
    remove: vi.fn(() => void (stored = null)),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghd-desktop-test-'));
  configPath = join(dir, 'config.json');
  child = fakeChild();
  tokens = fakeTokens();
  restart = vi.fn(async (): Promise<StartResult> => ({ ok: true, apiUrl: null }));
  desktop = new Desktop({
    child: child as unknown as ServerChild,
    tokens: tokens as unknown as TokenStore,
    configPath,
    dataDir: join(dir, 'data'),
    version: '1.2.3',
    restart,
    log: () => {},
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tokens', () => {
  it('uses and remembers a pasted token', async () => {
    const result = await desktop.setToken('ghp_good', true);
    expect(result).toMatchObject({ ok: true, remembered: true });
    expect(child.setToken).toHaveBeenCalledWith('app', 'ghp_good');
    expect(tokens.save).toHaveBeenCalledWith('ghp_good');
    expect(readConfig().tokenSource).toBe('app');
  });

  it('does not remember without a keychain, and forgets an older remembered token', async () => {
    await desktop.setToken('ghp_first', true);
    tokens.save.mockResolvedValueOnce(false);
    const result = await desktop.setToken('ghp_second', true);
    expect(result.remembered).toBe(false);
    expect(tokens.has()).toBe(false);
  });

  it('leaves everything as it was when GitHub rejects the token', async () => {
    writeFileSync(configPath, JSON.stringify({ tokenSource: 'gh' }));
    const result = await desktop.setToken('nope', true);
    expect(result).toMatchObject({ ok: false, remembered: false });
    expect(tokens.save).not.toHaveBeenCalled();
    expect(readConfig().tokenSource).toBe('gh');
    // The child is put back on gh.
    expect(child.setToken).toHaveBeenLastCalledWith('gh', null);
  });

  it('switches to gh and drops the pasted token', async () => {
    await desktop.setToken('ghp_good', true);
    const result = await desktop.useGitHubCli();
    expect(result.ok).toBe(true);
    expect(child.setToken).toHaveBeenLastCalledWith('gh', null);
    expect(readConfig().tokenSource).toBe('gh');
    expect(tokens.has()).toBe(false);
  });

  it('signs out: no choice, no stored token', async () => {
    await desktop.setToken('ghp_good', true);
    await desktop.signOut();
    expect(child.setToken).toHaveBeenLastCalledWith(null, null);
    expect(readConfig().tokenSource).toBeNull();
    expect(tokens.has()).toBe(false);
  });

  it('restores the remembered token at launch and re-sends it after restarts', async () => {
    await desktop.setToken('ghp_saved', true);
    child.sendSetToken.mockClear();
    const next = new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: dir, version: '1', restart, log: () => {} });
    await next.restoreToken();
    expect(child.sendSetToken).toHaveBeenCalledWith('app', 'ghp_saved');
    next.onChildReady();
    expect(child.sendSetToken).toHaveBeenCalledTimes(2);
  });

  it('does not let a slow keychain undo a sign-out or a new token made meanwhile', async () => {
    await desktop.setToken('ghp_saved', true);
    const launch = () => new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: dir, version: '1', restart, log: () => {} });
    const slowLoad = () => {
      let decrypted!: () => void;
      tokens.load.mockImplementationOnce(() => new Promise((r) => (decrypted = () => r('ghp_saved'))));
      return async () => {
        await vi.waitFor(() => expect(tokens.load).toHaveBeenCalled());
        decrypted();
      };
    };

    // Sign out while the remembered token is still being decrypted.
    let next = launch();
    let decrypt = slowLoad();
    const restored = next.restoreToken();
    const signedOut = next.signOut();
    await decrypt();
    await Promise.all([restored, signedOut]);
    expect(child.sent.at(-1)).toEqual([null, null]);
    expect(readConfig().tokenSource).toBeNull();
    expect(tokens.has()).toBe(false);
    child.sent.length = 0;
    next.onChildReady();
    expect(child.sent).toEqual([]);

    // Paste another token while it's being decrypted.
    await desktop.setToken('ghp_saved', true);
    tokens.load.mockClear();
    next = launch();
    decrypt = slowLoad();
    const restoredAgain = next.restoreToken();
    const pasted = next.setToken('ghp_new', false);
    await decrypt();
    await Promise.all([restoredAgain, pasted]);
    expect(child.sent.at(-1)).toEqual(['app', 'ghp_new']);
    child.sent.length = 0;
    next.onChildReady();
    expect(child.sent).toEqual([['app', 'ghp_new']]);
  });

  it('keeps an unremembered token for the session only', async () => {
    await desktop.setToken('ghp_session', false);
    child.sendSetToken.mockClear();
    desktop.onChildReady();
    expect(child.sendSetToken).toHaveBeenCalledWith('app', 'ghp_session');
    const next = new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: dir, version: '1', restart, log: () => {} });
    await next.restoreToken();
    next.onChildReady();
    expect(child.sendSetToken).toHaveBeenCalledTimes(1);
  });
});

describe('updateConfig', () => {
  it('writes config.json and restarts the server', async () => {
    child.apiUrl = 'http://127.0.0.1:4800';
    const state = await desktop.updateConfig({ listen: true, port: 4800 });
    expect(readConfig()).toEqual({ listen: true, port: 4800 });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ version: '1.2.3', apiUrl: 'http://127.0.0.1:4800', serverError: null, config: { listen: true, port: 4800 } });
  });

  it('skips the restart when nothing changes', async () => {
    writeFileSync(configPath, JSON.stringify({ listen: true }));
    await desktop.updateConfig({ listen: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it('rolls back settings the server cannot start with', async () => {
    writeFileSync(configPath, JSON.stringify({ listen: true, port: 4800 }));
    restart.mockResolvedValueOnce({ ok: false, message: 'port 4900 in use' });
    const state = await desktop.updateConfig({ port: 4900 });
    expect(restart).toHaveBeenCalledTimes(2);
    expect(readConfig()).toEqual({ listen: true, port: 4800 });
    expect(state.serverError).toBe('The new settings were not applied: port 4900 in use');
    expect(state.config.port).toBe(4800);
  });

  it('removes a config.json it created when rolling back', async () => {
    restart.mockResolvedValueOnce({ ok: false, message: 'nope' });
    await desktop.updateConfig({ port: 4900 });
    expect(existsSync(configPath)).toBe(false);
  });

  it('refuses invalid input and a broken config.json without touching it', async () => {
    await expect(desktop.updateConfig({ port: -1 })).rejects.toThrow(/port/);
    await expect(desktop.updateConfig({ network: true })).rejects.toThrow(/password/);
    writeFileSync(configPath, '{ not json');
    await expect(desktop.updateConfig({ port: 4800 })).rejects.toThrow(/Fix or remove/);
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
    expect(restart).not.toHaveBeenCalled();
  });

  it('checks that a new data folder is usable', async () => {
    await desktop.updateConfig({ dataDir: join(dir, 'new-data') });
    expect(readConfig().db).toBe(join(dir, 'new-data', 'gh-dash.db'));
    writeFileSync(join(dir, 'a-file'), '');
    await expect(desktop.updateConfig({ dataDir: join(dir, 'a-file', 'sub') })).rejects.toThrow(/Can't use/);
  });

  it('reports state with secrets reduced to flags', async () => {
    writeFileSync(configPath, JSON.stringify({ apiKey: 'k'.repeat(20), password: 'secret-password' }));
    const state = await desktop.state();
    expect(state.config).toMatchObject({ apiKeySet: true, passwordSet: true });
    expect(JSON.stringify(state)).not.toMatch(/secret-password|kkkk/);
    expect(state).toMatchObject({ secureStorage: 'available', tokenRemembered: false, configPath });
  });
});

describe('generateApiKey', () => {
  it('makes distinct keys that updateConfig accepts', async () => {
    const a = desktop.generateApiKey();
    expect(a).toMatch(/^ghd_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(desktop.generateApiKey());
    await desktop.updateConfig({ apiKey: a });
    expect(readConfig().apiKey).toBe(a);
  });
});

describe.skipIf(process.platform === 'win32')('Locate gh', () => {
  const script = (name: string, output: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('saves a gh that answers --version and restarts the server, keeping the token choice', async () => {
    writeFileSync(configPath, JSON.stringify({ tokenSource: 'gh', port: 4999 }));
    const gh = script('gh', 'gh version 2.100.0 (2026-09-01)');
    await desktop.setGhPath(gh);
    expect(readConfig()).toEqual({ tokenSource: 'gh', port: 4999, ghPath: gh });
    expect(restart).toHaveBeenCalledTimes(1);
    // Picking the same one again is a no-op.
    await desktop.setGhPath(gh);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('refuses anything that is not gh, and relative paths', async () => {
    const other = script('git', 'git version 2.50.0');
    await expect(desktop.setGhPath(other)).rejects.toThrow(/isn't the GitHub CLI/);
    await expect(desktop.setGhPath(join(dir, 'missing'))).rejects.toThrow(/isn't the GitHub CLI/);
    await expect(desktop.setGhPath('bin/gh')).rejects.toThrow(/gh executable/);
    expect(existsSync(configPath)).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('GitLab sources', () => {
  const HOST = 'gitlab.example.com';
  const URL = 'https://gitlab.example.com/gitlab';
  const sourceAccount = (over: Partial<SourceAccount> = {}): SourceAccount => ({
    source: 'none', choice: null, locked: false, env: null, login: null, name: null, avatarUrl: null, dbLogin: null, mismatch: false, kind: null,
    expiresAt: null, scopes: null, canWrite: null, repos: null, cli: null, tokenFile: null, instance: null, error: null, checkedAt: null, ...over,
  });
  /** The child's test: tokens starting with glpat-good pass, as do glab, a file and the variable. */
  const tested = (draft: SourceTestDraft): SourceCheck => {
    const ok = draft.method !== 'app' || !!draft.token?.startsWith('glpat-good');
    const host = new globalThis.URL(draft.url).hostname;
    const source = draft.method === 'app' ? 'app' : draft.method === 'env' ? 'env' : draft.method === 'file' ? 'file' : 'glab';
    return { ok, host, url: draft.url.replace(/\/+$/, ''), conflict: null, account: sourceAccount({ source, login: ok ? 'alice' : null, error: ok ? null : '401 Unauthorized', scopes: ok ? ['read_api'] : null }) };
  };
  let stores: Map<string, ReturnType<typeof fakeTokens>>;
  let env: NodeJS.ProcessEnv;
  let gl: ReturnType<typeof glChild>;
  const glChild = () => ({
    calls: [] as string[],
    testSource: vi.fn(async (draft: SourceTestDraft) => (gl.calls.push(`test ${draft.method}`), tested(draft))),
    reloadSources: vi.fn(async () => (gl.calls.push('reload'), { ok: true, error: null as string | null, sources: [] as string[] })),
    setSourceToken: vi.fn(async (host: string, token: string | null) => (gl.calls.push(`token ${host} ${token ? 'set' : 'null'}`), { ok: !!token, account: sourceAccount({ source: token ? 'app' : 'none' }) })),
    sendSetSourceToken: vi.fn(async (host: string, token: string | null) => (gl.calls.push(`push ${host} ${token ? 'set' : 'null'}`), { ok: true, account: sourceAccount() })),
    deleteSource: vi.fn(async (host: string) => (gl.calls.push(`delete ${host}`), { repos: 3 })),
    syncSource: vi.fn(async (host: string) => (gl.calls.push(`sync ${host}`), 'started' as const)),
  });
  const make = () =>
    new Desktop({
      child: { ...child, ...gl } as unknown as ServerChild,
      tokens: tokens as unknown as TokenStore,
      sourceTokens: (host) => {
        if (!stores.has(host)) stores.set(host, fakeTokens());
        return stores.get(host)! as unknown as TokenStore;
      },
      env,
      findGlab: async (path) => path ?? '/usr/bin/glab',
      configPath,
      dataDir: join(dir, 'data'),
      version: '1.2.3',
      restart,
      log: () => {},
    });
  beforeEach(() => {
    stores = new Map();
    env = {};
    gl = glChild();
    desktop = make();
  });

  it('adds a source with a pasted token: tested, written, loaded, token handed over and kept, first sync started', async () => {
    const result = await desktop.addSource({ kind: 'gitlab', url: `${URL}/`, method: 'app', token: 'glpat-good-1', remember: true });
    expect(result).toMatchObject({ saved: true, remembered: true, check: { ok: true, host: HOST, url: URL, account: { login: 'alice' } } });
    expect(readConfig()).toEqual({ sources: [{ kind: 'gitlab', url: URL, tokenSource: 'app' }] });
    await vi.waitFor(() => expect(gl.calls).toEqual(['test app', 'reload', `token ${HOST} set`, `sync ${HOST}`]));
    expect(stores.get(HOST)!.save).toHaveBeenCalledWith('glpat-good-1');
    expect(restart).not.toHaveBeenCalled();
    const state = await desktop.state();
    expect(state).toMatchObject({ sources: [{ host: HOST, url: URL, tokenRemembered: true }], glab: { path: '/usr/bin/glab', chosen: false }, gitlabEnv: 'unset' });
    // The token goes to main once and never comes back.
    expect(JSON.stringify([result, state])).not.toContain('glpat-good-1');
    // After a restart (a config change) and at the next launch, it is handed over again.
    desktop.onChildReady();
    expect(gl.sendSetSourceToken).toHaveBeenLastCalledWith(HOST, 'glpat-good-1');
    const next = make();
    await next.restoreToken();
    expect(gl.sendSetSourceToken).toHaveBeenCalledTimes(2);
    next.onChildReady();
    expect(gl.sendSetSourceToken).toHaveBeenCalledTimes(3);
  });

  it('saves nothing when the test fails, or when the source is already there', async () => {
    const failed = await desktop.addSource({ kind: 'gitlab', url: URL, method: 'app', token: 'glpat-bad', remember: true });
    expect(failed).toMatchObject({ saved: false, remembered: false, check: { ok: false, account: { error: '401 Unauthorized' } } });
    expect(existsSync(configPath)).toBe(false);
    expect(gl.calls).toEqual(['test app']);
    expect(stores.get(HOST)?.save).toBeUndefined();

    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'glab' });
    const again = await desktop.testSource({ kind: 'gitlab', url: 'https://GITLAB.example.com/gitlab', method: 'glab' });
    expect(again).toMatchObject({ ok: false, conflict: `${HOST} is already a source here: change its token under it instead.` });
    const twice = await desktop.addSource({ kind: 'gitlab', url: URL, method: 'glab' });
    expect(twice.saved).toBe(false);
    expect(readConfig().sources).toHaveLength(1);
  });

  it('keeps config.json as it was when the server cannot load the new sources', async () => {
    writeFileSync(configPath, JSON.stringify({ port: 4800 }));
    gl.reloadSources.mockResolvedValueOnce({ ok: false, error: 'boom', sources: [] });
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'glab' })).rejects.toThrow(`Adding ${HOST} failed: boom`);
    expect(readConfig()).toEqual({ port: 4800 });
    expect(gl.syncSource).not.toHaveBeenCalled();
  });

  it("uses main's own file picker for a token file, never a path from the renderer", async () => {
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'file' })).rejects.toThrow('Choose the token file first.');
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'file', tokenFile: '/etc/shadow' })).rejects.toThrow('Unexpected tokenFile.');
    const file = join(dir, 'gl-token');
    writeFileSync(file, 'glpat-in-a-file');
    expect(() => desktop.setTokenFile('relative/path')).toThrow('Choose the token file.');
    expect(() => desktop.setTokenFile(join(dir, 'missing'))).toThrow("missing isn't a file gh-dash can read.");
    expect(desktop.setTokenFile(file)).toBe(file);
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'file' });
    expect(gl.testSource).toHaveBeenLastCalledWith({ url: URL, method: 'file', tokenFile: file });
    expect(readConfig().sources).toEqual([{ kind: 'gitlab', url: URL, tokenSource: 'file', tokenFile: file }]);
    // Used once: the next file must be picked again.
    await expect(desktop.setSourceCredential(HOST, { method: 'file' })).rejects.toThrow('Choose the token file first.');
  });

  it('lets GITLAB_TOKEN sign a source in only when it is set, and never another way while it locks the source', async () => {
    await expect(desktop.testSource({ kind: 'gitlab', url: URL, method: 'env' })).rejects.toThrow("GITLAB_TOKEN isn't set");
    env.GITLAB_TOKEN = 'glpat-from-env';
    expect((await desktop.state()).gitlabEnv).toBe('locks');
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'glab' })).rejects.toThrow('so it is always this source');
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'env' });
    expect(gl.testSource).toHaveBeenLastCalledWith({ url: URL, method: 'env', tokenEnv: 'GITLAB_TOKEN' });
    expect(readConfig().sources).toEqual([{ kind: 'gitlab', url: URL, tokenEnv: 'GITLAB_TOKEN' }]);
    await expect(desktop.setSourceCredential(HOST, { method: 'glab' })).rejects.toThrow('GITLAB_TOKEN is set in the environment');
    await expect(desktop.signOutSource(HOST)).rejects.toThrow('GITLAB_TOKEN is set in the environment');
    // A second source: GITLAB_TOKEN is the first one's.
    expect((await desktop.state()).gitlabEnv).toBe('in-use');
    await expect(desktop.addSource({ kind: 'gitlab', url: 'https://gitlab2.example.com', method: 'env' })).rejects.toThrow("already another GitLab source's token");
    await desktop.addSource({ kind: 'gitlab', url: 'https://gitlab2.example.com', method: 'glab' });
    expect(readConfig().sources).toEqual([
      { kind: 'gitlab', url: URL, tokenEnv: 'GITLAB_TOKEN' },
      { kind: 'gitlab', url: 'https://gitlab2.example.com', tokenSource: 'glab' },
    ]);
  });

  it('changes a token only after the new one passes its test', async () => {
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'glab' });
    gl.calls.length = 0;
    const failed = await desktop.setSourceCredential(HOST, { method: 'app', token: 'glpat-bad', remember: true });
    expect(failed).toMatchObject({ saved: false, check: { ok: false } });
    expect(readConfig().sources[0].tokenSource).toBe('glab');
    expect(gl.calls).toEqual(['test app']);

    const ok = await desktop.setSourceCredential(HOST, { method: 'app', token: 'glpat-good-2', remember: false });
    expect(ok).toMatchObject({ saved: true, remembered: false });
    expect(readConfig().sources[0]).toEqual({ kind: 'gitlab', url: URL, tokenSource: 'app' });
    expect(gl.calls.slice(1)).toEqual(['test app', 'reload', `token ${HOST} set`]);
    expect(stores.get(HOST)!.has()).toBe(false);
    // Back to glab: the pasted token is forgotten, here and in the server.
    gl.calls.length = 0;
    await desktop.setSourceCredential(HOST, { method: 'glab' });
    expect(gl.calls).toEqual(['test glab', 'reload', `token ${HOST} null`]);
    desktop.onChildReady();
    expect(gl.sendSetSourceToken).not.toHaveBeenCalled();
    await expect(desktop.setSourceCredential('gitlab2.example.com', { method: 'glab' })).rejects.toThrow("gitlab2.example.com isn't one of this app's GitLab sources.");
  });

  it('signs out of a source, keeping it; removes one from config.json, then deletes its data', async () => {
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'app', token: 'glpat-good-3', remember: true });
    await desktop.addSource({ kind: 'gitlab', url: 'https://gitlab2.example.com', method: 'glab' });
    const account = await desktop.signOutSource(HOST);
    expect(account.source).toBe('none');
    expect(readConfig().sources[0]).toEqual({ kind: 'gitlab', url: URL, tokenSource: null });
    expect(stores.get(HOST)!.has()).toBe(false);

    gl.calls.length = 0;
    const state = await desktop.removeSource(HOST);
    expect(gl.calls).toEqual(['reload', `delete ${HOST}`]);
    expect(readConfig().sources).toEqual([{ kind: 'gitlab', url: 'https://gitlab2.example.com', tokenSource: 'glab' }]);
    expect(state.sources.map((s) => s.host)).toEqual(['gitlab2.example.com']);
    gl.deleteSource.mockRejectedValueOnce(new Error('database is locked'));
    await expect(desktop.removeSource('gitlab2.example.com')).rejects.toThrow("gitlab2.example.com was taken out of the app's sources, but its data wasn't deleted: database is locked");
    expect(readConfig().sources).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('Locate glab', () => {
  const script = (name: string, output: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('saves a glab that answers --version and reloads the sources, without a restart', async () => {
    const reloadSources = vi.fn(async () => ({ ok: true, error: null, sources: [] }));
    const d = new Desktop({ child: { ...child, reloadSources } as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: dir, version: '1', restart, log: () => {}, findGlab: async (p) => p });
    writeFileSync(configPath, JSON.stringify({ tokenSource: 'gh' }));
    const glab = script('glab', 'glab 1.119.0 (2026-09-01)');
    const state = await d.setGlabPath(glab);
    expect(readConfig()).toEqual({ tokenSource: 'gh', glabPath: glab });
    expect(state.glab).toEqual({ path: glab, chosen: true });
    expect(reloadSources).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
    await d.setGlabPath(glab);
    expect(reloadSources).toHaveBeenCalledTimes(1);
    expect(await d.setGlabPath(script('glab2', 'glab version 1.50.0')).then((s) => s.glab.path)).toBe(join(dir, 'glab2'));
    await expect(d.setGlabPath(script('gh', 'gh version 2.100.0'))).rejects.toThrow("gh isn't the GitLab CLI");
    await expect(d.setGlabPath('glab')).rejects.toThrow('Choose the glab executable.');
  });
});
