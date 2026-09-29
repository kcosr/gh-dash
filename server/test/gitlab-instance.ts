// A whole fake GitLab instance built from the fixtures: every request gh-dash's GitLab code makes for one project with
// items, alice/app (id 11), for tests that drive it end to end, like the smoke tool's. The token's account is alice.
// The instance knows six more projects (knownProjects): alice/corp.tools (12, archived, issues turned off),
// platform/team/svc (21, a group project alice is only a guest of), platform/api (22), team/platform/api (40, a group
// project she can read), bob/tool (23, another user's fork she is a member of) and team/docs (33). One REST list of
// their memberships (member-projects.json) serves the Add dialog's source and the smoke tool alike, and the smoke tool's
// own GraphQL operations are answered too (smokeOps). Any other path is a project the instance doesn't show her.

import commitDiffFixture from './fixtures/gitlab/commit-diff.json';
import commitFixture from './fixtures/gitlab/commit.json';
import commitsFixture from './fixtures/gitlab/commits.json';
import issuesFixture from './fixtures/gitlab/issues.json';
import lookupFixture from './fixtures/gitlab/lookup.json';
import memberProjectsFixture from './fixtures/gitlab/member-projects.json';
import mergeRequestsFixture from './fixtures/gitlab/merge-requests.json';
import revisionFixture from './fixtures/gitlab/mr-revision.json';
import versionFixture from './fixtures/gitlab/mr-version.json';
import versionsFixture from './fixtures/gitlab/mr-versions.json';
import ownedFixture from './fixtures/gitlab/owned-projects.json';
import probesFixture from './fixtures/gitlab/probes.json';
import projectFixture from './fixtures/gitlab/project.json';
import releasesFixture from './fixtures/gitlab/releases.json';
import starrersFixture from './fixtures/gitlab/starrers.json';
import viewerAccountFixture from './fixtures/gitlab/viewer-account.json';
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

/** A project as GraphQL shows it: the project fields and the probe fields. */
type Known = Record<string, unknown> & { id: string; fullPath: string };
type Permissions = { userPermissions: { downloadCode: boolean; readMergeRequest: boolean }; issuesEnabled: boolean };

const gid = (id: number) => `gid://gitlab/Project/${id}`;
const inSeconds = (time: string) => time.replace(/\.\d+Z$/, 'Z');

/** What the token may read of the projects it can't read all of; any other project is fully readable. */
const RESTRICTED: Record<string, Permissions> = {
  // Turned off on the project.
  [gid(12)]: { userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: false },
  // Alice is a guest of the group's private project: no code, no merge requests.
  [gid(21)]: { userPermissions: { downloadCode: false, readMergeRequest: false }, issuesEnabled: true },
};
const permissionsOf = (id: string): Permissions => RESTRICTED[id] ?? { userPermissions: { downloadCode: true, readMergeRequest: true }, issuesEnabled: true };

/** A project of the membership list as GraphQL shows it, with nothing going on in it. */
function fromMembership(p: (typeof memberProjectsFixture)[number]): Known {
  const active = inSeconds(p.last_activity_at);
  return {
    id: gid(p.id),
    path: p.path,
    fullPath: p.path_with_namespace,
    namespace: { fullPath: p.namespace.full_path },
    description: p.description ?? '',
    webUrl: p.web_url,
    visibility: p.visibility,
    archived: p.archived,
    isForked: 'forked_from_project' in p,
    starCount: p.star_count,
    forksCount: p.forks_count,
    createdAt: inSeconds(p.created_at),
    lastActivityAt: active,
    topics: p.topics,
    languages: [],
    repository: { rootRef: p.default_branch, tree: p.default_branch ? { lastCommit: { sha: '8'.repeat(40), committedDate: active } } : null },
    openMergeRequests: { count: 0 },
    lockedMergeRequests: { count: 0 },
    openIssues: { count: 0 },
    latestMergeRequest: { nodes: [] },
    latestIssue: { nodes: [] },
    latestReleases: { nodes: [] },
  };
}

