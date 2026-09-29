import { describe, expect, it } from 'vitest';
import type { RepoRecord } from '../db/records';
import { accessLost } from '../provider/access';
import type { RoundResult } from '../provider/types';
import commitsFixture from '../test/fixtures/gitlab/commits.json';
import issuesFixture from '../test/fixtures/gitlab/issues.json';
import lookupFixture from '../test/fixtures/gitlab/lookup.json';
import memberProjectsFixture from '../test/fixtures/gitlab/member-projects.json';
import mergeRequestsFixture from '../test/fixtures/gitlab/merge-requests.json';
import ownedFixture from '../test/fixtures/gitlab/owned-projects.json';
import probesFixture from '../test/fixtures/gitlab/probes.json';
import projectFixture from '../test/fixtures/gitlab/project.json';
import releasesFixture from '../test/fixtures/gitlab/releases.json';
import starrersFixture from '../test/fixtures/gitlab/starrers.json';
import viewerAccountFixture from '../test/fixtures/gitlab/viewer-account.json';
import viewerFixture from '../test/fixtures/gitlab/viewer.json';
import { fakeInstance } from '../test/gitlab-instance';
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

/**
 * A project's starrers as GitLab pages them: oldest first, 100 a page, u1 … u<count>, one a minute unless `minute`
 * says otherwise. Without `counted` there is no X-Total, as beyond 10,000. `unstar(i)` takes u<i> out, shifting the
 * pages after it.
 */
function fakeStarrers(count: number, opts: { counted?: boolean; minute?: (i: number) => number } = {}) {
  const at = (i: number) => new Date(Date.UTC(2020, 0, 1) + (opts.minute?.(i) ?? i) * 60_000).toISOString();
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const handler: Handler = (req) => {
    const p = Number(req.url.searchParams.get('page'));
    const body = ids.slice((p - 1) * 100, p * 100).map((i) => ({ starred_since: at(i), user: { username: `u${i}`, name: null, avatar_url: null } }));
    return page(body, p < Math.ceil(ids.length / 100) ? p + 1 : null, opts.counted === false ? {} : { 'x-total': String(ids.length) });
  };
  const unstar = (i: number) => ids.splice(ids.indexOf(i), 1);
  /** Logins from `from` down to `to`. */
  const logins = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `u${from - i}`);
  return { handler, unstar, logins };
}

const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as GitLabError);

