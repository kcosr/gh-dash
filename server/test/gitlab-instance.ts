// A whole fake GitLab instance built from the fixtures: every request gh-dash's GitLab code makes for one project,
// alice/app (id 11), for tests that drive it end to end, like the smoke tool's.

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

/** The fake's routes; `over` replaces or adds some (say, to make one endpoint fail). */
export function fakeInstance(over: Record<string, Handler> = {}, base = BASE) {
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
      }),
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
