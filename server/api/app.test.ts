import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../config';
import { setMeta } from '../db/meta';
import { ensureSource, GITHUB_SOURCE_ID, getSource, tryClaimViewer } from '../db/sources';
import { upsertCommit, upsertOwned } from '../db/write';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { fakeGitHub, page, type Reply, restFile, sha } from '../test/github';
import { fakeGraphQL, prNode, repoNode } from '../test/graphql';
import { Tracking } from '../sync/tracking';
import { addManualRepo, GITHUB, repoRecord, seedDb, seedGitLab, setViewer } from '../test/seed';
import { SourceRegistry } from '../sources/registry';
import lookupFixture from '../test/fixtures/gitlab/lookup.json';
import { BASE as GITLAB_BASE, type Handler as GitLabHandler } from '../test/gitlab';
import { fakeInstance } from '../test/gitlab-instance';
import type { RepoCandidate } from '../../shared/api';
import { DESKTOP_SECRET_HEADER } from '../../shared/desktop';
import { testTokens } from '../test/tokens';
import { type AppDeps, type AppTransport, createApp } from './app';
import { acceptsGzip } from './routes/diffs';

function makeApp(over: Partial<Config> = {}, db = seedDb(), transport?: AppTransport) {
  const config = { ...loadConfig({}), webDir: '/nonexistent', ...over };
  const tokens = testTokens();
  const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources: new GitHubDiffSources({ tokens }), log: () => {} });
  return createApp({ db, config, sync, diffs, tokens, transport });
}

