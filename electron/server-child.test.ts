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
  procs.at(-1)!.reply({ type: 'ready', apiUrl: null });
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
    procs[1]!.reply({ type: 'ready', apiUrl: null });
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
    procs[1]!.reply({ type: 'ready', apiUrl: null });
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
    procs[1]!.reply({ type: 'ready', apiUrl: null });
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
});
