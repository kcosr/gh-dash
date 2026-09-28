import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db';
import { getMeta } from '../db/meta';
import type { RepoProbe, RepoRecord } from '../db/records';
import { DEFAULT_SETTINGS } from '../db/settings';
import type { Settings } from '../../shared/api';
import type { SyncStateRow } from '../db/write';
import { GitHubClient } from '../github/client';
import type { GqlIssue, GqlPullRequest } from '../github/types';
import detailFixture from '../test/fixtures/repo-detail.json';
import probesFixture from '../test/fixtures/repo-probes.json';
import reposFixture from '../test/fixtures/viewer-repos.json';
import { planRepo, runSync } from './sync';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;

interface Call {
  op: string;
  vars: Record<string, unknown>;
}

type Item = (GqlPullRequest | GqlIssue) & { repository?: { nameWithOwner: string } };

/** A fake GitHub GraphQL endpoint serving (mutable copies of) the fixtures. */
function fakeGitHub() {
  const detail = structuredClone(detailFixture);
  const fx = {
    repos: structuredClone(reposFixture),
    probes: structuredClone(probesFixture),
    detail,
    /** What `pullRequests(states: OPEN)` / `issues(states: OPEN)` return for app. */
    openPrs: detail.repository.pullRequests.nodes.filter((n) => n.state === 'OPEN') as unknown as Item[],
    openIssues: detail.repository.issues.nodes.filter((n) => n.state === 'OPEN') as unknown as Item[],
    /** Answers to RecheckItems lookups by alias (`pr2`, `issue11`); missing/null = NOT_FOUND. */
    recheck: {} as Record<string, Item | null>,
    /** When set, app's commit history is served page by page, keyed by the `commitsAfter` cursor ('' = first page). */
    historyPages: null as Record<string, { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }> | null,
    /** Cursors whose history request fails (GraphQL error) until removed. */
    failHistory: new Set<string>(),
  };
  const calls: Call[] = [];
  const conn = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    const op = /query (\w+)/.exec(query)![1]!;
    calls.push({ op, vars: variables });
    const rateLimit = fx.repos.rateLimit;
    if (op === 'RecheckItems') {
      const aliases = [...query.matchAll(/(\w+): (?:pullRequest|issue)\(/g)].map((m) => m[1]!);
      const repository = Object.fromEntries(aliases.map((a) => [a, fx.recheck[a] ?? null]));
      const errors = aliases.filter((a) => !repository[a]).map((a) => ({ type: 'NOT_FOUND', path: ['repository', a], message: 'not found' }));
      return new Response(JSON.stringify({ data: { repository, rateLimit }, ...(errors.length ? { errors } : {}) }));
    }
    if (op === 'RepoDetail' && variables.name === 'app' && variables.withCommits && fx.failHistory.has(String(variables.commitsAfter ?? ''))) {
      return new Response(JSON.stringify({ data: null, errors: [{ type: 'INTERNAL', message: 'history page failed' }] }));
    }
    const data =
      op === 'ViewerRepos' ? fx.repos
      : op === 'RepoProbes' ? fx.probes
      : variables.name === 'app'
        ? {
            ...fx.detail,
            repository: fx.detail.repository && {
              ...fx.detail.repository,
              openPrs: conn(fx.openPrs),
              openIssues: conn(fx.openIssues),
              ...(fx.historyPages
                ? (() => {
                    const page = fx.historyPages[String(variables.commitsAfter ?? '')]!;
                    const history = { pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor }, nodes: page.nodes };
                    return { defaultBranchRef: { ...fx.detail.repository.defaultBranchRef, target: { history } } };
                  })()
                : {}),
            },
          }
      : {
          repository: {
            nameWithOwner: 'alice/corp', pullRequests: conn([]), issues: conn([]), openPrs: conn([]), openIssues: conn([]), releases: conn([]),
            stargazers: { totalCount: 0, pageInfo: conn([]).pageInfo, edges: [] },
          },
          rateLimit,
        };
    return new Response(JSON.stringify({ data }));
  }) as typeof fetch;
  return { fx, calls, fetchImpl };
}

const count = (db: Db, table: string) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;

