// A whole fake GitLab instance built from the fixtures: every request gh-dash's GitLab code makes for one project,
// alice/app (id 11), for tests that drive it end to end, like the smoke tool's. It also knows alice/corp.tools (id 12,
// archived) and platform/team/svc (id 21, a group project alice is a member of), and answers the smoke tool's queries
// for the integration wave's calls (smokeOps).

import commitDiffFixture from './fixtures/gitlab/commit-diff.json';
import commitFixture from './fixtures/gitlab/commit.json';
import commitsFixture from './fixtures/gitlab/commits.json';
import issuesFixture from './fixtures/gitlab/issues.json';
import mergeRequestsFixture from './fixtures/gitlab/merge-requests.json';
import revisionFixture from './fixtures/gitlab/mr-revision.json';
import versionFixture from './fixtures/gitlab/mr-version.json';
import versionsFixture from './fixtures/gitlab/mr-versions.json';
import ownedFixture from './fixtures/gitlab/owned-projects.json';
import probesFixture from './fixtures/gitlab/probes.json';
import releasesFixture from './fixtures/gitlab/releases.json';
import starrersFixture from './fixtures/gitlab/starrers.json';
import viewerFixture from './fixtures/gitlab/viewer.json';
import { BASE, fakeGitLab, graphql, page, type Handler } from './gitlab';

const clone = <T>(x: T): T => structuredClone(x);
const APP = '/api/v4/projects/alice%2Fapp';
/** The newest commit on alice/app's default branch (commits.json), and the MR the smoke diffs (the newest in merge-requests.json). */
const HEAD = commitsFixture[0]!.id;
const MR = 7;
const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');

type Ops = Record<string, (vars: Record<string, unknown>) => unknown>;

/** The projects the fake knows: alice/app and alice/corp.tools (alice's own), and platform/team/svc (a group's). */
function knownProjects() {
  const [app, corp] = ownedFixture.projects.nodes.map((n, i) => ({ ...clone(n), ...clone(probesFixture.projects.nodes[i]!) }));
  const svc = {
    ...clone(app!),
    id: 'gid://gitlab/Project/21',
    path: 'svc',
    fullPath: 'platform/team/svc',
    namespace: { fullPath: 'platform/team' },
    webUrl: 'https://gitlab.example.com/gitlab/platform/team/svc',
    visibility: 'internal',
    openMergeRequests: { count: 0 },
    openIssues: { count: 0 },
    latestMergeRequest: { nodes: [] },
    latestIssue: { nodes: [] },
    latestReleases: { nodes: [] },
  };
  return [app!, corp!, svc];
}

/** What the REST `projects?membership=true&simple=true` lists: alice's two projects (one archived) and two group ones. */
const simpleProject = (id: number, path: string, ns: { id: number; full: string; kind: 'user' | 'group' }, activity: string, archived = false) => ({
  archived,
  id,
  description: null,
  name: path.split('/').at(-1),
  name_with_namespace: path.split('/').join(' / '),
  path: path.split('/').at(-1),
  path_with_namespace: path,
  created_at: '2025-01-01T00:00:00.000Z',
  default_branch: 'main',
  topics: [],
  web_url: `https://gitlab.example.com/gitlab/${path}`,
  avatar_url: null,
  star_count: 0,
  forks_count: 0,
  last_activity_at: activity,
  namespace: { id: ns.id, name: ns.full.split('/').at(-1), path: ns.full.split('/').at(-1), kind: ns.kind, full_path: ns.full, parent_id: null, avatar_url: null, web_url: `https://gitlab.example.com/gitlab/${ns.kind === 'group' ? 'groups/' : ''}${ns.full}` },
});
const memberProjects = () => [
  simpleProject(11, 'alice/app', { id: 2, full: 'alice', kind: 'user' }, '2026-09-26T08:00:00.000Z'),
  simpleProject(12, 'alice/corp.tools', { id: 2, full: 'alice', kind: 'user' }, '2025-06-01T09:30:00.000Z', true),
  simpleProject(21, 'platform/team/svc', { id: 30, full: 'platform/team', kind: 'group' }, '2026-09-25T09:00:00.000Z'),
  simpleProject(22, 'platform/api', { id: 31, full: 'platform', kind: 'group' }, '2026-08-01T09:00:00.000Z'),
];

/**
 * The smoke tool's own GraphQL operations (the integration wave's new calls), answered from the fixtures. Exported so a
 * test can derive a broken variant of one: `fakeInstance({}, BASE, { SmokeLookup: (v) => drop(smokeOps().SmokeLookup(v)) })`.
 */
