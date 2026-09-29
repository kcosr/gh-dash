import { describe, expect, it, vi } from 'vitest';
import { fakeExec, fakeFs } from '../test/credentials';
import { fakeGitHub } from '../test/github';
import { BASE, fakeGitLab, graphql, type Handler, sha } from '../test/gitlab';
import { fakeGraphQL } from '../test/graphql';
import { testTokens } from '../test/tokens';
import { type Db, openDb } from '../db/db';
import { ensureSource, GITHUB_SOURCE_ID, getSource, listSources, removeSource, tryClaimViewer } from '../db/sources';
import { GitHubDiffSources } from '../github/diff-source';
import type { SourceConfig } from './config';
import { SourceRegistry } from './registry';

const HOST = 'gitlab.example.com';
const PAT = 'glpat-test-alice';
const SELF = '/api/v4/personal_access_tokens/self';
const NOW = Date.parse('2026-09-28T12:00:00Z');
const GLAB = '/usr/bin/glab';

const checkData = () => ({
  currentUser: { id: 'gid://gitlab/User/2', username: 'alice', name: 'Alice A', avatarUrl: null, publicEmail: 'alice@example.com', commitEmail: null, emails: { nodes: [] } },
  metadata: { version: '19.3.3-ee', enterprise: true },
  personal: { count: 3 },
});
const pat = (over: Record<string, unknown> = {}) => ({
  id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['read_api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, expires_at: '2026-12-31', ...over,
});
const CHECK_ROUTES: Record<string, Handler> = { '/api/graphql': graphql({ CredentialCheck: () => checkData() }), [SELF]: { body: pat() } };

/** A GitLab source as config gives it; BASE (gitlab.example.com, a relative root) is what the fake instance answers. */
const gitlab = (host = HOST, over: Partial<SourceConfig> = {}): SourceConfig => ({
  kind: 'gitlab', host, baseUrl: host === HOST ? BASE : `https://${host}`, tokenChoice: 'glab', tokenFile: null, tokenEnv: null, from: 'file', ...over,
});

/** One instance's registry; `db` shares another's database, as a second instance would. */
function setup(o: { env?: NodeJS.ProcessEnv; routes?: Record<string, Handler>; githubToken?: string; githubFetch?: typeof fetch; db?: Db } = {}) {
  const db = o.db ?? openDb(':memory:');
  const api = fakeGitLab(o.routes ?? CHECK_ROUTES);
  const glab = fakeExec(() => `${PAT}\n`);
  const logs: string[] = [];
  const github = testTokens(o.githubToken ?? null);
  const githubDiffs = new GitHubDiffSources({ tokens: github, log: () => {} });
  const registry = new SourceRegistry({
    db,
    env: o.env ?? { HOME: '/home/alice', PATH: '/usr/bin' },
    github: { tokens: github.credentials, diffs: githubDiffs, fetchImpl: o.githubFetch },
    log: (line) => logs.push(line),
    seams: { fetchImpl: api.fetchImpl, sleep: async () => {}, exec: glab.exec, fs: fakeFs({ [GLAB]: { exec: true } }), platform: 'linux', now: () => NOW },
  });
  return { db, registry, api, glab, logs, github, githubDiffs };
}

describe('SourceRegistry', () => {
  it('always has github.com, over the TokenProvider and diff sources startServer built', () => {
    const { registry, github, githubDiffs } = setup();
    const gh = registry.github();
    expect(gh).toMatchObject({ id: GITHUB_SOURCE_ID, kind: 'github', host: 'github.com', label: 'GitHub', configured: true, config: null });
    expect(gh.tokens).toBe(github.credentials);
    expect(gh.diffs).toBe(githubDiffs);
    expect(gh.row).toMatchObject({ id: 1, name: 'GitHub', baseUrl: 'https://github.com' });
    expect(registry.list()).toEqual([gh]);
    expect(registry.byId(1)).toBe(gh);
    expect(registry.byHost('GitHub.com')).toBe(gh);
  });

  it('reconciles the config with the sources table and builds one runtime per source', () => {
    const { db, registry, logs } = setup();
    const [first] = registry.apply({ glabPath: null, sources: [gitlab()] });
    expect(first).toMatchObject({ kind: 'gitlab', host: HOST, label: `GitLab (${HOST})`, configured: true, config: gitlab() });
    expect(first!.row).toMatchObject({ host: HOST, baseUrl: BASE, name: 'GitLab' });
    expect(registry.byHost('GITLAB.example.com')).toBe(first);
    expect(registry.byId(first!.id)).toBe(first);
    expect(logs).toEqual([`[sources] GitLab (${HOST}) at ${BASE} · token: glab`]);
    // Nothing to write, no write lock (another instance may be syncing): GitHub alone, or the same sources again.
    const tx = vi.spyOn(db, 'tx');
    expect(registry.apply({ glabPath: null, sources: [gitlab()] })).toEqual([]);
    const githubOnly = setup();
    const githubTx = vi.spyOn(githubOnly.db, 'tx');
    expect(githubOnly.registry.apply({ glabPath: null, sources: [] })).toEqual([]);
    expect([tx, githubTx].map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    tx.mockRestore();

    // A second GitLab source: both are named by host now; the first runtime is kept as it was.
    const built = registry.apply({ glabPath: null, sources: [gitlab(), gitlab('gitlab2.example.com', { tokenChoice: null, from: 'env' })] });
    expect(built.map((r) => r.host)).toEqual(['gitlab2.example.com']);
    expect(registry.byHost(HOST)).toBe(first);
    expect(first!.row.name).toBe(HOST);
    expect(registry.list().map((r) => r.host)).toEqual(['github.com', HOST, 'gitlab2.example.com']);
    expect(logs.at(-1)).toBe('[sources] GitLab (gitlab2.example.com) at https://gitlab2.example.com · token: not chosen · from env');

    // The base URL is refreshed from config (the host is the identity), which rebuilds the runtime.
    const [moved] = registry.apply({ glabPath: null, sources: [gitlab(HOST, { baseUrl: 'https://gitlab.example.com:8443' }), gitlab('gitlab2.example.com')] });
    expect(moved!.id).toBe(first!.id);
    expect(getSource(db, first!.id)!.baseUrl).toBe('https://gitlab.example.com:8443');
    expect(listSources(db)).toHaveLength(3);
  });

  it('keeps a source that is no longer configured here, without a token, and forgets a removed one', async () => {
    const { db, registry, logs, glab, api } = setup({ env: { GITLAB_TOKEN: PAT, PATH: '/usr/bin' } });
    const [gl] = registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenEnv: 'GITLAB_TOKEN' })] });
    expect((await gl!.tokens.get()).token).toBe(PAT);

    const [gone] = registry.apply({ glabPath: null, sources: [] });
    expect(gone).toMatchObject({ id: gl!.id, configured: false, config: null });
    expect(logs.at(-1)).toBe(`[sources] GitLab (${HOST}) is in the database but not configured on this server`);
    expect(registry.configured().map((r) => r.host)).toEqual(['github.com']);
    // Not even the env variable reaches it, and glab isn't looked for.
    expect(await gone!.tokens.get()).toMatchObject({ token: null, source: 'none', error: null, cli: { available: false, path: null } });
    expect(gone!.tokens.noTokenMessage()).toBe(`No GitLab token for ${HOST}: it isn't configured on this server`);
    expect(await gone!.diffs.get().catch((e: Error) => e.message)).toBe(`No GitLab token for ${HOST}: it isn't configured on this server`);
    expect(await registry.check()).toEqual([]);
    expect(glab.calls).toEqual([]);
    expect(api.requests).toEqual(['graphql CredentialCheck', SELF]);

    removeSource(db, gl!.id);
    expect(registry.apply()).toEqual([]);
    expect(registry.byHost(HOST)).toBeNull();
    expect(registry.list().map((r) => r.host)).toEqual(['github.com']);
  });

  it('catches up with the sources another instance adds or removes, before any lookup, without writing', async () => {
    const mine = setup();
    const other = setup({ db: mine.db });
    const [gl] = mine.registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenChoice: 'app' })] });
    other.registry.apply({ glabPath: null, sources: [] });

    // Another instance adds a source: listed here as not configured, by host and by id, with no reload.
    const added = ensureSource(mine.db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
    const rows = listSources(mine.db);
    const found = mine.registry.byHost('gitlab2.example.com');
    expect(found).toMatchObject({ id: added.id, configured: false, config: null });
    expect(mine.registry.byId(added.id)).toBe(found);
    expect(mine.registry.list().map((r) => r.host)).toEqual(['github.com', HOST, 'gitlab2.example.com']);
    expect(mine.registry.configured().map((r) => r.host)).toEqual(['github.com', HOST]);
    expect(await found!.tokens.get()).toMatchObject({ token: null, source: 'none' });
    expect(mine.logs.at(-1)).toBe('[sources] GitLab (gitlab2.example.com) is in the database but not configured on this server');
    // The other instance sees this one's configured source the same way.
    expect(other.registry.byId(gl!.id)).toMatchObject({ host: HOST, configured: false });

    // Another instance removes one: gone here too, configured or not, and not synced; nothing is written back.
    removeSource(mine.db, gl!.id);
    removeSource(mine.db, added.id);
    expect(mine.registry.byId(gl!.id)).toBeNull();
    expect(mine.registry.byHost(HOST)).toBeNull();
    expect(mine.registry.list().map((r) => r.host)).toEqual(['github.com']);
    expect(mine.registry.configured().map((r) => r.host)).toEqual(['github.com']);
    expect(other.registry.list().map((r) => r.host)).toEqual(['github.com']);
    expect(listSources(mine.db)).toEqual(rows.filter((r) => r.id === GITHUB_SOURCE_ID));
    expect(mine.logs.slice(-2)).toEqual([`[sources] GitLab (${HOST}) is no longer in the database`, '[sources] GitLab (gitlab2.example.com) is no longer in the database']);

    // An unchanged table costs one small query per lookup.
    const all = vi.spyOn(mine.db, 'all');
    const get = vi.spyOn(mine.db, 'get');
    mine.registry.list();
    expect([all.mock.calls.length, get.mock.calls.length]).toEqual([1, 0]);
  });

  it('rebuilds a source only when its settings change, keeping the app token and change listeners', async () => {
    const { registry } = setup();
    const changes: string[] = [];
    registry.onChange((rt, token) => changes.push(`${rt.host}:${token.source}`));
    const config = { glabPath: null, sources: [gitlab(HOST, { tokenChoice: 'app' })] };
    const [gl] = registry.apply(config);
    expect(registry.setAppToken(HOST, ` ${PAT} `)).toBe(gl);
    expect(await gl!.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    expect(registry.apply(config)).toEqual([]);

    // glab's location is part of a source's credentials: a new provider, with the app token carried over.
    const [rebuilt] = registry.apply({ ...config, glabPath: '/opt/glab' });
    expect(rebuilt).not.toBe(gl);
    expect(rebuilt!.tokens).not.toBe(gl!.tokens);
    expect(await rebuilt!.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    // The old provider is no longer listened to.
    gl!.tokens.setAppToken(null);
    await gl!.tokens.get();
    expect(changes).toEqual([`${HOST}:app`, `${HOST}:app`]);

    const [viaGlab] = registry.apply({ glabPath: '/opt/glab', sources: [gitlab(HOST, { tokenChoice: 'glab' })] });
    expect(viaGlab!.tokens.getChoice()).toBe('glab');
    const [back] = registry.apply({ glabPath: '/opt/glab', sources: [gitlab(HOST, { tokenChoice: 'app' })] });
    expect(await back!.tokens.get()).toMatchObject({ token: PAT, source: 'app' });
    registry.setAppToken(HOST, null);
    expect(await back!.tokens.get()).toMatchObject({ token: null, error: 'No token has been entered in the app' });
    // github.com's app token goes through its TokenProvider; unknown hosts are nobody's.
    expect(registry.setAppToken('github.com', PAT)).toBeNull();
    expect(registry.setAppToken('nowhere.example.com', PAT)).toBeNull();
  });

  it('sends a configured source its token at the configured URL only, whatever URL another instance stored', async () => {
    const { db, registry, api } = setup({ env: { GITLAB_TOKEN: PAT } });
    const [gl] = registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenEnv: 'GITLAB_TOKEN' })] });
    // Another instance removes the source and adds it again at another scheme, port and relative root.
    removeSource(db, gl!.id);
    const other = 'http://gitlab.example.com:8080/other';
    ensureSource(db, { kind: 'gitlab', host: HOST, baseUrl: other });
    const found = registry.byHost(HOST)!;
    expect(found).toMatchObject({ configured: true, config: { baseUrl: BASE } });
    expect(found.row.baseUrl).toBe(other);

    // Validation, a sync client and a diff client: every request with the token goes to the configured URL.
    await found.tokens.check();
    await found.syncSource(PAT).viewer().catch(() => null);
    await (await found.diffs.get()).commit({ key: `${HOST}/alice/app`, owner: 'alice', name: 'app', path: 'alice/app' }, sha('a'), AbortSignal.timeout(5000)).catch(() => null);
    const sent = api.calls.filter((c) => c.headers.Authorization === `Bearer ${PAT}`);
    expect(sent.map((c) => c.url.pathname)).toEqual(['/gitlab/api/graphql', `/gitlab${SELF}`, '/gitlab/api/graphql', '/gitlab/api/graphql', '/gitlab/api/v4/projects/alice%2Fapp/repository/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(api.calls.filter((c) => !c.url.href.startsWith(`${BASE}/`))).toEqual([]);
  });

  it("forgets a source's app token with the source: the host added again waits for a token of its own", async () => {
    const { db, registry } = setup();
    const config = { glabPath: null, sources: [gitlab(HOST, { tokenChoice: 'app' })] };
    const [gl] = registry.apply(config);
    registry.setAppToken(HOST, PAT);
    expect(await gl!.tokens.get()).toMatchObject({ token: PAT, source: 'app' });

    // Taken out of the config and removed with its data (the documented account reset), then added again.
    registry.apply({ glabPath: null, sources: [] });
    removeSource(db, gl!.id);
    registry.apply();
    const [again] = registry.apply(config);
    expect(again!.id).not.toBe(gl!.id);
    expect(await again!.tokens.get()).toMatchObject({ token: null, source: 'none', error: 'No token has been entered in the app' });

    // The same when another instance removes it; and forgetting a host with no source is accepted, and keeps nothing.
    registry.setAppToken(HOST, PAT);
    removeSource(db, again!.id);
    expect(registry.setAppToken(HOST, null)).toBeNull();
    expect(registry.setAppToken(HOST, PAT)).toBeNull();
    const [third] = registry.apply(config);
    expect(await third!.tokens.get()).toMatchObject({ token: null, error: 'No token has been entered in the app' });
  });

  it('checks each configured source, logging who the token is for, an expiry close by, and write scopes', async () => {
    const routes = { ...CHECK_ROUTES, [SELF]: { body: pat({ scopes: ['api'], expires_at: '2026-10-05' }) } };
    const { registry, logs, api } = setup({ env: { GITLAB_TOKEN: PAT, PATH: '/usr/bin' }, routes });
    const built = registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenEnv: 'GITLAB_TOKEN' })] });
    const [account] = await registry.check(built);
    expect(account).toMatchObject({ source: 'env', locked: true, env: 'GITLAB_TOKEN', login: 'alice', kind: 'personal', canWrite: true, expiresAt: '2026-10-05T00:00:00.000Z', error: null });
    const p = `[token ${HOST}]`;
    expect(logs).toEqual([
      `[sources] GitLab (${HOST}) at ${BASE} · token: GITLAB_TOKEN (locked)`,
      `${p} using env`,
      `${p} env token is for @alice (personal, expires 2026-10-05)`,
      expect.stringMatching(new RegExp(`^\\${p} warning: the token expires 2026-10-05 \\(in 7 days\\); create a new one: ${BASE}/-/user_settings/personal_access_tokens\\?`)),
      expect.stringMatching(new RegExp(`^\\${p} note: This token can change things on GitLab \\(api scope\\)\\. gh-dash only reads`)),
    ]);
    // One validation: 2 requests. github.com isn't checked here (startServer checks its TokenProvider).
    expect(api.requests).toEqual(['graphql CredentialCheck', SELF]);
  });

  it("builds sync and diff clients on the source's instance; a 401 during a sync invalidates that token", async () => {
    const routes: Record<string, Handler> = { '/api/graphql': { status: 401, body: { error: 'invalid_token', error_description: 'Token is expired' } } };
    const { db, registry, api } = setup({ env: { GITLAB_TOKEN: PAT }, routes });
    const [gl] = registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenEnv: 'GITLAB_TOKEN' })] });
    expect((await gl!.tokens.check()).error).toBe(`GitLab (${HOST}) rejected the token (401): Token is expired`);
    const before = api.calls.length;
    const sync = gl!.syncSource!(PAT);
    expect([sync.kind, sync.requests, sync.probesStars, sync.linksCommits]).toEqual(['gitlab', 0, false, false]);
    await expect(sync.viewer()).rejects.toMatchObject({ kind: 'auth' });
    expect(api.calls[before]!.url.href).toBe(`${BASE}/api/graphql`);
    expect(api.calls[before]!.headers.Authorization).toBe(`Bearer ${PAT}`);
    // The sync's 401 marked the token rejected: resolved again before the next use.
    expect((await gl!.tokens.account()).error).toBe(`GitLab (${HOST}) rejected the token (401)`);

    const diffs = await gl!.diffs.get();
    expect(diffs.kind).toBe('gitlab');
    // A rejected token's 503 names how to fix this source's: the credentials' hint, with the host.
    expect(diffs.authHint).toBe(gl!.tokens.spec.authHint);
    expect(diffs.authHint).toBe(`check the GitLab token in Settings → Sources, or run \`glab auth login --hostname ${HOST}\``);
    // Its provider knows the account this source's data belongs to.
    tryClaimViewer(db, gl!.id, { id: 'gid://gitlab/User/9', login: 'bob' });
    expect((await gl!.tokens.account()).dbLogin).toBe('bob');
  });

  it("builds github.com's sync clients: GitHub's rate limit goes to source 1 as it comes, and a 401 invalidates the token", async () => {
    const gql = fakeGraphQL();
    const gh = fakeGitHub({ '/graphql': gql.handler });
    const { db, registry, github } = setup({ githubToken: 'ghp_test', githubFetch: gh.fetchImpl });
    expect((await github.get()).token).toBe('ghp_test');
    const sync = registry.github().syncSource('ghp_test');
    expect([sync.kind, sync.requests, sync.points, sync.probesStars, sync.linksCommits]).toEqual(['github', 0, 0, true, true]);
    expect(await sync.viewer()).toEqual({ id: 'U_alice', login: 'alice', name: 'Alice', avatarUrl: null, emails: [] });
    expect([sync.requests, sync.points]).toEqual([1, 1]);
    expect(getSource(db, GITHUB_SOURCE_ID)!.rateLimit).toEqual({ limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z' });

    gh.routes['/graphql'] = { status: 401, body: { message: 'Bad credentials' } };
    await expect(registry.github().syncSource('ghp_test').viewer()).rejects.toMatchObject({ kind: 'auth' });
    expect(gh.requests).toEqual(['/graphql', '/graphql']);
    // Resolved again before the next use; meanwhile the account says why.
    expect((await github.account()).error).toBe('Bad credentials');
  });

  it('builds a sync client with other retry limits for a person waiting on it', async () => {
    const routes: Record<string, Handler> = { '/api/graphql': { status: 429, text: 'Retry later\n', headers: { 'retry-after': '30' } } };
    const { registry, api } = setup({ env: { GITLAB_TOKEN: PAT }, routes });
    const [gl] = registry.apply({ glabPath: null, sources: [gitlab(HOST, { tokenEnv: 'GITLAB_TOKEN' })] });
    // The sync waits out a 30 s throttle, 5 attempts in all.
    await expect(gl!.syncSource!(PAT).viewer()).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(api.requests).toHaveLength(5);
    // The Add dialog's gives up at once on a wait longer than it allows.
    await expect(gl!.syncSource!(PAT, { maxAttempts: 2, maxRetryWaitMs: 10_000 }).viewer()).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(api.requests).toHaveLength(6);
  });

  it('refuses a host stored for another kind, and changes nothing', () => {
    const { db, registry } = setup();
    registry.apply({ glabPath: null, sources: [gitlab('gitlab2.example.com')] });
    ensureSource(db, { kind: 'github', host: 'code.example.com', baseUrl: 'https://code.example.com' });
    const before = listSources(db);
    expect(() => registry.apply({ glabPath: null, sources: [gitlab('gitlab3.example.com'), gitlab('code.example.com')] })).toThrow('code.example.com is already a github source here');
    expect(listSources(db)).toEqual(before);
    expect(registry.config.sources.map((s) => s.host)).toEqual(['gitlab2.example.com']);
  });
});
