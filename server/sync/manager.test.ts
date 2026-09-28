import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import { SyncManager } from './manager';

const db = openDb(':memory:');
const managers: SyncManager[] = [];
function manager(schedule: boolean, token: string | null) {
  const m = new SyncManager({ db, schedule, resolveToken: () => ({ token, source: token ? 'env' : 'none' }), log: () => {} });
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
  it('reports a sync running in another process from the shared lock and refuses to start a second one', () => {
    lock(1000);
    const m = manager(false, 'token');
    expect(m.status()).toMatchObject({ running: true, trigger: 'scheduled', progress: { done: 3, total: 87, current: 'app' }, tokenSource: 'env' });
    expect(m.start('manual')).toEqual({ ok: false, reason: 'running' });
  });

  it('ignores a stale lock left by a dead process', () => {
    lock(5 * 60_000);
    expect(manager(false, null).status()).toMatchObject({ running: false, trigger: null, progress: null });
  });

  it('needs a token to start', () => {
    expect(manager(false, null).start('manual')).toEqual({ ok: false, reason: 'no-token' });
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
