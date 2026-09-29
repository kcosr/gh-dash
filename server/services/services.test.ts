// The services are plain functions: these call them without a Hono app (the HTTP behaviour, byte for byte, is
// api/app.test.ts's). Errors are HttpError, which any transport reports by status and message.

import { describe, expect, it, vi } from 'vitest';
import { activityQuerySchema, issueQuerySchema, listQuerySchema, prQuerySchema, statsQuerySchema } from '../api/scope';
import { loadConfig } from '../config';
import { getRepo } from '../db/repos';
import { HttpError, parseWith } from '../lib/errors';
import { SyncManager } from '../sync/manager';
import { removeTrackedRepo } from '../sync/tracking';
import { addManualRepo, GITLAB_HOST, seedDb, seedGitLab } from '../test/seed';
import { testTokens } from '../test/tokens';
import { parsePrNumber, prDetail, queryActivity, queryCommits, queryIssues, queryPrs, queryReleases, queryStars, queryStats, scopedQuery } from './lists';
import { patchRepo, queryRepos, repoDetail } from './repos';

const config = loadConfig({});
const range = { from: '2026-09-01', to: '2026-09-27', tz: 'UTC' };

/** What a service throws: an HttpError, by status and message. */
async function failure(fn: () => unknown): Promise<{ status: number; message: string }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    return { status: e.status, message: e.message };
  }
  throw new Error('expected an HttpError');
}

describe('lists', () => {
  const db = seedDb();
  const deps = { db, config };

  it('answers a page as JSON with an opaque cursor, or the whole selection as text', () => {
    const q = parseWith(prQuerySchema, { ...range, state: 'merged', limit: 1 });
    const first = queryPrs(deps, q);
    expect(first).toMatchObject({ format: 'json', body: { total: 2, items: [{ id: 'alice/secret#1' }] } });
    const cursor = first.format === 'json' ? first.body.nextCursor : null;
    expect(cursor).toEqual(expect.any(String));
    const next = queryPrs(deps, { ...q, cursor: cursor! });
    expect(next).toMatchObject({ format: 'json', body: { items: [{ id: 'alice/app#1' }], nextCursor: null } });

    const md = queryPrs(deps, parseWith(prQuerySchema, { ...range, state: 'merged', format: 'md' }));
    expect(md).toMatchObject({ format: 'md', text: expect.stringContaining('Fix login flow') });
    expect(queryPrs(deps, parseWith(prQuerySchema, { ...range, format: 'csv' }))).toMatchObject({ format: 'csv', text: expect.stringContaining('alice/app') });
  });

  it('answers every list, and the stats, from a plain object', () => {
    const list = parseWith(listQuerySchema, range);
    expect(queryCommits(deps, list)).toMatchObject({ format: 'json', body: { items: expect.any(Array) } });
    expect(queryIssues(deps, parseWith(issueQuerySchema, { ...range, state: 'open' }))).toMatchObject({ body: { items: [{ id: 'alice/app#11' }] } });
    expect(queryReleases(deps, list)).toMatchObject({ body: { items: [{ tag: 'v1.0.0' }] } });
    expect(queryStars(deps, list)).toMatchObject({ body: { total: expect.any(Number) } });
    expect(queryActivity(deps, parseWith(activityQuerySchema, { ...range, types: 'release' }))).toMatchObject({ body: { items: [{ type: 'release' }] } });
    expect(queryStats(deps, parseWith(statsQuerySchema, range)).range).toMatchObject({ tz: 'UTC', bucket: 'day' });
    expect(queryIssues(deps, parseWith(issueQuerySchema, { ...range, format: 'md' }))).toMatchObject({ format: 'md' });
  });

  it('bundles the scope and the per-request facts, and refuses a bad range', () => {
    const { scope, ctx } = scopedQuery(db, config, { ...range, who: 'me', repos: 'alice/app' });
    expect(scope).toMatchObject({ repos: ['alice/app'], who: 'me', tz: 'UTC' });
    expect(ctx.viewers.get(1)).toBe('alice');
    return Promise.all([
      failure(() => scopedQuery(db, config, { tz: 'Nowhere/Land' })).then((e) => expect(e).toEqual({ status: 400, message: 'Invalid tz: Nowhere/Land' })),
      failure(() => scopedQuery(db, config, { from: '2026-09-27', to: '2026-09-01' })).then((e) => expect(e.status).toBe(400)),
      failure(() => queryPrs(deps, { cursor: 'nope' })).then((e) => expect(e).toEqual({ status: 400, message: 'Invalid cursor' })),
    ]);
  });

  it('reads one pull request; 400 for a bad number, 404 for an unknown one', async () => {
    expect(prDetail(deps, 'alice/app', '1')).toMatchObject({ id: 'alice/app#1', title: 'Fix login flow', commits: [{ oid: 'p1' }] });
    expect(prDetail(deps, 'app', 1).id).toBe('alice/app#1');
    expect(await failure(() => prDetail(deps, 'alice/app', 'x'))).toEqual({ status: 400, message: 'Invalid PR number' });
    expect(await failure(() => prDetail(deps, 'alice/app', '999'))).toEqual({ status: 404, message: 'Pull request not found' });
    expect(await failure(() => prDetail(deps, 'nobody/nothing', '1'))).toEqual({ status: 404, message: 'Pull request not found' });
    expect([parsePrNumber('7'), parsePrNumber(8)]).toEqual([7, 8]);
    expect(await failure(() => parsePrNumber('0'))).toMatchObject({ status: 400 });
    expect(await failure(() => parsePrNumber('1.5'))).toMatchObject({ status: 400 });
  });

  it('is scoped per source through the same keys', () => {
    const both = seedDb();
    seedGitLab(both);
    const ids = (queryPrs({ db: both, config }, parseWith(prQuerySchema, { ...range, repos: `${GITLAB_HOST}/platform/app` })) as { body: { items: { id: string }[] } }).body.items.map((p) => p.id);
    expect(ids.sort()).toEqual([`${GITLAB_HOST}/platform/app#1`, `${GITLAB_HOST}/platform/app#2`, `${GITLAB_HOST}/platform/app#3`]);
    const md = queryPrs({ db: both, config }, parseWith(prQuerySchema, { ...range, repos: `${GITLAB_HOST}/platform/app`, format: 'md' }));
    expect(md).toMatchObject({ format: 'md', text: expect.stringContaining('!1') });
  });
});

