import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/db';
import { deleteMeta, getMeta, setMeta } from '../db/meta';
import { fakeGitHub } from '../test/github';
import { branchNode, fakeGraphQL, prNode, repoNode } from '../test/graphql';
import { addManualRepo, GITHUB, setViewer } from '../test/seed';
import { ensureSource, GITHUB_SOURCE_ID, getSource } from '../db/sources';
import { addManual } from '../db/write';
import { GitHubDiffSources } from '../github/diff-source';
import { mapRepo } from '../github/map';
import { SourceRegistry } from '../sources/registry';
import { gate } from '../test/gate';
import { BASE, type Handler } from '../test/gitlab';
import { syncInstance } from '../test/gitlab-instance';
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
    setViewer(db, null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 })));
    try {
      const tokens = supplyOf(() => 'revoked');
      await expect(manager(false, null, tokens).ensureViewer()).rejects.toThrow(/401/);
      expect(tokens.invalidated).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('schedules from the last full sync and clears nextSyncAt on shutdown', async () => {
    db.run("DELETE FROM meta WHERE key = 'syncLock'");
    const lastAt = new Date(Date.now() - 10 * 60_000).toISOString();
    setMeta(db, 'lastFullSyncAt', lastAt);
    // A later single-repo run doesn't move it.
    setMeta(db, 'lastSync', { at: new Date().toISOString(), durationMs: 1, trigger: 'manual', newItems: 0, errors: [], pointsUsed: 1, repo: 'bob/tool' });
    const m = manager(true, null);
    m.startScheduler();
    expect(m.status().nextSyncAt).toBe(new Date(Date.parse(lastAt) + 30 * 60_000).toISOString());
    await m.shutdown();
    expect(getMeta(db, 'nextSyncAt')).toBeNull();
  });

  it("reads a lock and a last sync written before sources as github.com's", async () => {
    const own = openDb(':memory:');
    const tokens = testTokens('t');
    await tokens.get();
    const m = new SyncManager({ db: own, schedule: false, tokens, log: () => {} });
    managers.push(m);
    const now = new Date().toISOString();
    setMeta(own, 'lastSync', { at: '2026-09-28T10:00:00.000Z', durationMs: 5, trigger: 'scheduled', newItems: 2, errors: ['alice/app: boom'], pointsUsed: 3 });
    setMeta(own, 'syncLock', { instance: 'old-build', pid: 1, trigger: 'scheduled', startedAt: now, heartbeatAt: now, progress: { done: 1, total: 4, current: 'alice/app' } });
    expect(m.status().sources).toEqual([{
      source: 'github.com', running: true, progress: { done: 1, total: 4, current: 'alice/app' }, lastSyncAt: '2026-09-28T10:00:00.000Z',
      lastResult: { newItems: 2, errors: ['alice/app: boom'] }, rateLimit: null, tokenSource: 'env', viewer: null, problem: null,
    }]);
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
    setViewer(own, { login: 'Alice', name: 'Alice A', avatarUrl: null });
    const viewer = () => getSource(own, GITHUB_SOURCE_ID)!.viewer;

    answerAs('U_mallory', 'mallory');
    await m.ensureViewer();
    expect(viewer()).toEqual({ id: null, login: 'Alice', name: 'Alice A', avatarUrl: null, emails: [] });
    expect(logs).toEqual([
      "[sync] warning: This database's GitHub account is @Alice, but the token is for @mallory. Switch back to @Alice, or use a different database.",
    ]);

    answerAs('U_alice', 'alice');
    await m.ensureViewer();
    expect(viewer()).toEqual({ id: 'U_alice', login: 'alice', name: null, avatarUrl: null, emails: [] });
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
    t.gql.state.branches['bob/tool'] = [branchNode('main', 'a', '2026-09-20T09:00:00Z', 'bob'), branchNode('topic', 'b', '2026-09-26T09:00:00Z', 'bob')];
    t.hold();
    expect(await t.m.startOrQueue({ repo: 'BOB/Tool' })).toBe('started');
    expect(t.m.status()).toMatchObject({ running: true, trigger: 'manual', repo: 'bob/tool', progress: { total: 1 } });
    t.release();
    await t.idle();
    expect(t.synced('bob/tool')).toBe(true);
    expect(t.gql.state.ops).toEqual(['RepoNode:R_bob/tool', 'RepoDetail:bob/tool']);
    // Its branches with the rest, in that one round.
    expect(t.db.all(`SELECT b.name FROM branches b JOIN repos r ON r.id = b.repo_id WHERE r.name_with_owner = 'bob/tool' ORDER BY b.name`)).toEqual([{ name: 'main' }, { name: 'topic' }]);
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
    const revived = addManual(t.db, GITHUB, mapRepo(repoNode('bob/tool')), { hidden: false }, '2026-09-29T01:00:00Z');
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
    addManual(t.db, GITHUB, mapRepo(repoNode('bob/tool')), { hidden: false }, '2026-09-29T01:00:00Z');
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

  it("leaves the first sync of a repo on a source it doesn't sync to the instance that does", async () => {
    const t = setup(true);
    // In the database, but this manager (github.com's alone) doesn't sync it.
    const gl = ensureSource(t.db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' });
    addManualRepo(t.db, 'platform/team/app', { source: gl, nodeId: 'gid://gitlab/Project/40' });
    expect([t.m.syncsSource('GitHub.com'), t.m.syncsSource('gitlab.example.com')]).toEqual([true, false]);
    expect(await t.m.startOrQueue({ repo: 'gitlab.example.com/platform/team/app', source: 'gitlab.example.com' })).toBe('queued');
    expect(t.m.status().running).toBe(false);
    // Nor does the scheduler start it: a GitHub run would refuse it, every few minutes.
    setMeta(t.db, 'lastFullSyncAt', new Date().toISOString());
    t.m.startScheduler();
    await new Promise((r) => setTimeout(r, 20));
    await t.idle();
    expect(getMeta(t.db, 'lastSync')).toBeNull();
    // A GitHub repo waiting beside it still gets its first sync.
    t.add('bob/tool');
    t.m.reschedule();
    await vi.waitFor(() => expect(t.synced('bob/tool')).toBe(true));
    await t.idle();
    expect(t.gql.state.ops.filter((o) => o.startsWith('RepoNode'))).toEqual(['RepoNode:R_bob/tool']);
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: 'bob/tool', errors: [] });
    t.add('carol/lib');
    expect(await t.m.startOrQueue({ repo: 'carol/lib', source: 'github.com' })).toBe('started');
    await t.idle();
  });

  it('single-repo runs never postpone the first full sync', async () => {
    const t = setup();
    t.add('bob/tool');
    expect(await t.m.startOrQueue({ repo: 'bob/tool' })).toBe('started');
    await t.idle();
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: 'bob/tool' });
    // No full sync has run: a scheduler, now or after a restart, finds one due at once.
    const m = new SyncManager({ db: t.db, schedule: true, tokens: testTokens(null), log: () => {} });
    managers.push(m);
    m.startScheduler();
    expect(Date.parse(getMeta(t.db, 'nextSyncAt')!)).toBeLessThanOrEqual(Date.now());
    expect(getMeta(t.db, 'lastFullSyncAt')).toBeNull();
  });

  it('adopts the last sync of a database from before full syncs were told apart as its last full sync', () => {
    const own = openDb(':memory:');
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    setMeta(own, 'lastSync', { at, durationMs: 1, trigger: 'scheduled', newItems: 0, errors: [], pointsUsed: 1 });
    const m = new SyncManager({ db: own, schedule: true, tokens: testTokens(null), log: () => {} });
    managers.push(m);
    expect(getMeta(own, 'lastFullSyncAt')).toBe(at);
    m.startScheduler();
    expect(getMeta(own, 'nextSyncAt')).toBe(new Date(Date.parse(at) + 30 * 60_000).toISOString());
  });

  it('counts unavailable repos out of a full sync total', async () => {
    const t = setup();
    t.add('bob/tool');
    t.add('carol/gone');
    t.db.run(`UPDATE repos SET unavailable_at = '2026-09-29T00:00:00Z', unavailable_reason = 'x' WHERE name_with_owner = 'carol/gone'`);
    t.db.run(`INSERT INTO repos (source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at) VALUES (1, 'alice/app', 'R_alice/app', 'app', 'alice/app', 'alice', 'u', 'public', 'x')`);
    t.hold();
    await t.m.start('manual');
    expect(t.m.status()).toMatchObject({ repo: null, progress: { total: 2 } });
    t.release();
    await t.idle();
  });
});

