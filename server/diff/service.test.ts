import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Diff } from '../../shared/api';
import { HttpError } from '../api/http';
import { patchSettings } from '../db/settings';
import { fakeGitHub, page, type Reply, restFile, sha } from '../test/github';
import { seedDb } from '../test/seed';
import { DiffCache } from './cache';
import { DiffService, MAX_BLOB_BYTES, type Payload, payloadText } from './service';

const BASE = sha('0');
const MERGE_BASE = sha('9');
const A = sha('a');
const B = sha('b');

function setup(routes: Record<string, Reply | ((req: { headers: Record<string, string> }) => Reply)> = {}) {
  const db = seedDb();
  const gh = fakeGitHub(routes);
  const token = { value: 'tok' as string | null };
  const logs: string[] = [];
  const svc = new DiffService({
    db,
    cache: new DiffCache(':memory:'),
    resolveToken: () => ({ token: token.value, source: token.value ? 'env' : 'none' }),
    fetchImpl: gh.fetchImpl,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  /** Requests made by `fn`. */
  const spent = async <T>(fn: () => Promise<T>) => {
    gh.requests.length = 0;
    const out = await fn();
    return { out, requests: [...gh.requests] };
  };
  const setHead = (number: number, head: string | null) =>
    db.run("UPDATE pull_requests SET head_oid = ? WHERE number = ? AND repo_id = (SELECT id FROM repos WHERE name = 'app')", [head, number]);
  return { db, gh, svc, token, logs, spent, setHead };
}

const diffOf = async (p: Payload | Promise<Payload>) => JSON.parse(await payloadText(await p)) as Diff;
const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof HttpError ? e.status : e));

/** GitHub serving app#2 at `head`, with `files` over pages of 100. */
function pr2(routes: Record<string, unknown>, head: string, files: object[], over: Record<string, unknown> = {}) {
  routes['/repos/alice/app/pulls/2'] = {
    body: { title: 'Add parser', html_url: 'https://github.com/alice/app/pull/2', changed_files: files.length, additions: 12, deletions: 3, head: { sha: head }, base: { sha: BASE }, ...over },
  };
  routes[`/repos/alice/app/compare/${BASE}...${head}?per_page=1&page=2`] = { body: { merge_base_commit: { sha: MERGE_BASE }, commits: [] } };
  const path = '/repos/alice/app/pulls/2/files';
  for (let i = 0; i * 100 < Math.max(files.length, 1); i++) {
    const next = (i + 1) * 100 < files.length ? `${path}?per_page=100&page=${i + 2}` : null;
    routes[i ? `${path}?per_page=100&page=${i + 1}` : `${path}?per_page=100`] = page(files.slice(i * 100, (i + 1) * 100), next);
  }
  routes['/repos/alice/app/commits/pull/2/head'] = ({ headers }: { headers: Record<string, string> }) =>
    headers['If-None-Match'] === `"${head}"` ? { status: 304 } : { text: head };
}

const PR_FILES_PATH = ['/repos/alice/app/pulls/2', `/repos/alice/app/compare/${BASE}...${A}?per_page=1&page=2`, '/repos/alice/app/pulls/2/files?per_page=100'];

