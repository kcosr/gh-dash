import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { BranchesResponse, BranchListResponse, Diff } from '../../shared/api';
import { loadConfig } from '../config';
import { DiffCache } from '../diff/cache';
import { DiffService } from '../diff/service';
import { GitHubDiffSources } from '../github/diff-source';
import { SyncManager } from '../sync/manager';
import { addBranch } from '../test/branches';
import { fakeGitHub, type Handler, type Reply, restFile, sha } from '../test/github';
import { seedDb } from '../test/seed';
import { testTokens } from '../test/tokens';
import { createApp } from './app';
import { diffRoutes } from './routes/diffs';

const A = sha('a');
const MERGE_BASE = sha('9');
const BRANCH = '/repos/alice/app/commits/heads%2Ffeature%2Fx';
const COMPARE = `/repos/alice/app/compare/heads%2Fmain...${A}?per_page=1`;

function branchApp(routes: Record<string, Handler> = {}, token: string | null = 'tok') {
  const db = seedDb();
  const config = { ...loadConfig({}), webDir: '/nonexistent' };
  const tokens = testTokens(token);
  const sync = new SyncManager({ db, schedule: false, tokens, log: () => {} });
  const gh = fakeGitHub(routes);
  const sources = new GitHubDiffSources({ tokens, fetchImpl: gh.fetchImpl, sleep: async () => {}, log: () => {} });
  const diffs = new DiffService({ db, cache: new DiffCache(':memory:'), sources, log: () => {} });
  return { app: createApp({ db, config, sync, diffs, tokens }), gh, db };
}

const feature: Record<string, Handler> = {
  [BRANCH]: { text: A },
  [COMPARE]: { body: { merge_base_commit: { sha: MERGE_BASE }, total_commits: 1, commits: [{ sha: A }], files: [restFile(1)] } },
};
const refs = (nodes: object[]): Reply => ({
  body: { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } },
});

