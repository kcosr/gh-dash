// GitHubSyncSource against the shared SyncSource contract, on the GraphQL fake answering as GitHub does (strict) with
// two items a page, so every section's cursors are followed. alice/app has the items; bob/tool is someone else's repo
// the token reads, bob/gone one it can't see.

import { fakeGitHub, page, type Handler, type Reply } from '../test/github';
import { commitNode, fakeGraphQL, issueNode, prNode, releaseNode, repoNode, starEdge } from '../test/graphql';
import { describeSyncSourceContract } from '../test/sync-source-contract';
import { GitHubSyncSource } from './sync-source';

const SINCE = '2025-09-29T00:00:00Z';
const at = (d: number) => `2026-09-${String(d).padStart(2, '0')}T09:00:00Z`;

/** GET /user/repos entries. */
const rest = (key: string) => ({
  node_id: `R_${key}`, name: key.split('/')[1], full_name: key, owner: { login: key.split('/')[0] }, description: null, visibility: 'public',
  private: false, archived: false, fork: false, stargazers_count: 5, pushed_at: at(20),
});

/** The fake with alice's repos and their items, and a source over it. */
function githubWorld() {
  const gql = fakeGraphQL();
  gql.state.strict = true;
  gql.state.pageSize = 2;
  const app = 'alice/app';
  gql.state.owned.push(
    repoNode(app, {
      stargazerCount: 3, openPrs: { totalCount: 1 }, openIssues: { totalCount: 2 }, latestPr: { nodes: [{ updatedAt: at(24) }] },
      latestIssue: { nodes: [{ updatedAt: at(23) }] }, latestReleases: { nodes: [{ tagName: 'v1.2', isDraft: true }, { tagName: 'v1.1', isDraft: false }] },
      latestStar: { edges: [{ starredAt: at(22) }] },
    }),
    repoNode('alice/lib'),
    repoNode('alice/empty', { defaultBranchRef: null }),
  );
  gql.state.others.push(repoNode('bob/tool', { primaryLanguage: { name: 'Go', color: '#00ADD8' } }), repoNode('carol/lib'));
  const open = { state: 'OPEN' as const, mergedAt: null, closedAt: null, mergedBy: null };
  gql.state.prs[app] = [{ ...prNode(app, 3, 'Open work', at(24)), ...open }, prNode(app, 1, 'First fix', at(21)), prNode(app, 5, 'Old fix', '2025-06-01T00:00:00Z')];
  gql.state.issues[app] = [
    issueNode(app, 2, 'Crash', at(23)),
    issueNode(app, 6, 'Typo', at(22), { state: 'CLOSED', closedAt: at(22) }),
    issueNode(app, 4, 'Ancient', '2024-01-01T00:00:00Z'),
  ];
  gql.state.commits[app] = ['a', 'b', 'c', 'd', 'e'].map((c, i) => commitNode(app, c, at(25 - i), c === 'b' ? 1 : null));
  gql.state.releases[app] = [releaseNode(app, 'v1.2', at(24), { isDraft: true }), releaseNode(app, 'v1.1', at(20)), releaseNode(app, 'v1.0', at(10))];
  gql.state.stars[app] = [starEdge('dave', at(22)), starEdge('carol', at(15)), starEdge('erin', at(2))];
  gql.state.suggested = ['carol/lib'];

  /** RepoProbes requests naming one of these node ids fail (a GraphQL error that isn't fatal). */
  const failing = new Set<string>();
  const graphql: Handler = (req) => {
    const { query, variables } = req.body as { query: string; variables: { ids?: string[] } };
    if (/query RepoProbes\b/.test(query) && variables.ids?.some((id) => failing.has(id))) return { body: { errors: [{ type: 'INTERNAL', message: 'Probes failed' }] } };
    return (gql.handler as (r: typeof req) => Reply)(req);
  };
  const gh = fakeGitHub({ '/graphql': graphql, '/user/repos': page([rest('bob/tool'), rest('carol/lib')], null) });
  const source = (over: { tokenKind?: 'classic' | null } = {}) =>
    new GitHubSyncSource({ token: 'ghp_test', fetchImpl: gh.fetchImpl, sleep: async () => {}, ...over });
  return { gql, gh, failing, source };
}

describeSyncSourceContract('GitHubSyncSource', {
  setup() {
    const w = githubWorld();
    return {
      source: w.source(),
      failProbe: (nodeId) => w.failing.add(nodeId),
      denyField: () => {
        w.gql.state.errors['R_bob/tool'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', field: 'primaryLanguage' };
        return ['languageName', 'languageColor'];
      },
      transferPr: (number) => {
        const prs = w.gql.state.prs['alice/app']!;
        const pr = prs.splice(prs.findIndex((p) => p.number === number), 1)[0]!;
        // GitHub answers the old number from the repository it's in now.
        (w.gql.state.prs['alice/lib'] ??= []).push(pr);
        w.gql.state.moved[`alice/app#${number}`] = 'alice/lib';
      },
    };
  },
  account: { viewer: 'alice', owned: ['alice/app', 'alice/lib', 'alice/empty'], repo: { found: 'app', missing: 'nope' } },
  busy: { path: 'alice/app', since: SINCE, pr: 1, issue: 2, missingPr: 99, missingIssue: 98 },
  manual: { readable: { nodeId: 'R_bob/tool', path: 'bob/tool' }, missing: { nodeId: 'R_bob/gone', path: 'bob/gone' } },
  tracking: { readable: 'bob/tool', missing: 'bob/gone', since: SINCE },
});
