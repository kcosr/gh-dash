import { describe, expect, it } from 'vitest';
import { SourceError } from '../provider/errors';
import type { DiffRepo, DiffSource } from '../provider/types';
import { fakeGitHub, type Handler, page, restFile, sha } from '../test/github';
import { supplyOf } from '../test/tokens';
import { GitHubClient } from './client';
import { GitHubDiffSource, GitHubDiffSources } from './diff-source';
import { GitHubRestClient } from './rest';

const REPO: DiffRepo = { key: 'app', owner: 'alice', name: 'app', path: 'alice/app' };
const BASE = sha('0');
const MERGE_BASE = sha('9');
const A = sha('a');
const B = sha('b');
const PULL = '/repos/alice/app/pulls/2';
const COMPARE = (head: string, baseSha = BASE) => `/repos/alice/app/compare/${baseSha}...${head}?per_page=1&page=2`;
const FILES = '/repos/alice/app/pulls/2/files?per_page=100';
const signal = new AbortController().signal;

function setup(routes: Record<string, Handler> = {}) {
  const gh = fakeGitHub(routes);
  const logs: string[] = [];
  const opts = { token: 'tok', fetchImpl: gh.fetchImpl, sleep: async () => {} };
  const source = new GitHubDiffSource({ rest: new GitHubRestClient(opts), graphql: new GitHubClient(opts), log: (line) => logs.push(line) });
  return { gh, source, logs };
}

/** GitHub serving app#2 at `head`: `pulls/2` answers its own ETag with 304, and the compare yields `mergeBase`. */
function pr2(routes: Record<string, Handler>, head: string, files: object[], over: { baseRef?: string; baseSha?: string; mergeBase?: string } = {}) {
  const { baseRef = 'main', baseSha = BASE, mergeBase = MERGE_BASE } = over;
  const body = { title: 'Add parser', html_url: 'https://github.com/alice/app/pull/2', changed_files: files.length, additions: 12, deletions: 3, head: { sha: head }, base: { sha: baseSha, ref: baseRef } };
  const etag = `W/"${head}-${baseRef}-${baseSha}"`;
  routes[PULL] = ({ headers }) => (headers['If-None-Match'] === etag ? { status: 304 } : { body, headers: { etag } });
  routes[COMPARE(head, baseSha)] = { body: { merge_base_commit: { sha: mergeBase } } };
  routes[FILES] = page(files, null);
}

/** Runs `change` right after GitHub serves `path`. */
function whenServed(routes: Record<string, Handler>, path: string, change: () => void) {
  const inner = routes[path]!;
  routes[path] = (req) => {
    const reply = typeof inner === 'function' ? inner(req) : inner;
    change();
    return reply;
  };
}

