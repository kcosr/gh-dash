import { describe, expect, it } from 'vitest';
import type { BranchListResponse, Diff } from '../../shared/api';
import { HttpError } from '../api/http';
import { GitHubDiffSources } from '../github/diff-source';
import { addBranch, branchesSynced } from '../test/branches';
import { fakeGitHub, type Handler as Route, restFile, sha } from '../test/github';
import { branchKey, fakeCode, serveBranch } from '../test/mcp';
import { seedDb } from '../test/seed';
import { supplyOf } from '../test/tokens';
import { DiffCache } from './cache';
import { BRANCH_LIST_LIMIT, BRANCH_LIST_TTL_MS, BRANCH_TTL_MS, DiffService, type DiffSources, type Payload, payloadText } from './service';

const MERGE_BASE = sha('9');
const A = sha('a');
const B = sha('b');

const diffOf = async (p: Payload | Promise<Payload>) => JSON.parse(await payloadText(await p)) as Diff;
const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof HttpError ? e.status : e));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as HttpError);

function setup(routes: Record<string, Route> = {}, opts: { sources?: DiffSources } = {}) {
  const db = seedDb();
  const gh = fakeGitHub(routes);
  const token = { value: 'tok' as string | null };
  const logs: string[] = [];
  const clock = { t: Date.parse('2026-09-28T00:00:00Z') };
  let tick = 0;
  // The cache's clock only orders accesses (LRU); it must advance between them.
  const cache = new DiffCache(':memory:', () => clock.t + tick++);
  const log = (line: string) => logs.push(line);
  const sources = opts.sources ?? new GitHubDiffSources({ tokens: supplyOf(() => token.value), fetchImpl: gh.fetchImpl, sleep: async () => {}, log });
  const svc = new DiffService({ db, cache, sources, log, now: () => clock.t });
  /** Requests made by `fn`. */
  const spent = async <T>(fn: () => Promise<T>) => {
    gh.requests.length = 0;
    const out = await fn();
    return { out, requests: [...gh.requests] };
  };
  return { db, gh, svc, cache, token, logs, clock, spent };
}

const BRANCH = '/repos/alice/app/commits/heads%2Ffeature%2Fx';
const compareOf = (head: string, base = 'main') => `/repos/alice/app/compare/heads%2F${base}...${head}?per_page=1`;

/**
 * GitHub serving branch feature/x at `head`, which compares with main against `mergeBase` as `files`. The branch's
 * head answers a request with its own SHA as the ETag with a 304, as GitHub does.
 */
function feature(routes: Record<string, Route>, head: string, files: object[], mergeBase = MERGE_BASE, base = 'main', conditions: (string | undefined)[] = []) {
  routes[BRANCH] = ({ headers }) => (conditions.push(headers['If-None-Match']), headers['If-None-Match'] === `"${head}"` ? { status: 304 } : { text: head });
  routes[compareOf(head, base)] = { body: { merge_base_commit: { sha: mergeBase }, total_commits: 1, commits: [{ sha: head }], files } };
}

