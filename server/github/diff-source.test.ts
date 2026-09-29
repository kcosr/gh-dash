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