describe('PR diffs', () => {
  it('fetches a PR diff against its merge base once, then serves it by head with no request', async () => {
    const files = [restFile(1), restFile(2, { status: 'added', patch: undefined }), restFile(3, { status: 'renamed', previous_filename: 'old/f3.ts' })];
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, files);
    setHead(2, A);

    const miss = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(miss.requests).toEqual(PR_FILES_PATH);
    expect(miss.out).toEqual({
      kind: 'pr', repo: 'app', number: 2, title: 'Add parser', baseOid: MERGE_BASE, headOid: A,
      files: [
        { path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a1\n+b1' },
        { path: 'src/f2.ts', previousPath: null, status: 'added', additions: 1, deletions: 1, patch: null },
        { path: 'src/f3.ts', previousPath: 'old/f3.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a3\n+b3' },
      ],
      totalFiles: 3, additions: 12, deletions: 3, fetchedAt: expect.any(String), url: 'https://github.com/alice/app/pull/2/files',
    });

    const hit = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(hit.requests).toEqual([]);
    expect(hit.out).toEqual(miss.out);
  });

  it('without a synced head, revalidates a cached diff with a conditional request (free when unchanged)', async () => {
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    setHead(2, null);
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual(PR_FILES_PATH);
    const again = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(again.requests).toEqual(['/repos/alice/app/commits/pull/2/head']);
    expect(again.out.headOid).toBe(A);
  });

  it('refresh=1 picks up a pushed head and the new diff supersedes the old one', async () => {
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    setHead(2, A);
    await svc.prDiff('app', 2);
    pr2(gh.routes, B, [restFile(1), restFile(2)]);

    // Not refreshed: the synced head is trusted.
    expect((await spent(() => diffOf(svc.prDiff('app', 2)))).out.headOid).toBe(A);
    const refreshed = await spent(() => diffOf(svc.prDiff('app', 2, true)));
    expect(refreshed.requests).toEqual([
      '/repos/alice/app/commits/pull/2/head',
      '/repos/alice/app/pulls/2',
      `/repos/alice/app/compare/${BASE}...${B}?per_page=1&page=2`,
      '/repos/alice/app/pulls/2/files?per_page=100',
    ]);
    expect(refreshed.out).toMatchObject({ headOid: B, totalFiles: 2 });
    expect(svc.stats().entries).toBe(1);

    // The sync still says A (stale): one request finds B, which is cached.
    const stale = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(stale.requests).toEqual(['/repos/alice/app/pulls/2']);
    expect(stale.out.headOid).toBe(B);
    // Once the sync catches up, no requests at all.
    setHead(2, B);
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);
  });

  it('replaces the cached diff when the sync reports a new head', async () => {
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    setHead(2, A);
    await svc.prDiff('app', 2);
    pr2(gh.routes, B, [restFile(2)]);
    setHead(2, B);
    const moved = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(moved.requests).toHaveLength(3);
    expect(moved.out.files.map((f) => f.path)).toEqual(['src/f2.ts']);
    expect(svc.stats().entries).toBe(1);
  });

  it("lists at most GitHub's 3000 files but reports the PR's full count", async () => {
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, Array.from({ length: 3100 }, (_, i) => restFile(i)), { changed_files: 3500 });
    setHead(2, A);
    const { out, requests } = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(out.files).toHaveLength(3000);
    expect(out.totalFiles).toBe(3500);
    expect(requests).toHaveLength(2 + 30);
  });

  it('shares one fetch between identical concurrent requests', async () => {
    const { svc, spent, setHead, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    setHead(2, A);
    const { out, requests } = await spent(() => Promise.all([svc.prDiff('app', 2), svc.prDiff('app', 2)]));
    expect(requests).toHaveLength(3);
    expect(out[0]).toBe(out[1]);
  });

  it('maps missing things, missing tokens and GitHub failures to API errors', async () => {
    const { svc, spent, setHead, gh, token } = setup();
    setHead(2, A);
    expect(await status(svc.prDiff('nope', 1))).toBe(404);
    const unknown = await spent(() => status(svc.prDiff('app', 99)));
    expect(unknown).toEqual({ out: 404, requests: [] });

    token.value = null;
    expect(await status(svc.prDiff('app', 2))).toBe(503);
    token.value = 'tok';
    // GitHub no longer has it.
    expect(await status(svc.prDiff('app', 2))).toBe(404);

    gh.routes['/repos/alice/app/pulls/2'] = { status: 500 };
    expect(await status(svc.prDiff('app', 2))).toBe(502);

    // A cached diff needs no token.
    pr2(gh.routes, A, [restFile(1)]);
    await svc.prDiff('app', 2);
    token.value = null;
    expect(await status(svc.prDiff('app', 2))).toBe(200);
    token.value = 'tok';

    gh.routes['/repos/alice/app/pulls/1'] = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } };
    const limited = await svc.prDiff('app', 1).catch((e: HttpError) => e);
    expect(limited).toMatchObject({ status: 429, details: { resetAt: '2099-01-01T00:00:00.000Z' } });
    // Until the reset, nothing more is sent.
    const after = await spent(() => status(svc.prDiff('app', 2, true)));
    expect(after).toEqual({ out: 429, requests: [] });
  });
});