/**
 * The projects the fake knows, as GraphQL shows them with their probe fields: alice/app and alice/corp.tools (alice's
 * own), platform/team/svc and team/platform/api (a group's), and the rest of the membership list.
 */
function knownProjects(): Known[] {
  const [app, corp] = ownedFixture.projects.nodes.map((n, i) => ({ ...clone(n), ...clone(probesFixture.projects.nodes[i]!) }));
  const svc = {
    ...clone(app!),
    id: gid(21),
    path: 'svc',
    fullPath: 'platform/team/svc',
    namespace: { fullPath: 'platform/team' },
    webUrl: 'https://gitlab.example.com/gitlab/platform/team/svc',
    visibility: 'internal',
    lastActivityAt: '2026-09-28T09:00:00Z',
    openMergeRequests: { count: 0 },
    lockedMergeRequests: { count: 0 },
    openIssues: { count: 0 },
    latestMergeRequest: { nodes: [] },
    latestIssue: { nodes: [] },
    latestReleases: { nodes: [] },
  };
  const others = memberProjectsFixture.filter((p) => ![11, 12, 21, 40].includes(p.id)).map(fromMembership);
  return [app!, corp!, svc, clone(projectFixture.project), ...others];
}

/**
 * The smoke tool's own GraphQL operations (the integration wave's new calls), answered from the fixtures. Exported so a
 * test can derive a broken variant of one: `fakeInstance({}, BASE, { SmokeLookup: (v) => drop(smokeOps().SmokeLookup(v)) })`.
 */
export function smokeOps(): Ops {
  const known = knownProjects();
  const byPath = (path: unknown) => known.find((p) => p.fullPath === path);
  const updatedSince = (v: Record<string, unknown>, times: string[]) => times.filter((t) => Date.parse(t) >= Date.parse(String(v.since))).length;
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
    // What the token may read of the projects it is a member of (RESTRICTED): to see the false values a lookup classifies.
    SmokePermissions: () => ({
      projects: {
        count: 3,
        nodes: [11, 12, 21].map((id) => ({ id: gid(id), ...permissionsOf(gid(id)) })),
      },
    }),
    // A fast-forwarded MR (no merge commit; its own commit is the second commit of commits.json, as 19.3's GraphQL has no
    // squash SHA to say so), a merge-commit one (the first), and an old one merged into a release branch.
    SmokeMergedMrs: () => ({
      project: {
        mergeRequests: {
          nodes: [
            { iid: '6', state: 'merged', mergedAt: ago(2), targetBranch: 'main', mergeCommitSha: null, diffHeadSha: 'c'.repeat(40), commits: { nodes: [{ sha: commitsFixture[1]!.id }] } },
            { iid: '5', state: 'merged', mergedAt: ago(3), targetBranch: 'main', mergeCommitSha: HEAD, diffHeadSha: 'a'.repeat(40), commits: { nodes: [{ sha: 'a'.repeat(40) }] } },
            { iid: '3', state: 'merged', mergedAt: ago(200), targetBranch: 'release/1.0', mergeCommitSha: 'd'.repeat(40), diffHeadSha: 'e'.repeat(40), commits: { nodes: [] } },
          ],
        },
      },
    }),
  };
}

/** A project's probe fields alone (what `Probes` answers). */
function probeOf(p: Known) {
  const { id, openMergeRequests, lockedMergeRequests, openIssues, latestMergeRequest, latestIssue, latestReleases } = p;
  return { id, openMergeRequests, lockedMergeRequests, openIssues, latestMergeRequest, latestIssue, latestReleases };
}

/**
 * The fake's routes; `over` replaces or adds some (say, to make one endpoint fail), `ops` GraphQL operations (over the
 * ones below, the smoke tool's included).
 */
