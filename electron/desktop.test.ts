import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus, Agent, SourceAccount, SourceCheck, TokenChoice } from '../shared/api';
import type { SourceTestDraft } from '../shared/desktop';
import { readConfigFile } from '../server/config-file';
import { agentTokenIs, createAgent } from '../server/db/agents';
import { openDb } from '../server/db/db';
import { loadSources } from '../server/sources/config';
import { ConfigInputError } from './config';
import { Desktop } from './desktop';
import type { ServerChild, StartResult } from './server-child';
import { type TokenStore, TokenStores } from './token-store';

/** safeStorage stand-in (as token-store.test.ts): "encrypts" by reversing and prefixing, so a file never holds a token as is. */
const safeStorage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptStringAsync: vi.fn(async (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`)),
  decryptStringAsync: vi.fn(async (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith('enc:')) throw new Error('bad data');
    return { result: [...text.slice(4)].reverse().join(''), shouldReEncrypt: false };
  }),
}));
vi.mock('electron', () => ({ safeStorage }));

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
  const agent = (id: number, name = 'Claude'): Agent => ({ id, name, tokenPrefix: 'ghd_abcd', createdAt: 'x', lastUsedAt: null, disabledAt: null, builtIn: false, sources: null });
  return {
    status: 'running', apiUrl: null as string | null, mcpUrl: null as string | null, lastError: null as string | null, sent, setToken: vi.fn(send), sendSetToken: vi.fn(send),
    addAgent: vi.fn(async (name: string) => ({ agent: agent(2, name), token: 'ghd_secret1' })),
    regenerateAgentToken: vi.fn(async (id: number) => ({ agent: agent(id), token: 'ghd_secret2' })),
    setAgentEnabled: vi.fn(async (id: number, enabled: boolean) => ({ ...agent(id), disabledAt: enabled ? null : 'y' })),
    agentFootprint: vi.fn(async () => ({ comments: 2, threads: 1, openThreads: 1, opened: 1 })),
    deleteAgent: vi.fn(async (id: number) => ({ id, name: 'Claude', deletedAs: `Deleted agent #${id}`, footprint: { comments: 2, threads: 1, openThreads: 1, opened: 1 } })),
    setAgentSources: vi.fn(async (id: number | 'built-in', sources: string[] | null) => ({ ...agent(id === 'built-in' ? 5 : id, id === 'built-in' ? 'Agent' : 'Claude'), sources })),
    checkAgentToken: vi.fn(async (_id: number, _hash: string) => false),
  };
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

describe('agents', () => {
  it("asks the child and hands the token back once, logging only the agent's name", async () => {
    const lines: string[] = [];
    desktop = new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: join(dir, 'data'), version: '1', restart, log: (l) => lines.push(l) });
    // The Local API serves MCP already: nothing else to do.
    writeFileSync(configPath, JSON.stringify({ listen: true }));
    // Without a store for them, tokens aren't kept.
    expect(await desktop.addAgent('Claude')).toEqual({ agent: expect.objectContaining({ id: 2, name: 'Claude' }), token: 'ghd_secret1', kept: false });
    expect(await desktop.regenerateAgentToken(2)).toMatchObject({ agent: { id: 2 }, token: 'ghd_secret2' });
    expect(await desktop.setAgentEnabled(2, false)).toMatchObject({ id: 2, tokenPrefix: 'ghd_abcd', disabledAt: 'y' });
    expect(await desktop.setAgentEnabled(2, true)).toMatchObject({ id: 2, disabledAt: null });
    expect(await desktop.agentFootprint(2)).toEqual({ comments: 2, threads: 1, openThreads: 1, opened: 1 });
    expect(await desktop.deleteAgent(2)).toMatchObject({ id: 2, name: 'Claude', deletedAs: 'Deleted agent #2' });
    expect(child.addAgent).toHaveBeenCalledWith('Claude', undefined, null);
    expect(child.regenerateAgentToken).toHaveBeenCalledWith(2, undefined);
    expect(child.setAgentEnabled.mock.calls).toEqual([[2, false], [2, true]]);
    expect(child.agentFootprint).toHaveBeenCalledWith(2);
    expect(child.deleteAgent).toHaveBeenCalledWith(2);
    expect(lines).toEqual([
      '[agents] added Claude (id 2)', '[agents] new token for Claude (id 2)', '[agents] disabled Claude (id 2)', '[agents] enabled Claude (id 2)',
      '[agents] deleted Claude (id 2); its comments stay, as by Deleted agent #2',
    ]);
    expect(lines.join('\n')).not.toContain('ghd_secret');
    // Nothing touches config.json or restarts the server.
    expect(readConfig()).toEqual({ listen: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it('turns MCP on for a new agent when the Local API is off (for agents alone) or its MCP is, and says so', async () => {
    restart.mockImplementation(async () => {
      const cfg = readConfig();
      child.mcpUrl = cfg.listen && cfg.mcp !== false ? 'http://127.0.0.1:4780/mcp' : null;
      return { ok: true, apiUrl: null };
    });
    // Off: the port comes on for agents alone, after the agent is made.
    const made = await desktop.addAgent('Claude');
    expect(made).toMatchObject({ agent: { name: 'Claude' }, token: 'ghd_secret1', enabledMcp: true });
    expect(readConfig()).toEqual({ listen: true, restApi: false, mcp: true });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(child.addAgent.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0]!);
    // On with MCP off: MCP comes on, the REST API stays as it was.
    writeFileSync(configPath, JSON.stringify({ listen: true, mcp: false, password: 'longenough' }));
    expect(await desktop.addAgent('Codex')).toMatchObject({ enabledMcp: true });
    expect(readConfig()).toEqual({ listen: true, mcp: true, password: 'longenough' });
    // Already served: nothing changes.
    expect(await desktop.addAgent('Other')).not.toHaveProperty('enabledMcp');
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('turns MCP on for other devices with tokens required, for "Turn on MCP" and a new agent alike', async () => {
    restart.mockImplementation(async () => ({ ok: true, apiUrl: null }));
    const shared = { listen: true, restApi: true, host: '0.0.0.0', password: 'longenough', mcp: false, mcpRequireTokens: false };
    writeFileSync(configPath, JSON.stringify(shared));
    await desktop.enableMcp();
    expect(readConfig()).toEqual({ ...shared, mcp: true, mcpRequireTokens: true });
    writeFileSync(configPath, JSON.stringify(shared));
    child.mcpUrl = 'http://127.0.0.1:4780/mcp';
    expect(await desktop.addAgent('Claude')).toMatchObject({ token: 'ghd_secret1', enabledMcp: true });
    expect(readConfig()).toEqual({ ...shared, mcp: true, mcpRequireTokens: true });
  });

  it("makes no agent when MCP can't be turned on with it, and hands the token back when turning it on fails after", async () => {
    // A hand-edited config.json the app would refuse (other devices without a password): nothing is made.
    writeFileSync(configPath, JSON.stringify({ listen: true, host: '0.0.0.0', mcp: false }));
    await expect(desktop.addAgent('Claude')).rejects.toThrow(/password/);
    writeFileSync(configPath, '{ broken');
    await expect(desktop.addAgent('Claude')).rejects.toThrow(/Fix or remove/);
    expect(child.addAgent).not.toHaveBeenCalled();
    // The restart fails: the previous config.json comes back, the agent is made, and its token is not withheld.
    writeFileSync(configPath, JSON.stringify({ listen: false }));
    restart.mockResolvedValueOnce({ ok: false, message: 'port 4780 is already in use' }).mockResolvedValue({ ok: true, apiUrl: null });
    expect(await desktop.addAgent('Codex')).toMatchObject({ agent: { name: 'Codex' }, token: 'ghd_secret1', enabledMcp: false });
    expect(readConfig()).toEqual({ listen: false });
  });

  it('"Turn on MCP": the port for agents alone when it was off, MCP alone when it was on; nothing when it is served', async () => {
    restart.mockImplementation(async () => ({ ok: true, apiUrl: null }));
    await desktop.enableMcp();
    expect(readConfig()).toEqual({ listen: true, restApi: false, mcp: true });
    writeFileSync(configPath, JSON.stringify({ listen: true, restApi: true, mcp: false }));
    await desktop.enableMcp();
    expect(readConfig()).toEqual({ listen: true, restApi: true, mcp: true });
    await desktop.enableMcp();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('passes a token the user chose to the child, after checking its shape, and never logs it', async () => {
    const lines: string[] = [];
    desktop = new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: join(dir, 'data'), version: '1', restart, log: (l) => lines.push(l) });
    writeFileSync(configPath, JSON.stringify({ listen: true }));
    const mine = 'my-own-agent-token-0123456789';
    await desktop.addAgent('Claude', mine);
    await desktop.regenerateAgentToken(2, mine);
    expect(child.addAgent).toHaveBeenCalledWith('Claude', mine, null);
    expect(child.regenerateAgentToken).toHaveBeenCalledWith(2, mine);
    expect(lines.join('\n')).not.toContain(mine);
    for (const bad of ['short', 'has a space in it, somewhere here', 'tëst-token-with-accents-000', 'x'.repeat(257), 42]) {
      expect(() => desktop.addAgent('Codex', bad), String(bad)).toThrow(ConfigInputError);
      expect(() => desktop.regenerateAgentToken(2, bad), String(bad)).toThrow(ConfigInputError);
    }
    expect(child.addAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses what isn't a name or an id before asking the child, and passes its refusals on as the user's to read", async () => {
    for (const bad of [undefined, 3, '', '   ']) expect(() => desktop.addAgent(bad), String(bad)).toThrow('Give the agent a name.');
    expect(() => desktop.addAgent('x'.repeat(201))).toThrow("That name is too long for an agent's.");
    for (const bad of ['2', 0, -1, 1.5, null]) {
      expect(() => desktop.regenerateAgentToken(bad), String(bad)).toThrow('That is not an agent.');
      expect(() => desktop.setAgentEnabled(bad, false), String(bad)).toThrow('That is not an agent.');
      expect(() => desktop.agentFootprint(bad), String(bad)).toThrow('That is not an agent.');
      expect(() => desktop.deleteAgent(bad), String(bad)).toThrow('That is not an agent.');
    }
    expect(child.addAgent).not.toHaveBeenCalled();
    child.addAgent.mockRejectedValueOnce(new Error('There is already an agent called Claude (id 2); regenerate its token instead'));
    const refused = await desktop.addAgent('claude').catch((e: Error) => e);
    expect(refused).toBeInstanceOf(ConfigInputError);
    expect((refused as Error).message).toBe('There is already an agent called Claude (id 2); regenerate its token instead');
  });

  it('passes the sources an agent may reach to the child, as hosts, for a new agent or one already there, the built-in one too', async () => {
    const lines: string[] = [];
    desktop = new Desktop({ child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath, dataDir: join(dir, 'data'), version: '1', restart, log: (l) => lines.push(l) });
    writeFileSync(configPath, JSON.stringify({ listen: true }));
    const work: Agent = { id: 2, name: 'Work', tokenPrefix: 'ghd_abcd', createdAt: 'x', lastUsedAt: null, disabledAt: null, builtIn: false, sources: ['gitlab.example.com'] };
    child.addAgent.mockImplementationOnce(async () => ({ agent: work, token: 'ghd_secret1' }));
    expect(await desktop.addAgent('Work', undefined, [' GitLab.example.com '])).toMatchObject({ agent: { sources: ['gitlab.example.com'] } });
    expect(child.addAgent).toHaveBeenCalledWith('Work', undefined, ['gitlab.example.com']);
    expect(await desktop.setAgentSources(2, ['github.com'])).toMatchObject({ id: 2, sources: ['github.com'] });
    expect(await desktop.setAgentSources(2, null)).toMatchObject({ id: 2, sources: null });
    expect(await desktop.setAgentSources('built-in', ['github.com'])).toMatchObject({ name: 'Agent', sources: ['github.com'] });
    expect(child.setAgentSources.mock.calls).toEqual([[2, ['github.com']], [2, null], ['built-in', ['github.com']]]);
    expect(lines).toEqual([
      '[agents] added Work (id 2), reaching gitlab.example.com only',
      '[agents] Claude (id 2) now reaches github.com only',
      '[agents] Claude (id 2) now reaches every source',
      '[agents] Agent (id 5) now reaches github.com only',
    ]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses sources that aren't a list of hosts, and an agent that isn't one, before asking the child", async () => {
    for (const bad of [[], 'github.com', [''], ['  '], [42], ['git hub.com'], ['a\nb'], ['x'.repeat(254)], Array(101).fill('github.com'), {}]) {
      expect(() => desktop.setAgentSources(2, bad), JSON.stringify(bad)).toThrow(ConfigInputError);
      expect(() => desktop.addAgent('Claude', undefined, bad), JSON.stringify(bad)).toThrow(ConfigInputError);
    }
    expect(() => desktop.setAgentSources(2, [])).toThrow('Choose at least one source, or all of them.');
    for (const bad of ['builtin', 'Agent', 0, -1, 1.5, null, undefined]) expect(() => desktop.setAgentSources(bad, null), String(bad)).toThrow('That is not an agent.');
    expect(child.setAgentSources).not.toHaveBeenCalled();
    expect(child.addAgent).not.toHaveBeenCalled();
    child.setAgentSources.mockRejectedValueOnce(new Error("gitlab.nope isn't a source here (the sources: github.com)"));
    const refused = await desktop.setAgentSources(2, ['gitlab.nope']).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(ConfigInputError);
    expect((refused as Error).message).toBe("gitlab.nope isn't a source here (the sources: github.com)");
  });

  it('waits for a restart in progress instead of racing it', async () => {
    let finish!: () => void;
    restart.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ ok: true, apiUrl: null }))));
    const updating = desktop.updateConfig({ listen: true });
    const adding = desktop.addAgent('Claude');
    await new Promise((r) => setTimeout(r, 10));
    expect(child.addAgent).not.toHaveBeenCalled();
    finish();
    await updating;
    await adding;
    expect(child.addAgent).toHaveBeenCalledOnce();
  });
});

describe('kept agent tokens', () => {
  const sha = (token: string) => createHash('sha256').update(token).digest('hex');
  let userData: string;
  let lines: string[];
  /** A Desktop keeping agents' tokens in <userData>/agent-tokens, as main makes it. */
  const keeping = () => {
    const stores = new TokenStores(userData, (l) => lines.push(l));
    return new Desktop({
      child: child as unknown as ServerChild, tokens: tokens as unknown as TokenStore, agentTokens: (id) => stores.agent(id), configPath,
      dataDir: join(dir, 'data'), version: '1', restart, log: (l) => lines.push(l),
    });
  };
  const file = (id: number) => join(userData, 'agent-tokens', `${id}.enc`);
  /** The child: agent `id`'s token in its database is `token`. */
  const current = (id: number, token: string) => child.checkAgentToken.mockImplementation(async (i, hash) => i === id && hash === sha(token));
  const made = (id: number, name: string, token: string) => ({
    agent: { id, name, tokenPrefix: token.slice(0, 8), createdAt: 'x', lastUsedAt: null, disabledAt: null, builtIn: false, sources: null }, token,
  });

  beforeEach(() => {
    userData = join(dir, 'userData');
    lines = [];
    safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    // The Local API serves MCP already: nothing else to do.
    writeFileSync(configPath, JSON.stringify({ listen: true }));
  });

  it("keeps a new agent's token, encrypted, and shows it again while it is still that agent's", async () => {
    desktop = keeping();
    expect(await desktop.addAgent('Claude')).toEqual({ agent: expect.objectContaining({ id: 2 }), token: 'ghd_secret1', kept: true });
    expect(readFileSync(file(2), 'utf8')).not.toContain('ghd_secret1');
    if (process.platform !== 'win32') expect(statSync(file(2)).mode & 0o777).toBe(0o600);
    current(2, 'ghd_secret1');
    expect(await desktop.keptAgentToken(2)).toBe('ghd_secret1');
    // Only its hash went to the child, to check: never the token. It is never logged.
    expect(child.checkAgentToken).toHaveBeenCalledWith(2, sha('ghd_secret1'));
    expect(JSON.stringify(child.checkAgentToken.mock.calls)).not.toContain('ghd_secret1');
    expect(lines.join('\n')).not.toContain('ghd_secret');
    // A token of the user's own is kept the same way.
    const mine = 'my-own-agent-token-0123456789';
    child.addAgent.mockResolvedValueOnce(made(3, 'Codex', mine));
    expect(await desktop.addAgent('Codex', mine)).toMatchObject({ kept: true });
    current(3, mine);
    expect(await desktop.keptAgentToken(3)).toBe(mine);
  });

  it('checks it by the hash the server keeps of it', async () => {
    desktop = keeping();
    const token = 'ghd_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
    child.addAgent.mockResolvedValueOnce(made(2, 'Claude', token));
    await desktop.addAgent('Claude');
    await desktop.keptAgentToken(2);
    const db = openDb(':memory:');
    try {
      expect(createAgent(db, 'Claude', undefined, token).agent.id).toBe(2);
      expect(agentTokenIs(db, 2, child.checkAgentToken.mock.calls[0]![1])).toBe(true);
    } finally {
      db.close();
    }
  });

  it('replaces it with a new token, keeps it while the agent is disabled, and removes it with the agent', async () => {
    desktop = keeping();
    await desktop.addAgent('Claude');
    expect(await desktop.regenerateAgentToken(2)).toMatchObject({ token: 'ghd_secret2', kept: true });
    current(2, 'ghd_secret2');
    expect(await desktop.keptAgentToken(2)).toBe('ghd_secret2');
    await desktop.setAgentEnabled(2, false);
    expect(await desktop.keptAgentToken(2)).toBe('ghd_secret2');
    await desktop.setAgentEnabled(2, true);
    await desktop.deleteAgent(2);
    expect(existsSync(file(2))).toBe(false);
    child.checkAgentToken.mockClear();
    expect(await desktop.keptAgentToken(2)).toBeNull();
    expect(child.checkAgentToken).not.toHaveBeenCalled();
    // A delete the child refuses leaves it.
    await desktop.addAgent('Claude');
    child.deleteAgent.mockRejectedValueOnce(new Error('There is no agent with id 2.'));
    await expect(desktop.deleteAgent(2)).rejects.toThrow('There is no agent with id 2.');
    expect(existsSync(file(2))).toBe(true);
  });

  it("shows none that isn't the agent's token in this database: kept for another data folder, or replaced by the command", async () => {
    desktop = keeping();
    await desktop.addAgent('Claude');
    // Another database's agent 2, or this one's given another token since by `agents regenerate`.
    current(2, 'ghd_another-database-token');
    expect(await desktop.keptAgentToken(2)).toBeNull();
    current(3, 'ghd_secret1');
    expect(await desktop.keptAgentToken(2)).toBeNull();
    // Nothing kept: an agent made before tokens were kept, or by the command.
    expect(await desktop.keptAgentToken(7)).toBeNull();
    for (const bad of ['2', 0, -1, 1.5, null]) expect(() => desktop.keptAgentToken(bad), String(bad)).toThrow('That is not an agent.');
  });

  it('keeps nothing without a real keychain (Linux basic_text): the token is shown once', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
      desktop = keeping();
      expect(await desktop.addAgent('Claude')).toMatchObject({ token: 'ghd_secret1', kept: false });
      expect(await desktop.regenerateAgentToken(2)).toMatchObject({ token: 'ghd_secret2', kept: false });
      expect(existsSync(join(userData, 'agent-tokens'))).toBe(false);
      current(2, 'ghd_secret2');
      expect(await desktop.keptAgentToken(2)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it("drops the token it had when a new one can't be kept, never showing a stale one", async () => {
    desktop = keeping();
    await desktop.addAgent('Claude');
    safeStorage.encryptStringAsync.mockRejectedValueOnce(new Error('keychain locked'));
    expect(await desktop.regenerateAgentToken(2)).toMatchObject({ token: 'ghd_secret2', kept: false });
    expect(existsSync(file(2))).toBe(false);
    expect(lines).toContain('[agents] could not keep the token of Claude (id 2): keychain locked');
    expect(lines.join('\n')).not.toContain('ghd_secret');
  });

  it('keeps nothing without a store for them', async () => {
    expect(await desktop.addAgent('Claude')).toMatchObject({ kept: false });
    expect(await desktop.keptAgentToken(2)).toBeNull();
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
  let confirmEnv: ReturnType<typeof vi.fn<(host: string) => Promise<boolean>>>;
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
      confirmEnv,
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
    confirmEnv = vi.fn(async () => true);
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

  it("uses main's own file picker for a token file, for the host it was picked for only", async () => {
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'file' })).rejects.toThrow(`Choose the token file for ${HOST} first.`);
    await expect(desktop.addSource({ kind: 'gitlab', url: URL, method: 'file', tokenFile: '/etc/shadow' })).rejects.toThrow('Unexpected tokenFile.');
    const file = join(dir, 'gl-token');
    writeFileSync(file, 'glpat-in-a-file');
    expect(desktop.tokenFileHost(`${URL}/`)).toBe(HOST);
    expect(() => desktop.tokenFileHost('')).toThrow('Enter the address first.');
    expect(() => desktop.tokenFileHost('https://github.com')).toThrow('github.com is built in');
    expect(() => desktop.setTokenFile('relative/path', HOST)).toThrow('Choose the token file.');
    expect(() => desktop.setTokenFile(join(dir, 'missing'), HOST)).toThrow("missing isn't a file gh-dash can read.");
    expect(desktop.setTokenFile(file, HOST)).toBe(file);
    // Picked for gitlab.example.com: the renderer can't send it to another address.
    await expect(desktop.testSource({ kind: 'gitlab', url: 'https://evil.example', method: 'file' })).rejects.toThrow('Choose the token file for evil.example first.');
    expect(gl.testSource).not.toHaveBeenCalled();
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'file' });
    expect(gl.testSource).toHaveBeenLastCalledWith({ url: URL, method: 'file', tokenFile: file });
    expect(readConfig().sources).toEqual([{ kind: 'gitlab', url: URL, tokenSource: 'file', tokenFile: file }]);
    // Used once: the next file must be picked again.
    await expect(desktop.setSourceCredential(HOST, { method: 'file' })).rejects.toThrow(`Choose the token file for ${HOST} first.`);
  });

  it('sends GITLAB_TOKEN only to a host the user agreed to in main\'s dialog, asking once per host', async () => {
    env.GITLAB_TOKEN = 'glpat-from-env';
    confirmEnv.mockResolvedValueOnce(false);
    await expect(desktop.testSource({ kind: 'gitlab', url: 'https://evil.example', method: 'env' })).rejects.toThrow("GITLAB_TOKEN wasn't sent to evil.example.");
    expect(gl.testSource).not.toHaveBeenCalled();
    await desktop.testSource({ kind: 'gitlab', url: URL, method: 'env' });
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'env' });
    expect(confirmEnv.mock.calls).toEqual([['evil.example'], [HOST]]);
    expect(gl.testSource).toHaveBeenCalledTimes(2);
    // Without a dialog (no window, a test), it is never sent.
    const quiet = new Desktop({ child: { ...child, ...gl } as unknown as ServerChild, tokens: tokens as unknown as TokenStore, configPath: join(dir, 'other.json'), dataDir: dir, version: '1', restart, log: () => {}, env });
    await expect(quiet.testSource({ kind: 'gitlab', url: URL, method: 'env' })).rejects.toThrow("GITLAB_TOKEN wasn't sent");
  });

  it('lets GITLAB_TOKEN sign a source in only when it is set and free, and never another way while it locks the source', async () => {
    await expect(desktop.testSource({ kind: 'gitlab', url: URL, method: 'env' })).rejects.toThrow("GITLAB_TOKEN isn't set");
    env.GITLAB_TOKEN = 'glpat-from-env';
    // Offered, never implied: even the first source signs in with it only when asked to (and main's dialog agrees).
    expect((await desktop.state()).gitlabEnv).toBe('offered');
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

  it('does not hand GITLAB_TOKEN to the source a removal leaves alone, on this reload or a later start', async () => {
    env.GITLAB_TOKEN = 'glpat-not-a-real-token';
    await desktop.addSource({ kind: 'gitlab', url: URL, method: 'env' });
    await desktop.addSource({ kind: 'gitlab', url: 'https://gitlab2.example.com', method: 'app', token: 'glpat-good-b', remember: false });
    await desktop.removeSource(HOST);
    expect(readConfig().sources).toEqual([{ kind: 'gitlab', url: 'https://gitlab2.example.com', tokenSource: 'app' }]);
    // What the child loads from that config.json, now and at every later start: no variable for the remaining source.
    expect(loadSources({ ...env, GH_DASH_DESKTOP: '1' }, readConfigFile(configPath)).sources.map((s) => [s.host, s.tokenEnv])).toEqual([['gitlab2.example.com', null]]);
    expect(confirmEnv.mock.calls).toEqual([[HOST]]);
    // Free again, behind main's dialog.
    expect((await desktop.state()).gitlabEnv).toBe('offered');
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
