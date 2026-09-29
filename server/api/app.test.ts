import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../config';
import { getMeta, setMeta } from '../db/meta';
import { upsertCommit, upsertRepo } from '../db/write';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { fakeGitHub, type Reply, restFile, sha } from '../test/github';
import { seedDb } from '../test/seed';
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
    expect(body).toMatchObject({ total: 2, items: [{ id: 'secret#1' }], facets: { byRepo: { app: 1, secret: 1 } } });
    const next = await app.request(`/api/v1/prs?${range}&state=merged&limit=1&cursor=${body.nextCursor}`);
    expect(((await next.json()) as { items: { id: string }[] }).items.map((p) => p.id)).toEqual(['app#1']);

    const md = await app.request(`/api/v1/prs?${range}&state=merged&who=me&format=md`);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await md.text()).toContain('- **Fix login flow** ([app#1](https://github.com/alice/x/pull/1)) — Fixes the login flow for SSO users.');
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
    expect((await read('state=open&who=me')).items.map((i) => i.id)).toEqual(['app#11']);
    // Alice closed issue 10, but Bob created it: author filtering uses Bob.
    expect((await read('state=closed&who=others&repos=app&q=10')).items.map((i) => i.id)).toEqual(['app#10']);
    expect((await read('state=closed&who=me')).total).toBe(0);
    expect((await read('repos=secret')).total).toBe(0);
    expect((await read('repos=')).total).toBe(0);
    const first = await read('state=all&limit=1');
    expect(first.total).toBe(2);
    expect(first.items.map((i) => i.id)).toEqual(['app#11']);
    const second = await read(`state=all&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.items.map((i) => i.id)).toEqual(['app#10']);
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
    const corp = upsertRepo(db, {
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

  it('serves index.html for client-side routes, dotted repository names included', async () => {
    for (const path of ['/', '/prs', '/repos/user.github.io', '/repos/foo.nvim', '/repos/x.js', '/repos/app?tab=files']) {
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
    const plain = await app.request(`/api/v1/commits/app/${C}/diff`);
    expect(plain.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(plain.headers.get('content-encoding')).toBeNull();
    const diff = await plain.json();
    expect(diff).toMatchObject({ kind: 'commit', headOid: C, files: [{ path: 'src/f1.ts' }] });
    const gz = await app.request(`/api/v1/commits/app/${C}/diff`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
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
    const paths = [`/api/v1/commits/app/${C}/diff`, `/api/v1/blob/app?ref=${C}&path=a.txt`, '/api/v1/prs/app/1/diff'];
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
    const res = await app.request(`/api/v1/blob/app?ref=${C}&path=src/a.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('export {};\n');
  });

  it('reports, clears and caps the cache', async () => {
    const { app, cache } = diffApp(commitRoute);
    const stats = async (init?: RequestInit) => (await (await app.request('/api/v1/diff-cache', init)).json()) as { entries: number; bytes: number; maxBytes: number };
    expect(await stats()).toEqual({ entries: 0, bytes: 0, maxBytes: 200 * 1024 * 1024 });
    await app.request(`/api/v1/commits/app/${C}/diff`);
    expect(await stats()).toMatchObject({ entries: 1, bytes: expect.any(Number) });
    expect(await stats({ method: 'DELETE' })).toEqual({ entries: 0, bytes: 0, maxBytes: 200 * 1024 * 1024 });

    // Lowering the cap evicts right away.
    for (const k of ['a', 'b', 'c']) cache.put({ key: k, kind: 'blob', repo: 'app', oid: C, fetchedAt: 1, data: Buffer.alloc(6 * 1024 * 1024) });
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
    const app = accountApp(testTokens('ghp_x', { fetchImpl: gh.fetchImpl, viewer: () => getMeta(db, 'viewer') }), {}, {}, db);
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
    setMeta(db, 'viewer', { login: 'mallory', name: null, avatarUrl: null });
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