describe('GET /branches/:repo/:branch/diff', () => {
  it('serves the diff of a branch against the default branch, its slashes URL-encoded like the repo key\'s', async () => {
    const { app, gh } = branchApp(feature);
    const res = await app.request('/api/v1/branches/alice%2Fapp/feature%2Fx/diff');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.json()) as Diff).toMatchObject({
      kind: 'branch', repo: 'alice/app', number: null, branch: 'feature/x', baseRef: 'main', title: 'feature/x', baseOid: MERGE_BASE, headOid: A,
      totalFiles: 1, url: 'https://github.com/alice/app/compare/main...feature/x', files: [{ path: 'src/f1.ts' }],
    });
    expect(gh.requests).toEqual([BRANCH, COMPARE]);

    // The repo's short name works as everywhere, and a branch without a slash needs no encoding.
    gh.routes['/repos/alice/app/commits/heads%2Ffix'] = { text: A };
    gh.routes[`/repos/alice/app/compare/heads%2Fmain...${A}?per_page=1`] = feature[COMPARE]!;
    expect((await app.request('/api/v1/branches/app/fix/diff')).status).toBe(200);
  });

  it('is gzip-encoded when the client accepts it, and asks the code host again only with refresh=1', async () => {
    const { app, gh } = branchApp(feature);
    const plain = await (await app.request('/api/v1/branches/app/feature%2Fx/diff')).json();
    const gz = await app.request('/api/v1/branches/app/feature%2Fx/diff', { headers: { 'accept-encoding': 'gzip, br' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString())).toEqual(plain);
    // The second view checked the branch's head (conditionally, though the fake has no 304s) and compared nothing.
    expect(gh.requests).toEqual([BRANCH, COMPARE, BRANCH]);
    expect((await app.request('/api/v1/branches/app/feature%2Fx/diff?refresh=1')).status).toBe(200);
    expect(gh.requests.slice(3)).toEqual([BRANCH, COMPARE]);
    expect((await app.request('/api/v1/branches/app/feature%2Fx/diff?refresh=yes')).status).toBe(400);
  });

  it('validates the branch and reports unknown things, missing tokens and rate limits', async () => {
    const { app, gh, db } = branchApp({}, null);
    const code = async (path: string) => (await app.request(path)).status;
    expect(await code('/api/v1/branches/app/a..b/diff')).toBe(400);
    expect(await code('/api/v1/branches/app/-x/diff')).toBe(400);
    expect(await code('/api/v1/branches/app/a%20b/diff')).toBe(400);
    expect(await code('/api/v1/branches/app/main/diff')).toBe(400);
    expect(await code('/api/v1/branches/nope/feature%2Fx/diff')).toBe(404);
    expect(await code('/api/v1/branches/bob%2Fapp/feature%2Fx/diff')).toBe(404);
    // A key's slash, and a branch's, must be encoded: raw, they are more path segments.
    expect(await code('/api/v1/branches/alice/app/feature%2Fx/diff')).toBe(404);
    expect(await code('/api/v1/branches/app/feature/x/diff')).toBe(404);
    const noToken = await app.request('/api/v1/branches/app/feature%2Fx/diff');
    expect(noToken.status).toBe(503);
    expect(await noToken.json()).toEqual({ error: 'No GitHub token: connect a GitHub account in Settings' });
    const main = await app.request('/api/v1/branches/app/main/diff');
    expect(await main.json()).toEqual({ error: 'main is the default branch: branches are compared against it' });

    db.run("UPDATE repos SET default_branch = NULL WHERE name = 'app'");
    expect(await code('/api/v1/branches/app/feature%2Fx/diff')).toBe(409);
    expect(gh.requests).toEqual([]);

    const gone = branchApp({ [BRANCH]: { status: 422, body: { message: 'No commit found for SHA: heads/feature/x' } } });
    const missing = await gone.app.request('/api/v1/branches/app/feature%2Fx/diff');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Branch feature/x not found on GitHub' });
    const limited = branchApp({ [BRANCH]: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } } });
    const res = await limited.app.request('/api/v1/branches/app/feature%2Fx/diff');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ details: { resetAt: '2099-01-01T00:00:00.000Z' } });
  });

  it("refuses cross-site requests that would spend the owner's quota", async () => {
    const { app, gh } = branchApp({ ...feature, '/graphql': refs([]) });
    for (const path of ['/api/v1/branches/alice%2Fapp/feature%2Fx/diff', '/api/v1/branches/alice%2Fapp']) {
      const res = await app.request(path, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'Cross-site request rejected' });
    }
    expect(gh.requests).toEqual([]);
    for (const site of ['same-origin', 'same-site', 'none', null]) {
      const headers: Record<string, string> = site ? { 'sec-fetch-site': site } : {};
      expect((await app.request('/api/v1/branches/alice%2Fapp/feature%2Fx/diff', { headers })).status, String(site)).toBe(200);
      expect((await app.request('/api/v1/branches/alice%2Fapp?refresh=1', { headers })).status, String(site)).toBe(200);
    }
  });
});

