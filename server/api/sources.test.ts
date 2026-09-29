// GET /sources, GET /sources/:source, POST /sources/:source/check and DELETE /sources/:source, on github.com plus a
// GitLab instance (gitlab.example.com, a fake). Nothing here adds a source or writes a credential.

import { describe, expect, it, vi } from 'vitest';
import type { Source } from '../../shared/api';
import { loadConfig } from '../config';
import type { Exec } from '../credentials/types';
import type { Db } from '../db/db';
import { GITHUB_SOURCE_ID, getSource, sourceByHost } from '../db/sources';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SourceRegistry } from '../sources/registry';
import { SyncManager } from '../sync/manager';
import { execError, fakeExec, fakeFs } from '../test/credentials';
import { fakeGitHub, type Reply } from '../test/github';
import { BASE as GITLAB_BASE, type Handler } from '../test/gitlab';
import { fakeInstance } from '../test/gitlab-instance';
import { addManualRepo, GITLAB_HOST, seedDb, seedGitLab, setViewer } from '../test/seed';
import { testTokens } from '../test/tokens';
import { type AppDeps, createApp } from './app';
import { openApiDocument } from './openapi';

const noFiles = {
  stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  access: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
};

/** What GitLab answers the token check with: bob, whom seedGitLab's source is claimed by. */
const CHECK = {
  CredentialCheck: () => ({
    currentUser: { id: 'gid://gitlab/User/7', username: 'bob', name: 'Bob B', avatarUrl: null, publicEmail: null, commitEmail: null, emails: { nodes: [] } },
    metadata: { version: '19.3.3-ee', enterprise: true },
    personal: { count: 3 },
  }),
};

interface Setup {
  /** Whether this server has GitLab configured (default), knows of it only from the database, or has none. */
  gitlab?: 'configured' | 'unconfigured' | 'none';
  /** GITLAB_TOKEN; null for none. */
  gitlabToken?: string | null;
  /** Declared by the environment (GH_DASH_GITLAB_URL) rather than config.json. */
  from?: 'file' | 'env';
  githubToken?: string | null;
  githubFetch?: typeof fetch;
  over?: Record<string, Handler>;
  /** A registry-less app, as the tests that don't need sources build it. */
  noRegistry?: boolean;
  /** glab's stand-in: the configured source then signs in with glab (/usr/bin/glab), not GITLAB_TOKEN. */
  glab?: Exec;
}