describe('commit diffs', () => {
  const commit = (oid: string, parents: string[], files: object[], message = 'Initial import\n\nWith a body') => ({
    sha: oid, html_url: `https://github.com/alice/app/commit/${oid}`, commit: { message }, parents: parents.map((p) => ({ sha: p })),
    stats: { additions: 700, deletions: 5 }, files,
  });

  it('fetches a root commit across pages of files and keeps it', async () => {
    const C = sha('c');
    const { svc, spent } = setup({
      [`/repos/alice/app/commits/${C}`]: page(commit(C, [], Array.from({ length: 300 }, (_, i) => restFile(i))), `/repositories/1/commits/${C}?page=2`),
      [`/repositories/1/commits/${C}?page=2`]: page(commit(C, [], [restFile(300), restFile(301, { patch: undefined })]), null),
    });
    const miss = await spent(() => diffOf(svc.commitDiff('app', C.toUpperCase())));
    expect(miss.requests).toHaveLength(2);
    expect(miss.out).toMatchObject({
      kind: 'commit', repo: 'app', number: null, title: 'Initial import', baseOid: null, headOid: C, totalFiles: 302,
      additions: 700, deletions: 5, url: `https://github.com/alice/app/commit/${C}`,
    });
    expect(miss.out.files).toHaveLength(302);
    expect(miss.out.files[301]!.patch).toBeNull();
    expect((await spent(() => svc.commitDiff('app', C))).requests).toEqual([]);
  });

  it('expands short SHAs from synced commits or the cache', async () => {
    const synced = 'c1'.padEnd(40, '0');
    const unsynced = 'def4567'.padEnd(40, '1');
    const { svc, spent } = setup({
      [`/repos/alice/app/commits/${synced}`]: { body: commit(synced, [sha('p')], [restFile(1)], 'Merge pull request #1') },
      '/repos/alice/app/commits/def4567': { body: commit(unsynced, [sha('p')], [restFile(1)]) },
    });
    expect((await diffOf(svc.commitDiff('app', 'C100000'))).baseOid).toBe(sha('p'));
    expect((await spent(() => svc.commitDiff('app', synced))).requests).toEqual([]);
    expect((await diffOf(svc.commitDiff('app', 'def4567'))).headOid).toBe(unsynced);
    expect((await spent(() => svc.commitDiff('app', 'def4567'))).requests).toEqual([]);
    expect((await spent(() => svc.commitDiff('app', unsynced))).requests).toEqual([]);
  });

  it("asks GraphQL for the real file count when GitHub's list stops at 3000", async () => {
    const C = sha('c');
    const routes: Record<string, Reply | (() => Reply)> = {
      '/graphql': () => ({ body: { data: { repository: { object: { changedFilesIfAvailable: 5048 } }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } } }),
    };
    for (let p = 1; p <= 11; p++) {
      routes[p === 1 ? `/repos/alice/app/commits/${C}` : `/repositories/1/commits/${C}?page=${p}`] = page(
        commit(C, [], Array.from({ length: 300 }, (_, i) => restFile(p * 1000 + i))),
        `/repositories/1/commits/${C}?page=${p + 1}`,
      );
    }
    const { svc, spent } = setup(routes);
    const { out, requests } = await spent(() => diffOf(svc.commitDiff('app', C)));
    expect(out.files).toHaveLength(3000);
    expect(out.totalFiles).toBe(5048);
    expect(requests).toHaveLength(10 + 1);
    expect(requests.at(-1)).toBe('/graphql');
  });

  it('rejects bad SHAs and reports unknown commits as 404', async () => {
    const { svc } = setup({ [`/repos/alice/app/commits/${sha('e')}`]: { status: 422, body: { message: `No commit found for SHA: ${sha('e')}` } } });
    for (const bad of ['xyz1234', '123456', sha('a') + 'a', 'HEAD']) expect(await status(svc.commitDiff('app', bad))).toBe(400);
    expect(await status(svc.commitDiff('app', sha('e')))).toBe(404);
    expect(await status(svc.commitDiff('nope', sha('e')))).toBe(404);
  });
});

