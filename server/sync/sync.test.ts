import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db';
import type { RepoProbe, RepoRecord } from '../db/records';
import { ensureSource, GITHUB_SOURCE_ID, getSource, type SourceRow, viewerMismatch } from '../db/sources';
import { upsertOwned } from '../db/write';
import { mapRepo } from '../github/map';
import { DEFAULT_SETTINGS } from '../db/settings';
import type { Settings } from '../../shared/api';
import type { SyncStateRow } from '../db/write';
import { GitHubSyncSource } from '../github/sync-source';
import type { GqlIssue, GqlProbe, GqlPullRequest, GqlRepo } from '../github/types';
import detailFixture from '../test/fixtures/repo-detail.json';
import probesFixture from '../test/fixtures/repo-probes.json';
import reposFixture from '../test/fixtures/viewer-repos.json';
import { fakeGitHub as fakeApi } from '../test/github';
import { fakeGraphQL, releaseNode, repoNode } from '../test/graphql';
import { planRepo, runSync } from './sync';
import { addManualRepo, setViewer } from '../test/seed';

const viewerOf = (db: Db) => getSource(db, GITHUB_SOURCE_ID)!.viewer;
/** The github.com source a run syncs, and its client for the fake. */
const github = (db: Db) => getSource(db, GITHUB_SOURCE_ID)!;
const on = (fetchImpl: typeof fetch, tokenKind: 'classic' | null = null) => new GitHubSyncSource({ token: 't', fetchImpl, tokenKind });

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;

interface Call {
  op: string;
  vars: Record<string, unknown>;
}

type Item = (GqlPullRequest | GqlIssue) & { repository?: { nameWithOwner: string } };
type Node = GqlRepo & GqlProbe;

