import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../shared/api';
import type { MainToServer, ServerToMain } from '../shared/desktop';
import { ServerChild } from './server-child';

/** A utilityProcess stand-in: exits (asynchronously, like the real one) on `shutdown` or kill(). */
class FakeProc extends EventEmitter {
  static last = 0;
  readonly pid = ++FakeProc.last;
  readonly stdout = null;
  readonly stderr = null;
  alive = true;
  readonly sent: MainToServer[] = [];
  postMessage(message: MainToServer) {
    this.sent.push(message);
    if (message.type === 'shutdown') this.exit(0);
  }
  kill() {
    this.exit(null);
    return true;
  }
  reply(message: ServerToMain) {
    this.emit('message', message);
  }
  exit(code: number | null) {
    if (!this.alive) return;
    this.alive = false;
    setImmediate(() => this.emit('exit', code));
  }
}

const procs: FakeProc[] = [];
const fork = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork } }));

/** Lets pending exits, promise chains and forks run (setImmediate isn't faked). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let child: ServerChild;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  procs.length = 0;
  fork.mockReset().mockImplementation(() => {
    const proc = new FakeProc();
    procs.push(proc);
    return proc;
  });
  child = new ServerChild({ script: 'desktop.mjs', env: () => ({}), log: () => {} });
});
afterEach(() => vi.useRealTimers());

async function startRunning() {
  const started = child.start();
  await flush();
  procs.at(-1)!.reply({ type: 'ready', apiUrl: null, mcpUrl: null });
  expect(await started).toEqual({ ok: true, apiUrl: null });
}

describe('ServerChild', () => {
  it('restarts a crashed child after a backoff', async () => {
    await startRunning();
    procs[0]!.exit(1);
    await flush();
    expect(child.status).toBe('starting');
    await vi.advanceTimersByTimeAsync(499);
    expect(fork).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fork).toHaveBeenCalledTimes(2);
    procs[1]!.reply({ type: 'ready', apiUrl: null, mcpUrl: null });
    expect(await child.whenSettled()).toBe('running');
  });

  it('cancels a pending crash recovery on restart, so only the replacement runs', async () => {
    await startRunning();
    procs[0]!.exit(1);
    await flush();
    // A settings change restarts the child during the backoff.
    const restarted = child.restart();
    await flush();
    expect(fork).toHaveBeenCalledTimes(2);
    procs[1]!.reply({ type: 'ready', apiUrl: null, mcpUrl: null });
    expect(await restarted).toMatchObject({ ok: true });
    // The old recovery would have fired by now.
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(child.status).toBe('running');
    expect(child.pid).toBe(procs[1]!.pid);
    await child.stop();
    expect(procs.filter((p) => p.alive)).toEqual([]);
    expect(child.status).toBe('idle');
  });

  it('starts nothing after stop() during a crash-recovery backoff', async () => {
    await startRunning();
    procs[0]!.exit(1);
    await flush();
    await child.stop();
    expect(child.status).toBe('idle');
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fork).toHaveBeenCalledTimes(1);
    expect(child.status).toBe('idle');
  });

  it('ignores a late exit from an earlier launch', async () => {
    const first = child.start();
    await flush();
    // Fatal: the first child is on its way out but hasn't exited yet when the next one starts.
    procs[0]!.reply({ type: 'fatal', message: 'database is locked' });
    expect(await first).toEqual({ ok: false, message: 'database is locked' });
    const second = child.start();
    await flush();
    procs[1]!.reply({ type: 'ready', apiUrl: null, mcpUrl: null });
    await second;
    const token = child.sendSetToken('gh', null);
    procs[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fork).toHaveBeenCalledTimes(2);
    expect(child.status).toBe('running');
    expect(child.pid).toBe(procs[1]!.pid);
    // The replacement's pending set-token is still answered.
    const request = procs[1]!.sent.find((m) => m.type === 'set-token')!;
    procs[1]!.reply({ type: 'token-result', id: (request as { id: number }).id, ok: true, account: {} as AccountStatus });
    expect(await token).toMatchObject({ ok: true });
  });

  it('routes the answers to the GitLab sources\' requests by id, and rejects a failed one with its reason', async () => {
    await startRunning();
    const proc = procs[0]!;
    const tested = child.testSource({ url: 'https://gitlab.example.com', method: 'glab' });
    const reloaded = child.reloadSources();
    const token = child.setSourceToken('gitlab.example.com', 'glpat-x');
    const deleted = child.deleteSource('gitlab2.example.com');
    const synced = child.syncSource('gitlab.example.com');
    await flush();
    const ids = Object.fromEntries(proc.sent.map((m) => [m.type, (m as { id: number }).id]));
    expect(proc.sent).toEqual([
      { type: 'test-source', id: ids['test-source'], draft: { url: 'https://gitlab.example.com', method: 'glab' } },
      { type: 'reload-sources', id: ids['reload-sources'] },
      { type: 'set-token', id: ids['set-token'], source: 'gitlab.example.com', token: 'glpat-x' },
      { type: 'delete-source', id: ids['delete-source'], source: 'gitlab2.example.com' },
      { type: 'sync-source', id: ids['sync-source'], source: 'gitlab.example.com' },
    ]);
    // Answered out of order.
    proc.reply({ type: 'sync-started', id: ids['sync-source']!, result: 'queued' });
    proc.reply({ type: 'request-failed', id: ids['delete-source']!, message: 'gitlab2.example.com is still configured on this server.' });
    proc.reply({ type: 'token-result', id: ids['set-token']!, ok: true, account: { login: 'alice' } as never });
    proc.reply({ type: 'sources-result', id: ids['reload-sources']!, ok: true, error: null, sources: ['gitlab.example.com'] });
    proc.reply({ type: 'source-test-result', id: ids['test-source']!, check: { ok: true, host: 'gitlab.example.com' } as never });
    expect(await synced).toBe('queued');
    await expect(deleted).rejects.toThrow('gitlab2.example.com is still configured on this server.');
    expect(await token).toEqual({ ok: true, account: { login: 'alice' } });
    expect(await reloaded).toEqual({ ok: true, error: null, sources: ['gitlab.example.com'] });
    expect(await tested).toMatchObject({ ok: true, host: 'gitlab.example.com' });
  });

  it("sends the agents' requests and hands back the agent, with its token when there is one", async () => {
    await startRunning();
    const proc = procs[0]!;
    const agent = { id: 2, name: 'Claude', tokenPrefix: 'ghd_abcd', createdAt: 'x', lastUsedAt: null, revokedAt: null, builtIn: false, sources: null };
    const added = child.addAgent('Claude');
    const regenerated = child.regenerateAgentToken(2);
    const revoked = child.revokeAgent(2);
    const taken = child.addAgent('Claude');
    const tokenless = child.regenerateAgentToken(3);
    await flush();
    const [a, g, r, t, n] = proc.sent.map((m) => (m as { id: number }).id);
    expect(proc.sent).toEqual([
      { type: 'add-agent', id: a, name: 'Claude' },
      { type: 'regenerate-agent-token', id: g, agent: 2 },
      { type: 'revoke-agent', id: r, agent: 2 },
      { type: 'add-agent', id: t, name: 'Claude' },
      { type: 'regenerate-agent-token', id: n, agent: 3 },
    ]);
    proc.reply({ type: 'agent-result', id: a!, agent, token: 'ghd_first' });
    proc.reply({ type: 'agent-result', id: g!, agent, token: 'ghd_second' });
    proc.reply({ type: 'agent-result', id: r!, agent: { ...agent, tokenPrefix: null, revokedAt: 'y' }, token: null });
    proc.reply({ type: 'request-failed', id: t!, message: 'There is already an agent called Claude (id 2); regenerate its token instead' });
    proc.reply({ type: 'agent-result', id: n!, agent, token: null });
    expect(await added).toEqual({ agent, token: 'ghd_first' });
    expect(await regenerated).toEqual({ agent, token: 'ghd_second' });
    expect(await revoked).toMatchObject({ id: 2, revokedAt: 'y' });
    await expect(taken).rejects.toThrow('There is already an agent called Claude');
    await expect(tokenless).rejects.toThrow('The gh-dash server answered without a token.');
  });

  it('passes a token the user chose to the child with the request, and nothing when there is none', async () => {
    await startRunning();
    const proc = procs[0]!;
    void child.addAgent('Claude', 'my-own-agent-token-0123456789');
    void child.regenerateAgentToken(2, 'another-token-of-mine-98765');
    void child.addAgent('Codex', null);
    await flush();
    expect(proc.sent.map((m) => { const { id: _id, ...rest } = m as { id: number }; return rest; })).toEqual([
      { type: 'add-agent', name: 'Claude', token: 'my-own-agent-token-0123456789' },
      { type: 'regenerate-agent-token', agent: 2, token: 'another-token-of-mine-98765' },
      { type: 'add-agent', name: 'Codex' },
    ]);
  });

  it('sends the sources an agent may reach, for a new agent (none: every source) and one already there', async () => {
    await startRunning();
    const proc = procs[0]!;
    const agent = { id: 2, name: 'Claude', tokenPrefix: 'ghd_abcd', createdAt: 'x', lastUsedAt: null, revokedAt: null, builtIn: false, sources: ['github.com'] };
    void child.addAgent('Claude', null, ['github.com']);
    void child.addAgent('Codex', null, null);
    const limited = child.setAgentSources(2, ['github.com']);
    const builtIn = child.setAgentSources('built-in', null);
    await flush();
    const sent = proc.sent.map((m) => { const { id: _id, ...rest } = m as { id: number }; return rest; });
    expect(sent).toEqual([
      { type: 'add-agent', name: 'Claude', sources: ['github.com'] },
      { type: 'add-agent', name: 'Codex' },
      { type: 'set-agent-sources', agent: 2, sources: ['github.com'] },
      { type: 'set-agent-sources', agent: 'built-in', sources: null },
    ]);
    const [, , s, b] = proc.sent.map((m) => (m as { id: number }).id);
    proc.reply({ type: 'agent-result', id: s!, agent, token: null });
    proc.reply({ type: 'request-failed', id: b!, message: 'There is no agent with id 5.' });
    expect(await limited).toEqual(agent);
    await expect(builtIn).rejects.toThrow('There is no agent with id 5.');
  });

  it('keeps the MCP URL the child reports as ready, apart from the REST API URL', async () => {
    const started = child.start();
    await flush();
    procs.at(-1)!.reply({ type: 'ready', apiUrl: null, mcpUrl: 'http://127.0.0.1:4780/mcp' });
    expect(await started).toMatchObject({ ok: true, apiUrl: null });
    expect([child.apiUrl, child.mcpUrl]).toEqual([null, 'http://127.0.0.1:4780/mcp']);
  });

  it('rejects a request the child answers with the wrong type, or not at all', async () => {
    await startRunning();
    const proc = procs[0]!;
    const reloaded = child.reloadSources();
    await flush();
    proc.reply({ type: 'source-deleted', id: (proc.sent[0] as { id: number }).id, repos: 1 });
    await expect(reloaded).rejects.toThrow('The gh-dash server answered source-deleted instead of sources-result.');
    const late = child.syncSource('gitlab.example.com');
    const caught = late.catch((e: Error) => e.message);
    await flush();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await caught).toBe('The gh-dash server did not answer in time.');
  });
});
