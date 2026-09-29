import { describe, expect, it } from 'vitest';
import type { DiffRepo, PrRevision } from '../provider/types';
import commitDiffFixture from '../test/fixtures/gitlab/commit-diff.json';
import commitFixture from '../test/fixtures/gitlab/commit.json';
import revisionFixture from '../test/fixtures/gitlab/mr-revision.json';
import versionFixture from '../test/fixtures/gitlab/mr-version.json';
import versionsFixture from '../test/fixtures/gitlab/mr-versions.json';
import { BASE, fakeGitLab, graphql, page, sha, type Handler } from '../test/gitlab';
import { GitLabDiffSource, MAX_FILES } from './diff-source';
import type { GitLabError } from './transport';

const REPO: DiffRepo = { key: 'api', owner: 'team/platform', name: 'api', path: 'team/platform/api' };
const PROJECT = '/api/v4/projects/team%2Fplatform%2Fapi';
const MR = `${PROJECT}/merge_requests/5`;
const [A, B, BASE_OID, OLD_BASE, START, OLD_START] = [sha('a'), sha('b'), sha('9'), sha('8'), sha('7'), sha('6')];
const clone = <T>(x: T): T => structuredClone(x);
const signal = () => new AbortController().signal;

function setup(routes: Record<string, Handler>) {
  const fake = fakeGitLab(routes);
  const source = new GitLabDiffSource({ baseUrl: BASE, token: 'glpat-test-token', fetchImpl: fake.fetchImpl, sleep: async () => {} });
  return { ...fake, source };
}

const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as GitLabError);