describe('HTTP API', () => {
  const app = makeApp();
  const range = 'from=2026-09-01&to=2026-09-27&tz=UTC';

  it('serves lists as JSON, Markdown and CSV', async () => {
    const json = await app.request(`/api/v1/prs?${range}&state=merged&limit=1`);
    const body = (await json.json()) as { items: { id: string }[]; total: number; nextCursor: string | null; facets: object };
    expect(body).toMatchObject({ total: 2, items: [{ id: 'alice/secret#1' }], facets: { byRepo: { 'alice/app': 1, 'alice/secret': 1 } } });
    const next = await app.request(`/api/v1/prs?${range}&state=merged&limit=1&cursor=${body.nextCursor}`);
    expect(((await next.json()) as { items: { id: string }[] }).items.map((p) => p.id)).toEqual(['alice/app#1']);

    const md = await app.request(`/api/v1/prs?${range}&state=merged&who=me&format=md`);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await md.text()).toContain('- **Fix login flow** ([alice/app#1](https://github.com/alice/x/pull/1)) — Fixes the login flow for SSO users.');
    const csv = await app.request(`/api/v1/activity?${range}&format=csv`);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  });

  it('returns { error } with 400 for bad input and 404 for unknown things', async () => {
    const bad = await app.request('/api/v1/prs?state=nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining('state') });
    expect((await app.request('/api/v1/prs/app/999')).status).toBe(404);
    expect((await app.request('/api/v1/nope')).status).toBe(404);
    expect((await app.request('/api/v1/sets/1', { method: 'DELETE' })).status).toBe(404);
  });

  it('filters issues by creator, state, repository and date and paginates without losing items', async () => {
    const read = async (query: string) => (await (await app.request(`/api/v1/issues?${range}&${query}`)).json()) as { total: number; nextCursor: string | null; items: { id: string }[] };
    expect((await read('state=open&who=me')).items.map((i) => i.id)).toEqual(['alice/app#11']);
    // Alice closed issue 10, but Bob created it: author filtering uses Bob.
    expect((await read('state=closed&who=others&repos=app&q=10')).items.map((i) => i.id)).toEqual(['alice/app#10']);
    expect((await read('state=closed&who=me')).total).toBe(0);
    expect((await read('repos=secret')).total).toBe(0);
    expect((await read('repos=')).total).toBe(0);
    const first = await read('state=all&limit=1');
    expect(first.total).toBe(2);
    expect(first.items.map((i) => i.id)).toEqual(['alice/app#11']);
    const second = await read(`state=all&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((i) => i.id)).toEqual(['alice/app#10']);
    expect(second.nextCursor).toBeNull();
    const md = await (await app.request(`/api/v1/issues?${range}&state=closed&format=md`)).text();
    expect(md).toContain('Issue 10');
    expect(md).not.toContain('Issue 11');
  });

  it('keeps repository inventory complete while exporting the selected repository scope', async () => {
    const read = async (query: string) => (await (await app.request(`/api/v1/repos?${query}`)).json()) as { items: { name: string }[] };
    expect((await read('')).items.map((r) => r.name).sort()).toEqual(['app', 'fork', 'hidden', 'old', 'secret']);
    expect((await read('scope=default')).items.map((r) => r.name).sort()).toEqual(['app', 'secret']);
    expect((await read('scope=default&repos=hidden,old,fork&sort=name')).items.map((r) => r.name)).toEqual(['fork', 'old', 'hidden']);
    expect((await read('scope=default&repos=')).items).toEqual([]);
    expect((await read('scope=default&visibility=private')).items.map((r) => r.name)).toEqual(['secret']);
    expect((await read('scope=default&q=APP')).items.map((r) => r.name)).toEqual(['app']);
    expect((await app.request('/api/v1/repos?sort=nope')).status).toBe(400);
    const forkApp = makeApp();
    await forkApp.request('/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"includeForks":true}' });
    const selected = await (await forkApp.request('/api/v1/repos?scope=default')).json() as { items: { name: string }[] };
    expect(selected.items.map((r) => r.name).sort()).toEqual(['app', 'fork', 'secret']);
  });

  it('takes GitHub Enterprise internal repositories as their own visibility', async () => {
    const db = seedDb();
    const corp = upsertOwned(db, GITHUB, {
      nodeId: 'R_corp', name: 'corp', nameWithOwner: 'alice/corp', owner: 'alice', description: null, url: 'https://github.com/alice/corp',
      visibility: 'internal', isArchived: false, isFork: false, languageName: null, languageColor: null, topics: [], defaultBranch: 'main',
      stars: 0, forks: 0, createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-25T00:00:00Z',
    }, '2026-09-27T00:00:00Z');
    upsertCommit(db, corp, { oid: 'e'.repeat(40), headline: 'Internal change', body: '', author: { login: 'alice', name: null, email: null, avatarUrl: null }, committedAt: '2026-09-21T00:00:00Z', url: 'u', additions: 1, deletions: 0, prNumber: null });
    const internalApp = makeApp({}, db);
    const repos = (await (await internalApp.request('/api/v1/repos?visibility=internal')).json()) as { items: { name: string; visibility: string }[] };
    expect(repos.items).toMatchObject([{ name: 'corp', visibility: 'internal' }]);
    const commits = (await (await internalApp.request(`/api/v1/commits?${range}&visibility=internal`)).json()) as { items: { headline: string }[] };
    expect(commits.items.map((c) => c.headline)).toEqual(['Internal change']);
    expect((await internalApp.request(`/api/v1/commits?${range}&visibility=secret`)).status).toBe(400);
  });

  it('reports sync status and refuses to sync without a token', async () => {
    expect(await (await app.request('/api/v1/sync/status')).json()).toMatchObject({ running: false, tokenSource: 'none', viewer: 'Alice' });
    expect((await app.request('/api/v1/sync', { method: 'POST' })).status).toBe(503);
  });

  it('refuses request bodies over 1 MB', async () => {
    const body = JSON.stringify({ name: 'x', repos: Array.from({ length: 30_000 }, () => 'a'.repeat(40)) });
    const res = await app.request('/api/v1/sets', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(res.status).toBe(413);
  });

  it('rejects cross-origin writes but allows same-origin and non-browser clients', async () => {
    const patch = (headers: Record<string, string>) =>
      app.request('http://localhost/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: '{"includeForks":true}' });
    expect((await patch({ origin: 'https://evil.example', host: 'localhost' })).status).toBe(403);
    expect((await patch({ origin: 'http://localhost', host: 'localhost' })).status).toBe(200);
    // Vite's dev proxy rewrites Host to the API port.
    expect((await patch({ origin: 'http://localhost:5173', host: '127.0.0.1:4780' })).status).toBe(200);
    expect((await patch({ origin: 'https://evil.example', host: '127.0.0.1:4780' })).status).toBe(403);
    expect((await patch({ origin: 'null', host: 'localhost' })).status).toBe(403);
    expect((await patch({})).status).toBe(200);
  });

  it('serves the OpenAPI document, docs page and a build hint for the UI', async () => {
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/api/v1/prs/{repo}/{number}');
    for (const path of ['/api/v1/prs/{repo}/{number}/diff', '/api/v1/commits/{repo}/{oid}/diff', '/api/v1/blob/{repo}', '/api/v1/diff-cache']) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
    for (const path of ['/api/v1/repo-candidates', '/api/v1/repo-lookup', '/api/v1/repos/{repo}']) expect(Object.keys(doc.paths)).toContain(path);
    // Every {param} in a path is documented as a path parameter, and the other way round.
    type Op = { parameters?: { name: string; in: string }[] };
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, Op>>)) {
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [method, op] of Object.entries(ops)) {
        expect((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name).sort(), `${method} ${path}`).toEqual(named);
      }
    }
    expect(await (await app.request('/api/docs')).text()).toContain('/api/v1/activity');
    expect(await (await app.request('/prs')).text()).toContain('npm run build');
  });
});

describe('web app', () => {
  const webDir = mkdtempSync(join(tmpdir(), 'gh-dash-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>gh-dash</title>');
  writeFileSync(join(webDir, 'assets', 'app-1234.js'), 'export {};');
  writeFileSync(join(webDir, 'favicon.svg'), '<svg/>');
  const app = makeApp({ webDir });
  afterAll(() => rmSync(webDir, { recursive: true, force: true }));

  it('serves index.html for client-side routes, dotted repository names and owner/name paths included', async () => {
    for (const path of ['/', '/prs', '/repos/user.github.io', '/repos/foo.nvim', '/repos/x.js', '/repos/app?tab=files', '/repos/kcosr/gh-dash', '/repos/dlvhdr/user.github.io', '/repos/org/team/proj.js', '/repos/kcosr%2Fgh-dash']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<title>gh-dash</title>');
    }
  });

  it('serves built files and 404s missing assets and top-level files', async () => {
    const asset = await app.request('/assets/app-1234.js');
    expect(await asset.text()).toBe('export {};');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const favicon = await app.request('/favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('cache-control')).toBe('no-cache');
    for (const path of ['/assets/missing.js', '/assets/sub/x', '/missing.png', '/robots.txt']) expect((await app.request(path)).status, path).toBe(404);
  });
});

describe('Host allowlist (DNS rebinding)', () => {
  const EVIL = 'rebind.attacker.example:4780';
  // After rebinding, the attacker's page is same-origin with the server: Origin and Sec-Fetch-Site agree with it.
  const rebound = (extra: Record<string, string> = {}) => ({ host: EVIL, origin: `http://${EVIL}`, 'sec-fetch-site': 'same-origin', ...extra });

  it('refuses a foreign Host on the API, the UI, the diff routes and health, with 421', async () => {
    const app = makeApp();
    for (const path of ['/api/v1/repos', '/api/v1/prs/app/2/diff', '/', '/prs', '/api/health', '/api/docs']) {
      const res = await app.request(`http://${EVIL}${path}`, { headers: rebound() });
      expect(res.status, path).toBe(421);
      expect(await res.json()).toEqual({ error: 'Host "rebind.attacker.example" is not allowed; add it to GH_DASH_ALLOWED_HOSTS to serve it' });
    }
    const patch = await app.request(`http://${EVIL}/api/v1/settings`, {
      method: 'PATCH',
      headers: rebound({ 'content-type': 'application/json' }),
      body: '{"syncIntervalMinutes":5}',
    });
    expect(patch.status).toBe(421);
    expect(await (await app.request('/api/v1/settings')).json()).not.toMatchObject({ syncIntervalMinutes: 5 });
    // X-Forwarded-Host is a header any page can send; only the raw Host counts.
    expect((await app.request('/api/v1/repos', { headers: { host: EVIL, 'x-forwarded-host': 'localhost' } })).status).toBe(421);
  });

  it('accepts loopback names, IP literals and listed names, with any port', async () => {
    const app = makeApp({ allowedHosts: ['dash.example.com'] });
    const hosts = [
      'localhost', 'localhost:5173' /* the Vite dev proxy */, 'LocalHost.', 'app.localhost:4780', '127.0.0.1:4780', '192.168.1.20',
      '[::1]:4780', '[fe80::1]', 'dash.example.com', 'Dash.Example.com:8443',
    ];
    for (const host of hosts) expect((await app.request('/api/v1/repos', { headers: { host } })).status, host).toBe(200);
    for (const host of ['example.com', 'dash.example.com.evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '']) {
      expect((await app.request('/api/v1/repos', { headers: { host } })).status, host).toBe(421);
    }
  });

  it("keeps a rebinding page from minting API-key-only mode's session cookie", async () => {
    const app = makeApp({ apiKey: 'k' });
    const page = await app.request(`http://${EVIL}/`, { headers: rebound() });
    expect(page.status).toBe(421);
    expect(page.headers.get('set-cookie')).toBeNull();
  });
});

describe('desktop transport', () => {
  const secret = 'f'.repeat(64);
  const app = makeApp({ apiKey: 'k3y', password: 'pw' }, seedDb(), { kind: 'desktop', secret });
  const get = (headers: Record<string, string>, path = '/api/v1/me') => app.request(`http://gh-dash${path}`, { headers });

  it('requires the per-launch secret on every request, and no password or API key', async () => {
    expect((await get({ [DESKTOP_SECRET_HEADER]: secret })).status).toBe(200);
    expect((await get({ [DESKTOP_SECRET_HEADER]: secret }, '/prs')).status).toBe(200);
    for (const headers of [{}, { [DESKTOP_SECRET_HEADER]: '' }, { [DESKTOP_SECRET_HEADER]: 'e'.repeat(64) }, { authorization: 'Bearer k3y' }] as Record<string, string>[]) {
      const res = await get(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    }
    expect((await get({}, '/api/health')).status).toBe(403);
  });

  it('answers only to the app host', async () => {
    expect((await get({ [DESKTOP_SECRET_HEADER]: secret, host: 'localhost' })).status).toBe(421);
    expect((await get({ [DESKTOP_SECRET_HEADER]: secret, host: 'gh-dash' })).status).toBe(200);
  });

  it('does not mention an API key on the docs page', async () => {
    expect(await (await get({ [DESKTOP_SECRET_HEADER]: secret }, '/api/docs')).text()).not.toContain('requires an API key');
  });
});

describe('auth', () => {
  it('requires the API key for /api/* but not for health; UI visits get a session cookie', async () => {
    const app = makeApp({ apiKey: 'k3y' });
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/v1/me')).status).toBe(401);
    expect((await app.request('/api/v1/me', { headers: { authorization: 'Bearer k3y' } })).status).toBe(200);
    expect((await app.request('/api/v1/me', { headers: { 'x-api-key': 'k3y' } })).status).toBe(200);
    const page = await app.request('/prs');
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/api/v1/me', { headers: { cookie } })).status).toBe(200);
  });

  it('leaves the API reference open in both modes', async () => {
    for (const over of [{ apiKey: 'k3y' }, { password: 'pw' }]) {
      const app = makeApp(over);
      expect((await app.request('/api/docs')).status).toBe(200);
      expect((await app.request('/api/v1/openapi.json')).status).toBe(200);
      expect((await app.request('/api/v1/me')).status).toBe(401);
    }
  });

  it('warns once when an API key alone guards a server listening beyond loopback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeApp({ apiKey: 'k3y', host: '127.0.0.1' });
      makeApp({ apiKey: 'k3y', password: 'pw', host: '0.0.0.0' });
      expect(warn).not.toHaveBeenCalled();
      makeApp({ apiKey: 'k3y', host: '0.0.0.0' });
      makeApp({ apiKey: 'k3y', host: '192.168.1.20' });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain('GH_DASH_API_KEY is set without GH_DASH_PASSWORD while listening on 0.0.0.0');
    } finally {
      warn.mockRestore();
    }
  });

  it('password mode redirects the UI to /login and only a correct password yields a session', async () => {
    const app = makeApp({ password: 'pw' });
    const page = await app.request('/prs?state=open');
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/login?next=%2Fprs%3Fstate%3Dopen');
    const login = (password: string) =>
      app.request('/login', { method: 'POST', body: new URLSearchParams({ password, next: '/prs' }) });
    expect((await login('wrong')).status).toBe(401);
    const ok = await login('pw');
    expect(ok.headers.get('location')).toBe('/prs');
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app.request('/api/v1/me', { headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/v1/me')).status).toBe(401);
  });

  it('never redirects off-site after login', async () => {
    const app = makeApp({ password: 'pw' });
    const next = async (value: string) =>
      (await app.request('/login', { method: 'POST', body: new URLSearchParams({ password: 'pw', next: value }) })).headers.get('location');
    // Browsers resolve `/\host` and `/<tab>/host` like `//host`.
    for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', 'https://evil.example', 'prs']) {
      expect(await next(bad), JSON.stringify(bad)).toBe('/');
    }
    expect(await next('/prs?state=open&q=a%5Cb')).toBe('/prs?state=open&q=a%5Cb');
    expect(await (await app.request('/login?next=%2F%5Cevil.example')).text()).toContain('name="next" value="/"');
  });
});

describe('repo keys', () => {
  function keyApp() {
    const db = seedDb();
    addManualRepo(db, 'bob/app');
    return makeApp({}, db);
  }
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  const send = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('take a key URL-encoded as one path segment, or the short name of a repo you own', async () => {
    const app = keyApp();
    for (const path of ['alice%2Fapp', 'ALICE%2FApp', 'app', 'App']) {
      expect(await json(await app.request(`/api/v1/repos/${path}`)), path).toMatchObject({ status: 200, body: { key: 'alice/app', trackedBy: 'owned' } });
    }
    expect(await json(await app.request('/api/v1/repos/bob%2Fapp'))).toMatchObject({ status: 200, body: { key: 'bob/app', trackedBy: 'manual' } });
    expect((await app.request('/api/v1/repos/alice/app')).status).toBe(404);
    expect((await app.request('/api/v1/repos/nope%2Fapp')).status).toBe(404);

    const patched = await json(await app.request('/api/v1/repos/bob%2Fapp', send('PATCH', { pinned: true })));
    expect(patched).toMatchObject({ status: 200, body: { key: 'bob/app', pinned: true } });
    expect(await json(await app.request('/api/v1/repos/app'))).toMatchObject({ body: { pinned: false } });

    for (const path of ['alice%2Fapp', 'app']) {
      expect(await json(await app.request(`/api/v1/prs/${path}/1`)), path).toMatchObject({ status: 200, body: { id: 'alice/app#1', repo: 'alice/app' } });
    }
    expect((await app.request('/api/v1/prs/alice/app/1')).status).toBe(404);
    expect((await app.request('/api/v1/prs/bob%2Fapp/1')).status).toBe(404);
  });

  it('select repos by key or alias in repos= lists', async () => {
    const app = keyApp();
    const keys = async (query: string) => ((await (await app.request(`/api/v1/repos?${query}`)).json()) as { items: { key: string }[] }).items.map((r) => r.key);
    expect(await keys('repos=app')).toEqual(['alice/app']);
    expect(await keys('repos=alice%2Fapp')).toEqual(['alice/app']);
    expect(await keys('repos=alice/app,bob/app&sort=name')).toEqual(['alice/app', 'bob/app']);
    expect(await keys('q=bob')).toEqual(['bob/app']);
    expect(await keys('ownership=others')).toEqual(['bob/app']);
    expect(await keys('ownership=mine')).not.toContain('bob/app');
    expect((await app.request('/api/v1/repos?ownership=nope')).status).toBe(400);
    expect((await app.request('/api/v1/prs?ownership=theirs')).status).toBe(400);
    const range = 'from=2026-09-01&to=2026-09-27&tz=UTC&state=all';
    const prs = async (repos: string) => ((await (await app.request(`/api/v1/prs?${range}&repos=${repos}`)).json()) as { items: { id: string }[] }).items.map((p) => p.id);
    expect(await prs('app')).toEqual(['alice/app#3', 'alice/app#2', 'alice/app#1']);
    expect(await prs('alice%2Fapp')).toEqual(await prs('app'));
    expect(await prs('bob/app')).toEqual([]);
    const own = async (ownership: string) => ((await (await app.request(`/api/v1/prs?${range}&ownership=${ownership}`)).json()) as { total: number }).total;
    expect(await own('others')).toBe(0);
    expect(await own('mine')).toBe(await own('all'));
  });

  it('store set members and saved views by key', async () => {
    const app = keyApp();
    const set = await json(await app.request('/api/v1/sets', send('POST', { name: 'Mix', repos: ['app', 'bob/app', 'ALICE/SECRET', 'nope'] })));
    expect(set.body).toMatchObject({ repos: ['alice/app', 'bob/app', 'alice/secret'] });

    const view = async (path: string, query: string) => (await json(await app.request('/api/v1/views', send('POST', { name: 'v', path, query })))).body;
    expect(await view('/prs', 'repos=app,bob/app,nope&who=me&pr=app%231&q=a%20b+c')).toMatchObject({
      path: '/prs', query: 'repos=alice/app,bob/app,nope&who=me&pr=alice/app%231&q=a%20b+c',
    });
    expect(await view('/repos/app', '?diff=secret@abc1234')).toMatchObject({ path: '/repos/alice/app', query: 'diff=alice/secret@abc1234' });
    expect(await view('/repos/BOB/APP', '')).toMatchObject({ path: '/repos/bob/app', query: '' });
    expect(await view('/insights', 'range=90d')).toMatchObject({ path: '/insights', query: 'range=90d' });
  });
});

/** The fake GitLab instance as a source configured on this server: its token (null: none), and changes to its answers. */
interface GitLabSetup {
  token?: string | null;
  over?: Record<string, GitLabHandler>;
  ops?: Record<string, (vars: Record<string, unknown>) => unknown>;
}

describe('adding and removing repositories', () => {
  /**
   * seedDb (viewer Alice; alice/app, secret, old, fork, hidden) against a fake GitHub that also knows bob/tool; with
   * `gitlab`, also the fake GitLab instance (test/gitlab-instance.ts: Alice, a relative root) as gitlab.example.com.
   */
  function trackApp(token: string | null = 'ghp_classic', wrap: (f: typeof fetch) => typeof fetch = (f) => f, gitlab?: GitLabSetup) {
    const db = seedDb();
    const gql = fakeGraphQL();
    gql.state.owned.push(...['app', 'secret', 'old', 'fork', 'hidden'].map((n) => repoNode(`alice/${n}`, { id: `R_${n}` })));
    gql.state.others.push(repoNode('bob/tool', { description: 'A tool', stargazerCount: 120, openPrs: { totalCount: 3 }, openIssues: { totalCount: 51 } }));
    gql.state.prs['bob/tool'] = [prNode('bob/tool', 7, 'Faster startup')];
    const rest = (key: string, over: object = {}) => ({
      node_id: `R_${key}`, name: key.split('/')[1], full_name: key, owner: { login: key.split('/')[0] }, description: null, visibility: 'public',
      private: false, archived: false, fork: false, stargazers_count: 5, pushed_at: '2026-09-20T00:00:00Z', ...over,
    });
    const gh = fakeGitHub({
      '/graphql': gql.handler,
      '/user/repos': page([rest('bob/tool'), rest('acme/infra', { visibility: 'internal' })], '/user/repos?page=2'),
      '/user/repos?page=2': page([rest('dlvhdr/gh-dash')], null),
    });
    const tokens = testTokens(token);
    const config = { ...loadConfig({}), webDir: '/nonexistent' };
    const sync = new SyncManager({ db, schedule: false, tokens, log: () => {}, fetchImpl: gh.fetchImpl });
    const githubDiffs = new GitHubDiffSources({ tokens });
    const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources: githubDiffs, log: () => {} });
    const gl = gitlab ? fakeInstance(gitlab.over, GITLAB_BASE, gitlab.ops) : null;
    const sources = gl
      ? new SourceRegistry({
          db,
          env: gitlab!.token === null ? {} : { GITLAB_TOKEN: gitlab!.token ?? 'gl-test-alice' },
          github: { tokens: tokens.credentials, diffs: githubDiffs },
          log: () => {},
          seams: { fetchImpl: gl.fetchImpl, sleep: async () => {}, exec: async () => { throw new Error('glab must not run in tests'); } },
        })
      : undefined;
    const [glRuntime] = sources?.apply({
      glabPath: null,
      sources: [{ kind: 'gitlab', host: 'gitlab.example.com', baseUrl: GITLAB_BASE, tokenChoice: 'auto', tokenFile: null, tokenEnv: 'GITLAB_TOKEN', from: 'env' }],
    }) ?? [];
    const tracking = new Tracking({ db, tokens, sources, sync, tz: 'UTC', fetchImpl: wrap(gh.fetchImpl), sleep: async () => {} });
    const deps: AppDeps = { db, config, sync, diffs, tokens, sources, tracking };
    const app = createApp(deps);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as Record<string, any>) };
    };
    const idle = () => vi.waitFor(() => expect(sync.status().running).toBe(false));
    /** What was asked of GitLab, leaving out the background check of a new token. */
    const glAsked = () => gl!.requests.filter((r) => !/CredentialCheck|personal_access_tokens/.test(r));
    return { app, db, gql, gh, sync, call, idle, deps, sources, gl, glId: glRuntime?.id ?? 0, glAsked };
  }

  it('looks a repository up: a preview with the size of its first sync', async () => {
    const t = trackApp();
    const res = await t.call('GET', '/repo-lookup?repo=https://github.com/Bob/tool.git');
    expect(res).toMatchObject({ status: 200, body: { ok: true, repo: {
      key: 'bob/tool', owner: 'bob', name: 'tool', description: 'A tool', visibility: 'public', stars: 120, tracked: null,
      url: 'https://github.com/bob/tool', openPrs: 3, openIssues: 51, owned: false, hidden: null,
      // max(240/100, 60/50, 12/50) = 3 rounds, plus 1 for the open PRs and 2 for the open issues
      backfill: { commits: 240, prs: 60, issues: 12, releases: 4, requests: 6 },
    } } });
    expect(res.body!.repo.backfill.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.rateLimit).toEqual({ limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z' });
    t.gql.state.size.prs = null;
    expect((await t.call('GET', '/repo-lookup?repo=bob/tool')).body).toMatchObject({ ok: true, repo: { backfill: { prs: null, requests: null } } });
    expect((await t.call('GET', '/repo-lookup?repo=app')).status).toBe(400);
    expect((await t.call('GET', '/repo-lookup?repo=gitlab.com/bob/tool')).status).toBe(400);
    expect((await t.call('GET', '/repo-lookup?repo=alice/app')).body).toMatchObject({ ok: true, repo: { owned: true, tracked: 'owned', hidden: false } });
  });

  it('explains why a repository can’t be read, with a hint for the kind of token', async () => {
    const t = trackApp();
    const lookup = async (repo: string) => (await t.call('GET', `/repo-lookup?repo=${repo}`)).body;
    expect(await lookup('bob/nope')).toEqual({
      ok: false, key: 'bob/nope', problem: 'not-found',
      message: "GitHub doesn't show bob/nope to this token: it doesn't exist, or the token can't read it.", hint: 'Check the spelling, or ask for access.',
    });
    t.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.' };
    expect(await lookup('bob/tool')).toMatchObject({ problem: 'sso', message: 'bob requires SAML single sign-on.', hint: 'Authorize the token for bob (github.com/settings/tokens → Configure SSO).' });
    t.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Although you appear to have the correct authorization credentials, the `bob` organization has enabled OAuth App access restrictions.' };
    expect(await lookup('bob/tool')).toMatchObject({ problem: 'org-policy', message: expect.stringContaining('OAuth App access restrictions'), hint: null });
    t.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', field: 'openIssues' };
    expect(await lookup('bob/tool')).toMatchObject({
      problem: 'permission', message: 'The token can see bob/tool but not its issues.', hint: 'Grant read access to Pull requests, Issues and Contents.',
    });

    const fine = trackApp('github_pat_x');
    expect((await fine.call('GET', '/repo-lookup?repo=bob/nope')).body).toMatchObject({ hint: expect.stringMatching(/^Fine-grained tokens read public repositories anywhere.*Create one for bob,/) });
    const gh = trackApp('gho_x');
    gh.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'the `bob` organization has enabled OAuth App access restrictions' };
    expect((await gh.call('GET', '/repo-lookup?repo=bob/tool')).body).toMatchObject({ hint: 'An owner of bob must approve GitHub CLI, or use a personal access token.' });
  });

  it('adds a repository and starts its first sync', async () => {
    const t = trackApp();
    const res = await t.call('POST', '/repos', { repo: 'bob/tool', includeInDefault: false });
    expect(res).toMatchObject({ status: 201, body: { sync: 'started', repo: {
      key: 'bob/tool', trackedBy: 'manual', hidden: true, description: 'A tool', stats: { openPrs: 3, openIssues: 51 }, unavailable: null,
    } } });
    expect(res.body!.repo.addedAt).toMatch(/^\d{4}-/);
    expect(t.sync.status()).toMatchObject({ running: true, repo: 'bob/tool' });
    await t.idle();
    // Its probe counts open items the sections don't list: the open passes take a second round.
    expect(t.gql.state.ops.slice(-3)).toEqual(['RepoNode:R_bob/tool', 'RepoDetail:bob/tool', 'RepoDetail:bob/tool']);
    const prs = await t.call('GET', '/prs?repos=bob/tool&from=2026-09-01&to=2026-09-29&state=all');
    expect(prs.body!.items.map((p: { id: string }) => p.id)).toEqual(['bob/tool#7']);
    // Now it's tracked: adding it again is refused, with how it is tracked.
    expect(await t.call('POST', '/repos', { repo: 'bob/tool' })).toMatchObject({
      status: 409, body: { error: 'bob/tool is already tracked.', details: { key: 'bob/tool', trackedBy: 'manual', hidden: true } },
    });
    expect((await t.call('GET', '/repo-lookup?repo=bob/tool')).body).toMatchObject({ repo: { tracked: 'manual', hidden: true } });
  });

  it('lets one account claim an unclaimed database when adds by two accounts race', async () => {
    const accounts = [
      { id: 'U_alice', login: 'alice', name: null, avatarUrl: null },
      { id: 'U_mallory', login: 'mallory', name: null, avatarUrl: null },
    ];
    let lookups = 0;
    let release = () => {};
    const answered = new Promise<void>((r) => (release = r));
    // Each lookup is answered as the next account, and both answers arrive together.
    const t = trackApp('ghp_classic', (f) => async (input, init) => {
      if (!/RepoLookup/.test(String(init?.body))) return f(input, init);
      t.gql.state.viewer = accounts[lookups++]!;
      const res = await f(input, init);
      if (lookups === 2) release();
      await answered;
      return res;
    });
    t.gql.state.others.push(repoNode('carol/lib'));
    setViewer(t.db, null);
    const [a, b] = await Promise.all([t.call('POST', '/repos', { repo: 'bob/tool' }), t.call('POST', '/repos', { repo: 'carol/lib' })]);
    await t.idle();
    expect([a.status, b.status]).toEqual([201, 409]);
    expect(b.body).toMatchObject({ error: "This database's GitHub account is @alice, but the token is for @mallory. Switch back to @alice, or use a different database." });
    expect(getSource(t.db, GITHUB_SOURCE_ID)!.viewer).toMatchObject({ id: 'U_alice', login: 'alice' });
    expect(t.db.get(`SELECT 1 FROM repos WHERE owner = 'carol'`)).toBeUndefined();
  });

  it('queues the first sync while a sync runs elsewhere', async () => {
    const t = trackApp();
    const now = new Date().toISOString();
    setMeta(t.db, 'syncLock', { instance: 'other', pid: 1, trigger: 'scheduled', startedAt: now, heartbeatAt: now, progress: { done: 0, total: 5, current: null } });
    expect(await t.call('POST', '/repos', { repo: 'bob/tool' })).toMatchObject({ status: 201, body: { sync: 'queued', repo: { key: 'bob/tool', hidden: false } } });
  });

  it('refuses what it can’t add', async () => {
    const t = trackApp();
    expect(await t.call('POST', '/repos', { repo: 'alice/app' })).toMatchObject({
      status: 409, body: { error: "You own alice/app, so it's tracked automatically.", details: { key: 'alice/app', trackedBy: 'owned', hidden: false } },
    });
    expect(await t.call('POST', '/repos', { repo: 'bob/nope' })).toMatchObject({ status: 404, body: { details: { problem: 'not-found', hint: expect.any(String) } } });
    t.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' };
    expect(await t.call('POST', '/repos', { repo: 'bob/tool' })).toMatchObject({ status: 403, body: { error: 'bob requires SAML single sign-on.', details: { problem: 'sso' } } });
    t.gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', field: 'openPrs' };
    expect(await t.call('POST', '/repos', { repo: 'bob/tool' })).toMatchObject({ status: 403, body: { details: { problem: 'permission' } } });
    expect((await t.call('POST', '/repos', { repo: 'not a repo' })).status).toBe(400);
    expect((await t.call('POST', '/repos', { repo: 'bob/tool', extra: 1 })).status).toBe(400);
    expect(t.db.get(`SELECT 1 FROM repos WHERE owner = 'bob'`)).toBeUndefined();

    t.gql.state.viewer = { id: 'U_mallory', login: 'mallory', name: null, avatarUrl: null };
    delete t.gql.state.errors['bob/tool'];
    const mismatch = await t.call('POST', '/repos', { repo: 'bob/tool' });
    expect(mismatch).toMatchObject({ status: 409, body: { error: expect.stringContaining('but the token is for @mallory') } });
    expect((await t.call('GET', '/repo-lookup?repo=bob/tool')).status).toBe(409);
    expect(t.db.get(`SELECT 1 FROM repos WHERE owner = 'bob'`)).toBeUndefined();

    const none = trackApp(null);
    expect((await none.call('POST', '/repos', { repo: 'bob/tool' })).status).toBe(503);
    expect((await none.call('GET', '/repo-candidates')).status).toBe(503);
  });

  it('removes a repository added by hand with all its data; owned ones are hidden instead', async () => {
    const t = trackApp();
    await t.call('POST', '/repos', { repo: 'bob/tool' });
    await t.idle();
    const id = t.db.get<{ id: number }>(`SELECT id FROM repos WHERE name_with_owner = 'bob/tool'`)!.id;
    t.db.run(`INSERT INTO commits (repo_id, oid, headline, committed_at, url) VALUES (?, 'c1', 'Speed up', '2026-09-25T00:00:00Z', 'u')`, [id]);
    t.db.run(`INSERT INTO issues (repo_id, number, title, state, created_at, updated_at, activity_at, url) VALUES (?, 3, 'Slow', 'open', 'x', 'x', 'x', 'u')`, [id]);
    t.db.run(`INSERT INTO releases (repo_id, tag, published_at, url) VALUES (?, 'v1', 'x', 'u')`, [id]);
    t.db.run(`INSERT INTO stars (repo_id, login, starred_at) VALUES (?, 'zed', 'x')`, [id]);
    t.db.run(`INSERT INTO pr_commits (pr_id, position, oid, headline, committed_at, url) SELECT id, 0, 'c', 'h', 'x', 'u' FROM pull_requests WHERE repo_id = ?`, [id]);
    await t.call('POST', '/sets', { name: 'Mix', repos: ['app', 'bob/tool'] });
    const children = ['sync_state', 'pull_requests', 'commits', 'issues', 'releases', 'stars', 'repo_set_members'];
    const count = (table: string) => t.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE repo_id = ?`, [id])!.n;
    expect(children.map(count).every((n) => n > 0)).toBe(true);

    expect(await t.call('DELETE', '/repos/alice%2Fapp')).toMatchObject({ status: 409, body: { error: 'Repositories you own are tracked automatically; hide it instead.' } });
    expect(await t.call('DELETE', '/repos/bob%2Fnope')).toMatchObject({ status: 404 });
    expect(await t.call('DELETE', '/repos/bob%2Ftool')).toEqual({ status: 204, body: null });
    expect(children.map(count)).toEqual(children.map(() => 0));
    expect(t.db.get<{ n: number }>('SELECT count(*) AS n FROM pr_commits WHERE pr_id NOT IN (SELECT id FROM pull_requests)')!.n).toBe(0);
    for (const fts of ['pull_requests_fts', 'issues_fts', 'commits_fts', 'releases_fts']) t.db.exec(`INSERT INTO ${fts}(${fts}) VALUES ('integrity-check')`);
    expect((await t.call('GET', '/sets')).body!.items).toMatchObject([{ name: 'Mix', repos: ['alice/app'] }]);
    expect(await t.call('DELETE', '/repos/bob%2Ftool')).toMatchObject({ status: 404 });
    // Adding it again syncs it from scratch.
    expect(await t.call('POST', '/repos', { repo: 'bob/tool' })).toMatchObject({ status: 201 });
    await t.idle();
  });

  it('lists candidates: tracked ones marked, suggestions untracked, cached until refreshed', async () => {
    const t = trackApp();
    t.gql.state.suggested = ['bob/tool', 'carol/lib'];
    t.gql.state.others.push(repoNode('carol/lib'));
    await t.call('POST', '/repos', { repo: 'bob/tool' });
    await t.idle();
    const first = await t.call('GET', '/repo-candidates');
    expect(first.status).toBe(200);
    expect(first.body!.items.map((c: { key: string; tracked: string | null; visibility: string }) => [c.key, c.tracked, c.visibility])).toEqual([
      ['bob/tool', 'manual', 'public'], ['acme/infra', null, 'internal'], ['dlvhdr/gh-dash', null, 'public'],
    ]);
    expect(first.body!.suggested.map((c: { key: string }) => c.key)).toEqual(['carol/lib']);
    expect(first.body).toMatchObject({ truncated: false, fetchedAt: expect.any(String) });
    const requests = t.gh.requests.length;
    await t.call('GET', '/repo-candidates');
    expect(t.gh.requests.length).toBe(requests);
    await t.call('GET', '/repo-candidates?refresh=1');
    expect(t.gh.requests.length).toBe(requests + 3);
    expect(t.gh.requests.filter((r) => r.startsWith('/user/repos'))[0]).toBe('/user/repos?affiliation=collaborator%2Corganization_member&sort=pushed&per_page=100');
    // A later add shows up without refetching.
    await t.call('POST', '/repos', { repo: 'carol/lib' });
    await t.idle();
    expect((await t.call('GET', '/repo-candidates')).body!.suggested).toEqual([]);
  });

  it('checks the account on every candidates answer, cached ones included', async () => {
    const t = trackApp();
    setViewer(t.db, null);
    expect((await t.call('GET', '/repo-candidates')).status).toBe(200);
    // Meanwhile the database was claimed by another account (Bob added a repo with his token); Alice's lists are cached.
    setViewer(t.db, { id: 'U_bob', login: 'bob', name: null, avatarUrl: null });
    const requests = t.gh.requests.length;
    expect(await t.call('GET', '/repo-candidates')).toMatchObject({ status: 409, body: { error: expect.stringContaining('but the token is for @alice') } });
    expect(t.gh.requests.length).toBe(requests);
  });

  it('refuses GitHub-spending lookups from other sites', async () => {
    const t = trackApp();
    for (const path of ['/api/v1/repo-candidates', '/api/v1/repo-lookup?repo=bob/tool']) {
      expect((await t.app.request(path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, path).toBe(403);
      expect((await t.app.request(path, { headers: { 'sec-fetch-site': 'same-origin' } })).status, path).toBe(200);
    }
    expect(t.gh.requests.filter((r) => r === '/graphql')).toHaveLength(2);
  });

  it('validates a single-repo POST /sync', async () => {
    const t = trackApp();
    expect(await t.call('POST', '/sync', { repo: 'bob/tool' })).toMatchObject({ status: 404, body: { error: "bob/tool isn't tracked. Add it first (POST /api/v1/repos)." } });
    expect(await t.call('POST', '/sync', { repo: 'APP' })).toMatchObject({ status: 202, body: { running: true, repo: 'alice/app' } });
    await t.idle();
    // The stored open items aren't GitHub's: the open passes take a second round.
    expect(t.gql.state.ops.slice(-3)).toEqual(['RepoNode:R_app', 'RepoDetail:alice/app', 'RepoDetail:alice/app']);
  });

  describe('on a GitLab source', () => {
    const GL = 'gitlab.example.com';
    const q = (repo: string, source?: string) => `/repo-lookup?repo=${encodeURIComponent(repo)}${source ? `&source=${source}` : ''}`;
    const onGitLab = (over: Omit<GitLabSetup, 'token'> = {}) => trackApp('ghp_classic', undefined, over);

    it('lists candidates: the personal namespace left out, keys with the host, cached per source', async () => {
      const t = onGitLab();
      const res = await t.call('GET', '/repo-candidates?source=gitlab.example.com');
      expect(res.status).toBe(200);
      const keys = ['platform/team/svc', 'team/platform/api', 'bob/tool', 'team/docs', 'platform/api'].map((p) => `${GL}/${p}`);
      expect(res.body!.items.map((c: RepoCandidate) => [c.key, c.owner, c.name, c.visibility, c.tracked])).toEqual([
        [keys[0], 'platform/team', 'svc', 'internal', null],
        [keys[1], 'team/platform', 'api', 'private', null],
        [keys[2], 'bob', 'tool', 'internal', null],
        [keys[3], 'team', 'docs', 'public', null],
        [keys[4], 'platform', 'api', 'private', null],
      ]);
      expect(res.body!.suggested.map((c: RepoCandidate) => c.key)).toEqual(keys);
      expect(res.body).toMatchObject({ truncated: false, fetchedAt: expect.any(String) });
      expect(t.glAsked().sort()).toEqual(['/api/v4/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100&page=1', 'graphql Viewer']);
      expect(t.gh.requests).toEqual([]);

      // GitHub's lists are cached apart: asking for them doesn't reuse GitLab's, and neither is asked again.
      await t.call('GET', '/repo-candidates?source=GITLAB.example.com');
      await t.call('GET', '/repo-candidates');
      await t.call('GET', '/repo-candidates?source=github.com');
      await t.call('GET', '/repo-candidates?source=gitlab.example.com');
      expect([t.gh.requests.length, t.glAsked().length]).toEqual([3, 2]);
      await t.call('GET', '/repo-candidates?source=gitlab.example.com&refresh=1');
      expect([t.gh.requests.length, t.glAsked().length]).toEqual([3, 4]);
    });

    it('looks a project up by its path, key, web URL or ssh address: a preview with the size of its first sync', async () => {
      const t = onGitLab();
      const preview = {
        key: `${GL}/team/platform/api`, owner: 'team/platform', name: 'api', description: 'Platform API', visibility: 'private', isArchived: false,
        isFork: false, stars: 5, tracked: null, url: 'https://gitlab.example.com/gitlab/team/platform/api', openPrs: 3, openIssues: 7, owned: false,
        hidden: null,
        // GitLab doesn't count commits cheaply, so neither they nor the requests are known.
        backfill: { commits: null, prs: 12, issues: 30, releases: 4, requests: null },
      };
      const inputs: [string, string?][] = [
        ['team/platform/api', GL],
        ['team/platform/api.git', 'GitLab.example.com'],
        ['gitlab.example.com/team/platform/api'],
        ['https://gitlab.example.com/gitlab/team/platform/api/-/merge_requests/3'],
        // An address on another source's host wins over the source asked for.
        ['git@gitlab.example.com:team/platform/api.git', 'github.com'],
        ['ssh://git@gitlab.example.com:2222/team/platform/api.git'],
      ];
      for (const [repo, source] of inputs) {
        const res = await t.call('GET', q(repo, source));
        expect(res, repo).toMatchObject({ status: 200, body: { ok: true, repo: preview } });
        expect(res.body!.repo.backfill.since, repo).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(res.body!.repo, repo).not.toHaveProperty('unavailable');
      }
      expect(t.glAsked()).toEqual(inputs.map(() => 'graphql ProjectLookup'));
      expect(t.gh.requests).toEqual([]);
      // Its own projects are tracked automatically.
      expect((await t.call('GET', q('alice/app', GL))).body).toMatchObject({ ok: true, repo: { key: `${GL}/alice/app`, owned: true, tracked: null } });
    });

    it('explains why a project can’t be added: GitLab doesn’t show it, or not its code', async () => {
      const t = onGitLab();
      expect((await t.call('GET', q('bob/gone', GL))).body).toEqual({
        ok: false, key: `${GL}/bob/gone`, problem: 'not-found',
        message: "GitLab doesn't show bob/gone to this token: it doesn't exist, or you aren't a member.",
        hint: 'Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.',
      });
      expect((await t.call('GET', q('https://gitlab.example.com/gitlab/platform/team/svc'))).body).toEqual({
        ok: false, key: `${GL}/platform/team/svc`, problem: 'permission',
        message: 'The token can see platform/team/svc but not its code.', hint: "Guests can't read a private project's code; ask for Reporter access.",
      });
      expect(await t.call('POST', '/repos', { repo: 'bob/gone', source: GL })).toMatchObject({ status: 404, body: { details: { problem: 'not-found', hint: expect.any(String) } } });
      expect(await t.call('POST', '/repos', { repo: 'platform/team/svc', source: GL })).toMatchObject({
        status: 403, body: { error: 'The token can see platform/team/svc but not its code.', details: { problem: 'permission' } },
      });
      expect(t.db.get('SELECT 1 FROM repos WHERE source_id <> 1')).toBeUndefined();
    });

    it('reports merge requests or issues turned off, and adds the project all the same', async () => {
      // Alice's own corp.tools has its issues turned off.
      const t = onGitLab();
      expect((await t.call('GET', q('alice/corp.tools', GL))).body).toMatchObject({
        ok: true, repo: { key: `${GL}/alice/corp.tools`, owned: true, unavailable: ['issues'], backfill: { prs: 12, issues: 0 } },
      });
      // A group project whose merge requests are hidden at the token's role, and whose issues are off.
      const off = onGitLab({
        ops: {
          ProjectLookup: (v) => ({
            currentUser: lookupFixture.currentUser,
            project: v.path === 'team/platform/api'
              ? { ...lookupFixture.project, userPermissions: { downloadCode: true, readMergeRequest: false }, issuesEnabled: false, recentMergeRequests: null, recentIssues: null }
              : null,
          }),
        },
      });
      expect((await off.call('GET', q('team/platform/api', GL))).body).toMatchObject({
        ok: true, repo: { owned: false, unavailable: ['prs', 'issues'], backfill: { commits: null, prs: 0, issues: 0, releases: 4, requests: null } },
      });
      expect(await off.call('POST', '/repos', { repo: 'team/platform/api', source: GL })).toMatchObject({ status: 201, body: { repo: { key: `${GL}/team/platform/api` } } });
    });

    it("adds a project, claims the source's account, and leaves its first sync to the multi-source manager", async () => {
      const t = onGitLab();
      const github = getSource(t.db, GITHUB_SOURCE_ID)!.viewer;
      const res = await t.call('POST', '/repos', { repo: 'https://gitlab.example.com/gitlab/team/platform/api/-/issues', includeInDefault: false });
      expect(res).toMatchObject({ status: 201, body: { sync: 'queued', repo: {
        key: `${GL}/team/platform/api`, source: GL, provider: 'gitlab', owner: 'team/platform', name: 'api', trackedBy: 'manual', hidden: true,
        url: 'https://gitlab.example.com/gitlab/team/platform/api', stats: { openPrs: 3, openIssues: 7 }, unavailable: null,
      } } });
      expect(res.body!.repo.addedAt).toMatch(/^\d{4}-/);
      // No GitHub run for it (a GitHub run would refuse it): step 5's manager syncs it.
      expect(t.sync.status().running).toBe(false);
      expect(t.gh.requests).toEqual([]);
      expect(getSource(t.db, t.glId)!.viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
      expect(getSource(t.db, GITHUB_SOURCE_ID)!.viewer).toEqual(github);

      // Now it's tracked: adding it again is refused, and the lookup and candidates say how it is tracked.
      expect(await t.call('POST', '/repos', { repo: 'team/platform/api', source: GL })).toMatchObject({
        status: 409, body: { error: `${GL}/team/platform/api is already tracked.`, details: { key: `${GL}/team/platform/api`, trackedBy: 'manual', hidden: true } },
      });
      expect((await t.call('GET', q('team/platform/api', GL))).body).toMatchObject({ repo: { tracked: 'manual', hidden: true } });
      const listed = (await t.call('GET', '/repo-candidates?source=gitlab.example.com')).body!;
      expect(listed.items.find((c: RepoCandidate) => c.key === `${GL}/team/platform/api`).tracked).toBe('manual');
      expect(listed.suggested.map((c: RepoCandidate) => c.key)).not.toContain(`${GL}/team/platform/api`);
      expect(await t.call('POST', '/repos', { repo: 'alice/app', source: GL })).toMatchObject({
        status: 409, body: { error: `You own ${GL}/alice/app, so it's tracked automatically.`, details: { key: `${GL}/alice/app`, trackedBy: 'owned', hidden: false } },
      });
    });

    it('removes a project added by hand, by its key or by its path with the source; owned ones are hidden instead', async () => {
      const t = onGitLab();
      await t.call('POST', '/repos', { repo: 'team/platform/api', source: GL });
      await t.call('POST', '/repos', { repo: 'team/docs', source: GL });
      upsertOwned(t.db, { id: t.glId, host: GL }, { ...repoRecord('app'), nodeId: 'gid://gitlab/Project/11', nameWithOwner: 'alice/app', owner: 'alice' }, '2026-09-29T00:00:00Z');
      const live = () => t.db.all<{ key: string }>('SELECT key FROM repos WHERE source_id = ? ORDER BY key', [t.glId]).map((r) => r.key);
      expect(live()).toEqual([`${GL}/alice/app`, `${GL}/team/docs`, `${GL}/team/platform/api`]);

      const owned = { status: 409, body: { error: 'Repositories you own are tracked automatically; hide it instead.' } };
      expect(await t.call('DELETE', '/repos/gitlab.example.com%2Falice%2Fapp')).toMatchObject(owned);
      expect(await t.call('DELETE', '/repos/alice%2Fapp?source=gitlab.example.com')).toMatchObject(owned);
      // A path names a repo on the source given, and a key must be on it.
      expect(await t.call('DELETE', '/repos/team%2Fdocs')).toMatchObject({ status: 404 });
      expect(await t.call('DELETE', '/repos/team%2Fdocs?source=github.com')).toMatchObject({ status: 404 });
      expect(await t.call('DELETE', '/repos/gitlab.example.com%2Fteam%2Fdocs?source=github.com')).toMatchObject({ status: 404 });
      expect(await t.call('DELETE', '/repos/team%2Fdocs?source=nowhere.example.com')).toEqual({ status: 400, body: { error: "nowhere.example.com isn't a source here." } });
      expect((await t.call('DELETE', '/repos/team%2Fdocs?source=not%20a%20host')).status).toBe(400);
      expect(await t.call('DELETE', '/repos/team%2Fdocs?source=GitLab.example.com')).toEqual({ status: 204, body: null });
      expect(await t.call('DELETE', '/repos/gitlab.example.com%2Fteam%2Fplatform%2Fapi')).toEqual({ status: 204, body: null });
      expect(live()).toEqual([`${GL}/alice/app`]);
      expect(await t.call('DELETE', '/repos/team%2Fplatform%2Fapi?source=gitlab.example.com')).toMatchObject({ status: 404 });
      // Adding it again tracks it from scratch.
      expect(await t.call('POST', '/repos', { repo: 'team/platform/api', source: GL })).toMatchObject({ status: 201 });
    });

    it("refuses a host that isn't a source here, or isn't configured on this server", async () => {
      const t = onGitLab();
      const other = { status: 400, body: { error: "gitlab.other.example isn't a source here." } };
      for (const path of [
        q('https://gitlab.other.example/alice/app'),
        q('git@gitlab.other.example:alice/app.git'),
        q('gitlab.other.example/alice/app'),
        q('https://gitlab.other.example/alice/app', GL),
        q('alice/app', 'gitlab.other.example'),
        '/repo-candidates?source=gitlab.other.example',
      ]) {
        expect(await t.call('GET', path), path).toEqual(other);
      }
      expect(await t.call('POST', '/repos', { repo: 'https://gitlab.other.example/alice/app' })).toEqual(other);
      expect(await t.call('POST', '/repos', { repo: 'alice/app', source: 'gitlab.other.example' })).toEqual(other);
      // In the database (another instance syncs it), but not configured on this one.
      ensureSource(t.db, { kind: 'gitlab', host: 'gitlab2.example.com', baseUrl: 'https://gitlab2.example.com' });
      t.sources!.apply();
      const unconfigured = { status: 400, body: { error: "GitLab (gitlab2.example.com) isn't configured on this server." } };
      expect(await t.call('GET', q('https://gitlab2.example.com/alice/app'))).toEqual(unconfigured);
      expect(await t.call('GET', q('gitlab2.example.com/alice/app'))).toEqual(unconfigured);
      expect(await t.call('GET', '/repo-candidates?source=gitlab2.example.com')).toEqual(unconfigured);
      // Input that names no project, or a URL outside the instance's relative root.
      expect(await t.call('GET', q('app', GL))).toEqual({ status: 400, body: { error: 'Not a GitLab project: "app". Enter group/project or a gitlab.example.com URL.' } });
      expect((await t.call('GET', q('https://gitlab.example.com/team/platform/api'))).status).toBe(400);
      expect([t.gh.requests.length, t.glAsked().length]).toEqual([0, 0]);

      // Without GitLab sources, GitHub is the only one.
      const github = trackApp();
      expect(await github.call('GET', q('https://gitlab.example.com/gitlab/team/platform/api'))).toEqual({ status: 400, body: { error: "gitlab.example.com isn't a source here." } });
      expect(await github.call('GET', q('bob/tool', GL))).toEqual({ status: 400, body: { error: "gitlab.example.com isn't a source here." } });
      expect((await github.call('GET', q('bob/tool', 'github.com'))).status).toBe(200);
    });

    it("needs the source's token, for the source's account; retries little, and waits for nothing long", async () => {
      const none = trackApp('ghp_classic', undefined, { token: null });
      expect(await none.call('GET', '/repo-candidates?source=gitlab.example.com')).toMatchObject({ status: 503, body: { error: expect.stringMatching(/^No GitLab token for gitlab\.example\.com: /) } });
      expect((await none.call('POST', '/repos', { repo: 'team/platform/api', source: GL })).status).toBe(503);
      expect(none.glAsked()).toEqual([]);

      // The source was claimed by another account: every answer is refused, cached candidates included.
      const t = onGitLab();
      expect((await t.call('GET', '/repo-candidates?source=gitlab.example.com')).status).toBe(200);
      tryClaimViewer(t.db, t.glId, { id: 'gid://gitlab/User/9', login: 'bob' });
      const asked = t.glAsked().length;
      const mismatch = { status: 409, body: { error: expect.stringContaining('GitLab (gitlab.example.com) account is @bob, but the token is for @alice') } };
      expect(await t.call('GET', '/repo-candidates?source=gitlab.example.com')).toMatchObject(mismatch);
      expect(t.glAsked().length).toBe(asked);
      expect(await t.call('GET', q('team/platform/api', GL))).toMatchObject(mismatch);
      expect(await t.call('POST', '/repos', { repo: 'team/platform/api', source: GL })).toMatchObject(mismatch);
      expect(t.db.get('SELECT 1 FROM repos WHERE source_id = ?', [t.glId])).toBeUndefined();
      // GitHub's account is its own: its lookups still answer.
      expect((await t.call('GET', q('bob/tool'))).status).toBe(200);

      const rejected = onGitLab({ over: { '/api/graphql': { status: 401, body: { error: 'invalid_token', error_description: 'Token is expired' } } } });
      expect(await rejected.call('GET', q('team/platform/api', GL))).toMatchObject({
        status: 503, body: { error: expect.stringContaining('check the GitLab token in Settings → Sources, or run `glab auth login --hostname gitlab.example.com`') },
      });
      // A long throttle is a 429 at once, and a failing instance is tried twice.
      const throttled = onGitLab({ over: { '/api/graphql': { status: 429, text: 'Retry later\n', headers: { 'retry-after': '60' } } } });
      expect(await throttled.call('GET', q('team/platform/api', GL))).toMatchObject({ status: 429, body: { details: { resetAt: expect.any(String) } } });
      expect(throttled.glAsked()).toEqual(['graphql ProjectLookup']);
      const down = onGitLab({ over: { '/api/graphql': { status: 502, text: 'Bad gateway' } } });
      expect(await down.call('GET', q('team/platform/api', GL))).toMatchObject({ status: 502, body: { error: expect.stringMatching(/^GitLab \(gitlab\.example\.com\) request failed: /) } });
      expect(down.glAsked()).toEqual(['graphql ProjectLookup', 'graphql ProjectLookup']);
    });

    it('is what createApp builds over the sources', async () => {
      const t = onGitLab();
      const app = createApp({ ...t.deps, tracking: undefined });
      const res = await app.request(`/api/v1${q('team/platform/api', GL)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, repo: { key: `${GL}/team/platform/api` } });
    });
  });
});

describe('GH_DASH_MY_EMAILS', () => {
  it('is parsed as a trimmed, lower-cased, de-duplicated list', () => {
    expect(loadConfig({ GH_DASH_MY_EMAILS: ' Me@Home.example, ,other@x.example,me@home.example ,' }).myEmails).toEqual(['me@home.example', 'other@x.example']);
    expect(loadConfig({}).myEmails).toEqual([]);
  });

  function envApp(myEmails: string[]) {
    const db = seedDb();
    const repoId = db.get<{ id: number }>("SELECT id FROM repos WHERE name = 'app'")!.id;
    upsertCommit(db, repoId, {
      oid: 'e'.repeat(40), headline: 'From my laptop', body: '', committedAt: '2026-09-24T08:00:00Z', url: 'https://github.com/c/e',
      additions: 1, deletions: 0, prNumber: null, author: { login: null, name: 'Al', email: 'me@home.example', avatarUrl: null },
    });
    return { db, app: makeApp({ myEmails }, db) };
  }
  const range = 'from=2026-09-20&to=2026-09-26&tz=UTC';

  it('counts as "me" everywhere, on top of settings.myEmails', async () => {
    const { app } = envApp(['me@home.example']);
    const commits = (await (await app.request(`/api/v1/commits?${range}&who=me`)).json()) as { items: { headline: string; author: { isMe: boolean } }[] };
    expect(commits.items.map((c) => c.headline)).toEqual(['From my laptop', 'Commit c4', 'Tweak config', 'Merge pull request #1']);
    expect(commits.items.every((c) => c.author.isMe)).toBe(true);
    const others = (await (await app.request(`/api/v1/activity?${range}&who=others&types=commit`)).json()) as { items: unknown[] };
    expect(others.items).toHaveLength(1); // bob's c3 only
    const stats = (await (await app.request(`/api/v1/stats?${range}`)).json()) as { contributors: { actor: { login: string; isMe: boolean }; commits: number }[]; series: { commitsMine: number }[] };
    expect(stats.contributors.filter((c) => c.actor.isMe)).toEqual([expect.objectContaining({ actor: expect.objectContaining({ login: 'Alice' }), commits: 4 })]);
    expect(stats.series.reduce((a, b) => a + b.commitsMine, 0)).toBe(4);

    const { app: plain } = envApp([]);
    const mine = (await (await plain.request(`/api/v1/commits?${range}&who=me`)).json()) as { items: unknown[] };
    expect(mine.items).toHaveLength(3);
  });

  it('is reported read-only in settings and ignored by PATCH', async () => {
    const { app, db } = envApp(['me@home.example']);
    expect(await (await app.request('/api/v1/settings')).json()).toMatchObject({ myEmails: ['alice@work.example'], myEmailsFromEnv: ['me@home.example'] });
    const patch = (body: object) =>
      app.request('/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // A client may send back the whole Settings object it fetched.
    const res = await patch({ myEmails: ['x@y.example'], myEmailsFromEnv: ['evil@x.example'], includeForks: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ myEmails: ['x@y.example'], myEmailsFromEnv: ['me@home.example'], includeForks: true });
    expect(db.all("SELECT key FROM settings WHERE key = 'myEmailsFromEnv'")).toEqual([]);
    expect((await patch({ nope: 1 })).status).toBe(400);
  });
});

describe('"me" per source', () => {
  // The seed's GitHub viewer is alice; seedGitLab adds gitlab.example.com, claimed by bob (address bob@corp.example).
  const range = 'from=2026-09-20&to=2026-09-26&tz=UTC';
  const KEY = 'gitlab.example.com/platform/app';
  function twoSources(myEmails: string[] = []) {
    const db = seedDb();
    seedGitLab(db);
    return makeApp({ myEmails }, db);
  }
  const read = async <T>(app: ReturnType<typeof makeApp>, path: string) => (await (await app.request(`/api/v1${path}`)).json()) as T;
  type Items = { items: { id?: string; headline?: string; author: { isMe: boolean } }[] };

  it('/me is still the github.com account', async () => {
    expect(await read(twoSources(), '/me')).toMatchObject({ login: 'Alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' });
  });

  it('who=me and who=others follow each source’s account, on every list', async () => {
    const app = twoSources();
    const ids = async (path: string) => (await read<Items>(app, path)).items.map((i) => i.id);
    expect(await ids(`/prs?${range}&who=me`)).toEqual(['alice/secret#1', `${KEY}#1`, 'alice/app#1']);
    expect(await ids(`/prs?${range}&who=others`)).toEqual([`${KEY}#3`, 'alice/app#3', `${KEY}#2`, 'alice/app#2']);
    expect(await ids(`/issues?${range}&state=all&who=me`)).toEqual(['alice/app#11', `${KEY}#1`]);
    // Scoping to the GitLab repo: GitLab's bob is me, and GitLab's alice is not.
    expect(await ids(`/prs?${range}&repos=${encodeURIComponent(KEY)}&who=me`)).toEqual([`${KEY}#1`]);
    const commits = await read<Items>(app, `/commits?${range}&who=me`);
    expect(commits.items.map((c) => c.headline).sort()).toEqual(['Bootstrap service', 'Commit c4', 'Merge pull request #1', 'Tune pipeline', 'Tweak config']);
    expect(commits.items.every((c) => c.author.isMe)).toBe(true);
    const activity = await read<{ total: number; items: { actor: { isMe: boolean } }[] }>(app, `/activity?${range}&who=me`);
    expect(activity.items.every((e) => e.actor.isMe)).toBe(true);
    const others = await read<{ total: number }>(app, `/activity?${range}&who=others`);
    expect(activity.total + others.total).toBe((await read<{ total: number }>(app, `/activity?${range}`)).total);
  });

  it('stats: the "me" series and contributors span the sources', async () => {
    type Stats = {
      tiles: { commits: { value: number }; prsMerged: { value: number } };
      series: { commitsMine: number; prsMergedMine: number }[];
      contributors: { actor: { login: string | null; isMe: boolean }; commits: number; prsMerged: number }[];
    };
    const app = twoSources();
    const stats = await read<Stats>(app, `/stats?${range}`);
    expect(stats.series.reduce((a, b) => a + b.commitsMine, 0)).toBe(5);
    expect(stats.series.reduce((a, b) => a + b.prsMergedMine, 0)).toBe(3);
    expect(stats.contributors.filter((c) => c.actor.isMe)).toEqual([expect.objectContaining({ actor: expect.objectContaining({ login: 'Alice' }), commits: 5, prsMerged: 3 })]);
    const mine = await read<Stats>(app, `/stats?${range}&who=me`);
    expect([mine.tiles.commits.value, mine.tiles.prsMerged.value]).toEqual([5, 3]);
    const gitlab = await read<Stats>(app, `/stats?${range}&who=me&repos=${encodeURIComponent(KEY)}`);
    expect(gitlab.contributors).toEqual([expect.objectContaining({ actor: expect.objectContaining({ login: 'bob', isMe: true }), commits: 2, prsMerged: 1 })]);
  });

  it('GH_DASH_MY_EMAILS counts on the GitLab repos too', async () => {
    const db = seedDb();
    const { repoId } = seedGitLab(db);
    upsertCommit(db, repoId, {
      oid: 'f'.repeat(40), headline: 'From my laptop', body: '', committedAt: '2026-09-24T08:00:00Z', url: 'https://gitlab.example.com/c/f',
      additions: 1, deletions: 0, prNumber: null, author: { login: null, name: 'Al', email: 'me@home.example', avatarUrl: null },
    });
    const commits = async (myEmails: string[]) =>
      (await read<Items>(makeApp({ myEmails }, db), `/commits?${range}&who=me`)).items.map((c) => c.headline);
    expect(await commits(['me@home.example'])).toContain('From my laptop');
    expect(await commits([])).not.toContain('From my laptop');
  });
});

