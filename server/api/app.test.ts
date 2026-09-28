import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../config';
import { upsertCommit } from '../db/write';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { SyncManager } from '../sync/manager';
import { fakeGitHub, type Reply, restFile, sha } from '../test/github';
import { seedDb } from '../test/seed';
import { createApp } from './app';

function makeApp(over: Partial<Config> = {}, db = seedDb()) {
  const config = { ...loadConfig({}), webDir: '/nonexistent', ...over };
  const sync = new SyncManager({ db, schedule: false, resolveToken: () => ({ token: null, source: 'none' }), log: () => {} });
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), resolveToken: () => ({ token: null, source: 'none' }), log: () => {} });
  return createApp({ db, config, sync, diffs });
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
    const sync = new SyncManager({ db, schedule: false, resolveToken: () => ({ token: null, source: 'none' }), log: () => {} });
    const gh = fakeGitHub(routes);
    const cache = new DiffCache(':memory:');
    const diffs = new DiffService({ db, cache, resolveToken: () => ({ token, source: token ? 'env' : 'none' }), fetchImpl: gh.fetchImpl, sleep: async () => {}, log: () => {} });
    return { app: createApp({ db, config, sync, diffs }), gh, cache };
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
    expect(await noToken.json()).toEqual({ error: 'No GitHub token: set GITHUB_TOKEN or run `gh auth login`' });

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

  it('serves file contents as text, immutable at a full SHA', async () => {
    const { app } = diffApp({ [`/repos/alice/app/contents/src/a.ts?ref=${C}`]: { text: 'export {};\n' } });
    const res = await app.request(`/api/v1/blob/app?ref=${C}&path=src/a.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
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
    for (const k of ['a', 'b', 'c']) cache.put({ key: k, kind: 'blob', repo: 'app', oid: C, data: Buffer.alloc(6 * 1024 * 1024) });
    const patch = await app.request('/api/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"diffCacheMb":10}' });
    expect(await patch.json()).toMatchObject({ diffCacheMb: 10 });
    expect(await stats()).toEqual({ entries: 1, bytes: 6 * 1024 * 1024, maxBytes: 10 * 1024 * 1024 });
  });
});
