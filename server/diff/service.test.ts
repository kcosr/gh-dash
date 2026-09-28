import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Diff } from '../../shared/api';
import { HttpError } from '../api/http';
import type { Db } from '../db/db';
import { patchSettings } from '../db/settings';
import { fakeGitHub, type Handler as Route, page, type Reply, restFile, sha } from '../test/github';
import { seedDb } from '../test/seed';
import { DiffCache } from './cache';
import { DiffService, MAX_BLOB_BYTES, OPEN_PR_TTL_MS, type Payload, payloadText } from './service';

const BASE = sha('0');
const MERGE_BASE = sha('9');
const A = sha('a');
const B = sha('b');
const HOUR = 3_600_000;

function setup(routes: Record<string, Route> = {}, opts: { fetchImpl?: (inner: typeof fetch) => typeof fetch; buildTimeoutMs?: number } = {}) {
  const db = seedDb();
  const gh = fakeGitHub(routes);
  const token = { value: 'tok' as string | null, resolved: 0 };
  const logs: string[] = [];
  const clock = { t: Date.parse('2026-09-28T00:00:00Z') };
  let tick = 0;
  // The cache's clock only orders accesses (LRU); it must advance between them.
  const cache = new DiffCache(':memory:', () => clock.t + tick++);
  const svc = new DiffService({
    db,
    cache,
    resolveToken: () => {
      token.resolved++;
      return { token: token.value, source: token.value ? 'env' : 'none' };
    },
    fetchImpl: opts.fetchImpl ? opts.fetchImpl(gh.fetchImpl) : gh.fetchImpl,
    sleep: async () => {},
    log: (line) => logs.push(line),
    now: () => clock.t,
    buildTimeoutMs: opts.buildTimeoutMs,
  });
  /** Requests made by `fn`. */
  const spent = async <T>(fn: () => Promise<T>) => {
    gh.requests.length = 0;
    const out = await fn();
    return { out, requests: [...gh.requests] };
  };
  /** What the last sync recorded for app#number. */
  const synced = (number: number, fields: { head_oid?: string | null; base_ref?: string; updated_at?: string; state?: string }) => {
    for (const [col, value] of Object.entries(fields)) {
      db.run(`UPDATE pull_requests SET ${col} = ? WHERE number = ? AND repo_id = (SELECT id FROM repos WHERE name = 'app')`, [value, number]);
    }
  };
  const iso = (t: number) => new Date(t).toISOString();
  return { db, gh, svc, cache, token, logs, clock, spent, synced, iso };
}

const diffOf = async (p: Payload | Promise<Payload>) => JSON.parse(await payloadText(await p)) as Diff;
const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof HttpError ? e.status : e));

type PrState = { mergeBase?: string; baseRef?: string; baseSha?: string; title?: string; changed_files?: number };

/**
 * GitHub serving app#2 at `head` against `mergeBase`, with `files` over pages of 100. `pulls/2` carries a weak ETag
 * derived from its body and answers a matching If-None-Match with 304, as GitHub does.
 */
function pr2(routes: Record<string, Route>, head: string, files: object[], over: PrState = {}) {
  const { mergeBase = MERGE_BASE, baseRef = 'main', baseSha = BASE, ...pull } = over;
  const body = {
    title: 'Add parser', html_url: 'https://github.com/alice/app/pull/2', changed_files: files.length, additions: 12, deletions: 3,
    head: { sha: head }, base: { sha: baseSha, ref: baseRef }, ...pull,
  };
  const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
  routes['/repos/alice/app/pulls/2'] = ({ headers }) => (headers['If-None-Match'] === etag ? { status: 304 } : { body, headers: { etag } });
  routes[`/repos/alice/app/compare/${baseSha}...${head}?per_page=1&page=2`] = { body: { merge_base_commit: { sha: mergeBase }, commits: [] } };
  const path = '/repos/alice/app/pulls/2/files';
  for (let i = 0; i * 100 < Math.max(files.length, 1); i++) {
    const next = (i + 1) * 100 < files.length ? `${path}?per_page=100&page=${i + 2}` : null;
    routes[i ? `${path}?per_page=100&page=${i + 1}` : `${path}?per_page=100`] = page(files.slice(i * 100, (i + 1) * 100), next);
  }
  routes['/repos/alice/app/commits/pull/2/head'] = ({ headers }) => (headers['If-None-Match'] === `"${head}"` ? { status: 304 } : { text: head });
}

