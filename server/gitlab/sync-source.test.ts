import { describe, expect, it } from 'vitest';
import type { RepoRecord } from '../db/records';
import commitsFixture from '../test/fixtures/gitlab/commits.json';
import issuesFixture from '../test/fixtures/gitlab/issues.json';
import mergeRequestsFixture from '../test/fixtures/gitlab/merge-requests.json';
import ownedFixture from '../test/fixtures/gitlab/owned-projects.json';
import probesFixture from '../test/fixtures/gitlab/probes.json';
import projectFixture from '../test/fixtures/gitlab/project.json';
import releasesFixture from '../test/fixtures/gitlab/releases.json';
import starrersFixture from '../test/fixtures/gitlab/starrers.json';
import viewerFixture from '../test/fixtures/gitlab/viewer.json';
import { BASE, fakeGitLab, graphql, page, sha, type Handler } from '../test/gitlab';
import { mapProject } from './map';
import { GitLabSyncSource } from './sync-source';
import type { GitLabError } from './transport';
import type { OwnedProjectsData } from './types';

const clone = <T>(x: T): T => structuredClone(x);
const APP: RepoRecord = mapProject((ownedFixture as unknown as OwnedProjectsData).projects.nodes[0]!, BASE);

function setup(routes: Record<string, Handler>) {
  const fake = fakeGitLab(routes);
  const source = new GitLabSyncSource({ baseUrl: BASE, token: 'glpat-test-token', fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const vars = (op: string) =>
    fake.calls.filter((c) => c.url.pathname.endsWith('/api/graphql') && (c.body as { query: string }).query.includes(`query ${op}(`)).map((c) => (c.body as { variables: Record<string, unknown> }).variables);
  return { ...fake, source, vars };
}

const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as GitLabError);

describe('GitLabSyncSource: account and projects', () => {
  it('reads the viewer, and treats a missing current user as a token problem', async () => {
    const { source } = setup({ '/api/graphql': graphql({ Viewer: () => viewerFixture }) });
    expect(await source.viewer()).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    const anonymous = setup({ '/api/graphql': graphql({ Viewer: () => ({ currentUser: null }) }) });
    expect(await fail(anonymous.source.viewer())).toMatchObject({ kind: 'auth' });
    const revoked = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(revoked.source.viewer())).toMatchObject({ kind: 'auth', status: 401, message: expect.stringContaining('Invalid token') });
    expect(source.kind).toBe('gitlab');
    expect(source.rateLimit).toBeNull();
  });

  it('lists the projects of the personal namespace, following GraphQL cursors', async () => {
    const first = clone(ownedFixture);
    first.projects.pageInfo = { hasNextPage: true, endCursor: 'cursor-1' };
    first.projects.nodes = first.projects.nodes.slice(0, 1);
    const second = clone(ownedFixture);
    second.projects.nodes = second.projects.nodes.slice(1);
    const { source, vars, calls } = setup({ '/api/graphql': graphql({ OwnedProjects: (v) => (v.after ? second : first) }) });
    expect((await source.ownedRepos()).map((r) => r.nameWithOwner)).toEqual(['alice/app', 'alice/corp.tools']);
    expect(vars('OwnedProjects')).toEqual([{ after: null, first: 50 }, { after: 'cursor-1', first: 50 }]);
    expect((calls[0]!.body as { query: string }).query).toContain('projects(personal: true');
  });

  it('reads one project by its full path, with its probe; null when GitLab has none', async () => {
    const { source, vars } = setup({
      '/api/graphql': graphql({ Project: (v) => (v.path === 'team/platform/api' ? projectFixture : { project: null }) }),
    });
    const found = await source.repo('team/platform/api');
    expect(found?.record).toMatchObject({ nodeId: 'gid://gitlab/Project/40', owner: 'team/platform', name: 'api' });
    expect(found?.probe).toEqual({
      openPrs: 3, openIssues: 7, latestPrUpdatedAt: '2026-09-27T09:20:00Z', latestIssueUpdatedAt: '2026-09-26T16:00:00Z',
      releaseTags: ['v2.1.0', 'v2.0.0'], latestStarredAt: null,
    });
    expect(await source.repo('team/platform/gone')).toBeNull();
    expect(vars('Project')).toEqual([{ path: 'team/platform/api' }, { path: 'team/platform/gone' }]);
  });

  it('probes projects by global id in chunks; a chunk that fails leaves its projects out', async () => {
    const repos = Array.from({ length: 30 }, (_, i) => ({ ...APP, nodeId: `gid://gitlab/Project/${i + 1}` }));
    const { source, vars } = setup({
      '/api/graphql': (req) => {
        const { ids } = (req.body as { variables: { ids: string[] } }).variables;
        if (ids.length === 5) return { body: { errors: [{ message: 'Internal server error' }] } };
        return { body: { data: { projects: { nodes: ids.map((id) => ({ ...clone(probesFixture.projects.nodes[1]!), id })) } } } };
      },
    });
    const probes = await source.probes(repos);
    expect(vars('Probes').map((v) => [(v.ids as string[]).length, v.first])).toEqual([[25, 25], [5, 5]]);
    expect(probes.size).toBe(25);
    expect(probes.get('gid://gitlab/Project/1')).toEqual({ openPrs: 0, openIssues: 0, latestPrUpdatedAt: null, latestIssueUpdatedAt: null, releaseTags: [], latestStarredAt: null });
    expect(probes.has('gid://gitlab/Project/26')).toBe(false);
  });

  it('stops probing on a token problem', async () => {
    const { source } = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(source.probes([APP]))).toMatchObject({ kind: 'auth' });
  });
});