describe('GET /branches/:repo', () => {
  it('lists the branches of the code host newest first with their PRs, without the default branch', async () => {
    const { app, gh, db } = branchApp({
      '/graphql': (req) =>
        refs(
          [
            { name: 'main', target: { oid: sha('1'), committedDate: '2026-09-29T00:00:00Z' } },
            { name: 'feature', target: { oid: sha('2'), committedDate: '2026-09-20T00:00:00Z' } },
            { name: 'feature/x', target: { oid: A, committedDate: '2026-09-27T00:00:00Z' } },
          ].filter((b) => !(req.body as { variables: { query: string | null } }).variables.query || b.name.includes((req.body as { variables: { query: string } }).variables.query)),
        ),
    });
    db.run("UPDATE pull_requests SET cross_repo = 0 WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE name = 'app')");
    const res = await app.request('/api/v1/branches/alice%2Fapp');
    expect(res.status).toBe(200);
    expect((await res.json()) as BranchListResponse).toEqual({
      defaultBranch: 'main',
      more: false,
      items: [
        { name: 'feature/x', headOid: A, committedAt: '2026-09-27T00:00:00Z', pr: null },
        { name: 'feature', headOid: sha('2'), committedAt: '2026-09-20T00:00:00Z', pr: { number: 2, state: 'open', title: 'Add parser' } },
      ],
    });
    // Kept for a minute; q narrows (its own list); refresh asks again.
    await app.request('/api/v1/branches/app');
    expect(gh.requests).toEqual(['/graphql']);
    expect(((await (await app.request('/api/v1/branches/app?q=x')).json()) as BranchListResponse).items.map((b) => b.name)).toEqual(['feature/x']);
    await app.request('/api/v1/branches/app?refresh=1');
    expect(gh.requests).toEqual(['/graphql', '/graphql', '/graphql']);
    expect(((await (await app.request('/api/v1/branches/app?q=')).json()) as BranchListResponse).items).toHaveLength(2);
    expect(gh.requests).toHaveLength(3);
  });

  it('validates the query and reports unknown things and failures', async () => {
    const { app, db } = branchApp({ '/graphql': refs([]) });
    expect((await app.request('/api/v1/branches/app?refresh=yes')).status).toBe(400);
    expect((await app.request(`/api/v1/branches/app?q=${'x'.repeat(256)}`)).status).toBe(400);
    expect((await app.request('/api/v1/branches/nope')).status).toBe(404);
    expect((await app.request('/api/v1/branches/alice/app')).status).toBe(404);
    db.run("UPDATE repos SET default_branch = NULL WHERE name = 'app'");
    const res = await app.request('/api/v1/branches/app');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The default branch isn't known yet: sync the repository" });
    expect((await branchApp({}, null).app.request('/api/v1/branches/app')).status).toBe(503);
  });
});