describe('file contents', () => {
  const REF = sha('a');
  const contents = (path: string) => `/repos/alice/app/contents/${path}?ref=${REF}`;

  it('serves text at a commit and caches it', async () => {
    const { svc, spent } = setup({ [contents('docs/a%20b.md')]: { text: '﻿hello\nworld\n' } });
    expect(await payloadText(await svc.blob('app', REF, 'docs/a b.md'))).toBe('﻿hello\nworld\n');
    expect((await spent(() => svc.blob('app', REF, 'docs/a b.md'))).requests).toEqual([]);
  });

  it('refuses binary, oversized, missing and non-file paths, and bad input', async () => {
    const binary = new Uint8Array(100);
    binary.set([0x89, 0x50, 0x4e, 0x47]);
    const { svc, spent } = setup({
      [contents('logo.png')]: { text: binary },
      [contents('big.txt')]: { text: 'x', headers: { 'content-length': String(MAX_BLOB_BYTES + 1) } },
      [contents('src')]: { body: [{ name: 'a.ts', type: 'file' }] },
    });
    expect(await status(svc.blob('app', REF, 'logo.png'))).toBe(415);
    expect(await status(svc.blob('app', REF, 'big.txt'))).toBe(413);
    expect(await status(svc.blob('app', REF, 'missing.txt'))).toBe(404);
    expect(await status(svc.blob('app', REF, 'src'))).toBe(404);
    expect(await status(svc.blob('nope', REF, 'a.txt'))).toBe(404);
    const bad = await spent(async () => {
      const codes = [];
      for (const ref of ['main', 'abc', `${REF}0`]) codes.push(await status(svc.blob('app', ref, 'a.txt')));
      for (const path of ['', '/etc/passwd', 'a//b', '../x', 'a/./b', 'a/..']) codes.push(await status(svc.blob('app', REF, path)));
      return codes;
    });
    expect(bad.out).toEqual(Array(9).fill(400));
    expect(bad.requests).toEqual([]);
  });

  it('evicts least recently used entries once the cache passes its cap', async () => {
    // Base64 of random bytes: ~3 MB compressed per 4 MB file, so four of them pass a 10 MB cap.
    const routes: Record<string, Reply> = {};
    for (const n of [1, 2, 3, 4]) routes[contents(`f${n}.txt`)] = { text: randomBytes(3 * 1024 * 1024).toString('base64') };
    const { svc, db, spent } = setup(routes);
    patchSettings(db, { diffCacheMb: 10 });
    for (const n of [1, 2, 3]) await svc.blob('app', REF, `f${n}.txt`);
    expect(svc.stats().entries).toBe(3);
    await svc.blob('app', REF, 'f1.txt'); // f2 is now the least recently used
    await svc.blob('app', REF, 'f4.txt');
    const { bytes, maxBytes } = svc.stats();
    expect(maxBytes).toBe(10 * 1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(maxBytes * 0.9);
    expect((await spent(() => svc.blob('app', REF, 'f4.txt'))).requests).toEqual([]);
    expect((await spent(() => svc.blob('app', REF, 'f1.txt'))).requests).toEqual([]);
    expect((await spent(() => svc.blob('app', REF, 'f2.txt'))).requests).toHaveLength(1);
  });
});