/** A repository of another owner as GitHub serves it (node id `R_<key>`, like addManualRepo's rows). */
function otherRepo(key: string, over: Partial<Node> = {}): Node {
  const [owner, name] = key.split('/') as [string, string];
  const base = structuredClone(reposFixture.viewer.repositories.nodes[0]!) as unknown as Node;
  // In step with what the fake's RepoDetail serves for it: one merged PR, nothing else.
  const probe: Omit<GqlProbe, 'id'> = {
    openPrs: { totalCount: 0 }, openIssues: { totalCount: 0 }, latestPr: { nodes: [{ updatedAt: '2026-09-21T10:00:05Z' }] },
    latestIssue: { nodes: [] }, latestReleases: { nodes: [] }, latestStar: { edges: [{ starredAt: '2026-09-20T00:00:00Z' }] },
  };
  return {
    ...base, ...probe, id: `R_${key}`, name, nameWithOwner: key, owner: { login: owner }, url: `https://github.com/${key}`,
    description: `${key} upstream`, stargazerCount: 900, ...over,
  };
}

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
    /** Repositories of other owners, served by node id (ManualRepos, RepoNode) and by name (RepoDetail). */
    others: [] as Node[],
    /** GraphQL errors for a node id (ManualRepos, RepoNode, RepoProbes): the node comes back null. */
    nodeErrors: {} as Record<string, { type: string; message: string }>,
    /** A field of a node the token may not read (ManualRepos, RepoNode): just that field is null, with its error. */
    fieldErrors: {} as Record<string, { field: string; type: string; message: string }>,
    /** RepoDetail errors by owner/name; a path of just ['repository'] nulls the whole repository. */
    detailErrors: {} as Record<string, { type: string; message: string; path: (string | number)[] }>,
    /** Called when RepoDetail is asked for owner/name (before it answers). */
    onDetail: null as ((key: string) => void) | null,
  };
  const calls: Call[] = [];
  const conn = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
  const viewerRepo = (name: string) => {
    const { repositories, ...viewer } = fx.repos.viewer;
    const node = repositories.nodes.find((n) => n.name === name);
    const probe = fx.probes.nodes.find((p) => p?.id === node?.id);
    return { viewer: { ...viewer, repository: node ? { ...node, ...probe } : null }, rateLimit: fx.repos.rateLimit };
  };
  /** A node by id, with its probe fields: one of the viewer's (fixtures) or of `others`. */
  const byId = (id: string): Node | null => {
    const own = fx.repos.viewer.repositories.nodes.find((n) => n.id === id);
    const probe = fx.probes.nodes.find((p) => p?.id === id);
    return own ? ({ ...own, ...probe } as unknown as Node) : (fx.others.find((n) => n.id === id) ?? null);
  };
  /** Answers a lookup of `ids` at `path(i)`: null plus an error for a node that errs or doesn't exist. */
  const nodesOf = (ids: string[], path: (i: number) => (string | number)[], pick: (id: string) => unknown) => {
    const errors: object[] = [];
    const nodes = ids.map((id, i) => {
      const err = fx.nodeErrors[id];
      const node = err ? null : pick(id);
      if (!node) errors.push({ ...(err ?? { type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${id}'` }), path: path(i) });
      const denied = node ? fx.fieldErrors[id] : undefined;
      if (denied) {
        errors.push({ type: denied.type, message: denied.message, path: [...path(i), denied.field] });
        return { ...(node as object), [denied.field]: null };
      }
      return node;
    });
    return { nodes, errors };
  };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    const op = /query (\w+)/.exec(query)![1]!;
    calls.push({ op, vars: variables });
    const rateLimit = fx.repos.rateLimit;
    const reply = (data: unknown, errors: object[] = []) => new Response(JSON.stringify({ data, ...(errors.length ? { errors } : {}) }));
    if (op === 'ManualRepos' || op === 'RepoProbes') {
      const ids = variables.ids as string[];
      const pick = op === 'RepoProbes' ? (id: string) => fx.probes.nodes.find((p) => p?.id === id) ?? null : byId;
      const { nodes, errors } = nodesOf(ids, (i) => ['nodes', i], pick);
      return reply({ nodes, rateLimit }, errors);
    }
    if (op === 'RepoNode') {
      const { nodes, errors } = nodesOf([String(variables.id)], () => ['node'], byId);
      const { repositories: _, ...viewer } = fx.repos.viewer;
      return reply({ viewer, node: nodes[0], rateLimit }, errors);
    }
    if (op === 'RepoDetail') {
      const key = `${String(variables.owner)}/${String(variables.name)}`;
      fx.onDetail?.(key);
      const err = fx.detailErrors[key];
      if (err?.path.length === 1) return reply({ repository: null, rateLimit }, [err]);
      if (err) return reply(null, [err]);
    }
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
      : op === 'ViewerRepo' ? viewerRepo(String(variables.name))
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
            nameWithOwner: `${String(variables.owner)}/${String(variables.name)}`,
            pullRequests: conn(variables.owner === 'alice' ? [] : [{ ...fx.detail.repository.pullRequests.nodes[1], number: 40, title: `Theirs (${String(variables.name)})` }]),
            issues: conn([]), openPrs: conn([]), openIssues: conn([]), releases: conn([]),
            // Stargazers of another owner's repo are served, but must never be asked for.
            stargazers: variables.owner === 'alice'
              ? { totalCount: 0, pageInfo: conn([]).pageInfo, edges: [] }
              : { totalCount: 1, pageInfo: conn([]).pageInfo, edges: [{ starredAt: '2026-09-20T00:00:00Z', node: { login: 'zed', name: null, avatarUrl: null } }] },
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
    runSync({ db, source: on(gh.fetchImpl), src: github(db), settings, now: () => at }, req);
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
    expect(viewerOf(db)).toEqual({ id: 'U_alice', login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice', emails: [] });
    expect([count(db, 'repos'), count(db, 'commits'), count(db, 'pull_requests'), count(db, 'pr_commits'), count(db, 'issues'), count(db, 'releases'), count(db, 'stars')])
      .toEqual([2, 3, 2, 1, 2, 1, 2]);
    expect(db.all('SELECT headline, pr_number FROM commits ORDER BY committed_at')).toEqual([
      { headline: 'Upstream change', pr_number: null },
      { headline: 'Merge pull request #1 from alice/fix', pr_number: 1 },
      { headline: 'Tweak config', pr_number: null },
    ]);
    expect(db.get('SELECT open_prs, open_issues FROM repos WHERE name = ?', ['app'])).toEqual({ open_prs: 1, open_issues: 1 });
    expect(db.all('SELECT name, visibility FROM repos ORDER BY name')).toEqual([{ name: 'app', visibility: 'public' }, { name: 'corp', visibility: 'internal' }]);
    expect(db.get('SELECT prs_hwm, issues_hwm, commits_pushed_at FROM sync_state JOIN repos r ON r.id = repo_id WHERE r.name = ?', ['app'])).toEqual({
      prs_hwm: '2026-09-22T09:00:00Z', issues_hwm: '2026-09-26T00:00:00Z', commits_pushed_at: '2026-09-25T12:00:00Z',
    });
  });

  it('syncs one tracked repo by node id, named by key or by the short name of a repo you own', async () => {
    for (const repo of ['alice/app', 'app', 'ALICE/App']) {
      gh.calls.length = 0;
      expect(await sync(NOW + HOUR, { repo }), repo).toMatchObject({ repos: 1, errors: [] });
      expect(gh.calls.filter((c) => c.op === 'RepoNode').map((c) => c.vars.id), repo).toEqual(['R_app']);
    }
    // A bare name nothing tracks yet: one of the viewer's own, looked up by name (it may have just been created).
    db.run(`DELETE FROM repos WHERE name = 'app'`);
    gh.calls.length = 0;
    expect(await sync(NOW + HOUR, { repo: 'app' })).toMatchObject({ repos: 1, errors: [] });
    expect(gh.calls.map((c) => c.op).slice(0, 1)).toEqual(['ViewerRepo']);
    // A repo added by hand, by its node id.
    addManualRepo(db, 'bob/tool');
    gh.fx.others.push(otherRepo('bob/tool'));
    gh.calls.length = 0;
    expect(await sync(NOW + HOUR, { repo: 'bob/tool' })).toMatchObject({ repos: 1, errors: [] });
    expect(gh.calls.filter((c) => c.op === 'RepoNode').map((c) => c.vars.id)).toEqual(['R_bob/tool']);
    expect(gh.calls.filter((c) => c.op === 'RepoDetail').map((c) => [c.vars.owner, c.vars.name, c.vars.withStars])).toEqual([['bob', 'tool', false]]);
    gh.calls.length = 0;
    await expect(sync(NOW + HOUR, { repo: 'bob/nope' })).rejects.toThrow("Repository isn't tracked: bob/nope");
    await expect(sync(NOW + HOUR, { repo: 'tool' })).rejects.toThrow('Repository not found on GitHub: tool');
    expect(gh.calls.map((c) => c.op)).toEqual(['ViewerRepo']);
  });

  it('keeps repos added by hand when the owned list no longer has them', async () => {
    const bob = addManualRepo(db, 'bob/app');
    gh.fx.others.push(otherRepo('bob/app'));
    expect(await sync(NOW + HOUR, { full: true })).toMatchObject({ repos: 3, errors: [] });
    expect(db.get('SELECT tracked_by, removed_at, unavailable_at FROM repos WHERE id = ?', [bob])).toEqual({ tracked_by: 'manual', removed_at: null, unavailable_at: null });
    expect(db.all(`SELECT DISTINCT tracked_by FROM repos WHERE id <> ?`, [bob])).toEqual([{ tracked_by: 'owned' }]);
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
    // The new PR is open: GitHub counts it, and lists it among the open ones.
    gh.fx.probes.nodes[0]!.openPrs.totalCount = 2;
    gh.fx.openPrs.unshift(newPr as unknown as Item);

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

  it('stores PR head commits and follows a PR whose head moves', async () => {
    const heads = () => db.all('SELECT number, substr(head_oid, 1, 4) AS head FROM pull_requests ORDER BY number');
    expect(heads()).toEqual([{ number: 1, head: 'aaaa' }, { number: 2, head: 'bbbb' }]);
    // PR 1 as synced before head_oid existed: it stays NULL (no backfill) until GitHub reports it updated.
    db.run('UPDATE pull_requests SET head_oid = NULL WHERE number = 1');
    // A push to PR 2 bumps its updatedAt, so the updatedAt pass re-reads it.
    Object.assign(gh.fx.detail.repository.pullRequests.nodes[0]!, { headRefOid: 'c'.repeat(40), updatedAt: '2026-09-27T09:00:00Z' });
    gh.fx.probes.nodes[0]!.latestPr.nodes[0]!.updatedAt = '2026-09-27T09:00:00Z';

    await sync(NOW + HOUR);
    expect(heads()).toEqual([{ number: 1, head: null }, { number: 2, head: 'cccc' }]);
  });

  it("stores whether a PR's head is in another repo, and gives the threads a same-repo PR had before that was known its branch", async () => {
    const app = db.get<{ id: number }>(`SELECT id FROM repos WHERE name = 'app'`)!.id;
    const flags = () => db.all('SELECT number, cross_repo FROM pull_requests WHERE repo_id = ? ORDER BY number', [app]);
    expect(flags()).toEqual([{ number: 1, cross_repo: 0 }, { number: 2, cross_repo: 1 }]);
    // As synced before v9 (schema.ts, BRANCHES): not known, and the threads made since have no branch.
    db.run('UPDATE pull_requests SET cross_repo = NULL');
    for (const n of [1, 2]) {
      db.run(`INSERT INTO comment_threads (repo_id, pr_number, commit_oid, created_at, updated_at) VALUES (?, ?, ?, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z')`, [app, n, 'a'.repeat(40)]);
    }
    const branches = () => db.all('SELECT pr_number, branch FROM comment_threads ORDER BY pr_number');
    expect(branches()).toEqual([{ pr_number: 1, branch: null }, { pr_number: 2, branch: null }]);

    // A full sync re-reads both: PR 1's branch (fix) is this repo's, PR 2's (parser, a fork's) is not.
    await sync(NOW + HOUR, { full: true });
    expect(flags()).toEqual([{ number: 1, cross_repo: 0 }, { number: 2, cross_repo: 1 }]);
    expect(branches()).toEqual([{ pr_number: 1, branch: 'fix' }, { pr_number: 2, branch: null }]);
  });

  it('re-reads stored-open items GitHub no longer lists as open, deleting ones that are gone', async () => {
    // Nothing bumped updatedAt (e.g. the issue was deleted), but GitHub now reports no open items.
    gh.fx.openPrs = [];
    gh.fx.openIssues = [];
    gh.fx.probes.nodes[0]!.openPrs.totalCount = 0;
    gh.fx.probes.nodes[0]!.openIssues.totalCount = 0;
    const pr2 = gh.fx.detail.repository.pullRequests.nodes[0]!;
    // As synced before v9: the recheck says whether it is from a fork.
    db.run('UPDATE pull_requests SET cross_repo = NULL WHERE number = 2');
    gh.fx.recheck.pr2 = { ...(pr2 as GqlPullRequest), state: 'MERGED', mergedAt: '2026-09-27T09:00:00Z', closedAt: '2026-09-27T09:00:00Z', headRefOid: 'd'.repeat(40), repository: { nameWithOwner: 'alice/app' } };

    expect(await sync(NOW + HOUR)).toMatchObject({ newItems: 0, errors: [] });
    expect(gh.calls.map((c) => c.op)).toEqual(['ViewerRepos', 'RepoProbes', 'RepoDetail', 'RecheckItems']);
    expect(state('pull_requests', 2)).toBe('merged');
    expect(state('issues', 11)).toBeNull();
    expect(db.get('SELECT activity_at, head_oid, cross_repo FROM pull_requests WHERE number = 2')).toEqual({ activity_at: '2026-09-27T09:00:00Z', head_oid: 'd'.repeat(40), cross_repo: 1 });
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
      expect((await sync(NOW + HOUR)).errors).toEqual(['alice/app: history page failed']);
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
    expect(res.errors).toEqual(['alice/app: repository not found']);
    expect(db.get('SELECT last_error FROM sync_state JOIN repos r ON r.id = repo_id WHERE r.name = ?', ['app'])).toEqual({ last_error: 'repository not found' });
  });
});

describe('repos added by hand', () => {
  let db: Db;
  let gh: ReturnType<typeof fakeGitHub>;
  const sync = (at: number, req = {}, tokenKind: 'classic' | null = null) =>
    runSync({ db, source: on(gh.fetchImpl, tokenKind), src: github(db), settings: DEFAULT_SETTINGS, now: () => at }, req);
  const row = (key: string) =>
    db.get<{ id: number; description: string | null; stars: number; open_prs: number; unavailable_at: string | null; unavailable_reason: string | null; removed_at: string | null }>(
      'SELECT id, description, stars, open_prs, unavailable_at, unavailable_reason, removed_at FROM repos WHERE name_with_owner = ?', [key]);
  const prsOf = (key: string) => db.all<{ title: string }>('SELECT p.title FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE r.name_with_owner = ?', [key]).map((p) => p.title);
  const syncedAt = (key: string) => db.get<{ synced_at: string | null }>('SELECT s.synced_at FROM sync_state s JOIN repos r ON r.id = s.repo_id WHERE r.name_with_owner = ?', [key])?.synced_at ?? null;
  const details = () => gh.calls.filter((c) => c.op === 'RepoDetail').map((c) => `${String(c.vars.owner)}/${String(c.vars.name)}`);

  beforeEach(async () => {
    db = openDb(':memory:');
    gh = fakeGitHub();
    await sync(NOW);
    addManualRepo(db, 'bob/tool');
    gh.fx.others.push(otherRepo('bob/tool'));
    gh.calls.length = 0;
  });

  it('are refreshed by node id and synced in the same run as owned repos, without stargazers', async () => {
    expect(await sync(NOW + HOUR)).toEqual({ repos: 3, newItems: 1, errors: [], forksSkipped: 0 });
    expect(gh.calls.map((c) => c.op).slice(0, 3)).toEqual(['ViewerRepos', 'ManualRepos', 'RepoProbes']);
    expect(gh.calls.find((c) => c.op === 'ManualRepos')!.vars).toEqual({ ids: ['R_bob/tool'] });
    expect(row('bob/tool')).toMatchObject({ description: 'bob/tool upstream', stars: 900, open_prs: 0, unavailable_at: null });
    expect(prsOf('bob/tool')).toEqual(['Theirs (tool)']);
    expect(gh.calls.filter((c) => c.op === 'RepoDetail').map((c) => [c.vars.owner, c.vars.withStars])).toEqual([['bob', false]]);
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM stars s JOIN repos r ON r.id = s.repo_id WHERE r.tracked_by = 'manual'`)!.n).toBe(0);
    expect(syncedAt('bob/tool')).not.toBeNull();
  });

  it('follow a rename on GitHub to a new key', async () => {
    gh.fx.others[0] = otherRepo('bob/tool', { name: 'tool2', nameWithOwner: 'bob/tool2' });
    await sync(NOW + HOUR);
    expect(row('bob/tool2')).toMatchObject({ removed_at: null });
    expect(row('bob/tool')).toBeUndefined();
  });

  it("that can't be read become unavailable: data kept, not synced, checked again every run", async () => {
    await sync(NOW + HOUR);
    gh.fx.nodeErrors['R_bob/tool'] = { type: 'NOT_FOUND', message: "Could not resolve to a node with the global id of 'R_bob/tool'" };
    gh.calls.length = 0;
    expect(await sync(NOW + 2 * HOUR)).toMatchObject({ repos: 2, errors: [] });
    expect(details()).not.toContain('bob/tool');
    const first = row('bob/tool')!;
    expect(first).toMatchObject({
      unavailable_at: '2026-09-27T14:00:00Z',
      unavailable_reason: "GitHub doesn't show bob/tool to this token: it doesn't exist, or the token can't read it. Check the spelling, or ask for access.",
    });
    expect(prsOf('bob/tool')).toEqual(['Theirs (tool)']);

    // Still unreadable: the first time is kept; the reason follows the latest answer.
    gh.fx.nodeErrors['R_bob/tool'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement. You must grant your token access to this organization.' };
    await sync(NOW + 3 * HOUR, {}, 'classic');
    expect(row('bob/tool')).toMatchObject({
      unavailable_at: '2026-09-27T14:00:00Z',
      unavailable_reason: 'bob requires SAML single sign-on. Authorize the token for bob (github.com/settings/tokens → Configure SSO).',
    });

    // Readable again: cleared and synced.
    delete gh.fx.nodeErrors['R_bob/tool'];
    gh.calls.length = 0;
    expect(await sync(NOW + 4 * HOUR)).toMatchObject({ repos: 3, errors: [] });
    expect(row('bob/tool')).toMatchObject({ unavailable_at: null, unavailable_reason: null });
  });

  it('become unavailable when the repository itself fails mid-run; a section the token may not read is an ordinary error', async () => {
    gh.fx.detailErrors['bob/tool'] = { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'bob/tool'.", path: ['repository'] };
    const res = await sync(NOW + HOUR);
    expect(res.errors).toEqual([`bob/tool: unavailable: GitHub doesn't show bob/tool to this token: it doesn't exist, or the token can't read it. Check the spelling, or ask for access.`]);
    expect(row('bob/tool')!.unavailable_at).toBe('2026-09-27T13:00:00Z');

    db.run('UPDATE repos SET unavailable_at = NULL, unavailable_reason = NULL');
    gh.fx.detailErrors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', path: ['repository', 'pullRequests'] };
    const again = await sync(NOW + 2 * HOUR);
    expect(again.errors).toEqual(['bob/tool: Resource not accessible by personal access token']);
    expect(row('bob/tool')!.unavailable_at).toBeNull();
  });

  it('a manual chunk failing for another reason skips its repos this run, and marks nothing', async () => {
    gh.fx.nodeErrors['R_bob/tool'] = { type: 'INTERNAL', message: 'Something broke' };
    const res = await sync(NOW + HOUR);
    expect(res).toMatchObject({ repos: 2, errors: ['manual repos: Something broke'] });
    expect(details()).not.toContain('bob/tool');
    expect(row('bob/tool')!.unavailable_at).toBeNull();
  });

  it('on a fatal error, waits for the requests in flight before giving up (nothing is written after)', async () => {
    // 26 repos added by hand: two MANUAL_REPOS chunks. The first is rate limited; the second answers later.
    for (let i = 0; i < 25; i++) {
      addManualRepo(db, `bob/r${i}`);
      gh.fx.others.push(otherRepo(`bob/r${i}`));
    }
    gh.fx.nodeErrors['R_bob/tool'] = { type: 'RATE_LIMITED', message: 'API rate limit exceeded' };
    const later = async (input: string | URL | Request, init?: RequestInit) => {
      const ids = (JSON.parse(String(init?.body)) as { variables: { ids?: string[] } }).variables.ids ?? [];
      if (ids.includes('R_bob/r24')) await new Promise((r) => setTimeout(r, 40));
      return gh.fetchImpl(input as string, init!);
    };
    const source = on(later as typeof fetch);
    const err = await runSync({ db, source, src: github(db), settings: DEFAULT_SETTINGS, now: () => NOW + HOUR }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate-limit' });
    const at = row('bob/r24');
    await new Promise((r) => setTimeout(r, 100));
    expect(row('bob/r24')).toEqual(at);
    expect(at!.description).toBe('bob/r24 upstream');
  });

  it('keep what they had for a field the token may not read, and report the repo as failed', async () => {
    await sync(NOW + HOUR);
    const before = db.get<{ default_branch: string; language_name: string; synced_at: string }>(
      `SELECT r.default_branch, r.language_name, s.synced_at FROM repos r JOIN sync_state s ON s.repo_id = r.id WHERE r.name_with_owner = 'bob/tool'`)!;
    expect(before).toMatchObject({ default_branch: 'main', language_name: 'TypeScript' });
    const reason = 'The token can see bob/tool but not its code history. Grant read access to Pull requests, Issues and Contents.';
    gh.fx.fieldErrors['R_bob/tool'] = { field: 'defaultBranchRef', type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' };
    for (const req of [{}, { repo: 'bob/tool' }]) {
      const res = await sync(NOW + 2 * HOUR, req);
      expect(res.errors, JSON.stringify(req)).toEqual([`bob/tool: ${reason}`]);
      expect(db.get(`SELECT r.default_branch, r.language_name, s.synced_at, s.last_error FROM repos r JOIN sync_state s ON s.repo_id = r.id WHERE r.name_with_owner = 'bob/tool'`))
        .toEqual({ ...before, last_error: reason });
      expect(row('bob/tool')!.unavailable_at).toBeNull();
    }
    gh.fx.fieldErrors['R_bob/tool'] = { field: 'primaryLanguage', type: 'FORBIDDEN', message: 'no' };
    await sync(NOW + 3 * HOUR);
    expect(db.get(`SELECT language_name, language_color FROM repos WHERE name_with_owner = 'bob/tool'`)).toEqual({ language_name: 'TypeScript', language_color: '#3178c6' });
  });

  it('one repo failing with FORBIDDEN leaves the others to finish', async () => {
    gh.fx.detailErrors['alice/app'] = { type: 'FORBIDDEN', message: 'Resource not accessible by integration', path: ['repository', 'pullRequests'] };
    const res = await sync(NOW + HOUR, { full: true });
    expect(res.errors).toEqual(['alice/app: Resource not accessible by integration']);
    expect(details().sort()).toEqual(['alice/app', 'alice/corp', 'bob/tool']);
    expect(syncedAt('bob/tool')).not.toBeNull();
  });

  it('a node the token may not read in a probe chunk costs only its own probe', async () => {
    gh.fx.repos.viewer.repositories.nodes[1]!.isArchived = false; // corp syncs when it looks changed
    await sync(NOW + HOUR);
    gh.fx.nodeErrors['R_corp'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' };
    gh.calls.length = 0;
    expect(await sync(NOW + 2 * HOUR)).toMatchObject({ errors: [] });
    // corp, without a probe, is fetched as if changed (its open items in a second round, once the first has read the
    // updatedAt passes); app's and bob/tool's probes match: nothing else.
    expect(details()).toEqual(['alice/corp', 'alice/corp']);
    expect(gh.calls.filter((c) => c.op === 'RepoProbes')).toHaveLength(1);
  });

  it('a repo removed while it syncs is dropped quietly and not brought back', async () => {
    gh.fx.onDetail = (key) => {
      if (key === 'bob/tool') db.run(`DELETE FROM repos WHERE name_with_owner = 'bob/tool'`);
    };
    const res = await sync(NOW + HOUR);
    expect(res.errors).toEqual([]);
    expect(row('bob/tool')).toBeUndefined();
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM sync_state WHERE repo_id NOT IN (SELECT id FROM repos)`)!.n).toBe(0);
    gh.fx.onDetail = null;
    await sync(NOW + 2 * HOUR);
    expect(row('bob/tool')).toBeUndefined();
  });

  it('never writes into a repo that took the id of one removed while its answer was pending', async () => {
    addManualRepo(db, 'bob/old');
    gh.fx.others.push(otherRepo('bob/old'));
    const oldId = row('bob/old')!.id;
    gh.fx.onDetail = (key) => {
      if (key !== 'bob/old') return;
      db.run('DELETE FROM repos WHERE id = ?', [oldId]);
      // Added meanwhile under the same id (a table without AUTOINCREMENT hands out the highest rowid again).
      db.run(`INSERT INTO repos (id, source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at, tracked_by, added_at)
        VALUES (?, 1, 'carol/new', 'R_carol/new', 'new', 'carol/new', 'carol', 'u', 'public', 'x', 'manual', 'x')`, [oldId]);
    };
    const res = await sync(NOW + HOUR);
    expect(res.errors).toEqual([]);
    expect(prsOf('carol/new')).toEqual([]);
    expect(syncedAt('carol/new')).toBeNull();
    expect(row('carol/new')).toMatchObject({ id: oldId, unavailable_at: null });
  });

  it('marks nothing unavailable in a repo that took the id of one removed while its answer was pending', async () => {
    const oldId = row('bob/tool')!.id;
    gh.fx.detailErrors['bob/tool'] = { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'bob/tool'.", path: ['repository'] };
    gh.fx.onDetail = (key) => {
      if (key !== 'bob/tool') return;
      db.run('DELETE FROM repos WHERE id = ?', [oldId]);
      db.run(`INSERT INTO repos (id, source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at, tracked_by, added_at)
        VALUES (?, 1, 'carol/new', 'R_carol/new', 'new', 'carol/new', 'carol', 'u', 'public', 'x', 'manual', 'x')`, [oldId]);
    };
    expect((await sync(NOW + HOUR)).errors).toEqual([]);
    expect(row('carol/new')).toMatchObject({ unavailable_at: null });
    expect(db.get('SELECT last_error FROM sync_state WHERE repo_id = ?', [oldId])).toBeUndefined();
  });

  it('a single-repo sync of one that became unreadable marks it unavailable and syncs nothing', async () => {
    gh.fx.nodeErrors['R_bob/tool'] = { type: 'FORBIDDEN', message: 'Although you appear to have the correct authorization credentials, the `bob` organization has enabled OAuth App access restrictions.' };
    const res = await sync(NOW + HOUR, { repo: 'bob/tool' });
    expect(res).toMatchObject({ repos: 0, errors: ['bob/tool: unavailable: Although you appear to have the correct authorization credentials, the `bob` organization has enabled OAuth App access restrictions.'] });
    expect(details()).toEqual([]);
    expect(row('bob/tool')!.unavailable_at).toBe('2026-09-27T13:00:00Z');
  });

  it('a single-repo sync never brings back a repo removed meanwhile', async () => {
    const id = row('bob/tool')!.id;
    // Removed after the request resolved it, before the answer is written.
    gh.fx.others[0] = otherRepo('bob/tool');
    const orig = gh.fetchImpl;
    const res = await runSync({
      db, settings: DEFAULT_SETTINGS, now: () => NOW + HOUR, src: github(db),
      source: on(async (u, init) => { db.run('DELETE FROM repos WHERE id = ?', [id]); return orig(u, init!); }),
    }, { repo: 'bob/tool' });
    expect(res).toMatchObject({ repos: 0, errors: [] });
    expect(row('bob/tool')).toBeUndefined();
  });
});

describe('account guard', () => {
  const MISMATCH = "This database's GitHub account is @alice, but the token is for @mallory. Switch back to @alice, or use a different database.";
  function setup() {
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    const sync = (req = {}) => runSync({ db, source: on(gh.fetchImpl), src: github(db), settings: DEFAULT_SETTINGS, now: () => NOW }, req);
    return { db, gh, sync };
  }

  it('refuses a token for another account before writing anything', async () => {
    const { db, gh, sync } = setup();
    await sync();
    const repos = () => db.all('SELECT * FROM repos ORDER BY id');
    const before = { repos: repos(), viewer: viewerOf(db) };
    // `gh auth switch` to another account, with its own repos of the same names.
    const v = gh.fx.repos.viewer;
    Object.assign(v, { id: 'U_mallory', login: 'mallory' });
    v.repositories.nodes = v.repositories.nodes.map((n) => ({ ...n, id: `M_${n.id}`, nameWithOwner: `mallory/${n.name}`, owner: { login: 'mallory' } }));
    gh.calls.length = 0;
    await expect(sync()).rejects.toThrow(MISMATCH);
    await expect(sync({ repo: 'app' })).rejects.toThrow(MISMATCH);
    await expect(sync({ repo: 'brand-new' })).rejects.toThrow(MISMATCH);
    expect(gh.calls.map((c) => c.op)).toEqual(['ViewerRepos', 'RepoNode', 'ViewerRepo']);
    expect({ repos: repos(), viewer: viewerOf(db) }).toEqual(before);
  });

  it('follows a renamed account by id, and matches logins for databases stored without one', async () => {
    const { db, gh, sync } = setup();
    setViewer(db, { login: 'Alice', name: null, avatarUrl: null });
    await sync({ repo: 'app' });
    expect(viewerOf(db)).toMatchObject({ id: 'U_alice', login: 'alice' });
    gh.fx.repos.viewer.login = 'alice-renamed';
    expect(await sync()).toMatchObject({ errors: [] });
    expect(viewerOf(db)).toMatchObject({ id: 'U_alice', login: 'alice-renamed' });
  });

  it('compares ids when both sides have one', () => {
    const github = (viewer: SourceRow['viewer']) => ({ id: GITHUB_SOURCE_ID, host: 'github.com', name: 'GitHub', viewer });
    const alice = { id: 'U_alice', login: 'alice', name: null, avatarUrl: null, emails: [] };
    expect(viewerMismatch(github(null), { id: 'U_x', login: 'x' })).toBeNull();
    expect(viewerMismatch(github(alice), { id: 'U_alice', login: 'someone-else' })).toBeNull();
    expect(viewerMismatch(github(alice), { id: 'U_new', login: 'alice' })).toContain('account is @alice');
    expect(viewerMismatch(github({ ...alice, id: null }), { id: 'U_new', login: 'ALICE' })).toBeNull();
    expect(viewerMismatch(github({ ...alice, id: null }), { login: 'mallory' })).toBe(MISMATCH);
  });
});

describe('other sources', () => {
  it("a GitHub run never reads, removes or marks another source's repos", async () => {
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    const gl = ensureSource(db, { kind: 'gitlab', host: 'gitlab.example.com', baseUrl: 'https://gitlab.example.com' });
    // The viewer's GitLab namesake of alice/app, and a nested project added by hand.
    const project = { ...otherRepo('alice/app'), id: 'gid://gitlab/Project/5', url: 'https://gitlab.example.com/alice/app' };
    upsertOwned(db, gl, mapRepo(project), '2026-09-27T00:00:00Z');
    addManualRepo(db, 'platform/team/svc', { source: gl, nodeId: 'gid://gitlab/Project/9' });
    const sync = (req = {}) => runSync({ db, source: on(gh.fetchImpl), src: github(db), settings: DEFAULT_SETTINGS, now: () => NOW }, req);

    expect(await sync()).toMatchObject({ repos: 2, errors: [] });
    expect(JSON.stringify(gh.calls)).not.toContain('gid://gitlab');
    expect(gh.calls.map((c) => c.op)).not.toContain('ManualRepos');
    expect(db.all('SELECT key, removed_at, unavailable_at FROM repos WHERE source_id = ? ORDER BY id', [gl.id])).toEqual([
      { key: 'gitlab.example.com/alice/app', removed_at: null, unavailable_at: null },
      { key: 'gitlab.example.com/platform/team/svc', removed_at: null, unavailable_at: null },
    ]);
    expect(db.all('SELECT key FROM repos WHERE source_id = 1 AND removed_at IS NULL ORDER BY key')).toEqual([{ key: 'alice/app' }, { key: 'alice/corp' }]);
    // A single-repo run is refused another source's repo before any request.
    gh.calls.length = 0;
    await expect(sync({ repo: 'gitlab.example.com/platform/team/svc' })).rejects.toThrow("gitlab.example.com/platform/team/svc isn't on GitHub");
    expect(gh.calls).toEqual([]);
  });
});

describe('fork commit history', () => {
  it('is skipped unless includeForks, backfilled when it is turned on, and never purged', async () => {
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    gh.fx.repos.viewer.repositories.nodes[0]!.isFork = true;
    const sync = (at: number, includeForks: boolean) =>
      runSync({ db, source: on(gh.fetchImpl), src: github(db), settings: { ...DEFAULT_SETTINGS, includeForks }, now: () => at });
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
    releases_synced_at: '2026-09-27T00:00:00Z', stars_synced_at: '2026-09-27T00:00:00Z', stars_full_at: '2026-09-27T00:00:00Z', stars_count: 3, synced_at: '2026-09-27T00:00:00Z', last_error: null,
  };
  const ctx = { full: false, syncStars: true, probesStars: true, includeForks: false, backfillStart: '2025-09-27T00:00:00Z', now: NOW, storedStars: { count: 3, latest: '2026-09-01T00:00:00Z' }, isKnownRelease: () => true };
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

  it("plans stars from the star count when the probe can't tell new ones (a source that doesn't probe stars)", () => {
    const blind = { ...ctx, probesStars: false };
    const noStar = { ...probe, latestStarredAt: null };
    // Unchanged since the last pass: nothing, whatever the probe says, or without one.
    expect(planRepo(repo, noStar, state, blind).stars).toBeNull();
    expect(planRepo(repo, null, state, blind).stars).toBeNull();
    // The count moved: an incremental pass, big projects (never re-listed in full) included.
    expect(planRepo({ ...repo, stars: 4 }, noStar, state, blind).stars).toEqual({ mode: 'incremental' });
    const big = { ...blind, now: NOW + 48 * HOUR };
    expect(planRepo({ ...repo, stars: 5000 }, noStar, { ...state, stars_count: 4990 }, big).stars).toEqual({ mode: 'incremental' });
    expect(planRepo({ ...repo, stars: 5000 }, noStar, { ...state, stars_count: 5000 }, big).stars).toBeNull();
    // No count kept by the last pass: once.
    expect(planRepo(repo, noStar, { ...state, stars_count: null }, blind).stars).toEqual({ mode: 'incremental' });
    // The first pass, the daily diff and fewer stars than stored are as with a probe.
    expect(planRepo(repo, noStar, { ...state, stars_synced_at: null }, blind).stars).toEqual({ mode: 'full' });
    expect(planRepo(repo, noStar, state, { ...blind, now: Date.parse(state.stars_full_at!) + 25 * HOUR }).stars).toEqual({ mode: 'full' });
    expect(planRepo({ ...repo, stars: 2 }, noStar, state, blind).stars).toEqual({ mode: 'full' });
    // A source that probes stars goes by the probe, not the count.
    expect(planRepo({ ...repo, stars: 4 }, { ...probe, latestStarredAt: '2026-08-01T00:00:00Z' }, state, ctx).stars).toBeNull();
  });

  it('skips fork commit history unless forks are included', () => {
    const fork = { ...repo, isFork: true };
    expect(planRepo(fork, probe, { ...state, commits_pushed_at: null }, ctx).commits).toBeNull();
    expect(planRepo(fork, probe, { ...state, commits_pushed_at: null }, { ...ctx, includeForks: true }).commits).toEqual({ stopAtKnown: false });
  });

  it('never plans stars for a repo the viewer does not own', () => {
    const fresh = { ...state, commits_pushed_at: null, prs_hwm: null, issues_hwm: null, releases_synced_at: null, stars_synced_at: null, stars_full_at: null };
    const others = { ...ctx, syncStars: false };
    expect(planRepo(repo, probe, fresh, others)).toEqual({
      commits: { stopAtKnown: false }, prs: { stopBefore: ctx.backfillStart }, issues: { stopBefore: ctx.backfillStart }, releases: { stopAtKnown: false }, stars: null,
    });
    expect(planRepo(repo, null, state, { ...others, full: true }).stars).toBeNull();
  });

  it('skips commits for empty repos', () => {
    expect(planRepo({ ...repo, defaultBranch: null }, probe, { ...state, commits_pushed_at: null }, ctx).commits).toBeNull();
  });

  it('walks commits when the head a source reads moved, even to a commit of the same time', () => {
    const walked = { ...state, commits_head: 'a'.repeat(40) };
    // A push or force-push to a commit dated like the old head: only the head tells.
    expect(planRepo({ ...repo, headOid: 'b'.repeat(40) }, probe, walked, ctx).commits).toEqual({ stopAtKnown: true });
    // The same head is the same branch, whatever its time says.
    expect(planRepo({ ...repo, headOid: 'a'.repeat(40) }, probe, walked, ctx).commits).toBeNull();
    expect(planRepo({ ...repo, headOid: 'a'.repeat(40), pushedAt: '2026-09-26T00:00:00Z' }, probe, walked, ctx).commits).toBeNull();
    // No head read (GitHub, or none found): the push time decides, as before.
    expect(planRepo(repo, probe, walked, ctx).commits).toBeNull();
    expect(planRepo({ ...repo, headOid: null, pushedAt: '2026-09-26T00:00:00Z' }, probe, walked, ctx).commits).toEqual({ stopAtKnown: true });
  });
});

describe('releases', () => {
  it("record a draft published after a newer release: a pass stops at a known release only once it has the probe's", async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    const app = 'alice/app';
    gql.state.releases[app] = [
      releaseNode(app, 'v3', '2026-09-26T09:00:00Z'), releaseNode(app, 'v2.5', '2026-09-25T09:00:00Z', { isDraft: true }),
      releaseNode(app, 'v2', '2026-09-24T09:00:00Z'), releaseNode(app, 'v1', '2026-09-20T09:00:00Z'),
    ];
    const probed = () => repoNode(app, { latestReleases: { nodes: gql.state.releases[app]!.slice(0, 3).map((r) => ({ tagName: r.tagName, isDraft: r.isDraft })) } });
    gql.state.owned.push(probed());
    const api = fakeApi({ '/graphql': gql.handler });
    const db = openDb(':memory:');
    const sync = (at: number) => runSync({ db, source: on(api.fetchImpl), src: github(db), settings: DEFAULT_SETTINGS, now: () => at });
    const tags = () => db.all<{ tag: string }>('SELECT tag FROM releases ORDER BY tag').map((r) => r.tag);
    await sync(NOW);
    expect(tags()).toEqual(['v1', 'v2', 'v3']);

    // Published: it keeps its place in the list (by creation), behind v3, which is known.
    Object.assign(gql.state.releases[app]![1]!, { isDraft: false, publishedAt: '2026-09-27T10:00:00Z' });
    gql.state.owned[0] = probed();
    expect(await sync(NOW + HOUR)).toMatchObject({ newItems: 1, errors: [] });
    expect(tags()).toEqual(['v1', 'v2', 'v2.5', 'v3']);
    // Known now: not asked for again.
    gql.state.ops.length = 0;
    await sync(NOW + 2 * HOUR);
    expect(gql.state.ops.filter((op) => op.startsWith('RepoDetail'))).toEqual([]);
  });
});
