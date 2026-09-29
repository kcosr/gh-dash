import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus, TokenChoice } from '../shared/api';
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