describe('runSync', () => {
  let db: Db;
  let gh: ReturnType<typeof fakeGitHub>;
  const sync = (at: number, req = {}, settings: Settings = DEFAULT_SETTINGS) =>
    runSync({ db, client: new GitHubClient({ token: 't', fetchImpl: gh.fetchImpl }), settings, now: () => at }, req);
  const detailCalls = () => gh.calls.filter((c) => c.op === 'RepoDetail');
  const state = (table: string, number: number) => db.get<{ state: string }>(`SELECT state FROM ${table} WHERE number = ?`, [number])?.state ?? null;

  beforeEach(async () => {
    db = openDb(':memory:');
    gh = fakeGitHub();
    const first = await sync(NOW);
    expect(first).toEqual({ repos: 2, newItems: 10, errors: [], forksSkipped: 0 });
    gh.calls.length = 0;
  });

  it('stores everything on the first sync', () => {
    expect(getMeta(db, 'viewer')).toEqual({ login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' });
    expect([count(db, 'repos'), count(db, 'commits'), count(db, 'pull_requests'), count(db, 'pr_commits'), count(db, 'issues'), count(db, 'releases'), count(db, 'stars')])
      .toEqual([2, 3, 2, 1, 2, 1, 2]);
    expect(db.all('SELECT headline, pr_number FROM commits ORDER BY committed_at')).toEqual([
      { headline: 'Upstream change', pr_number: null },
      { headline: 'Merge pull request #1 from alice/fix', pr_number: 1 },
      { headline: 'Tweak config', pr_number: null },
    ]);
    expect(db.get('SELECT open_prs, open_issues FROM repos WHERE name = ?', ['app'])).toEqual({ open_prs: 1, open_issues: 1 });
    expect(db.get('SELECT prs_hwm, issues_hwm, commits_pushed_at FROM sync_state JOIN repos r ON r.id = repo_id WHERE r.name = ?', ['app'])).toEqual({
      prs_hwm: '2026-09-22T09:00:00Z', issues_hwm: '2026-09-26T00:00:00Z', commits_pushed_at: '2026-09-25T12:00:00Z',
    });
  });

  it('an immediate second sync only lists and probes', async () => {
    expect(await sync(NOW + HOUR)).toEqual({ repos: 2, newItems: 0, errors: [], forksSkipped: 0 });
    expect(gh.calls.map((c) => c.op)).toEqual(['ViewerRepos', 'RepoProbes']);
  });

  it('fetches only the changed section and stops at the high-water mark', async () => {
    const newPr = { ...gh.fx.detail.repository.pullRequests.nodes[0]!, number: 3, title: 'New', isDraft: false, updatedAt: '2026-09-27T08:00:00Z', createdAt: '2026-09-27T08:00:00Z' };
    gh.fx.detail.repository.pullRequests.nodes.unshift(newPr);
    gh.fx.detail.repository.pullRequests.pageInfo.hasNextPage = true;
    gh.fx.probes.nodes[0]!.latestPr.nodes[0]!.updatedAt = '2026-09-27T08:00:00Z';

    expect(await sync(NOW + HOUR)).toEqual({ repos: 2, newItems: 1, errors: [], forksSkipped: 0 });
    const details = gh.calls.filter((c) => c.op === 'RepoDetail');
    expect(details).toHaveLength(1);
    expect(details[0]!.vars).toMatchObject({ name: 'app', withPrs: true, prsAfter: null, withCommits: false, withIssues: false, withReleases: false, withStars: false });
  });

  it('pages commits only until a page contains a known commit when pushedAt changes', async () => {
    gh.fx.repos.viewer.repositories.nodes[0]!.pushedAt = '2026-09-27T09:00:00Z';
    const history = gh.fx.detail.repository.defaultBranchRef.target.history;
    history.nodes.unshift({ ...history.nodes[1]!, oid: '4'.repeat(40), messageHeadline: 'Hotfix', committedDate: '2026-09-27T09:00:00Z' });
    history.pageInfo.hasNextPage = true;

    expect(await sync(NOW + HOUR)).toMatchObject({ newItems: 1 });
    const details = gh.calls.filter((c) => c.op === 'RepoDetail');
    expect(details.map((c) => [c.vars.withCommits, c.vars.commitsAfter])).toEqual([[true, null]]);
  });

  it('detects unstars by re-listing all stargazers', async () => {
    gh.fx.repos.viewer.repositories.nodes[0]!.stargazerCount = 1;
    gh.fx.detail.repository.stargazers = { ...gh.fx.detail.repository.stargazers, totalCount: 1, edges: [gh.fx.detail.repository.stargazers.edges[0]!] };
    await sync(NOW + HOUR);
    expect(db.all('SELECT login FROM stars')).toEqual([{ login: 'dave' }]);
  });

  it('re-fetches the backfill window on full sync without creating duplicates', async () => {
    expect(await sync(NOW + HOUR, { full: true })).toEqual({ repos: 2, newItems: 0, errors: [], forksSkipped: 0 });
    expect(gh.calls.filter((c) => c.op === 'RepoDetail').map((c) => c.vars.name)).toEqual(['app', 'corp']);
    expect(count(db, 'commits')).toBe(3);
  });

  it('lists open PRs and issues older than the backfill window when our open counts differ from GitHub', async () => {
    const old = { createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-06-01T00:00:00Z' };
    gh.fx.openPrs.push({ ...(gh.fx.openPrs[0] as GqlPullRequest), ...old, number: 5, title: 'Ancient open PR' });
    gh.fx.openIssues.push({ ...(gh.fx.openIssues[0] as GqlIssue), ...old, number: 3, title: 'Ancient open issue' });
    gh.fx.probes.nodes[0]!.openPrs.totalCount = 2;
    gh.fx.probes.nodes[0]!.openIssues.totalCount = 2;

    expect(await sync(NOW + HOUR)).toMatchObject({ newItems: 2, errors: [] });
    expect(detailCalls().map((c) => c.vars)).toEqual([
      expect.objectContaining({ withOpenPrs: true, withOpenIssues: true, withPrs: false, withIssues: false, withCommits: false }),
    ]);
    expect([state('pull_requests', 5), state('issues', 3)]).toEqual(['open', 'open']);

    gh.calls.length = 0;
    await sync(NOW + 2 * HOUR);
    expect(detailCalls()).toHaveLength(0);
  });

  it('updates items closed since through the updatedAt pass, without an extra open pass', async () => {
    const pr2 = gh.fx.detail.repository.pullRequests.nodes[0]!;
    Object.assign(pr2, { state: 'CLOSED', closedAt: '2026-09-27T09:00:00Z', updatedAt: '2026-09-27T09:00:00Z' });
    gh.fx.openPrs = [];
    gh.fx.probes.nodes[0]!.latestPr.nodes[0]!.updatedAt = '2026-09-27T09:00:00Z';
    gh.fx.probes.nodes[0]!.openPrs.totalCount = 0;

    await sync(NOW + HOUR);
    expect(state('pull_requests', 2)).toBe('closed');
    expect(detailCalls().map((c) => [c.vars.withPrs, c.vars.withOpenPrs])).toEqual([[true, false]]);
    expect(gh.calls.some((c) => c.op === 'RecheckItems')).toBe(false);
  });

  it('re-reads stored-open items GitHub no longer lists as open, deleting ones that are gone', async () => {
    // Nothing bumped updatedAt (e.g. the issue was deleted), but GitHub now reports no open items.
    gh.fx.openPrs = [];
    gh.fx.openIssues = [];
    gh.fx.probes.nodes[0]!.openPrs.totalCount = 0;
    gh.fx.probes.nodes[0]!.openIssues.totalCount = 0;
    const pr2 = gh.fx.detail.repository.pullRequests.nodes[0]!;
    gh.fx.recheck.pr2 = { ...(pr2 as GqlPullRequest), state: 'MERGED', mergedAt: '2026-09-27T09:00:00Z', closedAt: '2026-09-27T09:00:00Z', repository: { nameWithOwner: 'alice/app' } };

    expect(await sync(NOW + HOUR)).toMatchObject({ newItems: 0, errors: [] });
    expect(gh.calls.map((c) => c.op)).toEqual(['ViewerRepos', 'RepoProbes', 'RepoDetail', 'RecheckItems']);
    expect(state('pull_requests', 2)).toBe('merged');
    expect(state('issues', 11)).toBeNull();
    expect(db.get('SELECT activity_at FROM pull_requests WHERE number = 2')).toEqual({ activity_at: '2026-09-27T09:00:00Z' });
  });

  describe('commit history', () => {
    const base = () => gh.fx.detail.repository.defaultBranchRef.target.history.nodes;
    const node = (n: number, date: string) => ({ ...base()[1]!, oid: String(n).repeat(40).slice(0, 40), messageHeadline: `New ${n}`, committedDate: date });
    const oids = () => (db.all('SELECT oid FROM commits ORDER BY oid') as { oid: string }[]).map((r) => r.oid.slice(0, 2));
    const push = (pushedAt: string) => (gh.fx.repos.viewer.repositories.nodes[0]!.pushedAt = pushedAt);

    it('resumes an interrupted incremental pass instead of leaving a gap', async () => {
      // Three new commits on top of the known history, served two per page.
      push('2026-09-27T11:00:00Z');
      const [n4, n5, n6] = [node(4, '2026-09-27T10:00:00Z'), node(5, '2026-09-27T09:00:00Z'), node(6, '2026-09-27T08:00:00Z')];
      gh.fx.historyPages = {
        '': { nodes: [n4, n5], hasNextPage: true, endCursor: 'p2' },
        p2: { nodes: [n6, ...base().slice(0, 1)], hasNextPage: true, endCursor: 'p3' },
        p3: { nodes: base().slice(1), hasNextPage: false, endCursor: null },
      };
      gh.fx.failHistory.add('p2');
      expect((await sync(NOW + HOUR)).errors).toEqual(['app: history page failed']);
      expect(oids()).toEqual(['11', '22', '33', '44', '55']);

      gh.fx.failHistory.clear();
      expect(await sync(NOW + 2 * HOUR)).toMatchObject({ errors: [] });
      expect(oids()).toEqual(['11', '22', '33', '44', '55', '66']);
    });

    it('drops commits that a force push removed from the default branch', async () => {
      expect(oids()).toEqual(['11', '22', '33']);
      // History rewritten on top of 33: the previous head (11, the first commit the last walk saw) and 22 are gone.
      push('2026-09-27T11:00:00Z');
      gh.fx.historyPages = { '': { nodes: [node(4, '2026-09-27T10:00:00Z'), base()[2]!], hasNextPage: false, endCursor: null } };
      expect(await sync(NOW + HOUR)).toMatchObject({ errors: [], newItems: 1 });
      expect(oids()).toEqual(['33', '44']);
      // A full resync walks the whole window too, and prunes the same way.
      gh.fx.historyPages = { '': { nodes: [base()[2]!], hasNextPage: false, endCursor: null } };
      await sync(NOW + 2 * HOUR, { full: true });
      expect(oids()).toEqual(['33']);
    });

    it('state saved before commits_head existed stops at the first stored commit, then records the head', async () => {
      db.run('UPDATE sync_state SET commits_head = NULL');
      push('2026-09-27T11:00:00Z');
      gh.fx.historyPages = {
        '': { nodes: [node(4, '2026-09-27T10:00:00Z'), base()[2]!], hasNextPage: true, endCursor: 'p2' },
        p2: { nodes: base().slice(0, 2), hasNextPage: false, endCursor: null },
      };
      await sync(NOW + HOUR);
      expect(gh.calls.filter((c) => c.op === 'RepoDetail' && c.vars.withCommits).map((c) => c.vars.commitsAfter)).toEqual([null]);
      expect(oids()).toEqual(['11', '22', '33', '44']);
      expect(db.get("SELECT substr(commits_head, 1, 2) AS h FROM sync_state JOIN repos r ON r.id = repo_id WHERE r.name = 'app'")).toEqual({ h: '44' });
    });

    it('does not prune when an incremental pass stops at the previous head', async () => {
      push('2026-09-27T11:00:00Z');
      gh.fx.historyPages = { '': { nodes: [node(4, '2026-09-27T10:00:00Z'), ...base()], hasNextPage: true, endCursor: 'p2' } };
      await sync(NOW + HOUR);
      expect(oids()).toEqual(['11', '22', '33', '44']);
      expect(gh.calls.filter((c) => c.op === 'RepoDetail' && c.vars.withCommits).map((c) => c.vars.commitsAfter)).toEqual([null]);
    });
  });

  it('records per-repo errors without aborting the sync', async () => {
    gh.fx.probes.nodes[0]!.latestIssue.nodes[0]!.updatedAt = '2026-09-27T10:00:00Z';
    (gh.fx.detail as { repository: unknown }).repository = null;
    const res = await sync(NOW + HOUR);
    expect(res.errors).toEqual(['app: repository not found']);
    expect(db.get('SELECT last_error FROM sync_state JOIN repos r ON r.id = repo_id WHERE r.name = ?', ['app'])).toEqual({ last_error: 'repository not found' });
  });
});

describe('fork commit history', () => {
  it('is skipped unless includeForks, backfilled when it is turned on, and never purged', async () => {
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    gh.fx.repos.viewer.repositories.nodes[0]!.isFork = true;
    const sync = (at: number, includeForks: boolean) =>
      runSync({ db, client: new GitHubClient({ token: 't', fetchImpl: gh.fetchImpl }), settings: { ...DEFAULT_SETTINGS, includeForks }, now: () => at });
    const commitsFetched = () => gh.calls.filter((c) => c.op === 'RepoDetail' && c.vars.withCommits).map((c) => c.vars.commitsAfter);

    expect(await sync(NOW, false)).toMatchObject({ forksSkipped: 1, errors: [] });
    expect(commitsFetched()).toEqual([]);
    expect([count(db, 'commits'), count(db, 'pull_requests'), count(db, 'stars')]).toEqual([0, 2, 2]);

    gh.calls.length = 0;
    expect(await sync(NOW + HOUR, true)).toMatchObject({ forksSkipped: 0, newItems: 3 });
    expect(commitsFetched()).toEqual([null]);

    gh.calls.length = 0;
    gh.fx.repos.viewer.repositories.nodes[0]!.pushedAt = '2026-09-27T12:30:00Z';
    expect(await sync(NOW + 2 * HOUR, false)).toMatchObject({ forksSkipped: 1 });
    expect(commitsFetched()).toEqual([]);
    expect(count(db, 'commits')).toBe(3);
  });
});

describe('planRepo', () => {
  const repo = { defaultBranch: 'main', pushedAt: '2026-09-25T00:00:00Z', stars: 3 } as RepoRecord;
  const probe: RepoProbe = { openPrs: 0, openIssues: 0, latestPrUpdatedAt: '2026-09-20T00:00:00Z', latestIssueUpdatedAt: null, releaseTags: ['v1'], latestStarredAt: '2026-09-01T00:00:00Z' };
  const state: SyncStateRow = {
    repo_id: 1, commits_pushed_at: '2026-09-25T00:00:00Z', commits_branch: 'main', commits_head: null, prs_hwm: '2026-09-20T00:00:00Z', issues_hwm: '2026-09-01T00:00:00Z',
    releases_synced_at: '2026-09-27T00:00:00Z', stars_synced_at: '2026-09-27T00:00:00Z', stars_full_at: '2026-09-27T00:00:00Z', synced_at: '2026-09-27T00:00:00Z', last_error: null,
  };
  const ctx = { full: false, includeForks: false, backfillStart: '2025-09-27T00:00:00Z', now: NOW, storedStars: { count: 3, latest: '2026-09-01T00:00:00Z' }, isKnownRelease: () => true };
  const none = { commits: null, prs: null, issues: null, releases: null, stars: null };

  it('plans nothing when every probe matches the stored marks', () => {
    expect(planRepo(repo, probe, state, ctx)).toEqual(none);
  });

  it('plans everything from the backfill window on a first or full sync', () => {
    const fresh = { ...state, commits_pushed_at: null, prs_hwm: null, issues_hwm: null, releases_synced_at: null, stars_synced_at: null, stars_full_at: null };
    const all = { commits: { stopAtKnown: false }, prs: { stopBefore: ctx.backfillStart }, issues: { stopBefore: ctx.backfillStart }, releases: { stopAtKnown: false }, stars: { mode: 'full' } };
    expect(planRepo(repo, probe, fresh, ctx)).toEqual(all);
    expect(planRepo(repo, probe, state, { ...ctx, full: true })).toEqual(all);
  });

  it('switches default branch or unknown probes to fetching', () => {
    expect(planRepo(repo, probe, { ...state, commits_branch: 'master' }, ctx).commits).toEqual({ stopAtKnown: false });
    expect(planRepo(repo, null, state, ctx)).toMatchObject({ prs: { stopBefore: state.prs_hwm }, releases: { stopAtKnown: true }, stars: { mode: 'incremental' } });
    expect(planRepo(repo, probe, state, { ...ctx, isKnownRelease: () => false }).releases).toEqual({ stopAtKnown: true });
  });

  it('re-diffs stars daily, or at once when GitHub has fewer than we store', () => {
    expect(planRepo(repo, probe, state, { ...ctx, now: Date.parse(state.stars_full_at!) + 25 * HOUR }).stars).toEqual({ mode: 'full' });
    expect(planRepo({ ...repo, stars: 2 }, probe, state, ctx).stars).toEqual({ mode: 'full' });
    expect(planRepo({ ...repo, stars: 0 }, { ...probe, latestStarredAt: null }, state, { ...ctx, storedStars: { count: 0, latest: null }, now: NOW + 48 * HOUR }).stars).toBeNull();
    expect(planRepo({ ...repo, stars: 5000 }, probe, state, { ...ctx, now: NOW + 48 * HOUR }).stars).toBeNull();
  });

  it('skips fork commit history unless forks are included', () => {
    const fork = { ...repo, isFork: true };
    expect(planRepo(fork, probe, { ...state, commits_pushed_at: null }, ctx).commits).toBeNull();
    expect(planRepo(fork, probe, { ...state, commits_pushed_at: null }, { ...ctx, includeForks: true }).commits).toEqual({ stopAtKnown: false });
  });

  it('skips commits for empty repos', () => {
    expect(planRepo({ ...repo, defaultBranch: null }, probe, { ...state, commits_pushed_at: null }, ctx).commits).toBeNull();
  });
});
