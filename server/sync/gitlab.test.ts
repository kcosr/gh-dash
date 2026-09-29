// The neutral sync over a GitLab source, end to end on the fake instance (test/gitlab-instance.ts): alice's own
// projects keyed by host, projects added by hand, single-project runs, the commits merge requests landed, stars told by
// the count moving, and a rejected token. sync.test.ts is the same engine over GitHub.

import { describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db';
import { DEFAULT_SETTINGS } from '../db/settings';
import { ensureSource, GITHUB_SOURCE_ID, getSource } from '../db/sources';
import { notFound } from '../gitlab/access';
import { GitLabSyncSource } from '../gitlab/sync-source';
import { reasonOf } from '../provider/access';
import { BASE, type Handler, page, type Reply } from '../test/gitlab';
import { fakeInstance } from '../test/gitlab-instance';
import ownedFixture from '../test/fixtures/gitlab/owned-projects.json';
import { addManualRepo } from '../test/seed';
import { runSync, type SyncRequest } from './sync';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;
const HOST = 'gitlab.example.com';
const gid = (id: number) => `gid://gitlab/Project/${id}`;
const sha = (c: string) => c.repeat(40).slice(0, 40);

/**
 * The fake instance, with empty lists for the projects other than alice/app that the sync reads over REST. Its GraphQL
 * fixtures are single pages that say more follow: here any later page is empty and the last. `owned` edits the owned
 * projects GitLab lists.
 */
function instance(over: Record<string, Handler> = {}) {
  const owned = structuredClone(ownedFixture);
  const fake = fakeInstance({
    '/api/v4/projects/12/issues': page([], null),
    '/api/v4/projects/12/starrers': page([], null, { 'x-total': '0' }),
    '/api/v4/projects/40/issues': page([], null),
    '/api/v4/projects/40/repository/commits': page([], null),
    ...over,
  });
  const answer = fake.routes['/api/graphql'] as Extract<Handler, (...args: never[]) => Reply>;
  fake.routes['/api/graphql'] = (req) => {
    const { query, variables } = req.body as { query: string; variables?: { after?: string | null } };
    if (/query OwnedProjects\b/.test(query)) return { body: { data: owned } };
    const reply = answer(req);
    if (!variables?.after) return reply;
    const body = structuredClone(reply.body) as { data?: { project?: Record<string, unknown> | null } };
    for (const conn of Object.values(body.data?.project ?? {})) {
      if (conn && typeof conn === 'object' && 'pageInfo' in conn) Object.assign(conn, { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
    }
    return { ...reply, body };
  };
  return { ...fake, owned };
}

function setup(over: Record<string, Handler> = {}) {
  const db = openDb(':memory:');
  const gl = ensureSource(db, { kind: 'gitlab', host: HOST, baseUrl: BASE });
  const fake = instance(over);
  const sync = (req: SyncRequest = {}, at = NOW, concurrency?: number) => {
    const source = new GitLabSyncSource({ baseUrl: BASE, token: 'glpat-test-token', fetchImpl: fake.fetchImpl, sleep: async () => {} });
    return runSync({ db, source, src: getSource(db, gl.id)!, settings: DEFAULT_SETTINGS, now: () => at, concurrency }, req);
  };
  return { db, gl, fake, sync, take: () => fake.requests.splice(0) };
}

const keys = (db: Db, sourceId: number) => db.all<{ key: string }>('SELECT key FROM repos WHERE source_id = ? AND removed_at IS NULL ORDER BY key', [sourceId]).map((r) => r.key);
const repoRow = (db: Db, key: string) =>
  db.get<{ id: number; description: string | null; unavailable_reason: string | null; synced_at: string | null }>(
    'SELECT r.id, r.description, r.unavailable_reason, s.synced_at FROM repos r LEFT JOIN sync_state s ON s.repo_id = r.id WHERE r.key = ?',
    [key],
  );

describe('a GitLab source', () => {
  it("syncs the viewer's own projects under the host's keys, and links commits to the merge requests that landed them", async () => {
    const { db, gl, sync, take } = setup();
    expect(await sync()).toEqual({ repos: 2, newItems: expect.any(Number), errors: [], forksSkipped: 0 });
    expect(keys(db, gl.id)).toEqual([`${HOST}/alice/app`, `${HOST}/alice/corp.tools`]);
    expect(getSource(db, gl.id)!.viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    expect(getSource(db, GITHUB_SOURCE_ID)!.viewer).toBeNull();
    const requests = take();
    expect(requests.filter((r) => r.startsWith('graphql ') && !/MergeRequests|Releases/.test(r))).toEqual(['graphql OwnedProjects', 'graphql Probes']);

    // MR 5 was merged with the merge commit 3333…; 4444… was pushed directly.
    const app = repoRow(db, `${HOST}/alice/app`)!.id;
    expect(db.all('SELECT substr(oid, 1, 4) AS oid, pr_number FROM commits WHERE repo_id = ? ORDER BY oid', [app])).toEqual([
      { oid: '3333', pr_number: 5 },
      { oid: '4444', pr_number: null },
    ]);
    expect(db.get('SELECT merge_commit_oid, squash_commit_oid FROM pull_requests WHERE repo_id = ? AND number = 5', [app])).toEqual({
      merge_commit_oid: sha('3'),
      squash_commit_oid: null,
    });
    expect(db.get('SELECT stars_count FROM sync_state WHERE repo_id = ?', [app])).toEqual({ stars_count: 2 });

    // Nothing moved: the list and the probes, nothing else. !2 is locked (being merged): it is open, and GitLab's probe
    // counts it with the opened ones, so the open counts agree without listing and rechecking the open ones every sync.
    expect(db.all(`SELECT number FROM pull_requests WHERE repo_id = ? AND state = 'open' ORDER BY number`, [app])).toEqual([{ number: 2 }, { number: 7 }]);
    expect(await sync({}, NOW + HOUR)).toMatchObject({ newItems: 0, errors: [] });
    expect(take()).toEqual(['graphql OwnedProjects', 'graphql Probes']);
  });

  it("asks for stars when the project's star count moved, as its probe can't tell", async () => {
    const { db, fake, sync, take } = setup();
    await sync();
    take();
    fake.owned.projects.nodes[0]!.starCount = 3;
    expect(await sync({}, NOW + HOUR)).toMatchObject({ errors: [] });
    expect(take()).toEqual(['graphql OwnedProjects', 'graphql Probes', '/api/v4/projects/11/starrers?per_page=100&page=1']);
    expect(db.get(`SELECT stars_count FROM sync_state s JOIN repos r ON r.id = s.repo_id WHERE r.key = '${HOST}/alice/app'`)).toEqual({ stars_count: 3 });
    // Asked once per move.
    await sync({}, NOW + 2 * HOUR);
    expect(take()).toEqual(['graphql OwnedProjects', 'graphql Probes']);
  });

  it('refreshes the projects added by hand by global id, and sets aside one GitLab no longer shows', async () => {
    const { db, gl, sync, take } = setup();
    addManualRepo(db, 'team/platform/api', { source: gl, nodeId: gid(40), description: 'before' });
    addManualRepo(db, 'bob/gone', { source: gl, nodeId: gid(99) });
    expect(await sync()).toMatchObject({ repos: 3, errors: [] });
    expect(take().filter((r) => /ManualProjects/.test(r))).toEqual(['graphql ManualProjects']);
    expect(repoRow(db, `${HOST}/team/platform/api`)).toMatchObject({ description: 'Platform API', unavailable_reason: null, synced_at: '2026-09-27T12:00:00Z' });
    expect(repoRow(db, `${HOST}/bob/gone`)).toMatchObject({ unavailable_reason: reasonOf(notFound('bob/gone')), synced_at: null });
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM stars s JOIN repos r ON r.id = s.repo_id WHERE r.tracked_by = 'manual'`)!.n).toBe(0);
  });

  it('syncs one project by its global id, and refuses what is not one of its tracked projects', async () => {
    const { db, gl, sync, take } = setup();
    await sync();
    addManualRepo(db, 'bob/gone', { source: gl, nodeId: gid(99) });
    addManualRepo(db, 'bob/tool');
    take();

    expect(await sync({ repo: `${HOST}/ALICE/app` }, NOW + HOUR)).toMatchObject({ repos: 1, errors: [] });
    expect(take()[0]).toBe('graphql ProjectByNode');
    expect(await sync({ repo: `${HOST}/bob/gone` }, NOW + HOUR)).toEqual({
      repos: 0, newItems: 0, errors: [`${HOST}/bob/gone: unavailable: ${reasonOf(notFound('bob/gone'))}`], forksSkipped: 0,
    });
    take();
    // A GitHub repo isn't this source's, short names are github.com's, and GitLab keys name tracked projects only:
    // none of them asks GitLab anything.
    await expect(sync({ repo: 'bob/tool' })).rejects.toThrow("bob/tool isn't on GitLab (gitlab.example.com)");
    await expect(sync({ repo: 'app' })).rejects.toThrow("Repository isn't tracked: app");
    await expect(sync({ repo: `${HOST}/alice/new` })).rejects.toThrow(`Repository isn't tracked: ${HOST}/alice/new`);
    expect(take()).toEqual([]);
  });

  it('stops at a rejected token, like GitHub', async () => {
    const { db, sync } = setup({ '/api/v4/projects/11/issues': { status: 401, body: { message: '401 Unauthorized' } } });
    const res = await sync({}, NOW, 1);
    expect(res.errors).toEqual([expect.stringMatching(/^Sync stopped: GitLab rejected the token \(401\)/)]);
    // alice/app failed, and alice/corp.tools never started.
    expect(repoRow(db, `${HOST}/alice/corp.tools`)!.synced_at).toBeNull();
  });
});
