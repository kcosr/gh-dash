// Schema drift: the fake instance answers whatever the queries ask for, so it can never say that the real GitLab has no
// such field. Each finding of a real-instance smoke run goes in ABSENT below, and no GraphQL document GitLab code sends
// may request that field again.

import { describe, expect, it } from 'vitest';
import { fakeInstance } from '../test/gitlab-instance';
import { BASE } from '../test/gitlab';
import { CREDENTIAL_CHECK } from './credentials';
import * as queries from './queries';
import { main } from './smoke';

/** Fields the GraphQL schema of GitLab 19.3.3 (the version the smoke run answered on) does not have. Add more as found. */
const ABSENT: { type: string; field: string; finding: string }[] = [
  { type: 'MergeRequest', field: 'squashCommitSha', finding: "Field 'squashCommitSha' doesn't exist on type 'MergeRequest'" },
];

/** The names a document uses: comments and string literals left out. */
function names(document: string): Set<string> {
  const code = document.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return new Set(code.match(/[A-Za-z_]\w*/g));
}

/** The absent fields a document requests, as "Type.field: what GitLab said". */
function drift(document: string): string[] {
  const used = names(document);
  return ABSENT.filter((a) => used.has(a.field)).map((a) => `${a.type}.${a.field}: ${a.finding}`);
}

/** Every GraphQL document the smoke tool sends, from a whole run against the fake instance. */
async function smokeDocuments(): Promise<string[]> {
  const fake = fakeInstance();
  await main([], { GITLAB_URL: BASE, GITLAB_TOKEN: 'glpat-test-token' }, { out: () => {}, fetchImpl: fake.fetchImpl, build: 'test', sleep: async () => {} });
  const documents = fake.calls.flatMap((c) => (c.url.pathname.endsWith('/api/graphql') ? [(c.body as { query: string }).query] : []));
  return [...new Set(documents)];
}

describe('GitLab GraphQL documents against the fields known to be absent on 19.3.3', () => {
  it('notices a document that requests one', () => {
    expect(drift('fragment F on MergeRequest { iid mergeCommitSha squashCommitSha }')).toEqual([expect.stringContaining('MergeRequest.squashCommitSha')]);
    expect(drift('query Q { a(x: "squashCommitSha") { b } } # squashCommitSha')).toEqual([]);
    expect(drift('fragment F on MergeRequest { iid mergeCommitSha }')).toEqual([]);
  });

  const documents: [string, string][] = Object.entries(queries).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []));

  it('reads the documents it means to check', () => {
    expect(documents.map(([name]) => name)).toEqual(expect.arrayContaining(['MERGE_REQUESTS', 'RECHECK_MERGE_REQUESTS', 'PROJECT_LOOKUP', 'MR_REVISION']));
    expect(names(queries.MERGE_REQUESTS).has('mergeCommitSha')).toBe(true);
    // The fake instance answers whatever is asked: nothing else notices the fork check's fields going missing.
    for (const document of [queries.MERGE_REQUESTS, queries.RECHECK_MERGE_REQUESTS]) {
      expect(['sourceProjectId', 'targetProjectId'].map((field) => names(document).has(field))).toEqual([true, true]);
    }
  });

  it.each([...documents, ['CREDENTIAL_CHECK', CREDENTIAL_CHECK]])('%s requests none of them', (_name, document) => {
    expect(drift(document)).toEqual([]);
  });

  it("the smoke tool's documents request none of them", async () => {
    const sent = await smokeDocuments();
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.flatMap(drift)).toEqual([]);
  });
});