describe('several sources', () => {
  const GL = 'gitlab.example.com';
  const GL_RE = GL.replace(/\./g, '\\.');
  const gid = (id: number) => `gid://gitlab/Project/${id}`;

  /** GitLab's rate-limit headers on every answer, the window going down by one a request. */
  function rated(f: typeof fetch): typeof fetch {
    let remaining = 2000;
    return async (input, init) => {
      const res = await f(input, init);
      const headers = new Headers(res.headers);
      headers.set('ratelimit-limit', '2000');
      headers.set('ratelimit-remaining', String(--remaining));
      headers.set('ratelimit-reset', '4070908800');
      return new Response(res.body, { status: res.status, headers });
    };
  }

  /**
   * github.com (the GraphQL fake: alice/app) and a GitLab source (the fake instance: alice/app and alice/corp.tools),
   * each with its token (null: none) and a fetch that can be held back, through a real SourceRegistry.
   */
  function setup(o: { github?: string | null; gitlab?: string | null; schedule?: boolean; gitlabOver?: Record<string, Handler> } = {}) {
    const db = openDb(':memory:');
    const gql = fakeGraphQL();
    gql.state.owned.push(repoNode('alice/app'));
    const gh = fakeGitHub({ '/graphql': gql.handler });
    const gl = syncInstance(o.gitlabOver);
    const gates = { github: gate(), gitlab: gate() };
    const tokens = testTokens(o.github === undefined ? 'ghp_test' : o.github);
    const sources = new SourceRegistry({
      db,
      env: o.gitlab === null ? {} : { GITLAB_TOKEN: o.gitlab ?? 'glpat-test-alice' },
      github: { tokens: tokens.credentials, diffs: new GitHubDiffSources({ tokens }), fetchImpl: gates.github.wrap(gh.fetchImpl) },
      log: () => {},
      seams: { fetchImpl: gates.gitlab.wrap(rated(gl.fetchImpl)), sleep: async () => {}, exec: async () => { throw new Error('glab must not run in tests'); } },
    });
    const [runtime] = sources.apply({
      glabPath: null,
      sources: [{ kind: 'gitlab', host: GL, baseUrl: BASE, tokenChoice: 'auto', tokenFile: null, tokenEnv: 'GITLAB_TOKEN', from: 'env' }],
    });
    const logs: string[] = [];
    const m = new SyncManager({ db, schedule: !!o.schedule, tokens, sources, log: (line) => logs.push(line) });
    managers.push(m);
    const gitlab = { id: runtime!.id, host: GL };
    return {
      db, gql, gh, gl, gates, sources, m, logs, gitlab,
      /** What the sync asked of GitLab: not the checks of a new token. */
      glAsked: () => gl.requests.filter((r) => !/CredentialCheck|personal_access_tokens/.test(r)),
      keys: (sourceId: number) => db.all<{ key: string }>('SELECT key FROM repos WHERE source_id = ? AND removed_at IS NULL ORDER BY key', [sourceId]).map((r) => r.key),
      synced: (key: string) => !!db.get('SELECT 1 FROM sync_state s JOIN repos r ON r.id = s.repo_id WHERE r.key = ? AND s.synced_at IS NOT NULL', [key]),
      part: (host: string) => m.status().sources.find((s) => s.source === host)!,
      idle: () => vi.waitFor(() => expect(m.status().running).toBe(false)),
    };
  }

  it('syncs every source in one run, each with its own client, account, results and rate limit', async () => {
    const t = setup();
    expect(await t.m.start('manual')).toEqual({ ok: true });
    await t.idle();
    expect(t.keys(GITHUB_SOURCE_ID)).toEqual(['alice/app']);
    expect(t.keys(t.gitlab.id)).toEqual([`${GL}/alice/app`, `${GL}/alice/corp.tools`]);
    // Each source is claimed for its own account; GitLab's with the addresses its commits carry, read first.
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.viewer).toEqual({ id: 'U_alice', login: 'alice', name: 'Alice', avatarUrl: null, emails: [] });
    expect(getSource(t.db, t.gitlab.id)!.viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice', emails: expect.arrayContaining(['alice@example.com', 'alice@corp.example.com']) });
    expect(t.glAsked().slice(0, 2)).toEqual(['graphql ViewerAccount', 'graphql OwnedProjects']);

    // Each source's part, with its own counters; GitLab's rate limit as its last answer left it.
    const github = getSource(t.db, GITHUB_SOURCE_ID)!;
    const gitlab = getSource(t.db, t.gitlab.id)!;
    const part = { at: expect.any(String), durationMs: expect.any(Number), errors: [] };
    expect(github.lastSync).toEqual({ ...part, newItems: 0, requests: t.gh.requests.length, points: t.gh.requests.length });
    expect(gitlab.lastSync).toEqual({ ...part, newItems: expect.any(Number), requests: t.glAsked().length, points: null });
    expect(gitlab.lastSync!.newItems).toBeGreaterThan(0);
    expect(github.rateLimit).toEqual({ limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z' });
    expect(gitlab.rateLimit).toEqual({ limit: 2000, remaining: expect.any(Number), resetAt: '2099-01-01T00:00:00.000Z' });

    // The run: both sources' items, GitHub's points, and the schedule counts from it.
    expect(getMeta(t.db, 'lastSync')).toEqual({
      at: expect.any(String), durationMs: expect.any(Number), trigger: 'manual', newItems: gitlab.lastSync!.newItems, errors: [], pointsUsed: github.lastSync!.points,
    });
    expect(getMeta(t.db, 'lastFullSyncAt')).not.toBeNull();
    const status = t.m.status();
    expect(status).toMatchObject({ running: false, progress: null, lastResult: { newItems: gitlab.lastSync!.newItems, errors: [] }, rateLimit: github.rateLimit, tokenSource: 'env', viewer: 'alice', repo: null });
    expect(status.sources).toEqual([
      { source: 'github.com', running: false, progress: null, lastSyncAt: github.lastSync!.at, lastResult: { newItems: 0, errors: [] }, rateLimit: github.rateLimit, tokenSource: 'env', viewer: 'alice', problem: null },
      { source: GL, running: false, progress: null, lastSyncAt: gitlab.lastSync!.at, lastResult: { newItems: gitlab.lastSync!.newItems, errors: [] }, rateLimit: gitlab.rateLimit, tokenSource: 'env', viewer: 'alice', problem: null },
    ]);
    // One log line per source; GitHub's as it was.
    expect(t.logs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\[sync\] manual done in \d+\.\ds · 1 repos · 0 new items · 0 errors · \d+ points in \d+ requests \(4990\/5000 left\)$/),
      expect.stringMatching(new RegExp(`^\\[sync\\] GitLab \\(${GL_RE}\\) · manual done in \\d+\\.\\ds · 2 repos · \\d+ new items · 0 errors · ${t.glAsked().length} requests \\(\\d+/2000 left\\)$`)),
    ]));
  });

  it("keeps each source's progress in the lock, and a source doesn't wait for another", async () => {
    const t = setup();
    await t.m.start('manual');
    await t.idle();
    t.gates.github.hold();
    expect(await t.m.start('manual')).toEqual({ ok: true });
    // GitLab's part ends while GitHub's waits on its first answer, which still counts the repo it knows.
    await vi.waitFor(() => expect(t.part(GL)).toMatchObject({ running: false, progress: { done: 2 } }));
    expect(t.m.status()).toMatchObject({ running: true, progress: { done: 2, total: 3 } });
    expect(t.part('github.com')).toMatchObject({ running: true, progress: { done: 0, total: 1, current: null } });
    expect(getMeta(t.db, 'syncLock')!.sources).toEqual({
      'github.com': { done: 0, total: 1, current: null, running: true },
      [GL]: { done: 2, total: 2, current: null, running: false },
    });
    t.gates.github.release();
    await t.idle();
    expect(getMeta(t.db, 'syncLock')).toBeNull();
    expect(t.m.status().sources.map((s) => s.running)).toEqual([false, false]);
  });

  it('stops only the source whose token is rejected, or that is out of its rate limit', async () => {
    const t = setup({ gitlabOver: { '/api/v4/projects/11/issues': { status: 401, body: { message: '401 Unauthorized' } } } });
    await t.m.start('manual');
    await t.idle();
    expect(getSource(t.db, t.gitlab.id)!.lastSync!.errors).toEqual([expect.stringMatching(/^Sync stopped: GitLab rejected the token \(401\)/)]);
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.lastSync!.errors).toEqual([]);
    expect(t.synced('alice/app')).toBe(true);
    // The run's errors name the source, but for github.com's.
    expect(getMeta(t.db, 'lastSync')!.errors).toEqual([expect.stringMatching(new RegExp(`^GitLab \\(${GL_RE}\\): Sync stopped: GitLab rejected the token \\(401\\)`))]);
    expect(t.logs).toContain(`[sync]   error: GitLab (${GL}): ${getSource(t.db, t.gitlab.id)!.lastSync!.errors[0]}`);

    const u = setup();
    u.gql.state.errors['alice/app'] = { type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' };
    await u.m.start('manual');
    await u.idle();
    expect(getMeta(u.db, 'lastSync')!.errors).toEqual(['API rate limit exceeded for user ID 1.']);
    expect(getSource(u.db, u.gitlab.id)!.lastSync!.errors).toEqual([]);
    expect([u.synced(`${GL}/alice/app`), u.synced(`${GL}/alice/corp.tools`), u.synced('alice/app')]).toEqual([true, true, false]);
  });

  it('syncs the sources that have a token, and says why the others are left out', async () => {
    const t = setup({ gitlab: null });
    const gitlabTokens = t.sources.byHost(GL)!.tokens;
    expect(await t.m.start('manual')).toEqual({ ok: true });
    await t.idle();
    expect(t.keys(GITHUB_SOURCE_ID)).toEqual(['alice/app']);
    expect(t.glAsked()).toEqual([]);
    // Still a run of every source (the schedule counts from it), with nothing to report but the missing token.
    expect(getMeta(t.db, 'lastFullSyncAt')).not.toBeNull();
    expect(getMeta(t.db, 'lastSync')!.errors).toEqual([]);
    expect(t.part(GL)).toEqual({
      source: GL, running: false, progress: null, lastSyncAt: null, lastResult: null, rateLimit: null, tokenSource: 'none', viewer: null,
      problem: gitlabTokens.noTokenMessage(),
    });
    expect(t.part(GL).problem).toMatch(new RegExp(`^No GitLab token for ${GL_RE}: `));
    expect(await t.m.start('manual', { source: GL })).toEqual({ ok: false, reason: 'no-token' });
    expect(t.m.noTokenMessage({ source: GL })).toBe(gitlabTokens.noTokenMessage());

    // GitHub's missing instead: GitLab syncs alone.
    const u = setup({ github: null });
    expect(await u.m.start('manual')).toEqual({ ok: true });
    await u.idle();
    expect([u.keys(GITHUB_SOURCE_ID), u.keys(u.gitlab.id)]).toEqual([[], [`${GL}/alice/app`, `${GL}/alice/corp.tools`]]);
    expect(u.gh.requests).toEqual([]);
    expect(u.m.status()).toMatchObject({ tokenSource: 'none', lastResult: { errors: [] } });
    expect(u.part('github.com').problem).toBe(u.sources.github().tokens.noTokenMessage());

    // Neither has one: nothing starts, and each says why.
    const none = setup({ github: null, gitlab: null });
    expect(await none.m.start('manual')).toEqual({ ok: false, reason: 'no-token' });
    expect(none.m.noTokenMessage()).toBe(`${none.sources.github().tokens.noTokenMessage()}; ${none.sources.byHost(GL)!.tokens.noTokenMessage()}`);
    expect(none.m.status().running).toBe(false);
  });

  it("reads each source's account once; another source's failure is only logged", async () => {
    const t = setup();
    await t.m.ensureViewer();
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.viewer).toMatchObject({ id: 'U_alice', login: 'alice', emails: [] });
    expect(getSource(t.db, t.gitlab.id)!.viewer).toMatchObject({ id: 'gid://gitlab/User/2', emails: expect.arrayContaining(['alice@corp.example.com']) });
    expect([t.gql.state.ops, t.glAsked()]).toEqual([['Viewer'], ['graphql ViewerAccount']]);
    // Known by id, and GitLab's emails with them: no more requests, nor before the next sync.
    await t.m.ensureViewer();
    expect([t.gql.state.ops, t.glAsked()]).toEqual([['Viewer'], ['graphql ViewerAccount']]);
    await t.m.start('manual');
    await t.idle();
    expect(t.glAsked().filter((r) => r === 'graphql ViewerAccount')).toHaveLength(1);

    const u = setup({ gitlabOver: { '/api/graphql': { status: 502, text: 'Bad gateway' } } });
    await expect(u.m.ensureViewer()).resolves.toBeUndefined();
    expect(u.logs).toEqual([expect.stringMatching(new RegExp(`^\\[sync\\] could not read the GitLab \\(${GL_RE}\\) account: `))]);
    expect(getSource(u.db, GITHUB_SOURCE_ID)!.viewer).toMatchObject({ login: 'alice' });
  });

  it('refuses a token for another account on its own source only', async () => {
    const t = setup();
    setViewer(t.db, { id: 'gid://gitlab/User/9', login: 'bob' }, t.gitlab.id);
    const mismatch = `This database's GitLab (${GL}) account is @bob, but the token is for @alice. Switch back to @bob, or remove the source and add it again (its data is deleted).`;
    await t.m.ensureViewer();
    expect(t.logs).toEqual([`[sync] warning: ${mismatch}`]);
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.viewer).toMatchObject({ id: 'U_alice', login: 'alice' });
    expect(t.m.status().sources.map((s) => s.problem)).toEqual([null, mismatch]);

    await t.m.start('manual');
    await t.idle();
    expect(t.keys(t.gitlab.id)).toEqual([]);
    expect(getSource(t.db, t.gitlab.id)!.viewer).toMatchObject({ login: 'bob', emails: [] });
    expect(getSource(t.db, t.gitlab.id)!.lastSync!.errors).toEqual([mismatch]);
    expect(getMeta(t.db, 'lastSync')!.errors).toEqual([`GitLab (${GL}): ${mismatch}`]);
    expect(t.keys(GITHUB_SOURCE_ID)).toEqual(['alice/app']);
    expect(t.m.status().sources.map((s) => s.problem)).toEqual([null, mismatch]);

    // The other way round.
    const u = setup();
    setViewer(u.db, { id: 'U_mallory', login: 'mallory' });
    await u.m.start('manual');
    await u.idle();
    const github = "This database's GitHub account is @mallory, but the token is for @alice. Switch back to @mallory, or use a different database.";
    expect(getMeta(u.db, 'lastSync')!.errors).toEqual([github]);
    expect([u.keys(GITHUB_SOURCE_ID), u.keys(u.gitlab.id)]).toEqual([[], [`${GL}/alice/app`, `${GL}/alice/corp.tools`]]);
    expect(u.m.status().sources.map((s) => s.problem)).toEqual([github, null]);
  });

  it('syncs one source, or one repo on its own source, without moving the schedule of full syncs', async () => {
    const t = setup();
    await t.m.start('manual');
    await t.idle();
    const full = getMeta(t.db, 'lastFullSyncAt');
    t.gl.requests.length = 0;
    t.gql.state.ops.length = 0;

    t.gates.gitlab.hold();
    expect(await t.m.start('manual', { repo: `${GL}/ALICE/app` })).toEqual({ ok: true });
    expect(t.m.status()).toMatchObject({ running: true, repo: `${GL}/alice/app`, progress: { total: 1 } });
    expect(t.m.status().sources.map((s) => [s.source, s.running])).toEqual([['github.com', false], [GL, true]]);
    t.gates.gitlab.release();
    await t.idle();
    expect(t.glAsked()[0]).toBe('graphql ProjectByNode');
    expect(t.gql.state.ops).toEqual([]);
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: `${GL}/alice/app`, errors: [] });

    // By its path on the source named.
    expect(await t.m.start('manual', { repo: 'alice/corp.tools', source: GL })).toEqual({ ok: true });
    await t.idle();
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: `${GL}/alice/corp.tools`, errors: [] });

    // All of one source's repos: not a full sync of every source.
    t.gl.requests.length = 0;
    expect(await t.m.start('manual', { source: 'GitLab.example.com' })).toEqual({ ok: true });
    await t.idle();
    expect(t.glAsked()).toContain('graphql OwnedProjects');
    expect(t.gql.state.ops).toEqual([]);
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ errors: [] });
    expect(getMeta(t.db, 'lastFullSyncAt')).toBe(full);

    // Nothing this instance syncs.
    expect(await t.m.start('manual', { source: 'gitlab2.example.com' })).toEqual({ ok: false, reason: 'no-source' });
    const other = ensureSource(t.db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    t.sources.apply();
    addManualRepo(t.db, 'team/app', { source: other, nodeId: gid(1) });
    expect(await t.m.start('manual', { repo: 'gitlab2.example.com/team/app' })).toEqual({ ok: false, reason: 'no-source' });
    expect(t.m.syncsSource('gitlab2.example.com')).toBe(false);
    expect(t.part('gitlab2.example.com')).toMatchObject({ tokenSource: 'none', problem: "GitLab (gitlab2.example.com) isn't configured on this server" });
  });

  it('starts the first sync of a project added by hand on GitLab, or runs it after the sync it waited for', async () => {
    const t = setup();
    addManualRepo(t.db, 'team/platform/api', { source: t.gitlab, nodeId: gid(40) });
    expect(t.m.syncsSource(GL)).toBe(true);
    expect(await t.m.startOrQueue({ repo: `${GL}/team/platform/api`, source: GL })).toBe('started');
    await t.idle();
    expect(t.synced(`${GL}/team/platform/api`)).toBe(true);
    expect(t.gql.state.ops).toEqual([]);

    const u = setup();
    u.gates.github.hold();
    expect(await u.m.start('manual', { source: 'github.com' })).toEqual({ ok: true });
    addManualRepo(u.db, 'team/platform/api', { source: u.gitlab, nodeId: gid(40) });
    expect(await u.m.startOrQueue({ repo: `${GL}/team/platform/api`, source: GL })).toBe('queued');
    expect(u.glAsked()).toEqual([]);
    u.gates.github.release();
    await vi.waitFor(() => expect(u.synced(`${GL}/team/platform/api`)).toBe(true));
    await u.idle();
    expect(u.glAsked()[0]).toBe('graphql ViewerAccount');
    expect(u.glAsked()[1]).toBe('graphql ProjectByNode');
    expect(getMeta(u.db, 'lastSync')).toMatchObject({ repo: `${GL}/team/platform/api`, errors: [] });
  });

  it('the scheduler syncs every source, and picks up the repos added by hand on each', async () => {
    const t = setup({ schedule: true });
    t.m.startScheduler();
    await vi.waitFor(() => expect(getMeta(t.db, 'lastFullSyncAt')).not.toBeNull());
    await t.idle();
    expect([t.keys(GITHUB_SOURCE_ID), t.keys(t.gitlab.id)]).toEqual([['alice/app'], [`${GL}/alice/app`, `${GL}/alice/corp.tools`]]);
    // Not due, but repos added by hand on either source wait for their first sync (one run each).
    addManualRepo(t.db, 'team/platform/api', { source: t.gitlab, nodeId: gid(40) });
    t.gql.state.others.push(repoNode('bob/tool'));
    addManualRepo(t.db, 'bob/tool');
    t.m.reschedule();
    await vi.waitFor(() => expect([t.synced(`${GL}/team/platform/api`), t.synced('bob/tool')]).toEqual([true, true]));
    await t.idle();
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: 'bob/tool', errors: [] });
    // A source this instance doesn't sync: its repos are left to the instance that does.
    const other = ensureSource(t.db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    t.sources.apply();
    addManualRepo(t.db, 'team/app', { source: other, nodeId: gid(1) });
    t.m.reschedule();
    await new Promise((r) => setTimeout(r, 20));
    await t.idle();
    expect(getMeta(t.db, 'lastSync')).toMatchObject({ repo: 'bob/tool' });
  });

  it("keeps the schedule of the sources that have a token: one without waits alone", async () => {
    const t = setup({ schedule: true, gitlab: null });
    t.m.startScheduler();
    await vi.waitFor(() => expect(getMeta(t.db, 'lastFullSyncAt')).not.toBeNull());
    await t.idle();
    // GitLab's project waits for a token; one added on GitHub after it doesn't wait for GitLab's (nor for the next tick).
    addManualRepo(t.db, 'team/platform/api', { source: t.gitlab, nodeId: gid(40) });
    t.gql.state.others.push(repoNode('bob/tool'));
    addManualRepo(t.db, 'bob/tool');
    t.m.reschedule();
    await vi.waitFor(() => expect(t.synced('bob/tool')).toBe(true));
    await t.idle();
    expect(t.synced(`${GL}/team/platform/api`)).toBe(false);
    expect(t.glAsked()).toEqual([]);
    // Nor is the next full sync held back by it.
    expect(t.m.status().nextSyncAt).toBe(new Date(Date.parse(getMeta(t.db, 'lastFullSyncAt')!) + 30 * 60_000).toISOString());
  });
});