describe('branch diffs', () => {
  it('compares a branch with the default branch once, then serves it for the cost of a free head check', async () => {
    const { svc, spent, gh, cache, clock } = setup();
    feature(gh.routes, A, [restFile(1), restFile(2, { status: 'renamed', previous_filename: 'old/f2.ts', patch: undefined, additions: 0, deletions: 0 })]);

    const miss = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(miss.requests).toEqual([BRANCH, compareOf(A)]);
    expect(miss.out).toEqual({
      kind: 'branch', repo: 'alice/app', number: null, branch: 'feature/x', baseRef: 'main', title: 'feature/x', baseOid: MERGE_BASE, headOid: A,
      files: [
        { path: 'src/f1.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a1\n+b1' },
        { path: 'src/f2.ts', previousPath: 'old/f2.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
      ],
      totalFiles: 2, additions: 1, deletions: 1, fetchedAt: new Date(clock.t).toISOString(), url: 'https://github.com/alice/app/compare/main...feature/x',
    });
    // One entry per branch, keyed as the branch.
    expect(cache.branchEntry('branch/alice/app/feature/x')).toEqual({ key: 'branch/alice/app/feature/x', oid: A, baseRef: 'main', baseOid: MERGE_BASE, fetchedAt: clock.t });

    // Asked again: the head is checked with a conditional request (a 304), and nothing else.
    clock.t += 10 * 60_000;
    const hit = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(hit.requests).toEqual([BRANCH]);
    expect(hit.out).toEqual(miss.out);
  });

  it('compares again when the branch was pushed to, replacing its diff', async () => {
    const { svc, spent, gh, cache } = setup();
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');

    feature(gh.routes, B, [restFile(1), restFile(2)]);
    const pushed = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(pushed.requests).toEqual([BRANCH, compareOf(B)]);
    expect(pushed.out).toMatchObject({ headOid: B, totalFiles: 2 });
    expect(svc.stats().entries).toBe(1);
    expect(cache.branchEntry('branch/alice/app/feature/x')).toMatchObject({ oid: B });
    expect((await spent(() => svc.branchDiff('app', 'feature/x'))).requests).toEqual([BRANCH]);
  });

  it("trusts a cached diff for an hour, then recomputes it: the default branch can move the merge base", async () => {
    const { svc, spent, gh, clock } = setup();
    const heads: (string | undefined)[] = [];
    feature(gh.routes, A, [restFile(1), restFile(2)], MERGE_BASE, 'main', heads);
    await svc.branchDiff('app', 'feature/x');

    // main absorbed one of the branch's commits: the merge base moved, the branch didn't.
    feature(gh.routes, A, [restFile(2)], sha('8'), 'main', heads);
    clock.t += BRANCH_TTL_MS - 1;
    expect((await diffOf(svc.branchDiff('app', 'feature/x'))).baseOid).toBe(MERGE_BASE);
    clock.t += 2;
    const rechecked = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(rechecked.requests).toEqual([BRANCH, compareOf(A)]);
    expect(rechecked.out).toMatchObject({ baseOid: sha('8'), totalFiles: 1, fetchedAt: new Date(clock.t).toISOString() });
    // Not asked as a conditional request the second time: its answer wasn't going to be used.
    expect(heads).toEqual([undefined, `"${A}"`, undefined]);
    // The check starts over.
    expect((await spent(() => svc.branchDiff('app', 'feature/x'))).requests).toEqual([BRANCH]);
  });

  it('compares again with refresh, whatever is cached, and asks for the head without a condition', async () => {
    const { svc, spent, gh } = setup();
    const seen: (string | undefined)[] = [];
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');
    // Only the merge base moved, which nothing else would have shown.
    feature(gh.routes, A, [restFile(1), restFile(3)], sha('7'), 'main', seen);
    const refreshed = await spent(() => diffOf(svc.branchDiff('app', 'feature/x', true)));
    expect(refreshed.requests).toEqual([BRANCH, compareOf(A)]);
    expect(refreshed.out).toMatchObject({ baseOid: sha('7'), totalFiles: 2 });
    expect(seen).toEqual([undefined]);
  });

  it('compares with the default branch as the sync last saw it, and recomputes when that changed', async () => {
    const { svc, spent, gh, db } = setup();
    feature(gh.routes, A, [restFile(1), restFile(2)]);
    await svc.branchDiff('app', 'feature/x');

    db.run("UPDATE repos SET default_branch = 'develop' WHERE name = 'app'");
    feature(gh.routes, A, [restFile(2)], sha('8'), 'develop');
    const renamed = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(renamed.requests).toEqual([BRANCH, compareOf(A, 'develop')]);
    expect(renamed.out).toMatchObject({ baseRef: 'develop', baseOid: sha('8'), totalFiles: 1, url: 'https://github.com/alice/app/compare/develop...feature/x' });
    expect(svc.stats().entries).toBe(1);
    expect((await spent(() => svc.branchDiff('app', 'feature/x'))).requests).toEqual([BRANCH]);
  });

  it('keeps a diff per branch, apart from the PRs\' from it, and drops them with their repo', async () => {
    const { svc, gh, db } = setup();
    feature(gh.routes, A, [restFile(1)]);
    gh.routes['/repos/alice/app/commits/heads%2Ffeature'] = { text: B };
    gh.routes[compareOf(B)] = { body: { merge_base_commit: { sha: MERGE_BASE }, files: [restFile(5)] } };
    // PR 2 is from the branch "feature": its diff and the branch's are two entries.
    const pull = { title: 'Add parser', html_url: 'https://github.com/alice/app/pull/2', changed_files: 1, additions: 1, deletions: 1, head: { sha: B }, base: { sha: sha('0'), ref: 'main' } };
    gh.routes['/repos/alice/app/pulls/2'] = { body: pull };
    gh.routes[`/repos/alice/app/compare/${sha('0')}...${B}?per_page=1&page=2`] = { body: { merge_base_commit: { sha: MERGE_BASE } } };
    gh.routes['/repos/alice/app/pulls/2/files?per_page=100'] = { body: [restFile(5)] };
    await svc.branchDiff('app', 'feature/x');
    await svc.branchDiff('app', 'feature');
    await svc.prDiff('app', 2);
    expect(svc.stats().entries).toBe(3);
    expect((await diffOf(svc.branchDiff('app', 'feature'))).files[0]!.path).toBe('src/f5.ts');
    expect((await diffOf(svc.branchDiff('app', 'feature/x'))).files[0]!.path).toBe('src/f1.ts');
    // A push to the PR replaces the PR's diff only.
    gh.routes['/repos/alice/app/pulls/2'] = { body: { ...pull, head: { sha: A } } };
    gh.routes[`/repos/alice/app/compare/${sha('0')}...${A}?per_page=1&page=2`] = { body: { merge_base_commit: { sha: MERGE_BASE } } };
    await svc.prDiff('app', 2, true);
    expect(svc.stats().entries).toBe(3);
    svc.evict();
    expect(svc.stats().entries).toBe(3);
    db.run("UPDATE repos SET removed_at = '2026-09-28T00:00:00Z' WHERE name = 'app'");
    svc.evict();
    expect(svc.stats().entries).toBe(0);
  });

  it('shares one fetch between identical concurrent requests', async () => {
    const { svc, spent, gh } = setup();
    feature(gh.routes, A, [restFile(1)]);
    const { out, requests } = await spent(() => Promise.all([svc.branchDiff('app', 'feature/x'), svc.branchDiff('app', 'feature/x')]));
    expect(requests).toEqual([BRANCH, compareOf(A)]);
    expect(out[0]).toBe(out[1]);
  });

  it('logs what a fetch cost, as the other diffs do', async () => {
    const { svc, gh, logs } = setup();
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');
    expect(logs.at(-1)).toMatch(/^\[diff\] alice\/app~feature\/x: 2 GitHub requests in [\d.]+s \(4999\/5000 left\)$/);
    // A conditional request that is answered with a 304 is still one made (though GitHub doesn't count it).
    logs.length = 0;
    await svc.branchDiff('app', 'feature/x');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[diff\] alice\/app~feature\/x: 1 GitHub request in /);
  });

  it('refuses what cannot be reviewed as a branch, before asking the code host', async () => {
    const { svc, spent, db } = setup();
    for (const bad of ['', 'a..b', 'a b', '-x', 'x/', 'x.lock', 'a~b', 'a^b', '@', 'a\nb', 'x'.repeat(256)]) {
      expect(await failure(svc.branchDiff('app', bad)), JSON.stringify(bad)).toMatchObject({ status: 400, message: 'Invalid branch name' });
    }
    expect(await failure(svc.branchDiff('app', 'main'))).toMatchObject({ status: 400, message: 'main is the default branch: branches are compared against it' });
    expect(await spent(() => status(svc.branchDiff('nope', 'feature/x')))).toEqual({ out: 404, requests: [] });

    // The sync hasn't found the default branch (yet): there is nothing to compare with.
    db.run("UPDATE repos SET default_branch = NULL WHERE name = 'app'");
    expect(await spent(() => failure(svc.branchDiff('app', 'feature/x')))).toMatchObject({ out: { status: 409, message: "The default branch isn't known yet: sync the repository" }, requests: [] });
    db.run("UPDATE repos SET default_branch = '' WHERE name = 'app'");
    expect(await status(svc.branchDiff('app', 'feature/x'))).toBe(409);
  });

  it('maps a missing branch, a comparison GitHub cannot make, missing tokens and GitHub failures to API errors', async () => {
    const { svc, gh, token } = setup({ [BRANCH]: { status: 422, body: { message: 'No commit found for SHA: heads/feature/x' } } });
    expect(await failure(svc.branchDiff('app', 'feature/x'))).toMatchObject({ status: 404, message: 'Branch feature/x not found on GitHub' });

    gh.routes[BRANCH] = { text: A };
    expect(await failure(svc.branchDiff('app', 'feature/x'))).toMatchObject({
      status: 404,
      message: "Can't compare feature/x with main on GitHub: main isn't a branch there (renamed since the last sync?), or they have no history in common",
    });
    gh.routes[compareOf(A)] = { status: 404, body: { message: `No common ancestor between main and ${A}.` } };
    expect(await status(svc.branchDiff('app', 'feature/x'))).toBe(404);

    gh.routes[compareOf(A)] = { status: 500 };
    expect(await status(svc.branchDiff('app', 'feature/x'))).toBe(502);
    token.value = null;
    expect(await failure(svc.branchDiff('app', 'feature/x'))).toMatchObject({ status: 503, message: 'No GitHub token: none for this test' });
    token.value = 'tok';
    gh.routes[BRANCH] = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } };
    expect(await failure(svc.branchDiff('app', 'feature/x'))).toMatchObject({ status: 429, details: { resetAt: '2099-01-01T00:00:00.000Z' } });
    // Nothing is cached for a failure.
    expect(svc.stats().entries).toBe(0);
  });

  it('serves the cached copy, marked stale, when GitHub cannot be asked, but not one of a branch that is gone or with refresh', async () => {
    const { svc, gh, token, clock, logs } = setup();
    feature(gh.routes, A, [restFile(1)]);
    const fresh = await diffOf(svc.branchDiff('app', 'feature/x'));
    expect(fresh.stale).toBeUndefined();

    // Failing or rate limited: the last diff there is, whatever its age.
    gh.routes[BRANCH] = { status: 500 };
    expect(await diffOf(svc.branchDiff('app', 'feature/x'))).toEqual({ ...fresh, stale: true });
    expect(logs.at(-1)).toBe('[diff] alice/app~feature/x: serving the cached copy (GitHub returned 500 for /repos/alice/app/commits/heads%2Ffeature%2Fx)');
    clock.t += BRANCH_TTL_MS + 1;
    token.value = null;
    expect(await diffOf(svc.branchDiff('app', 'feature/x'))).toMatchObject({ headOid: A, stale: true });
    // The comparison of a new head failing leaves the diff of the old one.
    token.value = 'tok';
    gh.routes[BRANCH] = { text: B };
    gh.routes[compareOf(B)] = { status: 502 };
    expect(await diffOf(svc.branchDiff('app', 'feature/x'))).toMatchObject({ headOid: A, stale: true });
    // refresh=1 wants GitHub's answer: an error is one.
    expect(await status(svc.branchDiff('app', 'feature/x', true))).toBe(502);
    token.value = null;
    expect(await status(svc.branchDiff('app', 'feature/x', true))).toBe(503);
    token.value = 'tok';

    // A branch deleted since is an answer, not a failure.
    gh.routes[BRANCH] = { status: 422, body: { message: 'No commit found for SHA: heads/feature/x' } };
    expect(await status(svc.branchDiff('app', 'feature/x'))).toBe(404);
  });

  it('serves the cached copy, marked stale, when GitHub rate limits, until the limit resets', async () => {
    const { svc, gh, spent } = setup();
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');
    gh.routes[BRANCH] = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } };
    expect(await diffOf(svc.branchDiff('app', 'feature/x'))).toMatchObject({ headOid: A, stale: true });
    // Nothing more is sent until the reset, and the copy is still what is served; with refresh it is the limit's answer.
    const again = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(again).toMatchObject({ out: { stale: true }, requests: [] });
    expect(await failure(svc.branchDiff('app', 'feature/x', true))).toMatchObject({ status: 429, details: { resetAt: '2099-01-01T00:00:00.000Z' } });
  });

  it('does not serve a copy compared with another default branch when GitHub cannot be asked', async () => {
    const { svc, gh, db } = setup();
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');
    db.run("UPDATE repos SET default_branch = 'develop' WHERE name = 'app'");
    gh.routes[BRANCH] = { status: 500 };
    expect(await status(svc.branchDiff('app', 'feature/x'))).toBe(502);
  });

  it('serves what GitHub returned when the cache cannot be read', async () => {
    const { svc, spent, gh, cache } = setup();
    feature(gh.routes, A, [restFile(1)]);
    await svc.branchDiff('app', 'feature/x');
    cache.close(); // every cache call now throws
    const unreadable = await spent(() => diffOf(svc.branchDiff('app', 'feature/x')));
    expect(unreadable.out.headOid).toBe(A);
    expect(unreadable.requests).toEqual([BRANCH, compareOf(A)]);
  });
});