describe('GET /branches', () => {
  it('lists the branches with no PR yet from the database, paged, without asking the code host', async () => {
    const { app, gh, db } = branchApp({ '/graphql': refs([]) });
    addBranch(db, 'alice/app', 'main', { head: sha('1'), at: '2026-09-27T00:00:00Z' });
    addBranch(db, 'alice/app', 'fix/login', { head: A, at: '2026-09-26T00:00:00Z' });
    addBranch(db, 'alice/app', 'docs', { head: sha('b'), at: '2026-09-25T00:00:00Z', by: { login: 'bob', name: 'Bob' } });
    // From app#2, open: reviewed there.
    addBranch(db, 'alice/app', 'feature', { head: sha('2'), at: '2026-09-25T00:00:00Z' });
    const get = async (query: string) => {
      const res = await app.request(`/api/v1/branches?${query}`);
      expect(res.status, query).toBe(200);
      return (await res.json()) as BranchesResponse;
    };
    const first = await get('from=2026-09-01&to=2026-09-30&limit=1');
    expect(first).toMatchObject({ total: 2, items: [{ id: 'alice/app~fix/login', url: 'https://github.com/alice/app/compare/main...fix/login', comments: { threads: 0, unresolved: 0 } }] });
    const rest = await get(`from=2026-09-01&to=2026-09-30&limit=1&cursor=${first.nextCursor}`);
    expect(rest).toMatchObject({ total: 2, nextCursor: null, items: [{ id: 'alice/app~docs', author: { login: 'bob', isMe: false } }] });
    expect((await get('from=2026-09-01&to=2026-09-30&who=me&q=LOG')).items.map((b) => b.id)).toEqual(['alice/app~fix/login']);
    expect((await get('from=2026-09-01&to=2026-09-30&format=json')).total).toBe(2);
    // Not the owner's quota: a cross-site read is a list like the others.
    expect((await app.request('/api/v1/branches', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    expect(gh.requests).toEqual([]);
    // Next to it, one repo's branches are still the code host's (the sync hasn't listed them).
    expect((await app.request('/api/v1/branches/alice%2Fapp')).status).toBe(200);
    expect(gh.requests).toEqual(['/graphql']);
  });

  it('has no Markdown or CSV form, and validates the scope and the cursor', async () => {
    const { app } = branchApp();
    for (const format of ['md', 'csv']) {
      const res = await app.request(`/api/v1/branches?format=${format}`);
      expect(res.status, format).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'format: only json: branches have no Markdown or CSV export' });
    }
    expect((await app.request('/api/v1/branches?cursor=nope')).status).toBe(400);
    expect((await app.request('/api/v1/branches?limit=0')).status).toBe(400);
    expect((await app.request('/api/v1/branches?from=2026-09-30&to=2026-09-01')).status).toBe(400);
    expect((await app.request('/api/v1/branches?source=nowhere.example')).status).toBe(400);
  });
});

describe('the branch routes', () => {
  it("decode the repo and the branch alike, whatever characters the branch has, and leave the threads' route (mounted next to them) alone", async () => {
    const seen: string[] = [];
    const diffs = {
      branchDiff: async (repo: string, branch: string) => (seen.push(`diff ${repo} ${branch}`), { gz: new Uint8Array(), text: '{}' }),
      branchList: async (repo: string) => (seen.push(`list ${repo}`), { items: [], defaultBranch: 'main', more: false }),
    };
    const threads = new Hono().get('/branches/:repo/:branch/threads', (c) => (seen.push(`threads ${c.req.param('repo')} ${c.req.param('branch')}`), c.text('')));
    const app = new Hono().route('/api/v1', diffRoutes({ diffs } as never)).route('/api/v1', threads);
    for (const path of [
      '/api/v1/branches/alice%2Fapp/feature%2Fx/threads',
      '/api/v1/branches/alice%2Fapp/feature%2Fx/diff',
      '/api/v1/branches/alice%2Fapp',
      '/api/v1/branches/gitlab.example.com%2Fteam%2Fapp/a%23b%40c%2Fd%25e/diff',
    ]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
    expect(seen).toEqual(['threads alice/app feature/x', 'diff alice/app feature/x', 'list alice/app', 'diff gitlab.example.com/team/app a#b@c/d%e']);
  });
});

describe('the OpenAPI document', () => {
  it('describes both routes and the branch fields of a diff', async () => {
    const { app } = branchApp();
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, { get: { parameters: { name: string; in: string; required?: boolean }[]; responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[]; enum?: string[] }> };
    };
    const list = doc.paths['/api/v1/branches/{repo}']!.get;
    expect(list.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(['path:repo', 'query:q', 'query:refresh']);
    const diff = doc.paths['/api/v1/branches/{repo}/{branch}/diff']!.get;
    expect(diff.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(['path:repo', 'path:branch', 'query:refresh']);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['BranchSummary', 'BranchListResponse']));
    expect(Object.keys(doc.components.schemas.Diff!.properties)).toEqual(expect.arrayContaining(['branch', 'baseRef']));
    expect(doc.components.schemas.Diff!.required).not.toContain('branch');
    expect(doc.components.schemas.Diff!.properties.kind).toMatchObject({ enum: ['pr', 'commit', 'branch'] });
    expect(Object.keys(doc.components.schemas.BranchSummary!.properties)).toEqual(['name', 'headOid', 'committedAt', 'pr']);
  });

  it('describes GET /branches: the scope and a page, JSON only', async () => {
    const { app } = branchApp();
    type Op = { parameters: { name: string; in: string }[]; responses: Record<string, { content: Record<string, { schema: { properties: { items: unknown } } }> }> };
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, { get: Op }>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const list = doc.paths['/api/v1/branches']!.get;
    expect(list.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
      'query:repos', 'query:source', 'query:visibility', 'query:ownership', 'query:who', 'query:from', 'query:to', 'query:tz', 'query:q', 'query:limit', 'query:cursor',
    ]);
    expect(Object.keys(list.responses['200']!.content)).toEqual(['application/json']);
    expect(list.responses['200']!.content['application/json']!.schema.properties.items).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Branch' } });
    expect(Object.keys(doc.components.schemas.Branch!.properties)).toEqual(['id', 'repo', 'name', 'headOid', 'committedAt', 'author', 'url', 'comments']);
  });
});