describe('diffs', () => {
  const C = sha('c');
  function diffApp(routes: Record<string, Reply> = {}, token: string | null = 'tok') {
    const db = seedDb();
    const config = { ...loadConfig({}), webDir: '/nonexistent' };
    const tokens = testTokens(token);
    const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
    const gh = fakeGitHub(routes);
    const cache = new DiffCache(':memory:');
    const sources = new GitHubDiffSources({ tokens, fetchImpl: gh.fetchImpl, sleep: async () => {}, log: () => {} });
    const diffs = new DiffService({ db, cache, sources, log: () => {} });
    return { app: createApp({ db, config, sync, diffs, tokens }), gh, cache };
  }
  const commitRoute = {
    [`/repos/alice/app/commits/${C}`]: {
      body: { sha: C, html_url: 'https://github.com/alice/app/commit/c', commit: { message: 'Fix' }, parents: [], stats: { additions: 1, deletions: 1 }, files: [restFile(1)] },
    },
  };

  it('validates input and reports unknown things, missing tokens and rate limits', async () => {
    const { app } = diffApp({}, null);
    const code = async (path: string) => (await app.request(path)).status;
    expect(await code('/api/v1/prs/app/0/diff')).toBe(400);
    expect(await code('/api/v1/prs/app/1/diff?refresh=yes')).toBe(400);
    expect(await code('/api/v1/commits/app/xyz/diff')).toBe(400);
    expect(await code(`/api/v1/blob/app?path=a.txt`)).toBe(400);
    expect(await code(`/api/v1/blob/app?ref=${C}&path=../a`)).toBe(400);
    expect(await code('/api/v1/prs/nope/1/diff')).toBe(404);
    expect(await code('/api/v1/prs/app/999/diff')).toBe(404);
    expect(await code('/api/v1/prs/bob%2Fapp/1/diff')).toBe(404);
    // A key's slash must be encoded: raw, it is two path segments.
    expect(await code('/api/v1/prs/alice/app/1/diff')).toBe(404);
    expect(await code(`/api/v1/commits/alice/app/${C}/diff`)).toBe(404);
    const noToken = await app.request('/api/v1/prs/app/1/diff');
    expect(noToken.status).toBe(503);
    expect(await noToken.json()).toEqual({ error: 'No GitHub token: connect a GitHub account in Settings' });

    const limited = diffApp({ [`/repos/alice/app/commits/${C}`]: { status: 429, headers: { 'x-ratelimit-remaining': '0' } } }).app;
    const res = await limited.request(`/api/v1/commits/app/${C}/diff`);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('rate limit'), details: { resetAt: '2099-01-01T00:00:00.000Z' } });
  });

  it('serves diffs as JSON, gzip-encoded when the client accepts it', async () => {
    const { app } = diffApp(commitRoute);
    const plain = await app.request(`/api/v1/commits/alice%2Fapp/${C}/diff`);
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(plain.headers.get('content-encoding')).toBeNull();
    const diff = await plain.json();
    expect(diff).toMatchObject({ kind: 'commit', repo: 'alice/app', headOid: C, files: [{ path: 'src/f1.ts' }] });
    const gz = await app.request(`/api/v1/commits/alice%2Fapp/${C}/diff`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString())).toEqual(diff);
    const refused = await app.request(`/api/v1/commits/app/${C}/diff`, { headers: { 'accept-encoding': 'gzip;q=0, br' } });
    expect(refused.headers.get('content-encoding')).toBeNull();
  });

  it('reads Accept-Encoding per RFC 9110: an explicit gzip entry beats *', () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip('')).toBe(false);
    expect(acceptsGzip('br, deflate')).toBe(false);
    expect(acceptsGzip('gzip, deflate, br, zstd')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('GZIP;q=0.5')).toBe(true);
    expect(acceptsGzip('*, gzip;q=0')).toBe(false);
    expect(acceptsGzip('gzip ; q = 0 , *')).toBe(false);
    expect(acceptsGzip('gzip;q=0.000, br')).toBe(false);
    expect(acceptsGzip('*;q=0')).toBe(false);
    expect(acceptsGzip('x-gzip')).toBe(true);
  });

  it("refuses cross-site requests that would spend the owner's GitHub quota", async () => {
    const { app, gh } = diffApp({ ...commitRoute, [`/repos/alice/app/contents/a.txt?ref=${C}`]: { text: 'a' } });
    const paths = [`/api/v1/commits/alice%2Fapp/${C}/diff`, `/api/v1/blob/alice%2Fapp?ref=${C}&path=a.txt`, '/api/v1/prs/alice%2Fapp/1/diff'];
    for (const path of paths) {
      const res = await app.request(path, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'Cross-site request rejected' });
    }
    expect(gh.requests).toEqual([]);
    for (const site of ['same-origin', 'same-site', 'none', null]) {
      const headers: Record<string, string> = site ? { 'sec-fetch-site': site } : {};
      expect((await app.request(paths[0]!, { headers })).status, String(site)).toBe(200);
      expect((await app.request(paths[1]!, { headers })).status, String(site)).toBe(200);
    }
    // Cache stats read nothing from GitHub.
    expect((await app.request('/api/v1/diff-cache', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  });

  it('serves file contents as text, immutable at a full SHA', async () => {
    const { app } = diffApp({ [`/repos/alice/app/contents/src/a.ts?ref=${C}`]: { text: 'export {};\n' } });
    const res = await app.request(`/api/v1/blob/alice%2Fapp?ref=${C}&path=src/a.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('export {};\n');
  });

  it('marks file contents at a 64-character SHA immutable too, and not those at an abbreviation', async () => {
    const full = 'd'.repeat(64);
    const { app } = diffApp({
      [`/repos/alice/app/contents/src/a.ts?ref=${full}`]: { text: 'export {};\n' },
      [`/repos/alice/app/contents/src/a.ts?ref=${full.slice(0, 45)}`]: { text: 'export {};\n' },
    });
    const at = (ref: string) => app.request(`/api/v1/blob/alice%2Fapp?ref=${ref}&path=src/a.ts`);
    expect((await at(full)).headers.get('cache-control')).toContain('immutable');
    const abbreviated = await at(full.slice(0, 45));
    expect(abbreviated.status).toBe(200);
    expect(abbreviated.headers.get('cache-control')).toBeNull();
    expect((await app.request(`/api/v1/commits/app/${full}a/diff`)).status).toBe(400);
  });

  it('reports, clears and caps the cache', async () => {
    const { app, cache } = diffApp(commitRoute);
    const stats = async (init?: RequestInit) => (await (await app.request('/api/v1/diff-cache', init)).json()) as { entries: number; bytes: number; maxBytes: number };
    expect(await stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 200 * 1024 * 1024 });
    await app.request(`/api/v1/commits/app/${C}/diff`);
    expect(await stats()).toMatchObject({ entries: 1, bytes: expect.any(Number) });
    expect(await stats({ method: 'DELETE' })).toEqual({ entries: 0, bytes: 0, maxBytes: 200 * 1024 * 1024 });

    // Lowering the cap evicts right away.
    for (const k of ['a', 'b', 'c']) cache.put({ key: k, kind: 'blob', repo: 'alice/app', oid: C, fetchedAt: 1, data: Buffer.alloc(6 * 1024 * 1024) });
    const patch = await app.request('/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"diffCacheMb":10}' });
    expect(await patch.json()).toMatchObject({ diffCacheMb: 10 });
    expect(await stats()).toEqual({ entries: 1, bytes: 6 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 });
  });
});

describe('account and instance', () => {
  function accountApp(tokens = testTokens(), over: Partial<Config> = {}, deps: Partial<AppDeps> = {}, db = seedDb()) {
    const config = { ...loadConfig({}), webDir: '/nonexistent', ...over };
    const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
    const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources: new GitHubDiffSources({ tokens }), log: () => {} });
    return createApp({ db, config, sync, diffs, tokens, ...deps });
  }
  const viewer = (login: string, headers: Record<string, string> = {}): Reply => ({
    body: { data: { viewer: { id: `U_${login}`, login, name: null, avatarUrl: null, repos: { totalCount: 5 }, privateRepos: { totalCount: 2 } } } },
    headers,
  });

  it('reports the account behind the token, validating it once, and re-checks on request', async () => {
    const db = seedDb();
    const gh = fakeGitHub({ '/graphql': viewer('alice', { 'x-oauth-scopes': 'repo' }) });
    const app = accountApp(testTokens('ghp_x', { fetchImpl: gh.fetchImpl, viewer: () => getSource(db, GITHUB_SOURCE_ID)?.viewer ?? null }), {}, {}, db);
    const account = async (method = 'GET', path = '/api/v1/account') => (await app.request(path, { method })).json();
    // GET never waits for GitHub: the new token is validated in the background.
    expect(await account()).toMatchObject({ source: 'env', locked: true, kind: 'classic' });
    await vi.waitFor(async () =>
      expect(await account()).toMatchObject({
        source: 'env', locked: true, login: 'alice', dbLogin: 'Alice', mismatch: false, kind: 'classic', scopes: ['repo'],
        repos: { total: 5, private: 2 }, error: null,
      }),
    );
    await account();
    expect(gh.requests).toEqual(['/graphql']);
    gh.routes['/graphql'] = viewer('mallory');
    expect(await account('POST', '/api/v1/account/check')).toMatchObject({ login: 'mallory', dbLogin: 'Alice', mismatch: true });
    expect(gh.requests).toHaveLength(2);
    setViewer(db, { login: 'mallory', name: null, avatarUrl: null });
    expect(await account()).toMatchObject({ mismatch: false });

    const none = await (await accountApp().request('/api/v1/account')).json();
    expect(none).toMatchObject({ source: 'none', choice: null, locked: false, login: null, kind: null, error: null, checkedAt: null });
  });

  it('answers POST /sync without a token with 503 and the reason', async () => {
    const res = await accountApp(testTokens(null, { choice: 'file' })).request('/api/v1/sync', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No GitHub token: No token file is configured (GITHUB_TOKEN_FILE)' });
  });

  it('describes the instance: settings with their sources, never secrets', async () => {
    const config = loadConfig({ PORT: '4790', GH_DASH_API_KEY: 'k3y-secret', GH_DASH_ALLOWED_HOSTS: 'dash.example.com' });
    const app = accountApp(testTokens(), config);
    const res = await app.request('http://127.0.0.1:4790/api/v1/instance', { headers: { authorization: 'Bearer k3y-secret' } });
    const text = await res.text();
    expect(text).not.toContain('k3y-secret');
    expect(JSON.parse(text)).toEqual({
      version: config.version,
      desktop: false,
      apiUrl: 'http://127.0.0.1:4790',
      auth: { password: false, apiKey: true },
      configPath: null,
      settings: {
        host: { value: '127.0.0.1', source: 'default' },
        port: { value: 4790, source: 'env' },
        dbPath: { value: config.dbPath, source: 'default' },
        cacheDbPath: { value: config.cacheDbPath, source: 'default' },
        sync: { value: true, source: 'default' },
        allowedHosts: { value: ['dash.example.com'], source: 'env' },
        tokenFile: { value: null, source: 'default' },
        defaultTz: { value: config.defaultTz, source: 'default' },
      },
    });
    // Behind a reverse proxy: the public origin.
    const proxied = await app.request('http://127.0.0.1:4790/api/v1/instance', {
      headers: { authorization: 'Bearer k3y-secret', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dash.example.com' },
    });
    expect((await proxied.json()).apiUrl).toBe('https://dash.example.com');
  });

  it("gives the desktop app the Local API's address, or null while it's off", async () => {
    let local: string | null = null;
    const secret = 'a'.repeat(64);
    const app = accountApp(testTokens(), { desktop: true }, { transport: { kind: 'desktop', secret }, localApiUrl: () => local });
    const apiUrl = async () => (await (await app.request('http://gh-dash/api/v1/instance', { headers: { 'x-gh-dash-desktop': secret } })).json()).apiUrl;
    expect(await apiUrl()).toBeNull();
    local = 'http://127.0.0.1:4780';
    expect(await apiUrl()).toBe('http://127.0.0.1:4780');
  });
});