describe('branch diffs of another source', () => {
  it('build a compare link in its terms and ask only what the DiffSource contract has', async () => {
    const { code, sources } = fakeCode();
    const { svc, db } = setup({}, { sources });
    // The fake host is a GitLab one: the link and the messages follow the source's kind.
    Object.assign(await sources.get({ sourceId: 1 }), { kind: 'gitlab' });
    db.run("UPDATE repos SET url = 'https://gitlab.example.com/alice/app' WHERE name = 'app'");
    serveBranch(code, 'alice/app', 'feature/x', A, MERGE_BASE, [{ path: 'a.ts', previousPath: null, status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' }]);
    const out = await diffOf(svc.branchDiff('app', 'feature/x'));
    expect(out).toMatchObject({
      kind: 'branch', branch: 'feature/x', baseRef: 'main', baseOid: MERGE_BASE, headOid: A, totalFiles: 1, additions: 3, deletions: 0,
      url: 'https://gitlab.example.com/alice/app/-/compare/main...feature/x',
    });
    expect(code.requests).toEqual(['branch alice/app~feature/x', 'compare alice/app~feature/x']);
    // Nothing tells the host's head without asking: it is asked for on each view, the comparison only when it moved.
    await svc.branchDiff('app', 'feature/x');
    expect(code.requests).toHaveLength(3);
    serveBranch(code, 'alice/app', 'feature/x', B, MERGE_BASE, []);
    expect(await diffOf(svc.branchDiff('app', 'feature/x'))).toMatchObject({ headOid: B, files: [], totalFiles: 0 });
    expect(code.requests).toHaveLength(5);
    code.branches.delete(branchKey('alice/app', 'feature/x'));
    expect(await failure(svc.branchDiff('app', 'feature/x'))).toMatchObject({ status: 404, message: 'Branch feature/x not found on GitLab' });
    code.down = 'No token';
    expect(await failure(svc.branchDiff('app', 'feature/y'))).toMatchObject({ status: 503, message: 'No token' });
  });
});

describe('branch lists', () => {
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T09:00:00Z`;
  function listing() {
    const { code, sources } = fakeCode();
    const t = setup({}, { sources });
    serveBranch(code, 'alice/app', 'main', sha('1'), sha('1'), [], day(30));
    serveBranch(code, 'alice/app', 'feature', sha('2'), MERGE_BASE, [], day(20));
    serveBranch(code, 'alice/app', 'feature/x', sha('3'), MERGE_BASE, [], day(25));
    serveBranch(code, 'alice/app', 'old-branch', sha('4'), MERGE_BASE, [], day(2));
    serveBranch(code, 'alice/app', 'undated', sha('5'), MERGE_BASE, [], null);
    const asked = async <T>(fn: () => Promise<T>) => {
      code.requests.length = 0;
      const out = await fn();
      return { out, requests: [...code.requests] };
    };
    return { ...t, code, sources, asked };
  }

  it('lists the code host\'s branches newest first, the default branch left out, with the PR from each', async () => {
    const { svc, db, asked } = listing();
    // The seed's PRs 1-3 are from "feature" (1 merged, 2 open, 3 closed); the sync hasn't said which are from forks (NULL).
    const noPr = await asked(() => svc.branchList('app', null));
    expect(noPr.requests).toEqual(['branches alice/app']);
    expect(noPr.out).toEqual({
      defaultBranch: 'main',
      more: false,
      items: [
        { name: 'feature/x', headOid: sha('3'), committedAt: day(25), pr: null },
        { name: 'feature', headOid: sha('2'), committedAt: day(20), pr: null },
        { name: 'old-branch', headOid: sha('4'), committedAt: day(2), pr: null },
        { name: 'undated', headOid: sha('5'), committedAt: null, pr: null },
      ],
    });
    // The newest PR from a branch of this repo, of any state; not one from a fork.
    db.run("UPDATE pull_requests SET cross_repo = 0 WHERE number IN (1, 2) AND repo_id = (SELECT id FROM repos WHERE name = 'app')");
    db.run("UPDATE pull_requests SET cross_repo = 1 WHERE number = 3 AND repo_id = (SELECT id FROM repos WHERE name = 'app')");
    db.run("UPDATE pull_requests SET head_ref = 'feature/x', cross_repo = 0 WHERE number = 1 AND repo_id = (SELECT id FROM repos WHERE name = 'secret')");
    const withPrs = await asked(() => svc.branchList('app', null));
    // Kept: the PRs come from the sync's database, fresh on every request.
    expect(withPrs.requests).toEqual([]);
    expect(withPrs.out.items.map((b) => [b.name, b.pr])).toEqual([
      ['feature/x', null],
      ['feature', { number: 2, state: 'open', title: 'Add parser' }],
      ['old-branch', null],
      ['undated', null],
    ]);
    db.run("UPDATE pull_requests SET state = 'merged' WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE name = 'app')");
    expect((await svc.branchList('app', null)).items[1]!.pr).toEqual({ number: 2, state: 'merged', title: 'Add parser' });
  });

  it('keeps a list for a minute per repo and filter, and asks again with refresh', async () => {
    const { svc, asked, clock, code } = listing();
    await asked(() => svc.branchList('app', null));
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual([]);
    expect((await asked(() => svc.branchList('app', '  '))).requests).toEqual([]);
    const filtered = await asked(() => svc.branchList('app', ' Feature '));
    expect(filtered.requests).toEqual(['branches alice/app Feature']);
    expect(filtered.out.items.map((b) => b.name)).toEqual(['feature/x', 'feature']);
    expect((await asked(() => svc.branchList('app', 'Feature'))).requests).toEqual([]);
    expect((await asked(() => svc.branchList('secret', null))).requests).toEqual(['branches alice/secret']);

    clock.t += BRANCH_LIST_TTL_MS - 1;
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual([]);
    // A branch pushed meanwhile shows up when the list is asked for again.
    serveBranch(code, 'alice/app', 'fresh', sha('6'), MERGE_BASE, [], day(29));
    expect((await asked(() => svc.branchList('app', null, true))).out.items[0]!.name).toBe('fresh');
    clock.t += 1;
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual([]);
    clock.t += BRANCH_LIST_TTL_MS;
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual(['branches alice/app']);
    // Concurrent requests share one.
    clock.t += BRANCH_LIST_TTL_MS;
    const both = await asked(() => Promise.all([svc.branchList('app', null), svc.branchList('app', null)]));
    expect(both.requests).toEqual(['branches alice/app']);
  });

  it('asks for one more than it lists, so that leaving out the default branch still fills the list, and says when there are more', async () => {
    const { code, sources } = fakeCode();
    const { svc } = setup({}, { sources });
    const asked: number[] = [];
    const source = await sources.get({ sourceId: 1 });
    const inner = source.branches.bind(source);
    source.branches = (repo, query, limit, signal) => (asked.push(limit), inner(repo, query, limit, signal));
    serveBranch(code, 'alice/app', 'main', sha('1'), sha('1'), [], day(30));
    for (let i = 0; i < BRANCH_LIST_LIMIT - 1; i++) serveBranch(code, 'alice/app', `b${i}`, sha('2'), MERGE_BASE, [], `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
    // 99 others and the default branch: all there is.
    let list: BranchListResponse = await svc.branchList('app', null);
    expect(asked).toEqual([BRANCH_LIST_LIMIT + 1]);
    expect(list.items).toHaveLength(BRANCH_LIST_LIMIT - 1);
    expect(list.more).toBe(false);
    serveBranch(code, 'alice/app', 'b-last', sha('2'), MERGE_BASE, [], day(1));
    list = await svc.branchList('app', null, true);
    expect(list.items).toHaveLength(BRANCH_LIST_LIMIT);
    expect(list.more).toBe(false);
    expect(list.items.map((b) => b.name)).not.toContain('main');
    serveBranch(code, 'alice/app', 'b-over', sha('2'), MERGE_BASE, [], day(1));
    list = await svc.branchList('app', null, true);
    expect(list.items).toHaveLength(BRANCH_LIST_LIMIT);
    expect(list.more).toBe(true);
    // The default branch is the newest one of a host that cuts its list: it is not one of the hundred.
    serveBranch(code, 'alice/app', 'b-more', sha('2'), MERGE_BASE, [], day(1));
    expect((await svc.branchList('app', null, true)).more).toBe(true);
  });

  it("passes the code host's own `more` on, and keeps the list bounded", async () => {
    const { svc, sources } = listing();
    const source = await sources.get({ sourceId: 1 });
    source.branches = async () => ({ items: [{ name: 'a', headOid: A, committedAt: null }], more: true });
    expect((await svc.branchList('app', 'a')).more).toBe(true);
    // Many filters (a picker asks per keystroke) don't keep growing what is held: the oldest are asked for again.
    let calls = 0;
    source.branches = async () => (calls++, { items: [], more: false });
    for (let i = 0; i < 300; i++) await svc.branchList('app', `q${i}`);
    expect(calls).toBe(300);
    await svc.branchList('app', 'q299');
    expect(calls).toBe(300);
    await svc.branchList('app', 'q0');
    expect(calls).toBe(301);
  });

  it('refuses a bad filter, an unknown repo, and a repo whose default branch is not known', async () => {
    const { svc, db, asked } = listing();
    expect(await failure(svc.branchList('app', 'x'.repeat(256)))).toMatchObject({ status: 400, message: 'Invalid q' });
    expect(await failure(svc.branchList('app', 'a\nb'))).toMatchObject({ status: 400 });
    expect(await asked(() => status(svc.branchList('nope', null)))).toEqual({ out: 404, requests: [] });
    db.run("UPDATE repos SET default_branch = NULL WHERE name = 'app'");
    expect(await asked(() => failure(svc.branchList('app', null)))).toMatchObject({ out: { status: 409 }, requests: [] });
  });

  it("reads the sync's list once it has listed the repo completely, asking the code host only with refresh", async () => {
    const { svc, db, asked, code } = listing();
    // The sync's list, older than the host's (no feature/x yet), in the order the host would list it.
    addBranch(db, 'alice/app', 'main', { head: sha('1'), at: day(30) });
    addBranch(db, 'alice/app', 'feature', { head: sha('2'), at: day(20) });
    addBranch(db, 'alice/app', 'undated', { head: sha('5'), at: null });
    addBranch(db, 'alice/app', 'old-branch', { head: sha('4'), at: day(2) });
    addBranch(db, 'alice/app', 'Fix_%', { head: sha('6'), at: day(2) });
    db.run("UPDATE pull_requests SET cross_repo = 0 WHERE number = 2 AND repo_id = (SELECT id FROM repos WHERE name = 'app')");
    // Not listed yet, then listed but capped: only the code host knows them all.
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual(['branches alice/app']);
    branchesSynced(db, 'alice/app', false);
    expect((await asked(() => svc.branchList('app', null, true))).requests).toEqual(['branches alice/app']);

    branchesSynced(db, 'alice/app', true);
    const synced = await asked(() => svc.branchList('app', null));
    expect(synced.requests).toEqual([]);
    expect(synced.out).toEqual({
      defaultBranch: 'main',
      more: false,
      items: [
        { name: 'feature', headOid: sha('2'), committedAt: day(20), pr: { number: 2, state: 'open', title: 'Add parser' } },
        { name: 'Fix_%', headOid: sha('6'), committedAt: day(2), pr: null },
        { name: 'old-branch', headOid: sha('4'), committedAt: day(2), pr: null },
        { name: 'undated', headOid: sha('5'), committedAt: null, pr: null },
      ],
    });
    // `q` as the hosts take it: a part of the name, whatever its case, wildcards as themselves.
    const named = async (q: string) => (await asked(() => svc.branchList('app', q))).out.items.map((b) => b.name);
    expect(await named(' FEATURE ')).toEqual(['feature']);
    expect(await named('_%')).toEqual(['Fix_%']);
    expect(await named('main')).toEqual([]);
    expect(code.requests).toEqual([]);
    // refresh asks the code host, which has feature/x; the sync's list is read again after.
    const fresh = await asked(() => svc.branchList('app', null, true));
    expect(fresh.requests).toEqual(['branches alice/app']);
    expect(fresh.out.items.map((b) => b.name)).toEqual(['feature/x', 'feature', 'old-branch', 'undated']);
    expect((await asked(() => svc.branchList('app', null))).out.items[0]!.name).toBe('feature');
    expect(code.requests).toEqual([]);
  });

  it("says when the sync's list has more than a list holds, the default branch not among them", async () => {
    const { svc, db, asked } = listing();
    branchesSynced(db, 'alice/app', true);
    addBranch(db, 'alice/app', 'main', { head: sha('1'), at: day(30) });
    for (let i = 0; i < BRANCH_LIST_LIMIT; i++) addBranch(db, 'alice/app', `b${String(i).padStart(3, '0')}`, { head: sha('2'), at: day(1 + (i % 28)) });
    let list = (await asked(() => svc.branchList('app', null))).out;
    expect([list.items.length, list.more, list.items.some((b) => b.name === 'main')]).toEqual([BRANCH_LIST_LIMIT, false, false]);
    addBranch(db, 'alice/app', 'b-over', { head: sha('2'), at: '2026-08-31T09:00:00Z' });
    list = (await asked(() => svc.branchList('app', null))).out;
    expect([list.items.length, list.more]).toEqual([BRANCH_LIST_LIMIT, true]);
    // Newest first: the oldest is the one left over.
    expect(list.items[0]!.committedAt).toBe(day(28));
    expect(list.items.map((b) => b.name)).not.toContain('b-over');
    expect((await asked(() => svc.branchList('app', 'b-'))).out).toMatchObject({ items: [{ name: 'b-over' }], more: false });
  });

  it("reads another repo's list from the host until the sync has listed that one", async () => {
    const { svc, db, asked, code } = listing();
    branchesSynced(db, 'alice/app', true);
    serveBranch(code, 'alice/secret', 'spike', sha('7'), MERGE_BASE, [], day(29));
    expect(await asked(() => svc.branchList('secret', null))).toMatchObject({ requests: ['branches alice/secret'], out: { items: [{ name: 'spike' }] } });
    // The repo checks come first: a default branch that isn't known is a 409 whichever list would be read.
    db.run("UPDATE repos SET default_branch = NULL WHERE name = 'app'");
    expect(await asked(() => failure(svc.branchList('app', null)))).toMatchObject({ out: { status: 409 }, requests: [] });
  });

  it('maps the code host\'s failures, and keeps nothing of them', async () => {
    const { svc, code, asked } = listing();
    code.down = 'No GitHub token: connect an account';
    expect(await failure(svc.branchList('app', null))).toMatchObject({ status: 503 });
    code.down = null;
    expect((await asked(() => svc.branchList('app', null))).requests).toEqual(['branches alice/app']);
  });
});

describe('branch lists from GitHub', () => {
  it('reads them through GraphQL and leaves the default branch out', async () => {
    const refs = (nodes: object[]) => ({
      body: { data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }, rateLimit: { limit: 5000, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } } },
    });
    const { svc, spent } = setup({
      '/graphql': refs([
        { name: 'main', target: { oid: A, committedDate: '2026-09-29T00:00:00Z' } },
        { name: 'feature/x', target: { oid: B, committedDate: '2026-09-27T00:00:00Z' } },
      ]),
    });
    const { out, requests } = await spent(() => svc.branchList('app', null));
    expect(requests).toEqual(['/graphql']);
    expect(out).toEqual({ defaultBranch: 'main', more: false, items: [{ name: 'feature/x', headOid: B, committedAt: '2026-09-27T00:00:00Z', pr: null }] });
  });
});