const PULL = '/repos/alice/app/pulls/2';
const COMPARE = (head: string, baseSha = BASE) => `/repos/alice/app/compare/${baseSha}...${head}?per_page=1&page=2`;
const FILES = '/repos/alice/app/pulls/2/files?per_page=100';
const HEAD = '/repos/alice/app/commits/pull/2/head';
/**
 * A full fetch of a small PR: the PR, its merge base, one page of files, then a conditional re-read of the PR that
 * proves nothing changed meanwhile (a 304, which GitHub doesn't count). 3 requests against the rate limit.
 */
const FULL = (head: string, baseSha = BASE) => [PULL, COMPARE(head, baseSha), FILES, PULL];

/** Runs `change` right after GitHub serves `path` (e.g. a push landing mid-pagination); `times` = how often. */
function whenServed(routes: Record<string, Route>, path: string, change: () => void, times = 1) {
  const inner = routes[path]!;
  routes[path] = (req) => {
    const reply = typeof inner === 'function' ? inner(req) : inner;
    change();
    if (times > 1) whenServed(routes, path, change, times - 1);
    return reply;
  };
}

describe('PR diffs', () => {
  it('fetches a PR diff against its merge base once, then serves it with no request while the sync agrees', async () => {
    const files = [restFile(1), restFile(2, { status: 'added', patch: undefined }), restFile(3, { status: 'renamed', previous_filename: 'old/f3.ts' })];
    const { svc, spent, synced, gh, clock } = setup();
    pr2(gh.routes, A, files);
    synced(2, { head_oid: A });

    const miss = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(miss.requests).toEqual(FULL(A));
    expect(miss.out).toEqual({
      kind: 'pr', repo: 'app', number: 2, title: 'Add parser', baseOid: MERGE_BASE, headOid: A,
      files: [
        { path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a1\n+b1' },
        { path: 'src/f2.ts', previousPath: null, status: 'added', additions: 1, deletions: 1, patch: null },
        { path: 'src/f3.ts', previousPath: 'old/f3.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a3\n+b3' },
      ],
      totalFiles: 3, additions: 12, deletions: 3, fetchedAt: new Date(clock.t).toISOString(), url: 'https://github.com/alice/app/pull/2/files',
    });

    clock.t += 10 * 60_000;
    const hit = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(hit.requests).toEqual([]);
    expect(hit.out).toEqual(miss.out);
  });

  it('confirms a head the sync has not recorded with a conditional request (free when unchanged)', async () => {
    const { svc, spent, synced, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: null });
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual(FULL(A));
    const again = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(again.requests).toEqual([HEAD]);
    expect(again.out.headOid).toBe(A);
  });

  it('refresh=1 always re-checks the PR and merge base, but refetches files only when they changed', async () => {
    const { svc, spent, synced, gh, clock } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: A });
    await svc.prDiff('app', 2);

    // Only the title changed on GitHub.
    clock.t += 60_000;
    pr2(gh.routes, A, [restFile(1)], { title: 'Add a faster parser' });
    const retitled = await spent(() => diffOf(svc.prDiff('app', 2, true)));
    expect(retitled.requests).toEqual([PULL, COMPARE(A)]);
    expect(retitled.out).toMatchObject({ title: 'Add a faster parser', headOid: A, fetchedAt: new Date(clock.t).toISOString() });
    expect(retitled.out.files).toHaveLength(1);

    // A push: the new head's diff replaces the old one.
    pr2(gh.routes, B, [restFile(1), restFile(2)]);
    const pushed = await spent(() => diffOf(svc.prDiff('app', 2, true)));
    expect(pushed.requests).toEqual(FULL(B));
    expect(pushed.out).toMatchObject({ headOid: B, totalFiles: 2 });
    expect(svc.stats().entries).toBe(1);

    // The sync still says A: the newer cached head is confirmed for free.
    const stale = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(stale.requests).toEqual([HEAD]);
    expect(stale.out.headOid).toBe(B);
    // Once the sync catches up, no requests at all.
    synced(2, { head_oid: B, updated_at: new Date(clock.t - 1000).toISOString() });
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);
  });

  it('revalidates when the sync reports the PR updated since the diff was fetched', async () => {
    const { svc, spent, synced, gh, clock, iso } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: A });
    await svc.prDiff('app', 2);

    // A title edit (or a comment): the PR's own fields are refreshed, the files kept.
    clock.t += 60_000;
    synced(2, { updated_at: iso(clock.t - 1000) });
    pr2(gh.routes, A, [restFile(1)], { title: 'Renamed' });
    const edited = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(edited.requests).toEqual([PULL, COMPARE(A)]);
    expect(edited.out.title).toBe('Renamed');
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);

    // A push the sync has seen.
    clock.t += 60_000;
    synced(2, { head_oid: B, updated_at: iso(clock.t - 1000) });
    pr2(gh.routes, B, [restFile(2)]);
    const moved = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(moved.requests).toEqual(FULL(B));
    expect(moved.out.files.map((f) => f.path)).toEqual(['src/f2.ts']);
    expect(svc.stats().entries).toBe(1);
  });

  it('recomputes the diff when a PR is retargeted, even with the same head', async () => {
    const { svc, spent, synced, gh } = setup();
    pr2(gh.routes, A, [restFile(1), restFile(2)], { baseRef: 'feature-a' });
    synced(2, { head_oid: A, base_ref: 'feature-a' });
    await svc.prDiff('app', 2);

    // Stacked PR retargeted to main after its parent merged: a new merge base and fewer files. The sync recorded the
    // new base branch (without relying on updatedAt here).
    synced(2, { base_ref: 'main' });
    pr2(gh.routes, A, [restFile(2)], { baseRef: 'main', mergeBase: sha('8') });
    const retargeted = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(retargeted.requests).toEqual(FULL(A));
    expect(retargeted.out).toMatchObject({ baseOid: sha('8'), headOid: A, totalFiles: 1 });
    expect(svc.stats().entries).toBe(1);
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);
  });

  it("re-checks an open PR's merge base after an hour; merged PRs are final", async () => {
    const { svc, spent, synced, gh, clock } = setup();
    pr2(gh.routes, A, [restFile(1), restFile(2)]);
    synced(2, { head_oid: A });
    await svc.prDiff('app', 2);

    // The base branch absorbed one of the PR's commits: the merge base moved, the PR itself didn't change.
    pr2(gh.routes, A, [restFile(2)], { mergeBase: sha('8') });
    clock.t += OPEN_PR_TTL_MS - 1;
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);
    clock.t += 2;
    const rechecked = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(rechecked.requests).toEqual(FULL(A));
    expect(rechecked.out).toMatchObject({ baseOid: sha('8'), totalFiles: 1 });

    // Unchanged after another hour: two cheap requests, no files.
    clock.t += OPEN_PR_TTL_MS;
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([PULL, COMPARE(A)]);

    synced(2, { state: 'merged' });
    clock.t += 100 * HOUR;
    expect((await spent(() => svc.prDiff('app', 2))).requests).toEqual([]);
  });

  it('starts over when the PR is pushed to while its files are fetched', async () => {
    const { svc, spent, synced, gh, logs } = setup();
    pr2(gh.routes, A, [restFile(1), restFile(2)]);
    whenServed(gh.routes, FILES, () => pr2(gh.routes, B, [restFile(3)]));
    synced(2, { head_oid: A });
    // Two viewers at once still share one build, retry included.
    const both = await spent(() => Promise.all([svc.prDiff('app', 2), svc.prDiff('app', 2)]));
    expect(both.out[0]).toBe(both.out[1]);
    const { out, requests } = { out: await diffOf(both.out[0]), requests: both.requests };
    // The re-read shows head B: A's files are dropped and B is fetched from the fresh metadata (no extra pulls/N).
    expect(requests).toEqual([PULL, COMPARE(A), FILES, PULL, COMPARE(B), FILES, PULL]);
    expect(out).toMatchObject({ headOid: B, totalFiles: 1 });
    expect(out.files.map((f) => f.path)).toEqual(['src/f3.ts']);
    expect(svc.stats().entries).toBe(1);
    expect(logs.some((l) => l.includes('changed while its files were being fetched (attempt 1 of 2)'))).toBe(true);
  });

  it('detects a retarget or a moved merge base during pagination, even with the same head', async () => {
    const retarget = setup();
    pr2(retarget.gh.routes, A, [restFile(1), restFile(2)]);
    whenServed(retarget.gh.routes, FILES, () => pr2(retarget.gh.routes, A, [restFile(2)], { baseRef: 'release', baseSha: sha('5'), mergeBase: sha('8') }));
    const retargeted = await retarget.spent(() => diffOf(retarget.svc.prDiff('app', 2)));
    expect(retargeted.requests).toEqual([PULL, COMPARE(A), FILES, PULL, COMPARE(A, sha('5')), FILES, PULL]);
    expect(retargeted.out).toMatchObject({ headOid: A, baseOid: sha('8'), totalFiles: 1 });

    // Same base branch, but it moved and absorbed a head commit: a new merge base.
    const moved = setup();
    pr2(moved.gh.routes, A, [restFile(1), restFile(2)]);
    whenServed(moved.gh.routes, FILES, () => pr2(moved.gh.routes, A, [restFile(2)], { baseSha: sha('5'), mergeBase: sha('8') }));
    const rebased = await moved.spent(() => diffOf(moved.svc.prDiff('app', 2)));
    expect(rebased.requests).toEqual([PULL, COMPARE(A), FILES, PULL, COMPARE(A, sha('5')), FILES, PULL]);
    expect(rebased.out).toMatchObject({ headOid: A, baseOid: sha('8'), files: [{ path: 'src/f2.ts' }] });

    // The base moved without touching the merge base (and the title changed): the files stand, one compare confirms it.
    const benign = setup();
    pr2(benign.gh.routes, A, [restFile(1)]);
    whenServed(benign.gh.routes, FILES, () => pr2(benign.gh.routes, A, [restFile(1)], { baseSha: sha('5'), title: 'Renamed' }));
    const kept = await benign.spent(() => diffOf(benign.svc.prDiff('app', 2)));
    expect(kept.requests).toEqual([...FULL(A), COMPARE(A, sha('5'))]);
    expect(kept.out).toMatchObject({ headOid: A, baseOid: MERGE_BASE, title: 'Renamed' });
  });

  it('gives up with a retryable 502, caching nothing, when the PR keeps changing', async () => {
    const { svc, spent, synced, gh, logs } = setup();
    let n = 0;
    const push = () => {
      pr2(gh.routes, sha(String(++n)), [restFile(n)]);
      whenServed(gh.routes, FILES, push);
    };
    pr2(gh.routes, A, [restFile(0)]);
    whenServed(gh.routes, FILES, push);
    synced(2, { head_oid: A });
    const failed = await spent(() => svc.prDiff('app', 2).catch((e: HttpError) => e));
    expect(failed.out).toMatchObject({ status: 502, message: 'The pull request changed while its diff was being fetched; try again' });
    expect(failed.requests).toEqual([PULL, COMPARE(A), FILES, PULL, COMPARE(sha('1')), FILES, PULL]);
    expect(svc.stats().entries).toBe(0);
    expect(logs.filter((l) => l.includes('changed while its files were being fetched'))).toHaveLength(2);
    // Once it settles, the next request succeeds.
    pr2(gh.routes, B, [restFile(9)]);
    expect((await diffOf(svc.prDiff('app', 2))).headOid).toBe(B);
  });

  it("lists at most GitHub's 3000 files but reports the PR's full count", async () => {
    const { svc, spent, synced, gh } = setup();
    pr2(gh.routes, A, Array.from({ length: 3100 }, (_, i) => restFile(i)), { changed_files: 3500 });
    synced(2, { head_oid: A });
    const { out, requests } = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(out.files).toHaveLength(3000);
    expect(out.totalFiles).toBe(3500);
    expect(requests).toHaveLength(2 + 30 + 1);
  });

  it('shares one fetch between identical concurrent requests', async () => {
    const { svc, spent, synced, gh } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: A });
    const { out, requests } = await spent(() => Promise.all([svc.prDiff('app', 2), svc.prDiff('app', 2)]));
    expect(requests).toEqual(FULL(A));
    expect(out[0]).toBe(out[1]);
  });

  it('gives up on a build that outlives its deadline', async () => {
    const { svc, synced, gh } = setup({}, {
      buildTimeoutMs: 50,
      // The files never arrive (until the request is aborted).
      fetchImpl: (inner) => async (input, init) =>
        String(input).includes('/files')
          ? new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
          : inner(input, init),
    });
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: A });
    const err = await svc.prDiff('app', 2).catch((e: HttpError) => e);
    expect(err).toMatchObject({ status: 502, message: expect.stringContaining('Gave up') });
  });

  it('applies the build deadline across retries', async () => {
    let filesFetches = 0;
    const { svc, synced, gh } = setup({}, {
      buildTimeoutMs: 50,
      // The second attempt's files never arrive (until the build is aborted).
      fetchImpl: (inner) => async (input, init) =>
        String(input).includes('/files') && ++filesFetches === 2
          ? new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
          : inner(input, init),
    });
    pr2(gh.routes, A, [restFile(1)]);
    whenServed(gh.routes, FILES, () => pr2(gh.routes, B, [restFile(2)]));
    synced(2, { head_oid: A });
    expect(await svc.prDiff('app', 2).catch((e: HttpError) => e)).toMatchObject({ status: 502, message: expect.stringContaining('Gave up') });
    expect(svc.stats().entries).toBe(0);
  });

  it('maps missing things, missing tokens and GitHub failures to API errors', async () => {
    const { svc, spent, synced, gh, token, clock } = setup();
    synced(2, { head_oid: A });
    expect(await status(svc.prDiff('nope', 1))).toBe(404);
    const unknown = await spent(() => status(svc.prDiff('app', 99)));
    expect(unknown).toEqual({ out: 404, requests: [] });

    // No token: `gh auth token` isn't run again for a while (it blocks the event loop).
    token.value = null;
    expect(await status(svc.prDiff('app', 2))).toBe(503);
    expect(await status(svc.prDiff('app', 2))).toBe(503);
    expect(token.resolved).toBe(1);
    token.value = 'tok';
    clock.t += 30_000;
    // GitHub no longer has it.
    expect(await status(svc.prDiff('app', 2))).toBe(404);
    expect(token.resolved).toBe(2);

    gh.routes[PULL] = { status: 500 };
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

  it('serves what GitHub returned when the cache cannot be written or read', async () => {
    const { svc, spent, synced, gh, cache, logs } = setup();
    pr2(gh.routes, A, [restFile(1)]);
    synced(2, { head_oid: A });
    (cache as unknown as { db: Db }).db.exec('PRAGMA query_only = ON'); // as on a full disk
    expect((await diffOf(svc.prDiff('app', 2))).headOid).toBe(A);
    expect(logs.some((l) => l.startsWith('[diff] cache write failed'))).toBe(true);

    cache.close(); // every cache call now throws
    const unreadable = await spent(() => diffOf(svc.prDiff('app', 2)));
    expect(unreadable.out.headOid).toBe(A);
    expect(unreadable.requests).toEqual(FULL(A));
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
      '/repos/alice/app/commits/def4567': { body: commit(unsynced, [sha('p')], [restFile(1)], 'Fix CRLF\r\n\r\nBody') },
    });
    expect((await diffOf(svc.commitDiff('app', 'C100000'))).baseOid).toBe(sha('p'));
    expect((await spent(() => svc.commitDiff('app', synced))).requests).toEqual([]);
    const crlf = await diffOf(svc.commitDiff('app', 'def4567'));
    expect(crlf).toMatchObject({ headOid: unsynced, title: 'Fix CRLF' });
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

  it('serves text at a commit and caches it when the commit is fully named', async () => {
    const { svc, spent } = setup({
      [contents('docs/a%20b.md')]: { text: '﻿hello\nworld\n' },
      '/repos/alice/app/contents/a.txt?ref=abcdef1': { text: 'short' },
    });
    expect(await payloadText(await svc.blob('app', REF, 'docs/a b.md'))).toBe('﻿hello\nworld\n');
    expect((await spent(() => svc.blob('app', REF, 'docs/a b.md'))).requests).toEqual([]);
    // A short ref that no synced or cached commit expands is fetched each time.
    expect(await payloadText(await svc.blob('app', 'abcdef1', 'a.txt'))).toBe('short');
    expect((await spent(() => svc.blob('app', 'abcdef1', 'a.txt'))).requests).toHaveLength(1);
    expect(svc.stats().entries).toBe(1);
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
      for (const path of ['', '/etc/passwd', 'a//b', '../x', 'a/./b', 'a/..', 'a\r\n[diff] forged', 'a\tb', 'a\x7f']) {
        codes.push(await status(svc.blob('app', REF, path)));
      }
      return codes;
    });
    expect(bad.out).toEqual(Array(12).fill(400));
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