export function fakeInstance(over: Record<string, Handler> = {}, base = BASE, ops: Ops = {}) {
  const known = knownProjects();
  const byPath = (path: unknown) => known.find((p) => p.fullPath === path) ?? null;
  const byIds = (ids: unknown) => known.filter((p) => (ids as string[]).includes(p.id));
  const { currentUser } = viewerFixture;
  // What a lookup adds to a project: what the token may read of it, and the counts sizing its first sync (nothing to
  // count where merge requests or issues can't be read).
  const lookup = (path: unknown) => {
    const p = byPath(path);
    if (!p) return null;
    const { userPermissions, issuesEnabled } = permissionsOf(p.id);
    const { recentMergeRequests, recentIssues, releaseCount } = lookupFixture.project;
    return {
      ...p,
      userPermissions,
      issuesEnabled,
      recentMergeRequests: userPermissions.readMergeRequest ? recentMergeRequests : null,
      recentIssues: issuesEnabled ? recentIssues : null,
      releaseCount,
    };
  };
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
        ViewerAccount: () => viewerAccountFixture,
        OwnedProjects: () => ownedFixture,
        Project: (v) => ({ currentUser, project: byPath(v.path) }),
        ManualProjects: (v) => ({ projects: { nodes: byIds(v.ids) } }),
        ProjectByNode: (v) => ({ currentUser, projects: { nodes: byIds(v.ids) } }),
        ProjectLookup: (v) => ({ currentUser, project: lookup(v.path) }),
        Probes: (v) => ({ projects: { nodes: byIds(v.ids).map(probeOf) } }),
        MergeRequests: (v) => mrs((m) => v.state === 'all' || m.state === v.state),
        RecheckMergeRequests: (v) => mrs((m) => (v.iids as string[]).includes(m.iid)),
        Releases: () => releasesFixture,
        MrRevision: () => revisionFixture,
        ...smokeOps(),
        ...ops,
      }),
      '/api/v4/personal_access_tokens/self': {
        body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['read_api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, expires_at: '2027-01-31' },
      },
      // The token's memberships, filtered, ordered and paged like GitLab (an empty X-Next-Page on the last). The simple
      // entity leaves out what only the full one has: visibility, whether it is archived, and the fork's upstream.
      '/api/v4/projects': (req) => {
        const q = req.url.searchParams;
        const perPage = Number(q.get('per_page') ?? 20);
        const n = Number(q.get('page') ?? 1);
        const listed = memberProjectsFixture
          .filter((p) => q.get('archived') !== 'false' || !p.archived)
          .sort((a, b) => (q.get('order_by') === 'last_activity_at' && q.get('sort') === 'desc' ? b.last_activity_at.localeCompare(a.last_activity_at) : 0));
        const rows = listed.slice((n - 1) * perPage, n * perPage);
        const body = q.get('simple') === 'true' ? rows.map(({ visibility: _v, archived: _a, forked_from_project: _f, ...simple }) => simple) : rows;
        return page(body, n * perPage < listed.length ? n + 1 : null, { 'x-total': String(listed.length) });
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

/**
 * The fake instance for whole syncs (the sync, the manager): empty lists for the projects other than alice/app that the
 * sync reads over REST, and, since the GraphQL fixtures are single pages that say more follow, any later page empty and
 * the last. `owned` edits the owned projects GitLab lists. `over` and `ops` as for fakeInstance.
 */
export function syncInstance(over: Record<string, Handler> = {}, ops: Ops = {}) {
  const owned = structuredClone(ownedFixture);
  const fake = fakeInstance({
    '/api/v4/projects/12/issues': page([], null),
    '/api/v4/projects/12/starrers': page([], null, { 'x-total': '0' }),
    '/api/v4/projects/40/issues': page([], null),
    '/api/v4/projects/40/repository/commits': page([], null),
    ...over,
  }, BASE, ops);
  const answer = fake.routes['/api/graphql'];
  // A fixed reply in `over` (say, a 401) answers everything.
  if (typeof answer !== 'function') return { ...fake, owned };
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