function sourcesApp(setup: Setup = {}) {
  const { gitlab = 'configured', gitlabToken = 'glpat-test-bob', from = 'file' } = setup;
  const db = seedDb();
  if (gitlab !== 'none') {
    const { src } = seedGitLab(db);
    // The GitLab account of the claim, as the credential check names it.
    setViewer(db, { id: 'gid://gitlab/User/7', login: 'bob', name: 'Bob B', avatarUrl: 'https://avatars.example/bob-gl', emails: ['Bob@Corp.example'] }, src.id);
  }
  const tokens = testTokens(setup.githubToken ?? null, {
    viewer: () => getSource(db, GITHUB_SOURCE_ID)?.viewer ?? null,
    ...(setup.githubFetch ? { fetchImpl: setup.githubFetch } : {}),
  });
  const githubDiffs = new GitHubDiffSources({ tokens });
  const gl = fakeInstance(setup.over, GITLAB_BASE, CHECK);
  const sources = new SourceRegistry({
    db,
    env: { ...(gitlabToken === null ? {} : { GITLAB_TOKEN: gitlabToken }), ...(setup.glab ? { PATH: '/usr/bin' } : {}) },
    github: { tokens: tokens.credentials, diffs: githubDiffs },
    log: () => {},
    seams: {
      fetchImpl: gl.fetchImpl,
      sleep: async () => {},
      fs: setup.glab ? fakeFs({ '/usr/bin/glab': { exec: true } }) : noFiles,
      exec: setup.glab ?? (async () => { throw new Error('glab must not run in tests'); }),
    },
  });
  if (gitlab === 'configured') {
    const method = setup.glab ? { tokenChoice: 'glab' as const, tokenEnv: null } : { tokenChoice: 'auto' as const, tokenEnv: 'GITLAB_TOKEN' };
    sources.apply({
      glabPath: null,
      sources: [{ kind: 'gitlab', host: GITLAB_HOST, baseUrl: GITLAB_BASE, tokenFile: null, ...method, from }],
    });
  } else if (gitlab === 'unconfigured') {
    // What another instance sharing the database configured: the row is there, and the runtime is built without config.
    sources.apply({ glabPath: null, sources: [] });
  }
  const config = { ...loadConfig({}), webDir: '/nonexistent' };
  const cache = new DiffCache(':memory:');
  const diffs = new DiffService({ db, cache, sources: githubDiffs, log: () => {} });
  const evict = vi.spyOn(diffs, 'evict');
  const sync = new SyncManager({ db, schedule: false, tokens, sources, log: () => {} });
  const deps: AppDeps = { db, config, sync, diffs, tokens, ...(setup.noRegistry ? {} : { sources }) };
  const app = createApp(deps);
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${path}`, { method, headers });
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
  };
  return { app, db, sources, gl, cache, evict, call };
}

const hosts = (items: Source[]) => items.map((s) => s.host);

describe('GET /sources', () => {
  it('lists github.com first, then the GitLab sources: identity, credential, account, sync and repo counts', async () => {
    const t = sourcesApp();
    const res = await t.call('GET', '/sources');
    expect(res.status).toBe(200);
    expect(hosts(res.body.items)).toEqual(['github.com', GITLAB_HOST]);
    const [github, gitlab] = res.body.items as Source[];
    expect(github).toMatchObject({
      host: 'github.com', kind: 'github', name: 'GitHub', url: 'https://github.com', configured: true, removable: false,
      viewer: { login: 'Alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' },
      account: { source: 'none', choice: null, login: null, dbLogin: 'Alice', mismatch: false },
      sync: { source: 'github.com', running: false, tokenSource: 'none', viewer: 'Alice', problem: expect.stringMatching(/^No GitHub token/) },
      // seedDb: five repos of the viewer's, one hidden.
      repos: { owned: 5, added: 0, hidden: 1 },
    });
    expect(gitlab).toMatchObject({
      host: GITLAB_HOST, kind: 'gitlab', name: 'GitLab', url: GITLAB_BASE, configured: true, removable: false,
      viewer: { login: 'bob', name: 'Bob B', avatarUrl: 'https://avatars.example/bob-gl' },
      account: { source: 'env', choice: 'auto', locked: true, env: 'GITLAB_TOKEN', dbLogin: 'bob', cli: { name: 'glab' } },
      sync: { source: GITLAB_HOST, running: false, tokenSource: 'env', viewer: 'bob', problem: null },
      repos: { owned: 1, added: 0, hidden: 0 },
    });
    // The list is public information about sources, not credentials.
    expect(JSON.stringify(res.body)).not.toContain('glpat-test-bob');
  });

  it('counts repos added by hand and hidden ones, live ones only', async () => {
    const t = sourcesApp();
    const gl = sourceByHost(t.db, GITLAB_HOST)!;
    addManualRepo(t.db, 'team/platform/api', { source: gl });
    addManualRepo(t.db, 'team/docs', { source: gl, hidden: true });
    addManualRepo(t.db, 'bob/tool');
    const removed = addManualRepo(t.db, 'bob/gone', { source: gl });
    t.db.run("UPDATE repos SET removed_at = '2026-09-28T00:00:00Z' WHERE id = ?", [removed]);
    const items = (await t.call('GET', '/sources')).body.items as Source[];
    expect(items.map((s) => s.repos)).toEqual([
      { owned: 5, added: 1, hidden: 1 },
      { owned: 1, added: 2, hidden: 1 },
    ]);
  });

  it('includes a source another server configured, as not configured here, and never calls GitLab for it', async () => {
    const t = sourcesApp({ gitlab: 'unconfigured' });
    const items = (await t.call('GET', '/sources')).body.items as Source[];
    expect(items[1]).toMatchObject({
      host: GITLAB_HOST, configured: false, removable: true, account: null, viewer: { login: 'bob' }, repos: { owned: 1, added: 0, hidden: 0 },
      sync: { tokenSource: 'none', problem: `GitLab (${GITLAB_HOST}) isn't configured on this server` },
    });
    expect(t.gl.requests).toEqual([]);
  });

  it('does not ask the providers again on each poll', async () => {
    const t = sourcesApp();
    await t.call('GET', '/sources');
    // The new token is validated once, in the background; polling only reads that.
    await vi.waitFor(async () => expect(((await t.call('GET', `/sources/${GITLAB_HOST}`)).body as Source).account).toMatchObject({ login: 'bob', kind: 'personal', instance: { version: '19.3.3-ee', enterprise: true } }));
    const asked = t.gl.requests.length;
    expect(asked).toBeGreaterThan(0);
    await t.call('GET', '/sources');
    await t.call('GET', `/sources/${GITLAB_HOST}`);
    expect(t.gl.requests).toHaveLength(asked);
  });

  it('shows github.com alone when the app was built without a registry', async () => {
    const t = sourcesApp({ gitlab: 'none', noRegistry: true });
    const res = await t.call('GET', '/sources');
    expect(hosts(res.body.items)).toEqual(['github.com']);
    expect((await t.call('GET', `/sources/${GITLAB_HOST}`)).status).toBe(404);
  });
});

