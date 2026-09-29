// GitLabSyncSource against the shared SyncSource contract, on the fake instance (alice/app has the items). Repos added
// by hand and the Add dialog aren't answered by GitLab yet: those parts of the suite show as todo.
//
// The instance's GraphQL fixtures are single pages that say more follow; here any later page is empty and the last, so
// a walk through the cursors ends.

import { fakeInstance } from '../test/gitlab-instance';
import type { Handler, Reply } from '../test/gitlab';
import { describeSyncSourceContract } from '../test/sync-source-contract';
import { GitLabSyncSource } from './sync-source';

describeSyncSourceContract('GitLabSyncSource', {
  setup() {
    const fake = fakeInstance();
    const answer = fake.routes['/api/graphql'] as Extract<Handler, (...args: never[]) => Reply>;
    const failing = new Set<string>();
    fake.routes['/api/graphql'] = (req) => {
      const { query, variables } = req.body as { query: string; variables?: { ids?: string[]; after?: string | null } };
      if (query.includes('query Probes(') && variables?.ids?.some((id) => failing.has(id))) return { body: { errors: [{ message: 'Internal server error' }] } };
      const reply = answer(req);
      if (!variables?.after) return reply;
      const body = structuredClone(reply.body) as { data?: { project?: Record<string, unknown> | null } };
      for (const conn of Object.values(body.data?.project ?? {})) {
        if (conn && typeof conn === 'object' && 'pageInfo' in conn) Object.assign(conn, { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
      }
      return { ...reply, body };
    };
    const source = new GitLabSyncSource({ baseUrl: 'https://gitlab.example.com/gitlab', token: 'glpat-test-token', fetchImpl: fake.fetchImpl, sleep: async () => {} });
    return { source, failProbe: (nodeId) => failing.add(nodeId) };
  },
  account: { viewer: 'alice', owned: ['alice/app', 'alice/corp.tools'], repo: { found: 'alice/app', missing: 'alice/gone' } },
  busy: { path: 'alice/app', since: '2025-09-29T00:00:00Z', pr: 7, issue: 9, missingPr: 99, missingIssue: 98 },
});