describe('repos', () => {
  it('lists, reads and pins repos', async () => {
    const db = seedDb();
    const deps = { db, config };
    expect(queryRepos(deps, { scope: 'default' }).map((r) => r.name).sort()).toEqual(['app', 'secret']);
    expect(queryRepos(deps, {}).map((r) => r.key).sort()).toEqual(['alice/app', 'alice/fork', 'alice/hidden', 'alice/old', 'alice/secret']);
    expect(repoDetail(deps, 'alice/app')).toMatchObject({ key: 'alice/app', source: 'github.com', pinned: false });
    expect(patchRepo(deps, 'app', { pinned: true })).toMatchObject({ key: 'alice/app', pinned: true });
    expect(await failure(() => repoDetail(deps, 'alice/nope'))).toEqual({ status: 404, message: 'Repository not found' });
    expect(await failure(() => patchRepo(deps, 'alice/nope', { pinned: true }))).toEqual({ status: 404, message: 'Repository not found' });
  });
});

describe('removeTrackedRepo', () => {
  function setup() {
    const db = seedDb();
    const { src } = seedGitLab(db);
    addManualRepo(db, 'bob/tool');
    const glId = addManualRepo(db, 'team/platform/api', { source: src });
    const diffs = { evict: vi.fn() };
    return { db, diffs, glId };
  }

  it('removes a repo added by hand, its data, and evicts its cached diffs', () => {
    const { db, diffs } = setup();
    removeTrackedRepo({ db, diffs }, 'bob/tool');
    expect(getRepo(db, 'bob/tool', 'UTC')).toBeNull();
    expect(diffs.evict).toHaveBeenCalledTimes(1);
  });

  it('takes a path on the named source, on a source this server does not configure too', () => {
    const { db, diffs } = setup();
    removeTrackedRepo({ db, diffs }, 'team/platform/api', 'GitLab.Example.com');
    expect(getRepo(db, `${GITLAB_HOST}/team/platform/api`, 'UTC')).toBeNull();
    expect(diffs.evict).toHaveBeenCalledTimes(1);
  });

  it('refuses what it should, and changes nothing', async () => {
    const { db, diffs } = setup();
    expect(await failure(() => removeTrackedRepo({ db, diffs }, 'alice/app'))).toEqual({ status: 409, message: 'Repositories you own are tracked automatically; hide it instead.' });
    expect(await failure(() => removeTrackedRepo({ db, diffs }, 'nobody/nothing'))).toEqual({ status: 404, message: 'Repository not found' });
    expect(await failure(() => removeTrackedRepo({ db, diffs }, 'bob/tool', 'elsewhere.example'))).toEqual({ status: 400, message: "elsewhere.example isn't a source here." });
    // A path on another source's host isn't found there.
    expect(await failure(() => removeTrackedRepo({ db, diffs }, 'bob/tool', GITLAB_HOST))).toMatchObject({ status: 404 });
    expect(getRepo(db, 'bob/tool', 'UTC')).not.toBeNull();
    expect(diffs.evict).not.toHaveBeenCalled();
  });
});

describe('SyncManager.request', () => {
  function manager(token: string | null = null) {
    const db = seedDb();
    return { db, sync: new SyncManager({ db, schedule: false, tokens: testTokens(token), log: () => {} }) };
  }

  it('refuses without a token, naming why', async () => {
    const { sync } = manager();
    const e = await failure(() => sync.request({}));
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/^No GitHub token: /);
  });

  it('checks what the request names before it starts anything', async () => {
    const { sync, db } = manager('ghp_x');
    expect(await failure(() => sync.request({ source: 'nowhere.example.com' }))).toEqual({ status: 404, message: "nowhere.example.com isn't a source here." });
    expect(await failure(() => sync.request({ repo: 'someone/else' }))).toEqual({ status: 404, message: "someone/else isn't tracked. Add it first (POST /api/v1/repos)." });
    // A source this database has but this server does not sync.
    seedGitLab(db);
    expect(await failure(() => sync.request({ source: GITLAB_HOST }))).toEqual({ status: 404, message: `${GITLAB_HOST} isn't a source here.` });
    expect(await failure(() => sync.request({ repo: `${GITLAB_HOST}/platform/app` }))).toEqual({ status: 400, message: `GitLab (${GITLAB_HOST}) isn't configured on this server.` });
    expect(sync.status().running).toBe(false);
  });
});