describe('GitLabSyncSource: account and projects', () => {
  it('reads the viewer with its addresses, and treats a missing current user as a token problem', async () => {
    const { source, requests } = setup({ '/api/graphql': graphql({ ViewerAccount: () => viewerAccountFixture }) });
    expect(await source.viewer()).toEqual({
      id: 'gid://gitlab/User/2', login: 'alice', name: 'Alice A', avatarUrl: 'https://gitlab.example.com/gitlab/uploads/-/system/user/avatar/2/avatar.png',
      emails: ['alice@example.com', '2-alice@users.noreply.gitlab.example.com', 'alice@corp.example.com'],
    });
    expect(requests).toEqual(['graphql ViewerAccount']);
    const anonymous = setup({ '/api/graphql': graphql({ ViewerAccount: () => ({ currentUser: null }) }) });
    expect(await fail(anonymous.source.viewer())).toMatchObject({ kind: 'auth' });
    const revoked = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(revoked.source.viewer())).toMatchObject({ kind: 'auth', status: 401, message: expect.stringContaining('Invalid token') });
    expect(source.kind).toBe('gitlab');
    expect(source.rateLimit).toBeNull();
  });

  it('reads the viewer without addresses when GitLab refuses the query for them', async () => {
    // The addresses are best effort: "me" on commits then comes from the configured ones.
    const { source, requests } = setup({
      '/api/graphql': (req) =>
        (req.body as { query: string }).query.includes('query ViewerAccount')
          ? { body: { errors: [{ message: 'Field emails is not accessible', path: ['currentUser', 'emails'] }] } }
          : { body: { data: viewerFixture } },
    });
    expect(await source.viewer()).toMatchObject({ login: 'alice', emails: [] });
    expect(requests).toEqual(['graphql ViewerAccount', 'graphql Viewer']);
    // A token that is refused is not a missing field: no second try.
    const revoked = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(revoked.source.viewer())).toMatchObject({ kind: 'auth' });
    expect(revoked.requests).toEqual(['graphql ViewerAccount']);
  });

  it('lists the projects of the personal namespace, following GraphQL cursors, with the viewer they were read for', async () => {
    const first = clone(ownedFixture);
    first.projects.pageInfo = { hasNextPage: true, endCursor: 'cursor-1' };
    first.projects.nodes = first.projects.nodes.slice(0, 1);
    const second = clone(ownedFixture);
    second.projects.nodes = second.projects.nodes.slice(1);
    const { source, vars, calls, requests } = setup({ '/api/graphql': graphql({ OwnedProjects: (v) => (v.after ? second : first) }) });
    const { viewer, repos } = await source.ownedRepos();
    expect(repos.map((r) => r.nameWithOwner)).toEqual(['alice/app', 'alice/corp.tools']);
    expect(viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    expect(vars('OwnedProjects')).toEqual([{ after: null, first: 50 }, { after: 'cursor-1', first: 50 }]);
    expect((calls[0]!.body as { query: string }).query).toContain('projects(personal: true');
    // The viewer rides along with each page: no request of its own.
    expect(requests).toEqual(['graphql OwnedProjects', 'graphql OwnedProjects']);
    expect(repos.map((r) => r.visibility)).toEqual(['public', 'internal']);
  });

  it('fails a list whose account changes between pages, and one read as nobody', async () => {
    const first = clone(ownedFixture);
    first.projects.pageInfo = { hasNextPage: true, endCursor: 'cursor-1' };
    const second = clone(ownedFixture);
    second.currentUser = { ...second.currentUser, id: 'gid://gitlab/User/3', username: 'bob' };
    const { source } = setup({ '/api/graphql': graphql({ OwnedProjects: (v) => (v.after ? second : first) }) });
    expect(await fail(source.ownedRepos())).toMatchObject({ kind: 'auth', message: expect.stringContaining('account changed') });
    const anonymous = setup({ '/api/graphql': graphql({ OwnedProjects: () => ({ currentUser: null, projects: clone(ownedFixture).projects }) }) });
    expect(await fail(anonymous.source.ownedRepos())).toMatchObject({ kind: 'auth' });
  });

  it('reads one project by its full path, with its probe and the viewer; null when GitLab has none', async () => {
    const { source, vars, requests } = setup({
      '/api/graphql': graphql({
        Project: (v) => (v.path === 'team/platform/api' ? projectFixture : { currentUser: viewerFixture.currentUser, project: null }),
      }),
    });
    const { viewer, found } = await source.repo('team/platform/api');
    expect(viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    expect(found?.record).toMatchObject({ nodeId: 'gid://gitlab/Project/40', owner: 'team/platform', name: 'api' });
    expect(found?.probe).toEqual({
      openPrs: 3, openIssues: 7, latestPrUpdatedAt: '2026-09-27T09:20:00Z', latestIssueUpdatedAt: '2026-09-26T16:00:00Z',
      releaseTags: ['v2.1.0', 'v2.0.0'], latestStarredAt: null,
    });
    const missing = await source.repo('team/platform/gone');
    expect([missing.found, missing.viewer.login]).toEqual([null, 'alice']);
    expect(vars('Project')).toEqual([{ path: 'team/platform/api' }, { path: 'team/platform/gone' }]);
    // The viewer rides along: one request each.
    expect(requests).toEqual(['graphql Project', 'graphql Project']);
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
    const { probes, errors } = await source.probes(repos);
    expect(vars('Probes').map((v) => [(v.ids as string[]).length, v.first])).toEqual([[25, 25], [5, 5]]);
    expect(probes.size).toBe(25);
    expect(probes.get('gid://gitlab/Project/1')).toEqual({ openPrs: 0, openIssues: 0, latestPrUpdatedAt: null, latestIssueUpdatedAt: null, releaseTags: [], latestStarredAt: null });
    expect(probes.has('gid://gitlab/Project/26')).toBe(false);
    // Why they're missing, for the sync's error list; each call starts afresh.
    expect(errors).toEqual(['projects 26-30 of 30: Internal server error']);
    expect((await source.probes(repos.slice(0, 25))).errors).toEqual([]);
  });

  it('stops probing on a token problem', async () => {
    const { source } = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(source.probes([APP]))).toMatchObject({ kind: 'auth' });
  });
});