describe('GET /sources/:source', () => {
  it('reads one source by its host, in any case', async () => {
    const t = sourcesApp();
    const res = await t.call('GET', '/sources/GitLab.Example.COM');
    expect(res).toMatchObject({ status: 200, body: { host: GITLAB_HOST, kind: 'gitlab', configured: true } });
    expect((await t.call('GET', '/sources/github.com')).body).toMatchObject({ host: 'github.com', removable: false });
  });

  it('is 404 for a host that is not a source here', async () => {
    const t = sourcesApp();
    expect(await t.call('GET', '/sources/nowhere.example.com')).toEqual({ status: 404, body: { error: "nowhere.example.com isn't a source here." } });
  });
});

describe('POST /sources/:source/check', () => {
  it('resolves the GitLab token again and validates it now: 2 requests', async () => {
    const t = sourcesApp();
    // Let the background check of the new token finish, so the count below is this check's alone.
    await t.call('GET', '/sources');
    await vi.waitFor(() => expect(t.gl.requests.length).toBeGreaterThan(1));
    const before = t.gl.requests.length;
    const res = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      host: GITLAB_HOST,
      account: {
        source: 'env', login: 'bob', name: 'Bob B', dbLogin: 'bob', mismatch: false, kind: 'personal', scopes: ['read_api'], canWrite: false,
        expiresAt: '2027-01-31T00:00:00.000Z', instance: { version: '19.3.3-ee', enterprise: true }, repos: { total: 3, private: null },
        error: null, checkedAt: expect.any(String),
      },
    });
    expect(t.gl.requests.slice(before)).toHaveLength(2);
  });

  it('reports a token GitLab rejects in the account, not as an error', async () => {
    const t = sourcesApp({ over: { '/api/graphql': { status: 401, body: { message: '401 Unauthorized' } }, '/api/v4/personal_access_tokens/self': { status: 401, body: { message: '401 Unauthorized' } } } });
    const res = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ source: 'env', login: null, error: expect.stringContaining(`GitLab (${GITLAB_HOST})`) });
  });

  it('says a token for another account than the data is for', async () => {
    const t = sourcesApp();
    setViewer(t.db, { id: 'gid://gitlab/User/99', login: 'mallory' }, sourceByHost(t.db, GITLAB_HOST)!.id);
    const res = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(res.body.account).toMatchObject({ login: 'bob', dbLogin: 'mallory', mismatch: true });
  });

  it('checks github.com too: 1 GraphQL point', async () => {
    const viewer: Reply = { body: { data: { viewer: { id: 'U_alice', login: 'Alice', name: null, avatarUrl: null, repos: { totalCount: 5 }, privateRepos: { totalCount: 2 } } } }, headers: { 'x-oauth-scopes': 'repo' } };
    const gh = fakeGitHub({ '/graphql': viewer });
    const t = sourcesApp({ githubToken: 'ghp_x', githubFetch: gh.fetchImpl });
    const res = await t.call('POST', '/sources/github.com/check');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ host: 'github.com', account: { source: 'env', kind: 'classic', login: 'Alice', mismatch: false, scopes: ['repo'], repos: { total: 5, private: 2 }, cli: { name: 'gh' } } });
    expect(gh.requests).toEqual(['/graphql']);
  });

  it('is 503 without a token, naming why and showing the source', async () => {
    const t = sourcesApp({ gitlabToken: null });
    const github = await t.call('POST', '/sources/github.com/check');
    expect(github.status).toBe(503);
    expect(github.body).toMatchObject({ error: expect.stringMatching(/^No GitHub token: /), details: { host: 'github.com', account: { source: 'none' } } });
    const gitlab = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(gitlab.status).toBe(503);
    expect(gitlab.body.error).toMatch(new RegExp(`^No GitLab token for ${GITLAB_HOST}: `));
    expect(gitlab.body.details).toMatchObject({ host: GITLAB_HOST, configured: true, account: { source: 'none', locked: false } });
  });

  it('never sends a token glab printed as it failed, in the 503 or the source', async () => {
    const leaked = `glpat-${'Zq8'.repeat(7)}`;
    const glab = fakeExec((args) => (args[0] === 'config' ? Promise.reject(execError(`error: token ${leaked} could not be read`)) : ''));
    const t = sourcesApp({ gitlabToken: null, glab: glab.exec });
    const res = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      `No GitLab token for ${GITLAB_HOST}: glab has no token for ${GITLAB_HOST}: run \`glab auth login --hostname ${GITLAB_HOST}\` (glab config get token failed: error: token [token] could not be read)`,
    );
    expect(res.body.details.account).toMatchObject({ source: 'none', choice: 'glab', error: res.body.error.replace(`No GitLab token for ${GITLAB_HOST}: `, '') });
    const listed = await t.call('GET', '/sources');
    for (const body of [res.body, listed.body]) expect(JSON.stringify(body)).not.toMatch(/glpat|Zq8/);
    expect(glab.calls.map((c) => c.args[0])).toContain('config');
  });

  it('is 503 for a source not configured on this server, and asks nobody', async () => {
    const t = sourcesApp({ gitlab: 'unconfigured' });
    const res = await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: `No GitLab token for ${GITLAB_HOST}: it isn't configured on this server`, details: { configured: false, account: null } });
    expect(t.gl.requests).toEqual([]);
  });

  it('is 404 for an unknown source', async () => {
    const t = sourcesApp();
    expect(await t.call('POST', '/sources/nowhere.example.com/check')).toEqual({ status: 404, body: { error: "nowhere.example.com isn't a source here." } });
  });
});