export function smokeOps(): Ops {
  const known = knownProjects();
  const byPath = (path: unknown) => known.find((p) => p.fullPath === path);
  const updatedSince = (v: Record<string, unknown>, times: string[]) => times.filter((t) => Date.parse(t) >= Date.parse(String(v.since))).length;
  const squash = '4'.repeat(40);
  return {
    // The token validation query: the account with its emails, the instance, and the personal projects' count.
    SmokeValidate: () => ({
      currentUser: {
        ...clone(viewerFixture.currentUser),
        publicEmail: 'alice@example.com',
        commitEmail: '2-alice@users.noreply.gitlab.example.com',
        emails: { nodes: [{ email: 'alice@example.com' }, { email: 'Alice@Work.Example' }] },
      },
      metadata: { version: '19.3.3-ee', enterprise: true },
      projects: { count: ownedFixture.projects.nodes.length },
    }),
    SmokeProjectsByIds: (v) => ({ projects: { nodes: (v.ids as string[]).flatMap((id) => known.filter((p) => p.id === id)).slice(0, Number(v.first)) } }),
    SmokeLookup: (v) => {
      const project = byPath(v.path) ?? null;
      return {
        currentUser: { id: viewerFixture.currentUser.id, username: viewerFixture.currentUser.username },
        project: project && {
          ...clone(project),
          userPermissions: { downloadCode: true, readMergeRequest: true },
          issuesEnabled: true,
          mergeRequestsSince: { count: updatedSince(v, mergeRequestsFixture.project.mergeRequests.nodes.map((m) => m.updatedAt)) },
          issuesSince: { count: updatedSince(v, issuesFixture.map((i) => i.updated_at)) },
          releaseTotal: { count: releasesFixture.project.releases.nodes.length },
        },
      };
    },
    // A guest on the group's private project sees no code; one project has issues turned off.
    SmokePermissions: () => ({
      projects: {
        count: 3,
        nodes: [
          { id: 'gid://gitlab/Project/11', userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: true },
          { id: 'gid://gitlab/Project/12', userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: false },
          { id: 'gid://gitlab/Project/21', userPermissions: { downloadCode: false, readMergeRequest: false }, issuesEnabled: true },
        ],
      },
    }),
    // A squash-merged MR (its squash commit is the second commit of commits.json), a merge-commit one (the first), and an
    // old one merged into a release branch.
    SmokeMergedMrs: () => ({
      project: {
        mergeRequests: {
          nodes: [
            { iid: '6', state: 'merged', mergedAt: ago(2), targetBranch: 'main', mergeCommitSha: null, squashCommitSha: squash, diffHeadSha: 'c'.repeat(40), commits: { nodes: [{ sha: 'c'.repeat(40) }] } },
            { iid: '5', state: 'merged', mergedAt: ago(3), targetBranch: 'main', mergeCommitSha: HEAD, squashCommitSha: null, diffHeadSha: 'a'.repeat(40), commits: { nodes: [{ sha: 'a'.repeat(40) }] } },
            { iid: '3', state: 'merged', mergedAt: ago(200), targetBranch: 'release/1.0', mergeCommitSha: 'd'.repeat(40), squashCommitSha: null, diffHeadSha: 'e'.repeat(40), commits: { nodes: [] } },
          ],
        },
      },
    }),
  };
}

/** The fake's routes; `over` replaces or adds some (say, to make one endpoint fail), `ops` GraphQL operations. */
export function fakeInstance(over: Record<string, Handler> = {}, base = BASE, ops: Ops = {}) {
  const project = { ...clone(ownedFixture.projects.nodes[0]!), ...clone(probesFixture.projects.nodes[0]!) };
  const mrs = (keep: (mr: { iid: string; state: string }) => boolean) => {
    const data = clone(mergeRequestsFixture);
    data.project.mergeRequests.nodes = data.project.mergeRequests.nodes.filter(keep);
    return data;
  };
  return fakeGitLab(
    {
      '/api/graphql': graphql({
        SmokeMeta: () => ({ metadata: { version: '19.3.3-ee', enterprise: true } }),
        SmokeMembership: () => ({ projects: { nodes: [{ fullPath: 'alice/app' }] } }),
        Viewer: () => viewerFixture,
        OwnedProjects: () => ownedFixture,
        Project: (v) => ({ project: v.path === 'alice/app' ? project : null }),
        Probes: (v) => ({ projects: { nodes: probesFixture.projects.nodes.filter((n) => (v.ids as string[]).includes(n.id)) } }),
        MergeRequests: (v) => mrs((m) => v.state === 'all' || m.state === v.state),
        RecheckMergeRequests: (v) => mrs((m) => (v.iids as string[]).includes(m.iid)),
        Releases: () => releasesFixture,
        MrRevision: () => revisionFixture,
        ...smokeOps(),
        ...ops,
      }),
      '/api/v4/projects': (req) => {
        const q = req.url.searchParams;
        const perPage = Number(q.get('per_page') ?? 20);
        const n = Number(q.get('page') ?? 1);
        const listed = memberProjects()
          .filter((p) => q.get('archived') !== 'false' || !p.archived)
          .sort((a, b) => (q.get('order_by') === 'last_activity_at' && q.get('sort') === 'desc' ? b.last_activity_at.localeCompare(a.last_activity_at) : 0));
        return page(
          listed.slice((n - 1) * perPage, n * perPage).map(({ archived: _archived, ...p }) => p),
          n * perPage < listed.length ? n + 1 : null,
          { 'x-total': String(listed.length) },
        );
      },
      '/api/v4/personal_access_tokens/self': {
        body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['read_api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, expires_at: '2027-01-31' },
      },
      '/api/v4/projects/11/issues': (req) => {
        const iids = req.url.searchParams.getAll('iids[]');
        const state = req.url.searchParams.get('state');
        return page(issuesFixture.filter((i) => (!iids.length || iids.includes(String(i.iid))) && (state === 'all' || i.state === state)), null);
      },
      '/api/v4/projects/11/repository/commits': page(commitsFixture, null),
      '/api/v4/projects/11/starrers': page(starrersFixture, null, { 'x-total': String(starrersFixture.length) }),
      [`${APP}/merge_requests/${MR}/versions`]: page(versionsFixture, null),
      [`${APP}/merge_requests/${MR}/versions/103`]: { body: versionFixture },
      [`${APP}/repository/files/src%2Flogin%2Ets/raw`]: { text: "import { login } from './auth';\nconst retries = 3;\nexport { login };\n" },
      // The commit's stats are what its files add up to.
      [`${APP}/repository/commits/${HEAD}`]: { body: { ...clone(commitFixture), id: HEAD, stats: { additions: 4, deletions: 2, total: 6 } } },
      [`${APP}/repository/commits/${HEAD}/diff`]: page(commitDiffFixture, null, { 'x-total': String(commitDiffFixture.length) }),
      ...over,
    },
    base,
  );
}