describe('GitHubDiffSource', () => {
  it("describes a PR by pulls/N and its merge base, then proves its files' snapshot with a free 304", async () => {
    const { gh, source } = setup();
    pr2(gh.routes, A, [restFile(1), restFile(2, { status: 'renamed', previous_filename: 'old/f2.ts', patch: undefined })]);
    const rev = await source.prRevision(REPO, 2, signal);
    expect(rev).toMatchObject({
      headOid: A, baseRef: 'main', baseOid: MERGE_BASE, title: 'Add parser', totalFiles: 2, additions: 12, deletions: 3,
      url: 'https://github.com/alice/app/pull/2/files',
    });
    expect(gh.requests).toEqual([PULL, COMPARE(A)]);

    const { rev: filesRev, files } = await source.prFiles(REPO, 2, rev, signal);
    expect(gh.requests.slice(2)).toEqual([FILES, PULL]);
    expect(filesRev).toMatchObject({ headOid: A, baseOid: MERGE_BASE });
    expect(files).toEqual([
      { path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a1\n+b1' },
      { path: 'src/f2.ts', previousPath: 'old/f2.ts', status: 'renamed', additions: 1, deletions: 1, patch: null },
    ]);
    expect(source.requests).toBe(4);
    expect(source.rateLimit).toEqual({ limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00.000Z' });
  });

  it("checks a PR's head with a conditional request", async () => {
    const { gh, source } = setup({
      '/repos/alice/app/commits/pull/2/head': ({ headers }) => (headers['If-None-Match'] === `"${A}"` ? { status: 304 } : { text: A }),
    });
    expect(await source.prHeadIs(REPO, 2, A, signal)).toBe(true);
    expect(await source.prHeadIs(REPO, 2, B, signal)).toBe(false);
    expect(gh.requests).toHaveLength(2);
  });

  it('returns the revision the files belong to when the PR moved, and gives up as transient when it keeps moving', async () => {
    const { gh, source, logs } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    const rev = await source.prRevision(REPO, 2, signal);
    whenServed(gh.routes, FILES, () => pr2(gh.routes, B, [restFile(2)]));
    gh.requests.length = 0;
    const moved = await source.prFiles(REPO, 2, rev, signal);
    expect(moved.rev.headOid).toBe(B);
    expect(moved.files.map((f) => f.path)).toEqual(['src/f2.ts']);
    expect(gh.requests).toEqual([FILES, PULL, COMPARE(B), FILES, PULL]);
    expect(logs).toEqual(['[diff] app#2 changed while its files were being fetched (attempt 1 of 2)']);

    let n = 0;
    const push = () => {
      pr2(gh.routes, sha(String(++n)), [restFile(n)]);
      whenServed(gh.routes, FILES, push);
    };
    whenServed(gh.routes, FILES, push);
    const err = await source.prFiles(REPO, 2, moved.rev, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ kind: 'transient', message: 'The pull request changed while its diff was being fetched; try again' });
  });

  it("doesn't ask for a merge base it already knows when a retarget restarts the snapshot", async () => {
    const { gh, source } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    const rev = await source.prRevision(REPO, 2, signal);
    // Retargeted to a branch at the same commit: same range, so the same merge base.
    whenServed(gh.routes, FILES, () => pr2(gh.routes, A, [restFile(1)], { baseRef: 'release' }));
    gh.requests.length = 0;
    const retargeted = await source.prFiles(REPO, 2, rev, signal);
    expect(gh.requests).toEqual([FILES, PULL, FILES, PULL]);
    expect(retargeted.rev).toMatchObject({ headOid: A, baseRef: 'release', baseOid: MERGE_BASE });
  });

  it("maps a commit, counting a capped list's files with GraphQL", async () => {
    const C = sha('c');
    const commit = (files: object[]) => ({
      sha: C, html_url: `https://github.com/alice/app/commit/${C}`, commit: { message: 'Fix CRLF\r\n\r\nBody' }, parents: [{ sha: sha('p') }], files,
    });
    const routes: Record<string, Handler> = {
      '/graphql': { body: { data: { repository: { object: { changedFilesIfAvailable: 3500 } }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } } },
    };
    for (let p = 1; p <= 10; p++) {
      routes[p === 1 ? `/repos/alice/app/commits/${C}` : `/repositories/1/commits/${C}?page=${p}`] = page(
        commit(Array.from({ length: 300 }, (_, i) => restFile(p * 1000 + i, { additions: 2 }))),
        `/repositories/1/commits/${C}?page=${p + 1}`,
      );
    }
    const { source } = setup(routes);
    const diff = await source.commit(REPO, C, signal);
    expect(diff).toMatchObject({ title: 'Fix CRLF', baseOid: sha('p'), headOid: C, totalFiles: 3500, additions: 6000, deletions: 3000, url: `https://github.com/alice/app/commit/${C}` });
    expect(diff.files).toHaveLength(3000);
    expect(source.requests).toBe(11);
    expect(source.maxFiles).toBe(3000);
  });

  it("reports an unknown commit (GitHub's 422) and a missing file as not-found", async () => {
    const { source } = setup({ [`/repos/alice/app/commits/${sha('e')}`]: { status: 422, body: { message: `No commit found for SHA: ${sha('e')}` } } });
    expect(await source.commit(REPO, sha('e'), signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 422 });
    expect(await source.commit(REPO, sha('f'), signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 404 });
    expect(await source.blob(REPO, A, 'missing.txt', 100, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 404 });
  });

  it('reads raw contents, telling files from directories and ones over the cap', async () => {
    const contents = (path: string) => `/repos/alice/app/contents/${path}?ref=${A}`;
    const { source } = setup({
      [contents('docs/a%20b.md')]: { text: 'hello' },
      [contents('src')]: { body: [{ name: 'a.ts', type: 'file' }] },
      [contents('big.txt')]: { text: 'x'.repeat(101) },
    });
    const file = await source.blob(REPO, A, 'docs/a b.md', 100, signal);
    expect(file.kind === 'file' && new TextDecoder().decode(file.bytes)).toBe('hello');
    expect(await source.blob(REPO, A, 'src', 100, signal)).toEqual({ kind: 'not-file' });
    expect(await source.blob(REPO, A, 'big.txt', 100, signal)).toEqual({ kind: 'too-large' });
  });
});

/** A `git diff` of `n` small modified files (from `first`), the way GitHub's `.diff` writes them. */
function diffText(n: number, first = 1) {
  const file = (i: number) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\nindex 1111111..2222222 100644\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1 +1,2 @@\n-a${i}\n+b${i}\n+c${i}\n`;
  return Array.from({ length: n }, (_, i) => file(first + i)).join('');
}

const HEAD = sha('c');
const BRANCH = '/repos/alice/app/commits/heads%2Ffeature%2Fx';
const COMPARE_JSON = `/repos/alice/app/compare/heads%2Fmain...${HEAD}?per_page=1`;
const COMPARE_DIFF = `/repos/alice/app/compare/${MERGE_BASE}...${HEAD}`;
const jsonCompare = (files: object[]): Handler => ({ body: { merge_base_commit: { sha: MERGE_BASE }, total_commits: 1, commits: [{ sha: HEAD }], files } });
const noPatch = (i: number, over: Record<string, unknown> = {}) => restFile(i, { patch: undefined, additions: 0, deletions: 0, ...over });

describe('GitHubDiffSource: branches', () => {
  it('asks for the head of a branch as heads/<name>, conditionally, and reports a missing one as not-found', async () => {
    const seen: Record<string, string>[] = [];
    const { gh, source } = setup({
      [BRANCH]: ({ headers }) => {
        seen.push(headers);
        return headers['If-None-Match'] === `"${A}"` ? { status: 304 } : { text: B };
      },
      '/repos/alice/app/commits/heads%2Fgone': { status: 422, body: { message: 'No commit found for SHA: heads/gone' } },
    });
    expect(await source.branchHead(REPO, 'feature/x', null, signal)).toBe(B);
    expect(await source.branchHead(REPO, 'feature/x', A, signal)).toBe(A);
    expect(await source.branchHead(REPO, 'feature/x', B, signal)).toBe(B);
    expect(seen.map((h) => [h.Accept, h['If-None-Match']])).toEqual([
      ['application/vnd.github.sha', undefined],
      ['application/vnd.github.sha', `"${A}"`],
      ['application/vnd.github.sha', `"${B}"`],
    ]);
    expect(await source.branchHead(REPO, 'gone', null, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 422 });
    // An unknown repository is a 404, as everywhere.
    expect(await source.branchHead({ ...REPO, name: 'nope' }, 'main', null, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 404 });
    expect(gh.requests).toHaveLength(5);
  });

  it('lists the files of a small comparison from one compare request, with the merge base and totals', async () => {
    const { gh, source } = setup({
      [COMPARE_JSON]: jsonCompare([restFile(1), restFile(2, { status: 'renamed', previous_filename: 'old/f2.ts', patch: undefined, additions: 0, deletions: 0 }), restFile(3, { status: 'changed', patch: undefined, additions: 0, deletions: 0 })]),
    });
    const out = await source.compare(REPO, 'main', HEAD, signal);
    expect(out).toEqual({
      baseOid: MERGE_BASE, headOid: HEAD, totalFiles: 3, additions: 1, deletions: 1,
      files: [
        { path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a1\n+b1' },
        { path: 'src/f2.ts', previousPath: 'old/f2.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
        { path: 'src/f3.ts', previousPath: null, status: 'changed', additions: 0, deletions: 0, patch: null },
      ],
    });
    // A pure rename and a mode change have no patch by nature: nothing to fetch again.
    expect(gh.requests).toEqual([COMPARE_JSON]);
    expect(source.requests).toBe(1);
  });

  it('reads a comparison with no files, and one whose branch is behind, as empty', async () => {
    const { source } = setup({ [COMPARE_JSON]: jsonCompare([]), [`/repos/alice/app/compare/heads%2Fmain...${A}?per_page=1`]: { body: { merge_base_commit: { sha: A } } } });
    expect(await source.compare(REPO, 'main', HEAD, signal)).toEqual({ baseOid: MERGE_BASE, headOid: HEAD, files: [], totalFiles: 0, additions: 0, deletions: 0 });
    expect(await source.compare(REPO, 'main', A, signal)).toMatchObject({ baseOid: A, headOid: A, files: [], totalFiles: 0 });
  });

  it("reads the whole diff from the merge base when GitHub's list may be cut at 300 files, with no limit but ours", async () => {
    const accepts: string[] = [];
    const { gh, source } = setup({
      [COMPARE_JSON]: jsonCompare(Array.from({ length: 300 }, (_, i) => restFile(i))),
      [COMPARE_DIFF]: ({ headers }) => (accepts.push(headers.Accept!), { text: diffText(3005) }),
    });
    const out = await source.compare(REPO, 'main', HEAD, signal);
    // Pinned to the merge base the compare named, not the branch: the base branch may move between the two requests.
    expect(gh.requests).toEqual([COMPARE_JSON, COMPARE_DIFF]);
    expect(accepts).toEqual(['application/vnd.github.diff']);
    expect(out).toMatchObject({ baseOid: MERGE_BASE, headOid: HEAD, totalFiles: 3005, additions: 3005 * 2, deletions: 3005 });
    expect(out.files).toHaveLength(source.maxFiles);
    expect(out.files[0]).toEqual({ path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-a1\n+b1\n+c1' });
    expect(out.files[2999]!.path).toBe('src/f3000.ts');
  });

  it('reads the diff when a file with content lacks its patch: counted as 0 by GitHub once its size budget is spent', async () => {
    // As cli/cli's v1.0.0...v2.0.0: 160 of 300 files, sporadically then all from the 144th, are "modified" with no patch and 0 lines.
    const { gh, source } = setup({
      [COMPARE_JSON]: jsonCompare([restFile(1), noPatch(2), restFile(3)]),
      [COMPARE_DIFF]: { text: diffText(3) },
    });
    const out = await source.compare(REPO, 'main', HEAD, signal);
    expect(gh.requests).toEqual([COMPARE_JSON, COMPARE_DIFF]);
    expect(out.files.map((f) => [f.path, f.additions, f.deletions, f.patch !== null])).toEqual([['src/f1.ts', 2, 1, true], ['src/f2.ts', 2, 1, true], ['src/f3.ts', 2, 1, true]]);
    expect(out).toMatchObject({ totalFiles: 3, additions: 6, deletions: 3 });
    // An added or removed file the same way, and a binary file (which no request can tell from those).
    for (const status of ['added', 'removed']) {
      const one = setup({ [COMPARE_JSON]: jsonCompare([noPatch(1, { status })]), [COMPARE_DIFF]: { text: diffText(1) } });
      expect((await one.source.compare(REPO, 'main', HEAD, signal)).files[0]!.patch).not.toBeNull();
      expect(one.gh.requests).toHaveLength(2);
    }
  });

  it("keeps GitHub's files when the diff is over the limit, or GitHub won't build it, and logs it", async () => {
    const files = [restFile(1), noPatch(2)];
    const big = setup({ [COMPARE_JSON]: jsonCompare(files), [COMPARE_DIFF]: { text: 'x', headers: { 'content-length': String(21 * 1024 * 1024) } } });
    const out = await big.source.compare(REPO, 'main', HEAD, signal);
    expect(out.files.map((f) => [f.path, f.patch !== null])).toEqual([['src/f1.ts', true], ['src/f2.ts', false]]);
    expect(out).toMatchObject({ baseOid: MERGE_BASE, totalFiles: 2, additions: 1, deletions: 1 });
    expect(big.logs).toEqual([`[diff] app: the diff of main...${HEAD.slice(0, 7)} is over 20 MB; listing what the compare has`]);

    const refused = setup({ [COMPARE_JSON]: jsonCompare(files), [COMPARE_DIFF]: { status: 406, body: { message: 'Sorry, this diff is taking too long to generate.' } } });
    expect((await refused.source.compare(REPO, 'main', HEAD, signal)).files).toHaveLength(2);
    expect(refused.logs).toHaveLength(1);

    // The list at its limit, over the size limit: 300 files is all that is known.
    const capped = setup({ [COMPARE_JSON]: jsonCompare(Array.from({ length: 300 }, (_, i) => restFile(i))), [COMPARE_DIFF]: { text: 'x', headers: { 'content-length': String(21 * 1024 * 1024) } } });
    expect(await capped.source.compare(REPO, 'main', HEAD, signal)).toMatchObject({ totalFiles: 300 });
  });

  it('distrusts a diff that has fewer files than the list', async () => {
    const { source, logs } = setup({ [COMPARE_JSON]: jsonCompare([restFile(1), noPatch(2), restFile(3)]), [COMPARE_DIFF]: { text: diffText(2) } });
    const out = await source.compare(REPO, 'main', HEAD, signal);
    expect(out.files.map((f) => f.path)).toEqual(['src/f1.ts', 'src/f2.ts', 'src/f3.ts']);
    expect(logs).toEqual([`[diff] app: the diff of main...${HEAD.slice(0, 7)} lacks files the compare lists; listing what the compare has`]);
  });

  it('fails as GitHub does: 404 for a base or head it does not have, or no common ancestor; limits and outages are not hidden', async () => {
    const none = setup({ [COMPARE_JSON]: { status: 404, body: { message: 'No common ancestor between main and cccc.' } } });
    expect(await none.source.compare(REPO, 'main', HEAD, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found', status: 404, message: expect.stringContaining('No common ancestor') });
    expect(await none.source.compare(REPO, 'nope', HEAD, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found' });

    const limited = setup({
      [COMPARE_JSON]: jsonCompare([noPatch(1)]),
      [COMPARE_DIFF]: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } },
    });
    expect(await limited.source.compare(REPO, 'main', HEAD, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'rate-limit' });
    const down = setup({ [COMPARE_JSON]: jsonCompare([noPatch(1)]), [COMPARE_DIFF]: { status: 502 } });
    expect(await down.source.compare(REPO, 'main', HEAD, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'transient' });
  });
});

describe('GitHubDiffSource: branch lists', () => {
  const REFS = '/graphql';
  const node = (name: string, date: string | null, oid = sha('1')) => ({ name, target: { oid, ...(date ? { committedDate: date } : {}) } });
  const reply = (nodes: (object | null)[], next: string | null = null) => ({
    body: {
      data: { repository: { refs: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } },
    },
  });

  it('lists the newest first, those without a date last, and asks GraphQL with the repo and the name filter', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const { source } = setup({
      [REFS]: (req) => (calls.push(req.body as (typeof calls)[number]), reply([node('old', '2026-01-01T00:00:00Z'), node('undated', null), node('new/x', '2026-09-01T00:00:00Z', sha('2')), null, { name: 'broken', target: null }, node('mid', '2026-05-05T00:00:00Z'), node('mid-b', '2026-05-05T00:00:00Z')])),
    });
    const out = await source.branches(REPO, 'x', 100, signal);
    expect(out.items.map((b) => b.name)).toEqual(['new/x', 'mid', 'mid-b', 'old', 'undated']);
    expect(out.items[0]).toEqual({ name: 'new/x', headOid: sha('2'), committedAt: '2026-09-01T00:00:00Z' });
    expect(out.items[4]).toEqual({ name: 'undated', headOid: sha('1'), committedAt: null });
    expect(out.more).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toEqual({ owner: 'alice', name: 'app', query: 'x', after: null });
    expect(calls[0]!.query).toMatch(/^query/);
    expect(calls[0]!.query).toContain('refPrefix: "refs/heads/"');
  });

  it('reads pages until there are no more, so the newest of many branches is found wherever it sorts alphabetically', async () => {
    const afters: unknown[] = [];
    const { source, gh } = setup({
      [REFS]: (req) => {
        const after = (req.body as { variables: { after: string | null } }).variables.after;
        afters.push(after);
        if (after === null) return reply([node('a', '2026-01-01T00:00:00Z'), node('b', '2026-01-02T00:00:00Z')], 'c1');
        if (after === 'c1') return reply([node('c', '2026-01-03T00:00:00Z')], 'c2');
        return reply([node('z-newest', '2026-09-09T00:00:00Z')]);
      },
    });
    const out = await source.branches(REPO, null, 100, signal);
    expect(afters).toEqual([null, 'c1', 'c2']);
    expect(out.items.map((b) => b.name)).toEqual(['z-newest', 'c', 'b', 'a']);
    expect(out.more).toBe(false);
    expect(gh.requests).toEqual(['/graphql', '/graphql', '/graphql']);
    expect(source.requests).toBe(3);
  });

  it('cuts the list to the limit and says there are more; stops after five pages and says so', async () => {
    const many = setup({ [REFS]: reply(Array.from({ length: 5 }, (_, i) => node(`b${i}`, `2026-01-0${i + 1}T00:00:00Z`))) });
    const out = await many.source.branches(REPO, null, 3, signal);
    expect(out.items.map((b) => b.name)).toEqual(['b4', 'b3', 'b2']);
    expect(out.more).toBe(true);
    expect((await many.source.branches(REPO, null, 5, signal)).more).toBe(false);

    let pages = 0;
    const endless = setup({ [REFS]: () => reply([node(`p${++pages}`, '2026-01-01T00:00:00Z')], `c${pages}`) });
    const capped = await endless.source.branches(REPO, null, 100, signal);
    expect(capped.items).toHaveLength(5);
    expect(capped.more).toBe(true);
    expect(pages).toBe(5);
  });

  it('reports a repository GitHub does not have as not-found', async () => {
    const { source } = setup({ [REFS]: { body: { data: { repository: null, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } } } });
    expect(await source.branches(REPO, null, 100, signal).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found' });
  });
});

describe('GitHubDiffSources', () => {
  it('makes one source per token and forgets a rejected one', async () => {
    const token = { value: 'one' as string | null };
    const tokens = supplyOf(() => token.value);
    const invalidated: (string | undefined)[] = [];
    tokens.invalidate = (t) => invalidated.push(t);
    const sources = new GitHubDiffSources({ tokens, log: () => {} });

    const first = await sources.get();
    expect(await sources.get()).toBe(first);
    token.value = 'two';
    const second = await sources.get();
    expect(second).not.toBe(first);

    // A fetch that started with the old token names that one.
    sources.authFailed(first);
    expect(invalidated).toEqual(['one']);
    expect(await sources.get()).toBe(second);
    sources.authFailed(second);
    expect(invalidated).toEqual(['one', 'two']);
    expect(await sources.get()).not.toBe(second);

    token.value = null;
    expect(await sources.get().catch((e: unknown) => e)).toMatchObject({ kind: 'auth', message: 'No GitHub token: none for this test' });
    expect(first).toMatchObject({ kind: 'github', authHint: 'check GITHUB_TOKEN or run `gh auth login`' });
  });

  it('ignores sources it did not make', () => {
    const tokens = supplyOf(() => 'tok');
    const sources = new GitHubDiffSources({ tokens });
    sources.authFailed({ kind: 'gitlab' } as DiffSource);
    expect(tokens.invalidated).toBe(0);
  });
});