describe('DELETE /sources/:source', () => {
  const count = (db: Db, sql: string) => db.get<{ n: number }>(sql)!.n;

  it('removes an unconfigured source with everything tracked on it, and its cached diffs', async () => {
    const t = sourcesApp({ gitlab: 'unconfigured' });
    const gl = sourceByHost(t.db, GITLAB_HOST)!;
    addManualRepo(t.db, 'team/platform/api', { source: gl });
    // Rows under a repo, by table: those of the GitLab source's repos, and all of them.
    const tables = ['pull_requests', 'commits', 'issues', 'releases', 'stars', 'sync_state'];
    const rows = (table: string, source: number | null) =>
      count(t.db, `SELECT count(*) AS n FROM ${table}${source === null ? '' : ` WHERE repo_id IN (SELECT id FROM repos WHERE source_id = ${source})`}`);
    const onGitLab = Object.fromEntries(tables.map((table) => [table, rows(table, gl.id)]));
    const onGitHub = Object.fromEntries(tables.map((table) => [table, rows(table, GITHUB_SOURCE_ID)]));
    expect(onGitLab).toMatchObject({ pull_requests: 3, commits: 4, issues: 2, releases: 1 });
    const prCommits = count(t.db, 'SELECT count(*) AS n FROM pr_commits');
    // Diffs cached for a repo on each source.
    const cached = (repo: string) => ({ key: `commit/${repo}/${'a'.repeat(40)}`, kind: 'commit' as const, repo, oid: 'a'.repeat(40), fetchedAt: 1, data: new Uint8Array([1, 2, 3]) });
    t.cache.put(cached(`${GITLAB_HOST}/platform/app`));
    t.cache.put(cached('alice/app'));

    const res = await t.call('DELETE', `/sources/${GITLAB_HOST}`);
    expect(res).toEqual({ status: 204, body: null });
    expect(t.evict).toHaveBeenCalledTimes(1);
    expect(t.cache.get(cached('alice/app').key)).not.toBeNull();
    expect(t.cache.get(cached(`${GITLAB_HOST}/platform/app`).key)).toBeNull();

    expect(sourceByHost(t.db, GITLAB_HOST)).toBeNull();
    expect(count(t.db, 'SELECT count(*) AS n FROM repos')).toBe(5);
    // Every table holds github.com's rows and nothing else.
    for (const table of tables) expect([table, rows(table, null), rows(table, GITHUB_SOURCE_ID)], table).toEqual([table, onGitHub[table], onGitHub[table]]);
    expect(count(t.db, 'SELECT count(*) AS n FROM pr_commits')).toBe(prCommits - 2);
    expect(t.db.all('PRAGMA foreign_key_check')).toEqual([]);

    // Gone from the API, and from what the registry runs.
    expect((await t.call('GET', `/sources/${GITLAB_HOST}`)).status).toBe(404);
    expect(hosts((await t.call('GET', '/sources')).body.items)).toEqual(['github.com']);
    expect(t.sources.byHost(GITLAB_HOST)).toBeNull();
    expect((await t.call('GET', '/repos')).body.items.map((r: { source: string }) => r.source)).toEqual(Array(5).fill('github.com'));
    expect((await t.call('DELETE', `/sources/${GITLAB_HOST}`)).status).toBe(404);
  });

  it('refuses github.com, which is built in', async () => {
    const t = sourcesApp();
    expect(await t.call('DELETE', '/sources/github.com')).toEqual({ status: 409, body: { error: "github.com is built in and can't be removed." } });
    expect(t.evict).not.toHaveBeenCalled();
    expect(count(t.db, 'SELECT count(*) AS n FROM repos WHERE source_id = 1')).toBe(5);
  });

  it('refuses a source this server still has configured, and says how to remove it', async () => {
    const t = sourcesApp();
    const res = await t.call('DELETE', `/sources/${GITLAB_HOST}`);
    expect(res).toEqual({
      status: 409,
      body: { error: `GitLab (${GITLAB_HOST}) is still configured on this server. Remove it in Settings (desktop app) or from config.json first.` },
    });
    const env = await sourcesApp({ from: 'env' }).call('DELETE', `/sources/${GITLAB_HOST}`);
    expect(env.body.error).toBe(`GitLab (${GITLAB_HOST}) is still configured on this server. Unset GH_DASH_GITLAB_URL first.`);
    // Nothing was touched.
    expect(sourceByHost(t.db, GITLAB_HOST)).not.toBeNull();
    expect(count(t.db, `SELECT count(*) AS n FROM pull_requests WHERE repo_id IN (SELECT id FROM repos WHERE source_id != 1)`)).toBe(3);
    expect(t.evict).not.toHaveBeenCalled();
    expect((await t.call('GET', `/sources/${GITLAB_HOST}`)).body).toMatchObject({ configured: true, removable: false });
  });

  it('is 404 for an unknown source', async () => {
    const t = sourcesApp();
    expect(await t.call('DELETE', '/sources/nowhere.example.com')).toEqual({ status: 404, body: { error: "nowhere.example.com isn't a source here." } });
  });

  it('can be removed once it has been taken out of the configuration', async () => {
    const t = sourcesApp();
    expect((await t.call('DELETE', `/sources/${GITLAB_HOST}`)).status).toBe(409);
    // The desktop app's reload-sources: the source is no longer in the config.
    t.sources.apply({ glabPath: null, sources: [] });
    expect((await t.call('GET', `/sources/${GITLAB_HOST}`)).body).toMatchObject({ configured: false, removable: true });
    expect((await t.call('DELETE', `/sources/${GITLAB_HOST}`)).status).toBe(204);
    expect(sourceByHost(t.db, GITLAB_HOST)).toBeNull();
  });

  it('is a write like any other: a cross-site page cannot send it', async () => {
    const t = sourcesApp({ gitlab: 'unconfigured' });
    const evil = { origin: 'https://evil.example', host: 'localhost' };
    expect((await t.call('DELETE', `/sources/${GITLAB_HOST}`, evil)).status).toBe(403);
    expect((await t.call('POST', `/sources/${GITLAB_HOST}/check`, evil)).status).toBe(403);
    expect(sourceByHost(t.db, GITLAB_HOST)).not.toBeNull();
  });
});

