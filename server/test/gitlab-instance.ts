// A whole fake GitLab instance built from the fixtures: every request gh-dash's GitLab code makes for one project with
// items, alice/app (id 11), for tests that drive it end to end, like the smoke tool's. The token's account is alice. The
// instance also holds her other personal project (alice/corp.tools, 12) and one of a group she is a member of
// (team/platform/api, 40) for repos added by hand and the Add dialog; any other path is a project it doesn't show her.

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

/** A project's probe fields alone (what `Probes` answers). */
function probeOf(p: typeof probesFixture.projects.nodes[number] & Record<string, unknown>) {
  return {
    id: p.id,
    openMergeRequests: p.openMergeRequests,
    openIssues: p.openIssues,
    latestMergeRequest: p.latestMergeRequest,
    latestIssue: p.latestIssue,
    latestReleases: p.latestReleases,
  };
}

/** The fake's routes; `over` replaces or adds some (say, to make one endpoint fail). */
export function fakeInstance(over: Record<string, Handler> = {}, base = BASE) {
  // Every project the instance shows the token, with its probe fields.
  const projects = [
    { ...clone(ownedFixture.projects.nodes[0]!), ...clone(probesFixture.projects.nodes[0]!) },
    { ...clone(ownedFixture.projects.nodes[1]!), ...clone(probesFixture.projects.nodes[1]!) },
    clone(projectFixture.project),
  ];
  const byPath = (path: unknown) => projects.find((p) => p.fullPath === path) ?? null;
  const byIds = (ids: unknown) => projects.filter((p) => (ids as string[]).includes(p.id));
  const { currentUser } = viewerFixture;
  // What a lookup adds to a project: what the token may read of it, and the counts sizing its first sync.
  const { userPermissions, issuesEnabled, recentMergeRequests, recentIssues, releaseCount } = lookupFixture.project;
  const lookup = (path: unknown) => {
    const p = byPath(path);
    return p && { ...p, userPermissions, issuesEnabled, recentMergeRequests, recentIssues, releaseCount };
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
      }),
      '/api/v4/personal_access_tokens/self': {
        body: { id: 7, name: 'gh-dash', revoked: false, active: true, scopes: ['read_api'], user_id: 2, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null, expires_at: '2027-01-31' },
      },
      // The token's memberships, newest activity first, paged like GitLab (an empty X-Next-Page on the last).
      '/api/v4/projects': (req) => {
        const q = req.url.searchParams;
        const all = memberProjectsFixture.filter((p) => q.get('archived') !== 'false' || !p.archived);
        const [n, size] = [Number(q.get('page') ?? 1), Number(q.get('per_page') ?? 20)];
        return page(all.slice((n - 1) * size, n * size), n * size < all.length ? n + 1 : null, { 'x-total': String(all.length) });
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
