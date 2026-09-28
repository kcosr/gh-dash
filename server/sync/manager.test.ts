import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import { supplyOf, testTokens } from '../test/tokens';
import type { TokenSupply } from '../token';
import { SyncManager } from './manager';

const db = openDb(':memory:');
const managers: SyncManager[] = [];
function manager(schedule: boolean, token: string | null, tokens: TokenSupply = testTokens(token)) {
  const m = new SyncManager({ db, schedule, tokens, log: () => {} });
  managers.push(m);
  return m;
}
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

const lock = (heartbeatAgoMs: number) =>
  setMeta(db, 'syncLock', {
    instance: 'other-process',
    pid: 1,
    trigger: 'scheduled',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date(Date.now() - heartbeatAgoMs).toISOString(),
    progress: { done: 3, total: 87, current: 'app' },
  });

describe('SyncManager', () => {
  it('reports a sync running in another process from the shared lock and refuses to start a second one', async () => {
    lock(1000);
    let resolved = 0;
    const m = manager(false, 'token', supplyOf(() => (resolved++, 'token')));
    expect(m.status()).toMatchObject({ running: true, trigger: 'scheduled', progress: { done: 3, total: 87, current: 'app' }, tokenSource: 'env' });
    resolved = 0;
    // Refused before the token is resolved (that may run gh).
    expect(await m.start('manual')).toEqual({ ok: false, reason: 'running' });
    expect(resolved).toBe(0);
  });

  it('ignores a stale lock left by a dead process', () => {
    lock(5 * 60_000);
    expect(manager(false, null).status()).toMatchObject({ running: false, trigger: null, progress: null });
  });

  it('needs a token to start', async () => {
    expect(await manager(false, null).start('manual')).toEqual({ ok: false, reason: 'no-token' });
  });

  it('backs off a minute after finding no token, and drops the backoff when the token changes', async () => {
    db.run("DELETE FROM meta WHERE key IN ('syncLock', 'lastSync', 'nextSyncAt')");
    const tokens = testTokens(null, { choice: 'app' });
    const m = manager(true, null, tokens);
    m.startScheduler();
    const next = () => Date.parse(getMeta(db, 'nextSyncAt')!) - Date.now();
    await vi.waitFor(() => {
      m.reschedule();
      expect(next()).toBeGreaterThan(50_000);
    });
    expect(next()).toBeLessThanOrEqual(60_000);
    // Due in 30 s by the interval: the backoff still holds it back until the token changes.
    setMeta(db, 'lastSync', { at: new Date(Date.now() - 29.5 * 60_000).toISOString(), durationMs: 1, trigger: 'manual', newItems: 0, errors: [], pointsUsed: 1 });
    m.reschedule();
    expect(next()).toBeGreaterThan(50_000);
    tokens.setAppToken('github_pat_new');
    await tokens.get();
    m.reschedule();
    expect(next()).toBeLessThanOrEqual(30_000);
    expect(m.status().tokenSource).toBe('app');
  });

  it('forgets the token when GitHub rejects it', async () => {
    db.run("DELETE FROM meta WHERE key = 'viewer'");
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 })));
    try {
      const tokens = supplyOf(() => 'revoked');
      await expect(manager(false, null, tokens).ensureViewer()).rejects.toThrow(/401/);
      expect(tokens.invalidated).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('schedules from the last sync time and clears nextSyncAt on shutdown', async () => {
    db.run("DELETE FROM meta WHERE key = 'syncLock'");
    const lastAt = new Date(Date.now() - 10 * 60_000).toISOString();
    setMeta(db, 'lastSync', { at: lastAt, durationMs: 1, trigger: 'manual', newItems: 0, errors: [], pointsUsed: 1 });
    const m = manager(true, null);
    m.startScheduler();
    expect(m.status().nextSyncAt).toBe(new Date(Date.parse(lastAt) + 30 * 60_000).toISOString());
    await m.shutdown();
    expect(getMeta(db, 'nextSyncAt')).toBeNull();
  });

  it('never schedules when GH_DASH_SYNC=off', () => {
    setMeta(db, 'lastSync', { at: '2020-01-01T00:00:00.000Z', durationMs: 1, trigger: 'manual', newItems: 0, errors: [], pointsUsed: 1 });
    db.run("DELETE FROM meta WHERE key = 'nextSyncAt'");
    manager(false, 'token').startScheduler();
    expect(getMeta(db, 'nextSyncAt')).toBeNull();
    expect(getMeta(db, 'syncLock')).toBeNull();
  });
});

describe('ensureViewer', () => {
  afterEach(() => vi.unstubAllGlobals());
  const RL = { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 };
  /** GitHub answering the viewer query as `login`. */
  const answerAs = (id: string, login: string) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id, login, name: null, avatarUrl: null }, rateLimit: RL } })));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('adds the id to a viewer stored by login only, and just warns about a token for another account', async () => {
    const own = openDb(':memory:');
    const logs: string[] = [];
    const m = new SyncManager({ db: own, schedule: false, tokens: testTokens('t'), log: (line) => logs.push(line) });
    setMeta(own, 'viewer', { login: 'Alice', name: 'Alice A', avatarUrl: null });

    answerAs('U_mallory', 'mallory');
    await m.ensureViewer();
    expect(getMeta(own, 'viewer')).toEqual({ login: 'Alice', name: 'Alice A', avatarUrl: null });
    expect(logs).toEqual([
      '[sync] warning: This database belongs to @Alice, but the GitHub token is for @mallory. Switch back to @Alice, or use a different database.',
    ]);

    answerAs('U_alice', 'alice');
    await m.ensureViewer();
    expect(getMeta(own, 'viewer')).toEqual({ id: 'U_alice', login: 'alice', name: null, avatarUrl: null });
    // Known by id: no more requests.
    const fetch = answerAs('U_mallory', 'mallory');
    await m.ensureViewer();
    expect(fetch).not.toHaveBeenCalled();
  });
});