describe('GitLabSyncSource: rounds', () => {
  const mrPage = (v: Record<string, unknown>) => {
    const data = clone(mergeRequestsFixture);
    if (v.after) data.project.mergeRequests.pageInfo = { hasNextPage: false, endCursor: null as unknown as string };
    return data;
  };

  it('fetches every requested section in one round, and only those', async () => {
    const { source, requests } = setup({
      '/api/graphql': graphql({ MergeRequests: mrPage, Releases: () => releasesFixture }),
      '/api/v4/projects/11/issues': page(issuesFixture, null),
      '/api/v4/projects/11/repository/commits': page(commitsFixture, null),
      '/api/v4/projects/11/starrers': page(starrersFixture, null, { 'x-total': '2' }),
    });
    const all = await source.round(APP, {
      commits: { after: null, since: '2025-09-29T00:00:00Z' }, prs: { after: null }, issues: { after: null }, openPrs: { after: null },
      openIssues: { after: null }, releases: { after: null }, stars: { after: null },
    });
    expect(Object.keys(all).sort()).toEqual(['commits', 'issues', 'openIssues', 'openPrs', 'prs', 'releases', 'stars']);
    expect(requests).toHaveLength(7);
    requests.length = 0;
    expect(Object.keys(await source.round(APP, { releases: { after: null } }))).toEqual(['releases']);
    expect(requests).toEqual(['graphql Releases']);
  });

  it('pages merge requests by update time (all) or creation time (open), 25 at a time', async () => {
    const { source, vars } = setup({ '/api/graphql': graphql({ MergeRequests: mrPage }) });
    const prs = (await source.round(APP, { prs: { after: null } })).prs!;
    expect(prs.items.map((p) => [p.number, p.state])).toEqual([[7, 'open'], [5, 'merged'], [4, 'closed'], [2, 'open']]);
    expect([prs.hasMore, prs.endCursor]).toEqual([true, 'eyJ1cGRhdGVkX2F0IjoiMjAyNi0wOS0xOSJ9']);
    const next = (await source.round(APP, { prs: { after: prs.endCursor } })).prs!;
    expect([next.hasMore, next.endCursor]).toEqual([false, null]);
    await source.round(APP, { openPrs: { after: null } });
    expect(vars('MergeRequests')).toEqual([
      { path: 'alice/app', after: null, first: 25, state: 'all', sort: 'UPDATED_DESC' },
      { path: 'alice/app', after: 'eyJ1cGRhdGVkX2F0IjoiMjAyNi0wOS0xOSJ9', first: 25, state: 'all', sort: 'UPDATED_DESC' },
      { path: 'alice/app', after: null, first: 25, state: 'opened', sort: 'CREATED_DESC' },
    ]);
  });

  it('reads an empty page when merge requests are turned off, and fails for a project that is gone', async () => {
    const off = setup({ '/api/graphql': graphql({ MergeRequests: () => ({ project: { mergeRequests: null } }) }) });
    expect((await off.source.round(APP, { openPrs: { after: null } })).openPrs).toEqual({ items: [], hasMore: false, endCursor: null });
    const gone = setup({ '/api/graphql': graphql({ MergeRequests: () => ({ project: null }) }) });
    expect(await fail(gone.source.round(APP, { prs: { after: null } }))).toMatchObject({ kind: 'not-found', message: expect.stringContaining('alice/app') });
  });

  it('pages issues over REST by update time (all) or creation time (open), with page numbers as cursors', async () => {
    const { source, requests } = setup({
      '/api/v4/projects/11/issues': (req) => (req.url.searchParams.get('page') === '1' ? page(issuesFixture, 2) : page([], null)),
    });
    const issues = (await source.round(APP, { issues: { after: null } })).issues!;
    expect(issues.items.map((i) => [i.number, i.state, i.closedBy?.login ?? null])).toEqual([[9, 'open', null], [3, 'closed', 'alice']]);
    expect([issues.hasMore, issues.endCursor]).toEqual([true, '2']);
    // GitLab can offer a next page that turns out empty: that ends the section.
    expect((await source.round(APP, { issues: { after: '2' } })).issues).toEqual({ items: [], hasMore: false, endCursor: null });
    await source.round(APP, { openIssues: { after: null } });
    expect(requests).toEqual([
      '/api/v4/projects/11/issues?issue_type=issue&with_labels_details=true&state=all&order_by=updated_at&sort=desc&per_page=50&page=1',
      '/api/v4/projects/11/issues?issue_type=issue&with_labels_details=true&state=all&order_by=updated_at&sort=desc&per_page=50&page=2',
      '/api/v4/projects/11/issues?issue_type=issue&with_labels_details=true&state=opened&order_by=created_at&sort=desc&per_page=50&page=1',
    ]);
  });

  it('walks default-branch commits newest first, later pages pinned to the head the first page saw', async () => {
    const head = commitsFixture[0]!.id;
    const { source, requests } = setup({
      '/api/v4/projects/11/repository/commits': (req) => {
        const n = req.url.searchParams.get('page');
        return n === '1' ? page(commitsFixture, 2) : n === '2' ? page([{ ...commitsFixture[1]!, id: sha('9') }], 3) : page([], null);
      },
    });
    const since = '2025-09-29T00:00:00Z';
    const first = (await source.round(APP, { commits: { after: null, since } })).commits!;
    expect(first.items.map((c) => c.oid)).toEqual([head, commitsFixture[1]!.id]);
    expect([first.hasMore, first.endCursor]).toEqual([true, `2:${head}`]);
    const second = (await source.round(APP, { commits: { after: first.endCursor, since } })).commits!;
    expect([second.items.length, second.endCursor]).toEqual([1, `3:${head}`]);
    const last = (await source.round(APP, { commits: { after: second.endCursor, since } })).commits!;
    expect(last).toEqual({ items: [], hasMore: false, endCursor: null });
    const q = `since=${encodeURIComponent(since)}&with_stats=true&per_page=100`;
    expect(requests).toEqual([
      `/api/v4/projects/11/repository/commits?ref_name=main&${q}&page=1`,
      `/api/v4/projects/11/repository/commits?ref_name=${head}&${q}&page=2`,
      `/api/v4/projects/11/repository/commits?ref_name=${head}&${q}&page=3`,
    ]);
  });

  it('has no commits for a repository without a default branch', async () => {
    const { source, requests } = setup({});
    expect((await source.round({ ...APP, defaultBranch: null }, { commits: { after: null, since: '2025-09-29T00:00:00Z' } })).commits).toEqual({
      items: [], hasMore: false, endCursor: null,
    });
    expect(requests).toEqual([]);
  });

  it('pages releases newest first, leaving upcoming ones out but counting them for the backfill window', async () => {
    const { source, vars } = setup({ '/api/graphql': graphql({ Releases: () => releasesFixture }) });
    const releases = (await source.round(APP, { releases: { after: 'r1' } })).releases!;
    expect(releases.items.map((r) => r.tag)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(releases).toMatchObject({ hasMore: true, endCursor: 'eyJyZWxlYXNlZF9hdCI6IjIwMjUifQ', oldestCreatedAt: '2026-09-20T09:00:00Z' });
    expect(vars('Releases')).toEqual([{ path: 'alice/app', after: 'r1', first: 20 }]);
    const empty = setup({ '/api/graphql': graphql({ Releases: () => ({ project: { releases: null } }) }) });
    expect((await empty.source.round(APP, { releases: { after: null } })).releases).toEqual({ items: [], hasMore: false, endCursor: null, oldestCreatedAt: null });
  });

  it('lists every starrer in one round, most recent first, with GitLab count of the list', async () => {
    const older = { starred_since: '2026-01-01T00:00:00.000Z', user: { username: 'erin', name: 'Erin', avatar_url: null } };
    const { source, requests } = setup({
      '/api/v4/projects/11/starrers': (req) =>
        req.url.searchParams.get('page') === '1' ? page([older, starrersFixture[0]], 2, { 'x-total': '3' }) : page([starrersFixture[1]], null, { 'x-total': '3' }),
    });
    const stars = (await source.round(APP, { stars: { after: null } })).stars!;
    expect(stars.items.map((s) => [s.login, s.starredAt])).toEqual([
      ['dave', '2026-09-25T06:00:00Z'],
      ['carol', '2026-09-20T00:00:00Z'],
      ['erin', '2026-01-01T00:00:00Z'],
    ]);
    expect(stars).toMatchObject({ hasMore: false, endCursor: null, totalCount: 3 });
    expect(requests).toEqual(['/api/v4/projects/11/starrers?per_page=100&page=1', '/api/v4/projects/11/starrers?per_page=100&page=2']);
  });

  it('uses the URL-encoded full path for REST when the node id is not a project id', async () => {
    const { source, requests } = setup({ '/api/v4/projects/alice%2Fcorp%2Etools/starrers': page([], null, { 'x-total': '0' }) });
    expect((await source.round({ ...APP, nodeId: 'R_x', nameWithOwner: 'alice/corp.tools' }, { stars: { after: null } })).stars!.totalCount).toBe(0);
    expect(requests).toEqual(['/api/v4/projects/alice%2Fcorp%2Etools/starrers?per_page=100&page=1']);
  });
});

describe('GitLabSyncSource: recheck', () => {
  it('re-reads merge requests and issues by number, null for the ones that are gone', async () => {
    const { source, vars, requests } = setup({
      '/api/graphql': graphql({
        RecheckMergeRequests: (v) => {
          const data = clone(mergeRequestsFixture);
          data.project.mergeRequests.nodes = data.project.mergeRequests.nodes.filter((n) => (v.iids as string[]).includes(n.iid));
          return data;
        },
      }),
      '/api/v4/projects/11/issues': (req) => page(issuesFixture.filter((i) => req.url.searchParams.getAll('iids[]').includes(String(i.iid))), null),
    });
    const prNumbers = [5, 6, ...Array.from({ length: 25 }, (_, i) => 100 + i)];
    const result = await source.recheck(APP, prNumbers, [3, 8]);
    expect(result.prs.size).toBe(27);
    expect(result.prs.get(5)).toMatchObject({ number: 5, state: 'merged' });
    expect(result.prs.get(6)).toBeNull();
    expect(result.prs.get(124)).toBeNull();
    expect([...result.issues]).toEqual([[3, expect.objectContaining({ number: 3, state: 'closed' })], [8, null]]);
    expect(vars('RecheckMergeRequests').map((v) => [(v.iids as string[]).length, v.first, (v.iids as string[])[0]])).toEqual([[25, 25, '5'], [2, 2, '123']]);
    expect(requests.at(-1)).toBe('/api/v4/projects/11/issues?issue_type=issue&with_labels_details=true&state=all&iids%5B%5D=3&iids%5B%5D=8&per_page=2');
  });

  it('fails rather than report everything gone when the project itself is', async () => {
    const { source } = setup({ '/api/graphql': graphql({ RecheckMergeRequests: () => ({ project: null }) }) });
    expect(await fail(source.recheck(APP, [5], []))).toMatchObject({ kind: 'not-found' });
  });
});