describe('GitLabSyncSource: repos added by hand', () => {
  const API = { nodeId: 'gid://gitlab/Project/40', path: 'team/platform/api' };
  const nodeIds = (v: Record<string, unknown>) => v.ids as string[];
  const projectNode = (id: string) => ({ ...clone(projectFixture.project), id });

  it('reads tracked projects by global id, 25 to a request, and reports the ones GitLab does not list as not found', async () => {
    const tracked = Array.from({ length: 30 }, (_, i) => ({ nodeId: `gid://gitlab/Project/${100 + i}`, path: `team/p${i}` }));
    const gone = new Set([tracked[3]!.nodeId, tracked[27]!.nodeId]);
    const { source, vars, requests } = setup({
      '/api/graphql': graphql({ ManualProjects: (v) => ({ projects: { nodes: nodeIds(v).filter((id) => !gone.has(id)).map(projectNode) } }) }),
    });
    const { reads, errors } = await source.refresh(tracked);
    expect(errors).toEqual([]);
    expect(vars('ManualProjects').map((v) => [nodeIds(v).length, v.first])).toEqual([[25, 25], [5, 5]]);
    expect(requests).toEqual(['graphql ManualProjects', 'graphql ManualProjects']);
    expect([...reads.keys()]).toEqual(tracked.map((t) => t.nodeId));
    const ok = reads.get(tracked[0]!.nodeId)!;
    expect(ok).toMatchObject({ ok: true, denied: [], problem: null, record: { nodeId: tracked[0]!.nodeId, nameWithOwner: 'team/platform/api' } });
    expect(ok.ok && ok.probe).toMatchObject({ openPrs: 3, releaseTags: ['v2.1.0', 'v2.0.0'] });
    // The stored path names it, since GitLab shows nothing of it.
    expect(reads.get(tracked[3]!.nodeId)).toEqual({
      ok: false,
      access: {
        problem: 'not-found',
        message: "GitLab doesn't show team/p3 to this token: it doesn't exist, or you aren't a member.",
        hint: 'Private projects need membership (Reporter or higher). Check the path, or ask a maintainer.',
      },
    });
    expect(reads.get(tracked[27]!.nodeId)).toMatchObject({ ok: false, access: { problem: 'not-found' } });
  });

  it('asks nothing for nothing, and leaves out the projects of a request that fails, saying why', async () => {
    const tracked = Array.from({ length: 30 }, (_, i) => ({ nodeId: `gid://gitlab/Project/${100 + i}`, path: `team/p${i}` }));
    const { source, requests } = setup({
      '/api/graphql': (req) => {
        const ids = nodeIds((req.body as { variables: Record<string, unknown> }).variables);
        return ids.length === 5 ? { body: { errors: [{ message: 'Internal server error' }] } } : { body: { data: { projects: { nodes: ids.map(projectNode) } } } };
      },
    });
    expect(await source.refresh([])).toEqual({ reads: new Map(), errors: [] });
    expect(requests).toEqual([]);
    const { reads, errors } = await source.refresh(tracked);
    expect(errors).toEqual(['projects 26-30 of 30: Internal server error']);
    expect(reads.size).toBe(25);
    expect(reads.has(tracked[27]!.nodeId)).toBe(false);
  });

  it('stops reading on a token problem', async () => {
    const { source } = setup({ '/api/graphql': { status: 401, body: { errors: [{ message: 'Invalid token' }] } } });
    expect(await fail(source.refresh([API]))).toMatchObject({ kind: 'auth' });
    expect(await fail(source.repoByNode(API))).toMatchObject({ kind: 'auth' });
  });

  it('reads one tracked project by global id with the viewer in the same request; not found when GitLab lists none', async () => {
    const { source, vars, requests } = setup({
      '/api/graphql': graphql({
        ProjectByNode: (v) => ({ currentUser: viewerFixture.currentUser, projects: { nodes: nodeIds(v).filter((id) => id === API.nodeId).map(projectNode) } }),
      }),
    });
    const hit = await source.repoByNode(API);
    expect(hit.viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    expect(hit.read).toMatchObject({ ok: true, record: { nodeId: API.nodeId, nameWithOwner: 'team/platform/api' }, denied: [], problem: null });
    const miss = await source.repoByNode({ nodeId: 'gid://gitlab/Project/99', path: 'bob/gone' });
    expect(miss.viewer.login).toBe('alice');
    expect(miss.read).toMatchObject({ ok: false, access: { problem: 'not-found', message: expect.stringContaining('bob/gone') } });
    expect(vars('ProjectByNode')).toEqual([{ ids: [API.nodeId], first: 1 }, { ids: ['gid://gitlab/Project/99'], first: 1 }]);
    expect(requests).toEqual(['graphql ProjectByNode', 'graphql ProjectByNode']);
    const anonymous = setup({ '/api/graphql': graphql({ ProjectByNode: () => ({ currentUser: null, projects: { nodes: [] } }) }) });
    expect(await fail(anonymous.source.repoByNode(API))).toMatchObject({ kind: 'auth' });
  });
});

describe('GitLabSyncSource: the Add dialog', () => {
  const SINCE = '2025-09-29T00:00:00Z';
  const lookupRoute = (project: unknown) => ({ '/api/graphql': graphql({ ProjectLookup: () => ({ currentUser: viewerFixture.currentUser, project }) }) });

  it('lists the projects the token is a member of, newest activity first, without the ones in its personal namespace', async () => {
    const { source, requests } = setup({
      '/api/graphql': graphql({ Viewer: () => viewerFixture }),
      '/api/v4/projects': page(memberProjectsFixture, null, { 'x-total': String(memberProjectsFixture.length) }),
    });
    const c = await source.candidates();
    expect(c.viewer).toMatchObject({ id: 'gid://gitlab/User/2', login: 'alice' });
    // alice/app and alice/corp.tools are hers, and tracked automatically; bob/tool is in another user's namespace.
    expect(c.items.map((r) => r.nameWithOwner)).toEqual(['platform/team/svc', 'team/platform/api', 'bob/tool', 'team/docs', 'platform/api']);
    expect(c.items[2]).toMatchObject({ nodeId: 'gid://gitlab/Project/23', owner: 'bob', visibility: 'internal', isFork: true });
    expect(c.suggested).toEqual(c.items);
    expect(c.truncated).toBe(false);
    expect(requests).toContain('/api/v4/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100&page=1');
    expect(requests).toHaveLength(2);
  });

  it('suggests the eight most recently active, and stops at 1000 projects (10 pages), saying there are more', async () => {
    const listed = Array.from({ length: 1200 }, (_, i) => ({ ...clone(memberProjectsFixture[0]!), id: 1000 + i, path: `p${i}`, path_with_namespace: `team/p${i}` }));
    const { source, requests } = setup({
      '/api/graphql': graphql({ Viewer: () => viewerFixture }),
      '/api/v4/projects': (req) => {
        const n = Number(req.url.searchParams.get('page'));
        return page(listed.slice((n - 1) * 100, n * 100), n * 100 < listed.length ? n + 1 : null, { 'x-total': String(listed.length) });
      },
    });
    const c = await source.candidates();
    expect(c.items).toHaveLength(1000);
    expect(c.suggested.map((r) => r.name)).toEqual(Array.from({ length: 8 }, (_, i) => `p${i}`));
    expect(c.truncated).toBe(true);
    expect(requests.filter((r) => r.startsWith('/api/v4/projects'))).toHaveLength(10);

    // Exactly a thousand is not truncated.
    const exact = setup({
      '/api/graphql': graphql({ Viewer: () => viewerFixture }),
      '/api/v4/projects': (req) => {
        const n = Number(req.url.searchParams.get('page'));
        return page(listed.slice((n - 1) * 100, Math.min(n * 100, 1000)), n < 10 ? n + 1 : null, { 'x-total': '1000' });
      },
    });
    expect((await exact.source.candidates()).truncated).toBe(false);
  });

  it('looks a project up in one request: record, probe, owned or not, and the size of its first sync', async () => {
    const { source, vars, requests } = setup(lookupRoute(lookupFixture.project));
    const hit = await source.lookup('team/platform/api', SINCE);
    if (!hit.ok) throw new Error(hit.access.message);
    expect(hit.viewer.login).toBe('alice');
    expect(hit.record).toMatchObject({ nodeId: 'gid://gitlab/Project/40', nameWithOwner: 'team/platform/api', owner: 'team/platform' });
    expect(hit.probe).toMatchObject({ openPrs: 3, openIssues: 7, releaseTags: ['v2.1.0', 'v2.0.0'] });
    // Commits since the backfill start can't be counted cheaply: size unknown.
    expect(hit.counts).toEqual({ commits: null, prs: 12, issues: 30, releases: 4, openPrs: 3, openIssues: 7 });
    expect(hit.owned).toBe(false);
    expect(vars('ProjectLookup')).toEqual([{ path: 'team/platform/api', since: SINCE }]);
    expect(requests).toEqual(['graphql ProjectLookup']);
  });

  it('counts a project in the personal namespace as owned, whatever the case of the username', async () => {
    const own = { ...clone(lookupFixture.project), fullPath: 'Alice/app', path: 'app', namespace: { fullPath: 'Alice' } };
    const { source } = setup(lookupRoute(own));
    const hit = await source.lookup('Alice/app', SINCE);
    expect(hit.ok && hit.owned).toBe(true);
    // Another user's personal namespace, and a group that only looks similar, are not hers.
    for (const namespace of ['alice-team', 'bob']) {
      const other = setup(lookupRoute({ ...own, fullPath: `${namespace}/app`, namespace: { fullPath: namespace } }));
      const l = await other.source.lookup(`${namespace}/app`, SINCE);
      expect(l.ok && l.owned).toBe(false);
    }
  });

  it('explains a project GitLab does not show: it may not exist, or the token is not a member', async () => {
    const { source } = setup(lookupRoute(null));
    const miss = await source.lookup('bob/gone', SINCE);
    expect(miss).toMatchObject({ ok: false, viewer: { login: 'alice' }, path: 'bob/gone', access: { problem: 'not-found', message: expect.stringContaining('bob/gone') } });
  });

  it('refuses a project whose code the token cannot read, naming the provider spelling', async () => {
    const seen = (patch: Record<string, unknown>) => setup(lookupRoute({ ...clone(lookupFixture.project), ...patch }));
    const noCode = await seen({ userPermissions: { downloadCode: false, readMergeRequest: true } }).source.lookup('team/Platform/api', SINCE);
    expect(noCode).toMatchObject({ ok: false, viewer: { login: 'alice' }, path: 'team/platform/api', access: { problem: 'permission', message: 'The token can see team/platform/api but not its code.' } });
    // Code, and merge requests too: still the code that is refused.
    const nothing = await seen({ userPermissions: { downloadCode: false, readMergeRequest: false } }).source.lookup('team/platform/api', SINCE);
    expect(nothing).toMatchObject({ ok: false, access: { problem: 'permission', message: 'The token can see team/platform/api but not its code.' } });
  });

  it('accepts a project with merge requests or issues turned off (or hidden), and reports them unavailable with nothing to count', async () => {
    const seen = (patch: Record<string, unknown>) => setup(lookupRoute({ ...clone(lookupFixture.project), ...patch })).source.lookup('team/platform/api', SINCE);
    const all = await seen({});
    expect(all.ok && all.unavailable).toEqual([]);
    // GitLab lists no connection for a feature that is off.
    const noIssues = await seen({ issuesEnabled: false, recentIssues: null });
    expect(noIssues).toMatchObject({ ok: true, unavailable: ['issues'], counts: { commits: null, prs: 12, issues: 0, releases: 4, openPrs: 3, openIssues: 7 } });
    const noMrs = await seen({ userPermissions: { downloadCode: true, readMergeRequest: false }, recentMergeRequests: null });
    expect(noMrs).toMatchObject({ ok: true, unavailable: ['prs'], counts: { prs: 0, issues: 30 } });
    const neither = await seen({ userPermissions: { downloadCode: true, readMergeRequest: false }, issuesEnabled: false, recentMergeRequests: null, recentIssues: null });
    expect(neither).toMatchObject({ ok: true, unavailable: ['prs', 'issues'], counts: { prs: 0, issues: 0 } });
    // Counts GitLab did not give for a feature that is on are unknown, not zero.
    const unknown = await seen({ recentMergeRequests: null, recentIssues: null, releaseCount: null });
    expect(unknown.ok && unknown.counts).toEqual({ commits: null, prs: null, issues: null, releases: 0, openPrs: 3, openIssues: 7 });
    expect(unknown.ok && unknown.unavailable).toEqual([]);
  });

  it('cannot tell what a first sync costs, as it cannot count the commits', () => {
    const { source } = setup({});
    expect(source.requestsFor({ commits: null, prs: 12, issues: 30, releases: 4, openPrs: 3, openIssues: 7 })).toBeNull();
    expect(source.requestsFor({ commits: 500, prs: 12, issues: 30, releases: 4, openPrs: 3, openIssues: 7 })).toBeNull();
  });

  it('answers all of it from the fake instance', async () => {
    const fake = fakeInstance();
    const source = new GitLabSyncSource({ baseUrl: BASE, token: 'glpat-test-token', fetchImpl: fake.fetchImpl, sleep: async () => {} });
    // The archived project is not listed, alice's own are left out.
    expect((await source.candidates()).items.map((r) => [r.nameWithOwner, r.visibility])).toEqual([
      ['platform/team/svc', 'internal'], ['team/platform/api', 'private'], ['bob/tool', 'internal'], ['team/docs', 'public'], ['platform/api', 'private'],
    ]);
    const own = await source.lookup('alice/app', SINCE);
    expect(own).toMatchObject({ ok: true, owned: true, unavailable: [] });
    // alice's own project with issues turned off is still hers to track.
    const noIssues = await source.lookup('alice/corp.tools', SINCE);
    expect(noIssues).toMatchObject({ ok: true, owned: true, unavailable: ['issues'], counts: { issues: 0, prs: 12 } });
    // A guest of the group's private project reads no code.
    expect(await source.lookup('platform/team/svc', SINCE)).toMatchObject({ ok: false, path: 'platform/team/svc', access: { problem: 'permission' } });
    expect(await source.lookup('team/platform/api', SINCE)).toMatchObject({ ok: true, owned: false, unavailable: [] });
    expect(await source.lookup('bob/gone', SINCE)).toMatchObject({ ok: false, access: { problem: 'not-found' } });
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
    const err = await fail(gone.source.round(APP, { prs: { after: null } }));
    expect(err).toMatchObject({ kind: 'not-found', message: expect.stringContaining('alice/app') });
    // Why, in GitLab's words: the sync marks a repo added by hand unavailable with it.
    expect(accessLost(err)).toMatchObject({ problem: 'not-found', message: expect.stringContaining('alice/app') });
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

  it('orders stars within the same second by their full time, then newest listed first', async () => {
    const star = (login: string, at: string) => ({ starred_since: at, user: { username: login, name: null, avatar_url: null } });
    const { source } = setup({
      '/api/v4/projects/11/starrers': page(
        [star('known', '2026-09-20T10:00:00.100Z'), star('new', '2026-09-20T10:00:00.900Z'), star('tie-a', '2026-09-20T09:00:00.500Z'), star('tie-b', '2026-09-20T09:00:00.500Z')],
        null,
        { 'x-total': '4' },
      ),
    });
    // Whole seconds would tie "new" with "known" and keep GitLab's oldest-first order: the sync would stop at "known".
    expect((await source.round(APP, { stars: { after: null } })).stars!.items.map((s) => s.login)).toEqual(['new', 'known', 'tie-b', 'tie-a']);
  });

  it('lists the starrers again when their count moved mid-listing (a shifted page could skip one), once', async () => {
    const star = (login: string, day: number) => ({ starred_since: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`, user: { username: login, name: null, avatar_url: null } });
    // a, b, c, d (two a page here). Between the pages of the first listing b unstars, c moves up to page 1, and the
    // listing misses it: the sync would delete c's star.
    let listing = 0;
    const { source, requests } = setup({
      '/api/v4/projects/11/starrers': (req) => {
        const p = req.url.searchParams.get('page');
        if (p === '1') listing++;
        if (listing === 1) return p === '1' ? page([star('a', 1), star('b', 2)], 2, { 'x-total': '4' }) : page([star('d', 4)], null, { 'x-total': '3' });
        return p === '1' ? page([star('a', 1), star('c', 3)], 2, { 'x-total': '3' }) : page([star('d', 4)], null, { 'x-total': '3' });
      },
    });
    const stars = (await source.round(APP, { stars: { after: null } })).stars!;
    expect(stars.items.map((s) => s.login)).toEqual(['d', 'c', 'a']);
    expect(stars.totalCount).toBe(3);
    expect(requests).toHaveLength(4);

    const restless = setup({
      '/api/v4/projects/11/starrers': (req) =>
        req.url.searchParams.get('page') === '1' ? page([star('a', 1), star('b', 2)], 2, { 'x-total': '3' }) : page([star('d', 4)], null, { 'x-total': '2' }),
    });
    expect(await fail(restless.source.round(APP, { stars: { after: null } }))).toMatchObject({ kind: 'transient', message: expect.stringContaining('changing') });
    expect(restless.requests).toHaveLength(4);
  });

  it('reads the newest starrers first when there are too many to list at once, continuing backwards', async () => {
    const stargazers = fakeStarrers(3050);
    const { source, requests } = setup({ '/api/v4/projects/11/starrers': stargazers.handler });
    const repo = { ...APP, stars: 3050 };
    const first = (await source.round(repo, { stars: { after: null } })).stars!;
    expect(first.items.map((s) => s.login)).toEqual(stargazers.logins(3050, 3001));
    // The cursor: the next page, and the oldest star handed out so far (its time in ms, and who).
    expect(first).toMatchObject({ hasMore: true, endCursor: `30:${Date.parse(first.items.at(-1)!.starredAt)}:u3001`, totalCount: 3050 });
    const next = (await source.round(repo, { stars: { after: first.endCursor } })).stars!;
    expect(next.items.map((s) => s.login)).toEqual(stargazers.logins(3000, 2901));
    expect(next).toMatchObject({ hasMore: true, endCursor: expect.stringMatching(/^29:\d+:u2901$/), totalCount: 3050 });
    const oldest = (await source.round(repo, { stars: { after: '1' } })).stars!;
    expect(oldest).toMatchObject({ hasMore: false, endCursor: null });
    expect(oldest.items.at(-1)!.login).toBe('u1');
    expect(requests).toEqual([1, 31, 30, 1].map((p) => `/api/v4/projects/11/starrers?per_page=100&page=${p}`));
  });

  /**
   * The sync's incremental stars pass over `source`: rounds until a page has a star it knows (stored before, or added
   * by an earlier round), running `between` after each round. Returns the stars it added.
   */
  async function incrementalStars(source: GitLabSyncSource, repo: RepoRecord, known: Set<string>, between: (round: number) => void) {
    const added: string[] = [];
    let after: string | null = null;
    for (let round = 1; round <= 5; round++) {
      const stars: NonNullable<RoundResult['stars']> = (await source.round(repo, { stars: { after } })).stars!;
      const stop = stars.items.findIndex((s) => known.has(s.login));
      for (const s of stop === -1 ? stars.items : stars.items.slice(0, stop)) {
        known.add(s.login);
        added.push(s.login);
      }
      between(round);
      if (stop !== -1 || !stars.hasMore) break;
      after = stars.endCursor;
    }
    return added;
  }

  it('never repeats a star in a later page when an older star goes mid-walk (the sync would stop at it)', async () => {
    // Stored: u1 … u3000. New since: u3001 … u3200. u1 unstars after the first round: every page shifts back by one,
    // and page 31 would start with u3101 again.
    const stargazers = fakeStarrers(3200);
    const { source } = setup({ '/api/v4/projects/11/starrers': stargazers.handler });
    const added = await incrementalStars(source, { ...APP, stars: 3200 }, new Set(stargazers.logins(3000, 1)), (round) => {
      if (round === 1) stargazers.unstar(1);
    });
    expect(added).toEqual(stargazers.logins(3200, 3001));
  });

  it('leaves out every star already handed out at the boundary time, not just one', async () => {
    // As above, but u3101, u3102 and u3103 starred in the same instant, and two stars go (u1, u2): page 31 then starts
    // with u3102 and u3103 again.
    const stargazers = fakeStarrers(3200, { minute: (i) => (i === 3102 || i === 3103 ? 3101 : i) });
    const { source } = setup({ '/api/v4/projects/11/starrers': stargazers.handler });
    const added = await incrementalStars(source, { ...APP, stars: 3200 }, new Set(stargazers.logins(3000, 1)), (round) => {
      if (round === 1) [1, 2].forEach(stargazers.unstar);
    });
    expect(added.sort()).toEqual(stargazers.logins(3200, 3001).sort());
    expect(added).toHaveLength(200);
  });

  it('finds the newest starrers beyond 10,000, where GitLab stops counting, from the project star count', async () => {
    // 10,050 visible starrers (101 pages). The star count also counts private profiles, so it can overshoot by far
    // (11,050: ten pages too many; 50,000), or lag a little behind (10,000).
    for (const starCount of [10_250, 11_050, 50_000, 10_000]) {
      const stargazers = fakeStarrers(10_050, { counted: false });
      const { source, requests } = setup({ '/api/v4/projects/11/starrers': stargazers.handler });
      const stars = (await source.round({ ...APP, stars: starCount }, { stars: { after: null } })).stars!;
      expect(stars.items.map((s) => s.login)).toEqual(stargazers.logins(10_050, 10_001));
      expect(stars).toMatchObject({ hasMore: true, endCursor: expect.stringMatching(/^100:\d+:u10001$/), totalCount: starCount });
      // A binary search: a handful of pages, whatever the estimate.
      expect(requests.length).toBeLessThanOrEqual(12);
    }
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
    const err = await fail(source.recheck(APP, [5], []));
    expect(err).toMatchObject({ kind: 'not-found' });
    expect(accessLost(err)).toMatchObject({ problem: 'not-found' });
  });
});
