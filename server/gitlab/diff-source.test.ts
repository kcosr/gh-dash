import { describe, expect, it } from 'vitest';
import type { DiffRepo, PrRevision } from '../provider/types';
import commitDiffFixture from '../test/fixtures/gitlab/commit-diff.json';
import commitFixture from '../test/fixtures/gitlab/commit.json';
import revisionFixture from '../test/fixtures/gitlab/mr-revision.json';
import versionFixture from '../test/fixtures/gitlab/mr-version.json';
import versionsFixture from '../test/fixtures/gitlab/mr-versions.json';
import { BASE, fakeGitLab, graphql, page, sha, type Handler } from '../test/gitlab';
import { supplyOf } from '../test/tokens';
import { GitLabDiffSource, GitLabDiffSources, MAX_FILES } from './diff-source';
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

describe('GitLabDiffSource: branches', () => {
  const REPOSITORY = `${PROJECT}/repository`;
  const BRANCH_ROUTE = `${REPOSITORY}/branches/feature%2Fx`;
  const COMPARE = `${REPOSITORY}/compare?from=${BASE_OID}&to=${B}`;
  const MERGE_BASE = `${REPOSITORY}/merge_base?refs%5B%5D=main&refs%5B%5D=${B}`;
  // What `merge_base` answers: the commit.
  const mergeBase = { body: { id: BASE_OID, short_id: BASE_OID.slice(0, 8), title: 'Base', parent_ids: [], committed_date: '2026-09-01T10:00:00.000Z' } };
  const branch = (name: string, id: string, committed: string | null) => ({ name, merged: false, protected: false, default: false, commit: { id, short_id: id.slice(0, 8), committed_date: committed } });

  it('reads the head of a branch, its name encoded as one segment', async () => {
    const { source, requests } = setup({ [BRANCH_ROUTE]: { body: branch('feature/x', B, '2026-09-30T10:00:00+02:00') } });
    expect(await source.branchHead(REPO, 'feature/x', A, signal())).toBe(B);
    expect(requests).toEqual([BRANCH_ROUTE]);
    // Dots are encoded as well: ".json" would otherwise be taken for a format.
    const dotted = setup({ [`${REPOSITORY}/branches/release%2Fv1%2E0%2Ejson`]: { body: branch('release/v1.0.json', A, null) } });
    expect(await dotted.source.branchHead(REPO, 'release/v1.0.json', null, signal())).toBe(A);
  });

  it('reports a branch the project does not have as not-found', async () => {
    const { source } = setup({ [BRANCH_ROUTE]: { status: 404, body: { message: '404 Branch Not Found' } } });
    expect(await fail(source.branchHead(REPO, 'feature/x', null, signal()))).toMatchObject({ kind: 'not-found', status: 404, message: expect.stringContaining('404 Branch Not Found') });
  });

  it('compares from the merge base to the head, both pinned, with the files mapped and counted like a merge request\'s', async () => {
    const { source, requests, calls } = setup({
      [MERGE_BASE]: mergeBase,
      [COMPARE]: { body: { commit: { id: B }, commits: [{ id: B }], diffs: versionFixture.diffs, compare_timeout: false, compare_same_ref: false, web_url: 'https://x' } },
    });
    const out = await source.compare(REPO, 'main', B, signal());
    expect(requests).toEqual([MERGE_BASE, COMPARE]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(out).toMatchObject({ baseOid: BASE_OID, headOid: B, totalFiles: 8, additions: 6, deletions: 4 });
    expect(out.files.map((f) => [f.path, f.previousPath, f.status, f.additions, f.deletions, f.patch === null])).toEqual([
      ['src/login.ts', null, 'modified', 1, 1, false],
      ['docs/auth.md', null, 'added', 3, 0, false],
      ['config/legacy.toml', null, 'removed', 0, 2, false],
      ['src/session/store.ts', 'src/store.ts', 'renamed', 0, 0, true],
      ['src/session/token.ts', 'src/token.ts', 'renamed', 2, 1, false],
      ['assets/logo.png', null, 'modified', 0, 0, true],
      ['data/fixtures.json', null, 'modified', 0, 0, true],
      ['package-lock.json', null, 'modified', 0, 0, true],
    ]);
    expect(out.files[0]!.patch).toBe("@@ -1,4 +1,4 @@\n import { login } from './auth';\n-const retries = 1;\n+const retries = 3;\n export { login };");
  });

  it('lists at most MAX_FILES files, and says when GitLab cut the comparison off', async () => {
    const diffs = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ ...versionFixture.diffs[0]!, new_path: `f${i}`, old_path: `f${i}` }));
    const many = setup({ [MERGE_BASE]: mergeBase, [COMPARE]: { body: { diffs, compare_timeout: false } } });
    const out = await many.source.compare(REPO, 'main', B, signal());
    expect(out.files).toHaveLength(MAX_FILES);
    expect(out.totalFiles).toBe(MAX_FILES + 5);

    const some = versionFixture.diffs.slice(0, 2);
    const cut = setup({ [MERGE_BASE]: mergeBase, [COMPARE]: { body: { diffs: some, compare_timeout: true } } });
    // The list is a lower bound now: there is at least one file more than it has.
    expect(await cut.source.compare(REPO, 'main', B, signal())).toMatchObject({ totalFiles: 3, additions: 4, deletions: 1 });
    expect((await cut.source.compare(REPO, 'main', B, signal())).files).toHaveLength(2);

    const same = setup({ [MERGE_BASE]: mergeBase, [COMPARE]: { body: { diffs: [], compare_timeout: false, compare_same_ref: false } } });
    expect(await same.source.compare(REPO, 'main', B, signal())).toEqual({ baseOid: BASE_OID, headOid: B, files: [], totalFiles: 0, additions: 0, deletions: 0 });
  });

  it('reports a comparison GitLab cannot make (no merge base, an unknown ref) as not-found', async () => {
    const orphan = setup({ [MERGE_BASE]: { status: 404, body: { message: '404 Merge Base Not Found' } } });
    expect(await fail(orphan.source.compare(REPO, 'main', B, signal()))).toMatchObject({ kind: 'not-found', status: 404 });
    expect(orphan.requests).toEqual([MERGE_BASE]);
    const gone = setup({ [MERGE_BASE]: mergeBase, [COMPARE]: { status: 404, body: { message: '404 Commit Not Found' } } });
    expect(await fail(gone.source.compare(REPO, 'main', B, signal()))).toMatchObject({ kind: 'not-found' });
  });

  it('lists branches newest first, as UTC instants, with GitLab asked to sort and search', async () => {
    const list = [
      branch('main', A, '2026-09-30T12:00:00+02:00'),
      branch('old', sha('1'), '2026-01-01T00:00:00.000Z'),
      branch('undated', sha('2'), null),
      branch('feature/x', B, '2026-09-30T11:30:00.000Z'),
    ];
    const { source, requests } = setup({ [`${REPOSITORY}/branches`]: page(list, null) });
    const out = await source.branches(REPO, 'fea', 50, signal());
    expect(requests).toEqual([`${REPOSITORY}/branches?per_page=50&sort=updated_desc&search=fea`]);
    // 12:00+02:00 is 10:00Z: older than 11:30Z, which string order would get wrong.
    expect(out.items).toEqual([
      { name: 'feature/x', headOid: B, committedAt: '2026-09-30T11:30:00.000Z' },
      { name: 'main', headOid: A, committedAt: '2026-09-30T10:00:00.000Z' },
      { name: 'old', headOid: sha('1'), committedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'undated', headOid: sha('2'), committedAt: null },
    ]);
    expect(out.more).toBe(false);
    expect(await setup({ [`${REPOSITORY}/branches`]: page([], null) }).source.branches(REPO, null, 1000, signal())).toEqual({ items: [], more: false });
  });

  it('asks for at most 100 and no search without a query, and says when there are more', async () => {
    const full = Array.from({ length: 100 }, (_, i) => branch(`b${i}`, sha('3'), `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`));
    const next = setup({ [`${REPOSITORY}/branches`]: page(full, 2, { 'x-total': '250' }) });
    expect((await next.source.branches(REPO, null, 1000, signal())).more).toBe(true);
    expect(next.requests).toEqual([`${REPOSITORY}/branches?per_page=100&sort=updated_desc`]);
    // GitLab counts nothing beyond 10,000 items or for long lists, and may not name a next page: a full page is then all there is to go by.
    expect((await setup({ [`${REPOSITORY}/branches`]: page(full, null) }).source.branches(REPO, null, 100, signal())).more).toBe(true);
    expect((await setup({ [`${REPOSITORY}/branches`]: page(full.slice(0, 99), null) }).source.branches(REPO, null, 100, signal())).more).toBe(false);
    // Counted: the total decides.
    expect((await setup({ [`${REPOSITORY}/branches`]: page(full, null, { 'x-total': '100' }) }).source.branches(REPO, null, 100, signal())).more).toBe(false);
    expect((await setup({ [`${REPOSITORY}/branches`]: page(full, null, { 'x-total': '101' }) }).source.branches(REPO, null, 100, signal())).more).toBe(true);
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

describe('GitLabDiffSources', () => {
  it('makes one source per token on the instance, and forgets a rejected one', async () => {
    const token = { value: 'glpat-one' as string | null };
    const supply = supplyOf(() => token.value);
    const invalidated: (string | undefined)[] = [];
    const tokens = Object.assign(supply, {
      invalidate: (t?: string) => void invalidated.push(t),
      noTokenMessage: () => "No GitLab token for gitlab.example.com: it isn't configured on this server",
    });
    const api = fakeGitLab({ [`${PROJECT}/repository/files/README%2Emd/raw`]: { text: 'hi' } });
    const sources = new GitLabDiffSources({ baseUrl: BASE, tokens, fetchImpl: api.fetchImpl, sleep: async () => {} });

    const first = await sources.get();
    expect(await sources.get()).toBe(first);
    // It talks to the configured instance (relative root included) with the token it was made with.
    await first.blob(REPO, B, 'README.md', 1000, signal());
    expect(api.calls.map((c) => [c.url.href.startsWith(`${BASE}/api/v4/`), c.headers.Authorization])).toEqual([[true, 'Bearer glpat-one']]);

    token.value = 'glpat-two';
    const second = await sources.get();
    expect(second).not.toBe(first);
    sources.authFailed(first);
    expect(invalidated).toEqual(['glpat-one']);
    expect(await sources.get()).toBe(second);
    sources.authFailed(second);
    expect(await sources.get()).not.toBe(second);

    token.value = null;
    expect(await fail(sources.get())).toMatchObject({ kind: 'auth', message: "No GitLab token for gitlab.example.com: it isn't configured on this server" });
  });

  it("gives its sources the credentials' hint for a rejected token, or a generic one", async () => {
    const tokens = Object.assign(supplyOf(() => 'glpat-one'), { noTokenMessage: () => 'none' });
    const hint = 'check the GitLab token in Settings → Sources, or run `glab auth login --hostname gitlab.example.com`';
    const hinted = new GitLabDiffSources({ baseUrl: BASE, tokens, authHint: hint, fetchImpl: fakeGitLab().fetchImpl, sleep: async () => {} });
    expect((await hinted.get()).authHint).toBe(hint);
    const plain = new GitLabDiffSources({ baseUrl: BASE, tokens, fetchImpl: fakeGitLab().fetchImpl, sleep: async () => {} });
    expect((await plain.get()).authHint).toContain('read_api');
  });
});