describe('nothing adds a source or writes a credential', () => {
  it('has no route for it', async () => {
    const t = sourcesApp({ gitlab: 'none' });
    for (const [method, path] of [['POST', '/sources'], ['PUT', '/sources/gitlab.example.com'], ['PATCH', '/sources/github.com'], ['PUT', '/sources/github.com/token']] as const) {
      expect((await t.call(method, path)).status, `${method} ${path}`).toBe(404);
    }
    expect(hosts((await t.call('GET', '/sources')).body.items)).toEqual(['github.com']);
  });
});

describe('the OpenAPI document', () => {
  const doc = openApiDocument('test') as {
    paths: Record<string, Record<string, { tags: string[]; parameters?: { name: string }[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };

  it('documents the four sources operations, and only those', () => {
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ op: `${method.toUpperCase()} ${path}`, tags: op.tags })));
    expect(ops.filter((o) => o.tags.includes('Sources')).map((o) => o.op).sort()).toEqual([
      'DELETE /api/v1/sources/{source}', 'GET /api/v1/sources', 'GET /api/v1/sources/{source}', 'POST /api/v1/sources/{source}/check',
    ]);
    expect(doc.paths['/api/v1/sources/{source}']!.delete!.responses).toHaveProperty('204');
    expect(doc.paths['/api/v1/sources/{source}/check']!.post!.parameters).toMatchObject([{ name: 'source', in: 'path', required: true }]);
  });

  it('describes Source, SourceAccount and SourceSyncStatus with the fields the API sends', async () => {
    const t = sourcesApp();
    // Validated: the fields of a real answer are the schema's.
    await t.call('POST', `/sources/${GITLAB_HOST}/check`);
    const source = (await t.call('GET', `/sources/${GITLAB_HOST}`)).body as Source;
    const keys = (name: string) => Object.keys(doc.components.schemas[name]!.properties!).sort();
    expect(Object.keys(source).sort()).toEqual(keys('Source'));
    expect(Object.keys(source.account!).sort()).toEqual(keys('SourceAccount'));
    expect(Object.keys(source.sync).sort()).toEqual(keys('SourceSyncStatus'));
    expect(Object.keys(source.account!.cli!).sort()).toEqual(['available', 'login', 'name', 'path']);
  });

  it('only refers to schemas it defines', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(20);
    expect(refs.filter((name) => !doc.components.schemas[name])).toEqual([]);
  });

  it('is served, with the sources in the human-readable reference too', async () => {
    const t = sourcesApp();
    const page = await (await t.app.request('/api/docs')).text();
    expect(page).toContain('/api/v1/sources/{source}/check');
    expect(page).toContain("curl -s -X DELETE &#39;http://localhost/api/v1/sources/github.com&#39;");
  });
});