describe('GitLabDiffSource: merge requests', () => {
  it('reads the revision from the MR diff refs, with GitLab totals', async () => {
    const { source, calls } = setup({ '/api/graphql': graphql({ MrRevision: () => revisionFixture }) });
    const rev = await source.prRevision(REPO, 5, signal());
    expect(rev).toEqual({
      headOid: B, baseRef: 'main', baseOid: BASE_OID, title: 'Fix login flow', totalFiles: 8, additions: 9, deletions: 4,
      url: 'https://gitlab.example.com/gitlab/team/platform/api/-/merge_requests/5/diffs', handle: { startSha: START },
    });
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({ path: 'team/platform/api', iid: '5' });
    expect(source.requests).toBe(1);
  });

  it('diffs against the start SHA when there is no merge base, and fails clearly without a diff or MR', async () => {
    const noBase = clone(revisionFixture);
    noBase.project.mergeRequest.diffRefs.baseSha = null as unknown as string;
    const unrelated = setup({ '/api/graphql': graphql({ MrRevision: () => noBase }) });
    expect((await unrelated.source.prRevision(REPO, 5, signal())).baseOid).toBe(START);

    const preparing = clone(revisionFixture);
    preparing.project.mergeRequest.diffRefs = null as unknown as typeof preparing.project.mergeRequest.diffRefs;
    expect(await fail(setup({ '/api/graphql': graphql({ MrRevision: () => preparing }) }).source.prRevision(REPO, 5, signal()))).toMatchObject({ kind: 'transient' });
    const missing = setup({ '/api/graphql': graphql({ MrRevision: () => ({ project: { mergeRequest: null } }) }) });
    expect(await fail(missing.source.prRevision(REPO, 5, signal()))).toMatchObject({ kind: 'not-found', message: expect.stringContaining('!5') });
    const noProject = setup({ '/api/graphql': graphql({ MrRevision: () => ({ project: null }) }) });
    expect(await fail(noProject.source.prRevision(REPO, 5, signal()))).toMatchObject({ kind: 'not-found' });
  });

  it("can't tell a head change for free, so leaves it to prRevision", async () => {
    const { source, requests } = setup({});
    expect(await source.prHeadIs(REPO, 5, B, signal())).toBeNull();
    expect(requests).toEqual([]);
  });

  it("reads the files of the revision's own diff version, not just the newest", async () => {
    const { source, requests } = setup({
      [`${MR}/versions`]: page(versionsFixture, null),
      [`${MR}/versions/102`]: { body: { ...clone(versionFixture), id: 102 } },
    });
    // Same head as the newest version, but the target branch has moved since: version 102 is this revision's.
    const rev: PrRevision = { headOid: B, baseRef: 'main', baseOid: OLD_BASE, title: 't', totalFiles: 8, additions: 9, deletions: 4, url: 'u', handle: { startSha: OLD_START } };
    const out = await source.prFiles(REPO, 5, rev, signal());
    expect(out.rev).toBe(rev);
    expect(requests).toEqual([`${MR}/versions?per_page=20`, `${MR}/versions/102`]);
    expect(out.files).toHaveLength(8);
  });

  it('maps every kind of file: counts from the hunks, renames, and no patch for binary or over-limit files', async () => {
    const { source } = setup({
      '/api/graphql': graphql({ MrRevision: () => revisionFixture }),
      [`${MR}/versions`]: page(versionsFixture, null),
      [`${MR}/versions/103`]: { body: versionFixture },
    });
    const { files } = await source.prFiles(REPO, 5, await source.prRevision(REPO, 5, signal()), signal());
    expect(files.map((f) => [f.path, f.previousPath, f.status, f.additions, f.deletions, f.patch === null])).toEqual([
      ['src/login.ts', null, 'modified', 1, 1, false],
      ['docs/auth.md', null, 'added', 3, 0, false],
      ['config/legacy.toml', null, 'removed', 0, 2, false],
      ['src/session/store.ts', 'src/store.ts', 'renamed', 0, 0, true],
      ['src/session/token.ts', 'src/token.ts', 'renamed', 2, 1, false],
      ['assets/logo.png', null, 'modified', 0, 0, true],
      ['data/fixtures.json', null, 'modified', 0, 0, true],
      ['package-lock.json', null, 'modified', 0, 0, true],
    ]);
    expect(files[0]!.patch).toBe("@@ -1,4 +1,4 @@\n import { login } from './auth';\n-const retries = 1;\n+const retries = 3;\n export { login };");
    expect(files[4]!.patch!.endsWith('\n\\ No newline at end of file')).toBe(true);
  });

  it("starts over from the MR's current revision when the given one's version isn't listed", async () => {
    let revisions = 0;
    const { source, requests } = setup({
      '/api/graphql': graphql({ MrRevision: () => (revisions++, revisionFixture) }),
      [`${MR}/versions`]: page(versionsFixture, null),
      [`${MR}/versions/103`]: { body: versionFixture },
    });
    const stale: PrRevision = { headOid: A, baseRef: 'main', baseOid: BASE_OID, title: 'old', totalFiles: 1, additions: 1, deletions: 0, url: 'u', handle: { startSha: START } };
    const out = await source.prFiles(REPO, 5, stale, signal());
    expect(out.rev).toMatchObject({ headOid: B, title: 'Fix login flow' });
    expect(revisions).toBe(1);
    expect(requests).toEqual([`${MR}/versions?per_page=20`, 'graphql MrRevision', `${MR}/versions?per_page=20`, `${MR}/versions/103`]);
  });

  it('gives up as transient when no listed version matches even after re-reading the MR', async () => {
    const moved = clone(revisionFixture);
    moved.project.mergeRequest.diffRefs.headSha = sha('c');
    const { source } = setup({ '/api/graphql': graphql({ MrRevision: () => moved }), [`${MR}/versions`]: page(versionsFixture, null) });
    const rev = await source.prRevision(REPO, 5, signal());
    expect(await fail(source.prFiles(REPO, 5, rev, signal()))).toMatchObject({ kind: 'transient', message: expect.stringContaining('changed') });
  });

  it('lists at most MAX_FILES files of a version', async () => {
    const many = { ...clone(versionFixture), diffs: Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ ...versionFixture.diffs[0]!, new_path: `f${i}`, old_path: `f${i}` })) };
    const { source } = setup({
      '/api/graphql': graphql({ MrRevision: () => revisionFixture }),
      [`${MR}/versions`]: page(versionsFixture, null),
      [`${MR}/versions/103`]: { body: many },
    });
    const { files } = await source.prFiles(REPO, 5, await source.prRevision(REPO, 5, signal()), signal());
    expect(files).toHaveLength(MAX_FILES);
    expect(source.maxFiles).toBe(MAX_FILES);
  });
});

