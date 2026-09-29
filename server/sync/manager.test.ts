import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/db';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { fakeGitHub } from '../test/github';
import { fakeGraphQL, prNode, repoNode } from '../test/graphql';
import { addManualRepo } from '../test/seed';
import { addManual } from '../db/write';
import { mapRepo } from '../github/map';
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

describe('syncing repos added by hand', () => {
  /** A manager over its own database and a fake GitHub whose answers can be held back (a sync that keeps running). */
  function setup(schedule = false) {
    const own = openDb(':memory:');
    const gql = fakeGraphQL();
    gql.state.owned.push(repoNode('alice/app'));
    const gh = fakeGitHub({ '/graphql': gql.handler });
    let gate: Promise<void> | null = null;
    let open = () => {};
    const fetchImpl: typeof fetch = async (input, init) => {
      if (gate) await gate;
      return gh.fetchImpl(input, init);
    };
    const m = new SyncManager({ db: own, schedule, tokens: testTokens('t'), log: () => {}, fetchImpl });
    managers.push(m);
    const add = (key: string) => {
      addManualRepo(own, key);
      gql.state.others.push(repoNode(key));
      gql.state.prs[key] = [prNode(key, 1, `${key} PR`)];
    };
    return {
      db: own, gql, m, add,
      hold: () => { gate = new Promise((r) => { open = () => { gate = null; r(); }; }); },
      release: () => open(),
      synced: (key: string) => !!own.get('SELECT 1 FROM sync_state s JOIN repos r ON r.id = s.repo_id WHERE r.name_with_owner = ? AND s.synced_at IS NOT NULL', [key]),
      idle: () => vi.waitFor(() => expect(m.status().running).toBe(false)),
    };
  }

  it('starts the first sync of a repo just added, naming it in the status', async () => {
    const t = setup();
    t.add('bob/tool');
    t.hold();
    expect(await t.m.startOrQueue({ repo: 'BOB/Tool' })).toBe('started');
    expect(t.m.status()).toMatchObject({ running: true, trigger: 'manual', repo: 'bob/tool', progress: { total: 1 } });
    t.release();
    await t.idle();
    expect(t.synced('bob/tool')).toBe(true);
    expect(t.gql.state.ops).toEqual(['RepoNode:R_bob/tool', 'RepoDetail:bob/tool']);
    expect(t.m.status().repo).toBeNull();
    // A single-repo run doesn't count as the full sync the schedule waits for.
    expect(getMeta(t.db, 'lastFullSyncAt')).toBeNull();
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ errors: [] });
  });

  it('queues behind the sync this process runs, once per repo, then runs it', async () => {
    const t = setup();
    t.add('bob/tool');
    t.hold();
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('started');
    t.add('carol/lib');
    expect(await t.m.startOrQueue({ repo: 'carol/lib' })).toBe('queued');
    expect(await t.m.startOrQueue({ repo: 'carol/lib' })).toBe('queued');
    t.release();
    await vi.waitFor(() => expect(t.synced('carol/lib')).toBe(true));
    await t.idle();
    expect(t.gql.state.ops.filter((o) => o.startsWith('RepoNode'))).toEqual(['RepoNode:R_bob/tool', 'RepoNode:R_carol/lib']);
  });

  it('runs the queued sync of a repo revived by a new add, though it synced before it was removed', async () => {
    const t = setup(true);
    t.add('bob/tool');
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('started');
    await t.idle();
    // Removed (say, transferred away and back), then added by hand again: the row comes back with its old sync state.
    t.db.run(`UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE name_with_owner = 'bob/tool'`);
    t.add('carol/lib');
    t.hold();
    expect(await t.m.startOrQueue({ repo: 'carol/lib' })).toBe('started');
    const revived = addManual(t.db, mapRepo(repoNode('bob/tool')), { hidden: false }, '2026-09-29T01:00:00Z');
    expect(revived).toMatchObject({ added: true });
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('queued');
    t.gql.state.ops.length = 0;
    t.release();
    await vi.waitFor(() => expect(t.gql.state.ops).toContain('RepoNode:R_bob/tool'));
    await t.idle();
    expect(t.synced('bob/tool')).toBe(true);
  });

  it('the scheduler also picks up a revived repo that is waiting for its sync', async () => {
    const t = setup(true);
    t.add('bob/tool');
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('started');
    await t.idle();
    t.db.run(`UPDATE repos SET removed_at = '2026-09-29T00:00:00Z' WHERE name_with_owner = 'bob/tool'`);
    addManual(t.db, mapRepo(repoNode('bob/tool')), { hidden: false }, '2026-09-29T01:00:00Z');
    setMeta(t.db, 'lastFullSyncAt', new Date().toISOString());
    t.gql.state.ops.length = 0;
    t.m.startScheduler();
    await vi.waitFor(() => expect(t.gql.state.ops).toContain('RepoNode:R_bob/tool'));
    await t.idle();
  });

  it("doesn't run a queued first sync that the full sync it waited for already did", async () => {
    const t = setup();
    t.hold();
    expect(await t.m.start('manual')).toEqual({ ok: true });
    t.add('bob/tool'); // before the full sync reads the repos added by hand
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('queued');
    t.release();
    await vi.waitFor(() => expect(t.synced('bob/tool')).toBe(true));
    await t.idle();
    expect(t.gql.state.ops.filter((o) => o.startsWith('RepoNode'))).toEqual([]);
    expect(getMeta(t.db, 'lastFullSyncAt')).not.toBeNull();
  });

  it('leaves it to the scheduler when another instance holds the lock', async () => {
    const t = setup(true);
    t.add('bob/tool');
    setMeta(t.db, 'syncLock', { instance: 'other', pid: 1, trigger: 'scheduled', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), progress: { done: 0, total: 1, current: null } });
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('queued');
    expect(t.gql.state.ops).toEqual([]);
    // Lock gone, full sync not due: the scheduler still starts the never-synced repo's first sync.
    deleteMeta(t.db, 'syncLock');
    setMeta(t.db, 'lastFullSyncAt', new Date().toISOString());
    t.m.startScheduler();
    await vi.waitFor(() => expect(t.synced('bob/tool')).toBe(true));
    await t.idle();
    expect(t.gql.state.ops).toEqual(['RepoNode:R_bob/tool', 'RepoDetail:bob/tool']);
  });

  it("doesn't retry a failed first sync on every tick, and skips unavailable repos", async () => {
    const t = setup(true);
    t.add('bob/tool');
    t.gql.state.errors['bob/tool'] = { type: 'INTERNAL', message: 'boom' };
    t.add('carol/gone');
    t.db.run(`UPDATE repos SET unavailable_at = '2026-09-29T00:00:00Z', unavailable_reason = 'x' WHERE name_with_owner = 'carol/gone'`);
    setMeta(t.db, 'lastFullSyncAt', new Date().toISOString());
    t.m.startScheduler();
    await vi.waitFor(() => expect(t.gql.state.ops.length).toBeGreaterThan(0));
    await t.idle();
    t.m.reschedule();
    t.m.reschedule();
    await t.idle();
    expect(t.gql.state.ops.filter((o) => o.startsWith('RepoNode'))).toEqual(['RepoNode:R_bob/tool']);
  });

  it('counts unavailable repos out of a full sync total', async () => {
    const t = setup();
    t.add('bob/tool');
    t.add('carol/gone');
    t.db.run(`UPDATE repos SET unavailable_at = '2026-09-29T00:00:00Z', unavailable_reason = 'x' WHERE name_with_owner = 'carol/gone'`);
    t.db.run(`INSERT INTO repos (node_id, name, name_with_owner, owner, url, visibility, created_at) VALUES ('R_alice/app', 'app', 'alice/app', 'alice', 'u', 'public', 'x')`);
    t.hold();
    await t.m.start('manual');
    expect(t.m.status()).toMatchObject({ repo: null, progress: { total: 2 } });
    t.release();
    await t.idle();
  });
});