describe('GitLabDiffSource: commits', () => {
  it("reads a commit and pages its diff against the first parent", async () => {
    const { source, requests } = setup({
      [`${PROJECT}/repository/commits/bbbbbbb`]: { body: commitFixture },
      [`${PROJECT}/repository/commits/${B}/diff`]: (req) =>
        req.url.searchParams.get('page') === '1'
          ? page(commitDiffFixture.slice(0, 2), 2, { 'x-total': '3' })
          : page(commitDiffFixture.slice(2), null, { 'x-total': '3' }),
    });
    const diff = await source.commit(REPO, 'bbbbbbb', signal());
    expect(diff).toMatchObject({
      title: 'Retry logins three times', baseOid: BASE_OID, headOid: B, totalFiles: 3, additions: 5, deletions: 2,
      url: `https://gitlab.example.com/gitlab/team/platform/api/-/commit/${B}`,
    });
    expect(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/login.ts', 'modified', 1, 1],
      ['docs/auth.md', 'added', 3, 0],
      ['old.cfg', 'removed', 0, 1],
    ]);
    expect(requests).toEqual([
      `${PROJECT}/repository/commits/bbbbbbb`,
      `${PROJECT}/repository/commits/${B}/diff?per_page=100&page=1`,
      `${PROJECT}/repository/commits/${B}/diff?per_page=100&page=2`,
    ]);
  });

  it('has no base for a root commit, and sums the files when GitLab sends no stats', async () => {
    const { stats: _, ...root } = { ...clone(commitFixture), parent_ids: [] as string[] };
    const { source } = setup({
      [`${PROJECT}/repository/commits/${B}`]: { body: root },
      [`${PROJECT}/repository/commits/${B}/diff`]: page(commitDiffFixture, null),
    });
    expect(await source.commit(REPO, B, signal())).toMatchObject({ baseOid: null, totalFiles: 3, additions: 4, deletions: 2 });
  });

  it('never builds a path out of the API root from what GitLab answered', async () => {
    const { source, requests } = setup({
      [`${PROJECT}/repository/commits/bbbbbbb`]: { body: { ...clone(commitFixture), id: '../../../../../../gitlab/x' } },
      [`${PROJECT}/repository/commits/b%2Fc/diff`]: page([], null),
    });
    await expect(source.commit(REPO, 'bbbbbbb', signal())).rejects.toThrow(/\.\./);
    expect(requests).toEqual([`${PROJECT}/repository/commits/bbbbbbb`]);
    // An id that is merely odd stays one encoded segment.
    const odd = setup({
      [`${PROJECT}/repository/commits/bbbbbbb`]: { body: { ...clone(commitFixture), id: 'b/c' } },
      [`${PROJECT}/repository/commits/b%2Fc/diff`]: page([], null),
    });
    await odd.source.commit(REPO, 'bbbbbbb', signal());
    expect(odd.requests.at(-1)).toBe(`${PROJECT}/repository/commits/b%2Fc/diff?per_page=100&page=1`);
  });

  it('reports an unknown commit as not-found', async () => {
    const { source } = setup({ [`${PROJECT}/repository/commits/${A}`]: { status: 404, body: { message: '404 Commit Not Found' } } });
    expect(await fail(source.commit(REPO, A, signal()))).toMatchObject({ kind: 'not-found', status: 404, message: expect.stringContaining('404 Commit Not Found') });
  });
});

describe('GitLabDiffSource: file contents', () => {
  const RAW = `${PROJECT}/repository/files/src%2Fsession%2Ftoken%2Ets/raw`;

  it('reads a file at a commit, the whole path encoded as one segment', async () => {
    const { source, requests } = setup({ [RAW]: { text: 'export const token = 1;\n' } });
    const blob = await source.blob(REPO, B, 'src/session/token.ts', 1000, signal());
    expect(blob.kind === 'file' && new TextDecoder().decode(blob.bytes)).toBe('export const token = 1;\n');
    expect(requests).toEqual([`${RAW}?ref=${B}`]);
  });

  it('stops reading at the byte cap', async () => {
    const big = new Uint8Array(5000).fill(97);
    const declared = setup({ [RAW]: { text: big, headers: { 'content-length': '5000' } } });
    expect(await declared.source.blob(REPO, B, 'src/session/token.ts', 1000, signal())).toEqual({ kind: 'too-large' });
    const streamed = setup({ [RAW]: { text: big } });
    expect(await streamed.source.blob(REPO, B, 'src/session/token.ts', 1000, signal())).toEqual({ kind: 'too-large' });
  });

  it('reports a missing file (or a directory) as not-found', async () => {
    const { source } = setup({ [RAW]: { status: 404, body: { message: '404 File Not Found' } } });
    expect(await fail(source.blob(REPO, B, 'src/session/token.ts', 1000, signal()))).toMatchObject({ kind: 'not-found' });
  });

  it('describes itself to the diff service', () => {
    const { source } = setup({});
    expect([source.kind, source.rateLimit, source.requests]).toEqual(['gitlab', null, 0]);
    expect(source.authHint).toContain('read_api');
  });
});
