// GitHubSyncSource asks GitHub what the sync (runSync) and the tracking API (Tracking) ask, request for request, and
// reads the answers as they do. Each case runs the sync (or Tracking) on the GraphQL fake, then the source's methods on
// the same fake in the same state, and compares the requests (document and variables) and what each made of the
// answers. Written against the GitHub-only sync the neutral one replaced (step 3b), with the request counts it made:
// they still hold, so the neutral sync over GitHubSyncSource asks GitHub what the old one did.

import { describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/db';
import type { RepoRecord } from '../db/records';
import { DEFAULT_SETTINGS } from '../db/settings';
import { GITHUB_SOURCE_ID, getSource } from '../db/sources';
import { DAY_MS, isoSec } from '../lib/time';
import { accessLost, reasonOf } from '../provider/access';
import type { LookupRecord, Page, RoundRequest, RoundResult, TrackedRepo } from '../provider/types';
import { SyncManager } from '../sync/manager';
import { runSync, type SyncRequest } from '../sync/sync';
import { fakeGitHub, page, type Handler, type Reply } from '../test/github';
import { commitNode, fakeGraphQL, issueNode, prNode, releaseNode, repoNode, starEdge } from '../test/graphql';
import { addManualRepo } from '../test/seed';
import { supplyOf, testTokens } from '../test/tokens';
import { mapCommit, mapIssue, mapPullRequest, mapRelease, mapStar } from './map';
import { GitHubSyncSource } from './sync-source';
import { Tracking } from '../sync/tracking';
import type { Connection, RepoDetailData } from './types';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 3_600_000;
const SINCE = isoSec(NOW - DEFAULT_SETTINGS.backfillDays * DAY_MS);
const at = (d: number, h = 9) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const pad = (i: number) => String(i).padStart(3, '0');
const RATE = { limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z', cost: 1 };

type Gql = ReturnType<typeof fakeGraphQL>;
type Body = { query: string; variables: Record<string, any> };

interface Sent {
  /** The GraphQL operation, or the REST path and query. */
  op: string;
  query: string | null;
  variables: Record<string, any> | null;
  /** The answer's body, once it came. */
  answer: any;
}

/**
 * The fake behind a recording fetch. `intercept` answers a GraphQL request itself (or returns null to let the fake
 * answer); `delay` holds an answer back.
 */
function wire(gql: Gql, routes: Record<string, Handler> = {}) {
  const hooks = {
    intercept: null as ((op: string, body: Body) => Reply | null) | null,
    delay: null as ((op: string, body: Body) => number) | null,
  };
  const graphql: Handler = (req) => {
    const body = req.body as Body;
    return hooks.intercept?.(opOf(body.query), body) ?? (gql.handler as (r: typeof req) => Reply)(req);
  };
  const gh = fakeGitHub({ '/graphql': graphql, ...routes });
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
    const entry: Sent = { op: body ? opOf(body.query) : url.pathname + url.search, query: body?.query ?? null, variables: body?.variables ?? null, answer: undefined };
    sent.push(entry);
    const ms = body && hooks.delay ? hooks.delay(entry.op, body) : 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    const res = await gh.fetchImpl(input, init);
    entry.answer = await res.clone().json();
    return res;
  };
  return { hooks, sent, fetchImpl, take: () => sent.splice(0) };
}
type Wire = ReturnType<typeof wire>;

const opOf = (query: string) => /query (\w+)/.exec(query)?.[1] ?? '?';

/** The requests (of these operations), comparable as a multiset: the pools send chunks in whatever order they finish. */
const asked = (sent: Sent[], ...ops: string[]) =>
  sent.filter((s) => !ops.length || ops.includes(s.op)).map((s) => JSON.stringify({ op: s.op, query: s.query, variables: s.variables })).sort();

const count = (sent: Sent[]) => sent.reduce<Record<string, number>>((n, s) => ({ ...n, [s.op]: (n[s.op] ?? 0) + 1 }), {});

const sourceOn = (w: Wire, tokenKind: 'classic' | null = null) => new GitHubSyncSource({ token: 't', fetchImpl: w.fetchImpl, sleep: async () => {}, tokenKind });

/** The sync, as the manager runs it: github.com's source, with a GitHubSyncSource of its own. */
const syncOn = (db: Db, w: Wire, req: SyncRequest = {}, now = NOW, tokenKind: 'classic' | null = null) =>
  runSync({ db, source: sourceOn(w, tokenKind), src: getSource(db, GITHUB_SOURCE_ID)!, settings: DEFAULT_SETTINGS, now: () => now }, req);

/** The live repos added by hand, as the sync reads them (by id). */
const manualRows = (db: Db): TrackedRepo[] =>
  db.all<{ node_id: string; key: string }>(`SELECT node_id, name_with_owner AS key FROM repos WHERE tracked_by = 'manual' AND removed_at IS NULL ORDER BY id`)
    .map((r) => ({ nodeId: r.node_id, path: r.key }));

/** A repo as the sync stored it (read here rather than through db/write, whose signatures step 1a changes). */
function storedRepoRecord(db: Db, nodeId: string): RepoRecord | null {
  const r = db.get<Record<string, any>>('SELECT * FROM repos WHERE node_id = ?', [nodeId]);
  return r
    ? {
        nodeId: r.node_id, name: r.name, nameWithOwner: r.name_with_owner, owner: r.owner, description: r.description, url: r.url, visibility: r.visibility,
        isArchived: !!r.is_archived, isFork: !!r.is_fork, languageName: r.language_name, languageColor: r.language_color,
        topics: JSON.parse(r.topics) as string[], defaultBranch: r.default_branch, stars: r.stars, forks: r.forks, createdAt: r.created_at, pushedAt: r.pushed_at,
      }
    : null;
}

const recordOf = (db: Db, key: string): RepoRecord =>
  storedRepoRecord(db, db.get<{ node_id: string }>('SELECT node_id FROM repos WHERE name_with_owner = ?', [key])!.node_id)!;

/** The account the fake's token belongs to: the viewer the sync claims. */
const ALICE = { id: 'U_alice', login: 'alice', name: 'Alice', avatarUrl: null };

/**
 * 30 repos of alice's (5 pages of 7, 2 probe requests) and 27 of others added by hand (2 requests): bob/m003 no longer
 * exists, bob/m005 is behind SAML, bob/m007's default branch may not be read, bob/m009 was renamed. alice/r004's
 * probe is partly refused.
 */
function manyRepos(owned = 30, manual = 27) {
  const gql = fakeGraphQL();
  gql.state.strict = true;
  gql.state.pageSize = 7;
  for (let i = 0; i < owned; i++) gql.state.owned.push(repoNode(`alice/r${pad(i)}`, { description: `r${i}`, stargazerCount: i }));
  const db = openDb(':memory:');
  for (let i = 0; i < manual; i++) {
    const key = `bob/m${pad(i)}`;
    addManualRepo(db, key);
    if (i !== 3) gql.state.others.push(repoNode(i === 9 ? 'bob/m009-renamed' : key, { id: `R_${key}`, description: `${key} upstream`, stargazerCount: 900 + i }));
  }
  gql.state.errors['R_alice/r004'] = { type: 'FORBIDDEN', message: 'Resource not accessible by integration', field: 'latestStar' };
  gql.state.errors['R_bob/m005'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' };
  gql.state.errors['R_bob/m007'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', field: 'defaultBranchRef' };
  return { gql, db, w: wire(gql) };
}

describe('GitHubSyncSource asks what the sync asks', () => {
  it('a full sync: the owned list, the repos added by hand and the probes, chunk for chunk', async () => {
    const { db, w } = manyRepos();
    const tracked = manualRows(db);
    const denied = storedRepoRecord(db, 'R_bob/m007')!;
    await syncOn(db, w, {}, NOW, 'classic');
    const sync = w.take();

    const source = sourceOn(w, 'classic');
    const owned = await source.ownedRepos();
    const refreshed = await source.refresh(tracked);
    const probed = await source.probes(owned.repos);
    const mine = w.take();

    // The same requests, and no others.
    expect(asked(mine)).toEqual(asked(sync, 'ViewerRepos', 'ManualRepos', 'RepoProbes'));
    expect(count(mine)).toEqual({ ViewerRepos: 5, ManualRepos: 2, RepoProbes: 2 });
    expect(mine.filter((s) => s.op !== 'ViewerRepos').map((s) => s.variables!.ids.length).sort()).toEqual([2, 25, 25, 5]);
    expect([source.requests, source.points]).toEqual([9, 9]);

    // What the sync stored is what the source read.
    expect(owned.viewer).toEqual(ALICE);
    expect(owned.repos).toEqual(owned.repos.map((r) => storedRepoRecord(db, r.nodeId)));
    expect(refreshed.errors).toEqual([]);
    expect([...refreshed.reads.keys()].sort()).toEqual(tracked.map((t) => t.nodeId).sort());
    for (const t of tracked) {
      const read = refreshed.reads.get(t.nodeId)!;
      const row = db.get<{ unavailable_reason: string | null }>('SELECT unavailable_reason FROM repos WHERE node_id = ?', [t.nodeId])!;
      if (!read.ok) {
        expect(reasonOf(read.access), t.path).toBe(row.unavailable_reason);
        continue;
      }
      expect(row.unavailable_reason, t.path).toBeNull();
      // Denied fields keep what was stored: the sync merges them back.
      expect({ ...read.record, ...Object.fromEntries(read.denied.map((f) => [f, denied[f]])) }, t.path).toEqual(storedRepoRecord(db, t.nodeId));
    }
    expect(Object.fromEntries([...refreshed.reads].filter(([, r]) => !r.ok || r.problem).map(([id, r]) => [id, r.ok ? [r.denied, r.problem, r.probe] : r.access.problem]))).toEqual({
      'R_bob/m003': 'not-found',
      'R_bob/m005': 'sso',
      'R_bob/m007': [['defaultBranch'], 'The token can see bob/m007 but not its code history. Grant read access to Pull requests, Issues and Contents.', null],
    });
    // The partly refused probe costs only its own.
    expect([probed.errors, probed.probes.size, probed.probes.has('R_alice/r004')]).toEqual([[], 29, false]);
  });

  it("a request that fails: the chunk's repos left out, and the sync's error line without its prefix", async () => {
    const { db, w } = manyRepos();
    w.hooks.intercept = (op, { variables }) =>
      (op === 'RepoProbes' && variables.ids.includes('R_alice/r027')) || (op === 'ManualRepos' && variables.ids.includes('R_bob/m026'))
        ? { body: { errors: [{ type: 'INTERNAL', message: 'Something broke' }] } }
        : null;
    const tracked = manualRows(db);
    const res = await syncOn(db, w);
    const sync = w.take();
    expect(res.errors.filter((e) => /^(probe|manual repos):/.test(e))).toEqual(['manual repos: Something broke', 'probe: Something broke']);

    const source = sourceOn(w);
    const owned = await source.ownedRepos();
    const refreshed = await source.refresh(tracked);
    const probed = await source.probes(owned.repos);
    expect(asked(w.take())).toEqual(asked(sync, 'ViewerRepos', 'ManualRepos', 'RepoProbes'));
    expect([refreshed.errors, refreshed.reads.size, refreshed.reads.has('R_bob/m026')]).toEqual([['Something broke'], 25, false]);
    expect([probed.errors, probed.probes.size, probed.probes.has('R_alice/r027')]).toEqual([['Something broke'], 24, false]);
  });

  it('a fatal failure: no more requests start, and it is rethrown once the ones in flight are answered', async () => {
    // Five chunks of each: the first fails for good (rate limited), the second answers late, the fifth never starts.
    const { db, gql, w } = manyRepos(110, 110);
    gql.state.errors['R_alice/r000'] = gql.state.errors['R_bob/m000'] = { type: 'RATE_LIMITED', message: 'API rate limit exceeded' };
    w.hooks.delay = (_op, { variables }) => (variables.ids?.includes('R_alice/r025') || variables.ids?.includes('R_bob/m025') ? 30 : 0);
    const tracked = manualRows(db);

    await expect(syncOn(db, w)).rejects.toMatchObject({ kind: 'rate-limit' });
    const sync = w.take();
    expect(count(sync)).toEqual({ ViewerRepos: 16, ManualRepos: 4 });
    // The sync writes the late chunk before rethrowing (it calls refresh() per chunk); refresh() itself returns nothing
    // when it fails.
    expect(db.get('SELECT description FROM repos WHERE node_id = ?', ['R_bob/m025'])).toEqual({ description: 'bob/m025 upstream' });

    const source = sourceOn(w);
    await expect(source.refresh(tracked)).rejects.toMatchObject({ kind: 'rate-limit' });
    const refreshing = w.take();
    expect(refreshing.every((s) => s.answer !== undefined)).toBe(true);
    expect(asked(refreshing)).toEqual(asked(sync, 'ManualRepos'));

    const owned = (await source.ownedRepos()).repos;
    w.take();
    await expect(source.probes(owned)).rejects.toMatchObject({ kind: 'rate-limit' });
    const probing = w.take();
    expect(probing.every((s) => s.answer !== undefined)).toBe(true);
    expect(probing.map((s) => s.variables!.ids[0]).sort()).toEqual(['R_alice/r000', 'R_alice/r025', 'R_alice/r050', 'R_alice/r075']);
  });

  it('single-repo syncs: RepoNode for a tracked repo, ViewerRepo for the short name of a new one', async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    gql.state.owned.push(repoNode('alice/app'), repoNode('alice/fresh'));
    gql.state.others.push(repoNode('bob/tool'));
    const db = openDb(':memory:');
    const w = wire(gql);
    const source = sourceOn(w);
    /** The single-repo sync `req`, then `mine`: the same one request to read the repo. */
    const same = async <T>(req: SyncRequest, mine: () => Promise<T>): Promise<T> => {
      await syncOn(db, w, req).catch(() => {});
      const sync = w.take().filter((s) => s.op === 'RepoNode' || s.op === 'ViewerRepo');
      const out = await mine();
      expect(asked(w.take()), JSON.stringify(req)).toEqual(asked(sync));
      expect(sync).toHaveLength(1);
      return out;
    };

    // A short name nothing tracks yet: one of the viewer's own, by name.
    const fresh = await same({ repo: 'fresh' }, () => source.repo('fresh'));
    expect(fresh.found!.record).toEqual(recordOf(db, 'alice/fresh'));
    expect(fresh.viewer).toEqual(ALICE);
    await expect(syncOn(db, w, { repo: 'nope' })).rejects.toThrow('Repository not found on GitHub: nope');
    w.take();
    expect((await same({ repo: 'nope' }, () => source.repo('nope'))).found).toBeNull();

    // Tracked ones, owned or added by hand, by node id.
    await same({ repo: 'fresh' }, () => source.repoByNode({ nodeId: 'R_alice/fresh', path: 'alice/fresh' }));
    addManualRepo(db, 'bob/tool');
    addManualRepo(db, 'bob/gone');
    const tool = await same({ repo: 'bob/tool' }, () => source.repoByNode({ nodeId: 'R_bob/tool', path: 'bob/tool' }));
    expect(tool.read.ok && tool.read.record).toEqual(recordOf(db, 'bob/tool'));
    const gone = await same({ repo: 'bob/gone' }, () => source.repoByNode({ nodeId: 'R_bob/gone', path: 'bob/gone' }));
    expect(!gone.read.ok && reasonOf(gone.read.access)).toBe(db.get<{ r: string }>(`SELECT unavailable_reason AS r FROM repos WHERE name_with_owner = 'bob/gone'`)!.r);
    expect(gone.viewer).toEqual(ALICE);
  });

  it("a short name GitHub doesn't know: found null with the viewer (the sync then fails, after the claim)", async () => {
    const gql = fakeGraphQL();
    gql.state.owned.push(repoNode('alice/app'));
    const w = wire(gql);
    // As github.com answers: the viewer, a null repository, and a NOT_FOUND error for it.
    w.hooks.intercept = (op) =>
      op === 'ViewerRepo'
        ? { body: { data: { viewer: { ...gql.state.viewer, repository: null }, rateLimit: RATE }, errors: [{ type: 'NOT_FOUND', path: ['viewer', 'repository'], message: "Could not resolve to a Repository with the name 'alice/nope'." }] } }
        : null;
    await expect(syncOn(openDb(':memory:'), w, { repo: 'nope' })).rejects.toThrow('Repository not found on GitHub: nope');
    const sync = w.take();
    const source = sourceOn(w);
    expect(await source.repo('nope')).toEqual({ viewer: ALICE, found: null });
    expect(asked(w.take())).toEqual(asked(sync));
  });

  it("the viewer: the sync manager's request", async () => {
    const w = wire(fakeGraphQL());
    await new SyncManager({ db: openDb(':memory:'), schedule: false, tokens: testTokens('t'), log: () => {}, fetchImpl: w.fetchImpl }).ensureViewer();
    const manager = w.take();
    expect(await sourceOn(w).viewer()).toEqual({ ...ALICE, emails: [] });
    expect(asked(w.take())).toEqual(asked(manager));
  });

  it('an account that changes while the owned list is read: refused after the same requests', async () => {
    const gql = fakeGraphQL();
    gql.state.pageSize = 1;
    gql.state.owned.push(repoNode('alice/app'), repoNode('alice/lib'));
    const w = wire(gql);
    const mallory = { id: 'U_mallory', login: 'mallory', name: null, avatarUrl: null };
    w.hooks.intercept = (op, { variables }) => {
      gql.state.viewer = op === 'ViewerRepos' && variables.after ? mallory : ALICE;
      return null;
    };
    // The owned list fails as a whole, before the sync claims anything (the GitHub-only sync claimed after each page,
    // and refused the second page's account as a mismatch).
    const db = openDb(':memory:');
    await expect(syncOn(db, w)).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('(@alice, then @mallory)') });
    expect(getSource(db, GITHUB_SOURCE_ID)!.viewer).toBeNull();
    const sync = w.take();
    await expect(sourceOn(w).ownedRepos()).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('(@alice, then @mallory)') });
    expect(asked(w.take())).toEqual(asked(sync));
  });
});

// ---------------------------------------------------------------------------
// Rounds and rechecks: every REPO_DETAIL / RecheckItems request of a sync, replayed through the source.
// ---------------------------------------------------------------------------

const SECTIONS = ['commits', 'prs', 'issues', 'openPrs', 'openIssues', 'releases', 'stars'] as const;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The RoundRequest a REPO_DETAIL request stands for: its switched-on sections, at their cursors. */
function roundOf(v: Record<string, any>): RoundRequest {
  const req: Record<string, unknown> = {};
  for (const s of SECTIONS) if (v[`with${cap(s)}`]) req[s] = { after: v[`${s}After`] ?? null, ...(s === 'commits' ? { since: v.since } : {}) };
  return req as RoundRequest;
}

/** A REPO_DETAIL request's variables that GitHub reads: those of switched-off sections go with their fields (@include). */
function read(v: Record<string, any>) {
  const out = { ...v };
  for (const s of SECTIONS) if (!v[`with${cap(s)}`]) delete out[`${s}After`];
  if (!v.withCommits) delete out.since;
  return out;
}

/** What the GitHub-only sync read from a REPO_DETAIL answer, section by section, with the mappers it used. */
function pagesOf(req: RoundRequest, r: NonNullable<RepoDetailData['repository']>): RoundResult {
  const pageOf = <N, T>(c: Connection<N>, map: (n: N) => T): Page<T> => ({ items: c.nodes.map(map), hasMore: c.pageInfo.hasNextPage, endCursor: c.pageInfo.endCursor });
  const out: RoundResult = {};
  if (req.commits) out.commits = pageOf(r.defaultBranchRef!.target!.history!, (n) => mapCommit(n, r.nameWithOwner));
  if (req.prs) out.prs = pageOf(r.pullRequests!, mapPullRequest);
  if (req.issues) out.issues = pageOf(r.issues!, mapIssue);
  if (req.openPrs) out.openPrs = pageOf(r.openPrs!, mapPullRequest);
  if (req.openIssues) out.openIssues = pageOf(r.openIssues!, mapIssue);
  if (req.releases) {
    const c = r.releases!;
    // Drafts map to nothing, but the last node's age is what stops the sync's paging.
    out.releases = { items: c.nodes.flatMap((n) => mapRelease(n) ?? []), hasMore: c.pageInfo.hasNextPage, endCursor: c.pageInfo.endCursor, oldestCreatedAt: c.nodes.at(-1)?.createdAt ?? null };
  }
  if (req.stars) {
    const c = r.stargazers!;
    out.stars = { items: c.edges.map(mapStar), hasMore: c.pageInfo.hasNextPage, endCursor: c.pageInfo.endCursor, totalCount: c.totalCount };
  }
  return out;
}

/**
 * Replays the REPO_DETAIL requests `sync` made through `source.round()`, on the fake as it is: each is one request of
 * the same document with the same variables (those GitHub reads), and hands over what the sync read from the answer.
 */
async function replayRounds(db: Db, w: Wire, sync: Sent[]): Promise<number> {
  const source = sourceOn(w);
  const rounds = sync.filter((s) => s.op === 'RepoDetail');
  for (const [i, s] of rounds.entries()) {
    const req = roundOf(s.variables!);
    const res = await source.round(recordOf(db, `${s.variables!.owner}/${s.variables!.name}`), req);
    const [mine, ...more] = w.take();
    expect(more, `round ${i}`).toEqual([]);
    expect([mine!.op, mine!.query], `round ${i}`).toEqual(['RepoDetail', s.query]);
    expect(read(mine!.variables!), `round ${i}`).toEqual(read(s.variables!));
    // Switched-off sections go without cursors.
    for (const sec of SECTIONS) if (!req[sec]) expect(mine!.variables![`${sec}After`], `round ${i} ${sec}`).toBeNull();
    expect(res, `round ${i}`).toEqual(pagesOf(req, s.answer.data.repository));
  }
  expect(source.requests).toBe(rounds.length);
  return rounds.length;
}

describe('GitHubSyncSource rounds and rechecks', () => {
  it("a first, an incremental and a full sync: each REPO_DETAIL request, as one round()", async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    gql.state.pageSize = 2;
    const app = 'alice/app';
    const open = { state: 'OPEN' as const, mergedAt: null, closedAt: null, mergedBy: null };
    const probe = () => ({
      openPrs: { totalCount: gql.state.prs[app]!.filter((p) => p.state === 'OPEN').length },
      openIssues: { totalCount: gql.state.issues[app]!.filter((i) => i.state === 'OPEN').length },
      latestPr: { nodes: [{ updatedAt: gql.state.prs[app]![0]!.updatedAt }] },
      latestIssue: { nodes: [{ updatedAt: gql.state.issues[app]![0]!.updatedAt }] },
      latestReleases: { nodes: gql.state.releases[app]!.slice(0, 3).map((r) => ({ tagName: r.tagName, isDraft: r.isDraft })) },
      latestStar: { edges: [{ starredAt: gql.state.stars[app]![0]!.starredAt }] },
      stargazerCount: gql.state.stars[app]!.length,
      pushedAt: gql.state.commits[app]![0]!.committedDate,
    });
    gql.state.prs[app] = [
      { ...prNode(app, 5, 'Open', at(26)), ...open }, prNode(app, 4, 'Four', at(25)),
      { ...prNode(app, 3, 'Closed', at(24)), state: 'CLOSED', mergedAt: null, mergedBy: null }, prNode(app, 2, 'Two', at(23)), prNode(app, 1, 'One', at(22)),
    ];
    gql.state.issues[app] = [issueNode(app, 8, 'Open', at(26)), issueNode(app, 7, 'Done', at(25), { state: 'CLOSED', closedAt: at(25) }), issueNode(app, 6, 'Old', at(24), { state: 'CLOSED', closedAt: at(24) })];
    gql.state.commits[app] = ['e', 'd', 'c', 'b', 'a'].map((c, i) => commitNode(app, c, at(26 - i), c === 'b' ? 2 : null));
    gql.state.releases[app] = [releaseNode(app, 'v3', at(26), { isDraft: true }), releaseNode(app, 'v2', at(24)), releaseNode(app, 'v1', at(20))];
    gql.state.stars[app] = [starEdge('dave', at(25)), starEdge('carol', at(20)), starEdge('erin', at(10))];
    gql.state.owned.push(repoNode(app, probe()));
    const db = openDb(':memory:');
    const w = wire(gql);

    // First sync: every section from the start, in rounds of two items; sections end in different rounds.
    expect(await syncOn(db, w)).toMatchObject({ errors: [] });
    expect(await replayRounds(db, w, w.take())).toBe(3);

    // Incremental: a new PR, commit, release and star, and an unstar (the stars pass restarts as a full one).
    gql.state.prs[app]!.unshift({ ...prNode(app, 9, 'New', at(27)), ...open });
    gql.state.commits[app]!.unshift(commitNode(app, 'f', at(27)));
    gql.state.releases[app]!.unshift(releaseNode(app, 'v4', at(27)));
    gql.state.stars[app] = [starEdge('zed', at(27)), ...gql.state.stars[app]!.filter((s) => s.node.login !== 'erin')];
    gql.state.owned[0] = repoNode(app, probe());
    expect(await syncOn(db, w, {}, NOW + HOUR)).toMatchObject({ errors: [], newItems: 4 });
    const incremental = w.take();
    expect(incremental.filter((s) => s.op === 'RepoDetail').map((s) => [s.variables!.withStars, s.variables!.starsAfter])).toEqual([[true, null], [true, null], [true, '2']]);
    expect(await replayRounds(db, w, incremental)).toBe(3);

    // Full: open items listed from the start too.
    expect(await syncOn(db, w, { full: true }, NOW + 2 * HOUR)).toMatchObject({ errors: [] });
    const full = w.take();
    expect(full.find((s) => s.op === 'RepoDetail')!.variables).toMatchObject({ withOpenPrs: true, withOpenIssues: true });
    expect(await replayRounds(db, w, full)).toBe(3);
  });

  it('stored-open items GitHub no longer lists: each RecheckItems request, as recheck(), with the same verdicts', async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    const app = 'alice/app';
    const open = { state: 'OPEN' as const, mergedAt: null, closedAt: null, mergedBy: null };
    // 60 open PRs and 53 open issues, most recently updated first: two rechecks, each with PRs and issues.
    const minutesBefore = (i: number) => isoSec(Date.parse(at(26)) - i * 60_000);
    gql.state.prs[app] = Array.from({ length: 60 }, (_, i) => ({ ...prNode(app, 60 - i, `PR ${60 - i}`, minutesBefore(i)), ...open }));
    gql.state.issues[app] = Array.from({ length: 53 }, (_, i) => issueNode(app, 113 - i, `Issue ${113 - i}`, minutesBefore(i)));
    const node = repoNode(app, {
      openPrs: { totalCount: 60 }, openIssues: { totalCount: 53 }, latestPr: { nodes: [{ updatedAt: at(26) }] }, latestIssue: { nodes: [{ updatedAt: at(26) }] },
      stargazerCount: 0,
    });
    gql.state.owned.push(node, repoNode('alice/lib'));
    const db = openDb(':memory:');
    const w = wire(gql);
    expect(await syncOn(db, w)).toMatchObject({ errors: [] });
    w.take();

    // Closed without an update GitHub's order shows; PR 7 moved to alice/lib; issue 62 deleted.
    for (const p of gql.state.prs[app]!) Object.assign(p, { state: 'CLOSED', closedAt: p.updatedAt });
    const [moved] = gql.state.prs[app]!.splice(gql.state.prs[app]!.findIndex((p) => p.number === 7), 1);
    gql.state.prs['alice/lib'] = [moved!];
    gql.state.moved[`${app}#7`] = 'alice/lib';
    gql.state.issues[app] = gql.state.issues[app]!.filter((i) => i.number !== 62).map((i) => ({ ...i, state: 'CLOSED' as const, closedAt: i.updatedAt }));
    gql.state.owned[0] = { ...node, openPrs: { totalCount: 0 }, openIssues: { totalCount: 0 } };
    expect(await syncOn(db, w, {}, NOW + HOUR)).toMatchObject({ errors: [] });
    const sync = w.take().filter((s) => s.op === 'RecheckItems');
    expect(sync.map((s) => [s.query!.match(/\bpr\d+: /g)!.length, s.query!.match(/\bissue\d+: /g)!.length])).toEqual([[50, 50], [10, 3]]);

    const numbers = (kind: 'pr' | 'issue') => sync.flatMap((s) => [...s.query!.matchAll(new RegExp(`\\b${kind}(\\d+): `, 'g'))].map((m) => Number(m[1])));
    const source = sourceOn(w);
    const res = await source.recheck(recordOf(db, app), numbers('pr'), numbers('issue'));
    const mine = w.take();
    expect(mine.map((s) => [s.op, s.query, s.variables])).toEqual(sync.map((s) => [s.op, s.query, s.variables]));
    expect([res.prs.size, res.issues.size]).toEqual([60, 53]);
    // null where the sync deleted it, the record it stored otherwise.
    const stored = (table: string, n: number) => db.get<{ state: string }>(`SELECT state FROM ${table} WHERE number = ?`, [n])?.state ?? null;
    for (const [n, pr] of res.prs) expect(pr?.state ?? null, `PR ${n}`).toBe(stored('pull_requests', n));
    for (const [n, issue] of res.issues) expect(issue?.state ?? null, `issue ${n}`).toBe(stored('issues', n));
    expect([res.prs.get(7), res.issues.get(62)]).toEqual([null, null]);
    expect(await source.recheck(recordOf(db, app), [], [])).toEqual({ prs: new Map(), issues: new Map() });
    expect(w.take()).toEqual([]);
  });

  it('a repository lost mid-sync: the error the sync reports, with access saying why', async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    gql.state.owned.push(repoNode('alice/app'));
    gql.state.others.push(repoNode('bob/tool'));
    gql.state.prs['bob/tool'] = [prNode('bob/tool', 1, 'One')];
    const db = openDb(':memory:');
    addManualRepo(db, 'bob/tool');
    const w = wire(gql);
    const record = recordOf(db, 'bob/tool');
    const lose = (error: object) =>
      (w.hooks.intercept = (op) => (op === 'RepoDetail' || op === 'RecheckItems' ? { body: { data: { repository: null, rateLimit: RATE }, errors: [error] } } : null));
    const source = sourceOn(w);

    // Gone: the sync marks it unavailable, in the words of access.
    const gone = { type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'bob/tool'." };
    const unavailable = "GitHub doesn't show bob/tool to this token: it doesn't exist, or the token can't read it. Check the spelling, or ask for access.";
    lose(gone);
    expect((await syncOn(db, w, { repo: 'bob/tool' })).errors).toEqual([`bob/tool: unavailable: ${unavailable}`]);
    const err = await source.round(record, { prs: { after: null } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'not-found', message: gone.message });
    expect(reasonOf(accessLost(err)!)).toBe(unavailable);

    // SAML on the repository while rechecking: lost too (the GitHub-only sync's lostAccess read the same errors the same way).
    lose({ type: 'FORBIDDEN', path: ['repository'], message: 'Resource protected by organization SAML enforcement.' });
    const saml = await source.recheck(record, [1], []).catch((e: unknown) => e);
    expect(accessLost(saml)).toMatchObject({ problem: 'sso', message: 'bob requires SAML single sign-on.' });

    // A section it may not read: an ordinary error of that repo.
    db.run('UPDATE repos SET unavailable_at = NULL, unavailable_reason = NULL');
    const section = { type: 'FORBIDDEN', path: ['repository', 'pullRequests'], message: 'Resource not accessible by personal access token' };
    w.hooks.intercept = (op) => (op === 'RepoDetail' ? { body: { data: null, errors: [section] } } : null);
    expect((await syncOn(db, w, { repo: 'bob/tool' })).errors).toEqual([`bob/tool: ${section.message}`]);
    const denied = await source.round(record, { prs: { after: null } }).catch((e: unknown) => e);
    expect(denied).toMatchObject({ kind: 'forbidden', message: section.message, access: { problem: 'permission' } });
    expect(accessLost(denied)).toBeNull();

    // No repository and no error: the same message as before, and nothing lost.
    w.hooks.intercept = (op) => (op === 'RepoDetail' ? { body: { data: { repository: null, rateLimit: RATE } } } : null);
    expect((await syncOn(db, w, { repo: 'bob/tool' })).errors).toEqual(['bob/tool: repository not found']);
    const none = await source.round(record, { prs: { after: null } }).catch((e: unknown) => e);
    expect(none).toMatchObject({ kind: 'not-found', message: 'repository not found', access: null });
  });

  // The GitHub-only sync started an open-items pass in the round that finished the dated one (when the stored open
  // count isn't the probe's, or there is no probe), then read that section from the same answer: GitHub left it out,
  // as it wasn't asked for, and the round failed with a TypeError. Lenient fakes answered it anyway (this file's by
  // default, sync.test.ts's always). The neutral sync reads only the sections a round asked for: the open pass goes
  // into the next round.
  it('an open pass started mid-round waits for the next round (GitHub sends only the sections asked for)', async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    gql.state.owned.push(repoNode('alice/app', { openPrs: { totalCount: 1 } }));
    const w = wire(gql);
    const res = await syncOn(openDb(':memory:'), w);
    expect(res.errors).toEqual([]);
    const rounds = w.sent.filter((s) => s.op === 'RepoDetail').map((s) => SECTIONS.filter((sec) => s.variables![`with${cap(sec)}`]));
    expect(rounds).toEqual([['commits', 'prs', 'issues', 'releases', 'stars'], ['openPrs']]);
  });
});

describe('GitHubSyncSource and the Add dialog', () => {
  it("candidates and lookups: the tracking API's requests and answers", async () => {
    const gql = fakeGraphQL();
    gql.state.strict = true;
    gql.state.owned.push(repoNode('alice/app', { id: 'R_app' }));
    gql.state.others.push(repoNode('bob/tool', { description: 'A tool', stargazerCount: 120, openPrs: { totalCount: 3 }, openIssues: { totalCount: 51 } }), repoNode('carol/lib'));
    gql.state.suggested = ['carol/lib', 'bob/tool'];
    const rest = (key: string, over: object = {}) => ({
      node_id: `R_${key}`, name: key.split('/')[1], full_name: key, owner: { login: key.split('/')[0] }, description: null, visibility: 'public',
      private: false, archived: false, fork: false, stargazers_count: 5, pushed_at: '2026-09-20T00:00:00Z', ...over,
    });
    const w = wire(gql, {
      '/user/repos': page([rest('bob/tool'), rest('acme/infra', { visibility: undefined, private: true })], '/user/repos?page=2'),
      '/user/repos?page=2': page([rest('dlvhdr/gh-dash', { description: 'Dash' })], null),
    });
    const db = openDb(':memory:');
    const tracking = new Tracking({ db, tokens: supplyOf(() => 'ghp_classic'), sync: { startOrQueue: async () => 'queued' }, tz: 'UTC', fetchImpl: w.fetchImpl, sleep: async () => {}, now: () => NOW });
    const source = sourceOn(w, 'classic');

    const listed = await tracking.candidates();
    const byTracking = w.take();
    const c = await source.candidates();
    expect(asked(w.take())).toEqual(asked(byTracking));
    expect(count(byTracking)).toEqual({ '/user/repos?affiliation=collaborator%2Corganization_member&sort=pushed&per_page=100': 1, '/user/repos?page=2': 1, RepoSuggestions: 1 });
    const asCandidate = ({ nodeId: _, nameWithOwner, ...r }: (typeof c.items)[number]) => ({ key: nameWithOwner, ...r, tracked: null });
    expect({ items: c.items.map(asCandidate), suggested: c.suggested.map(asCandidate), truncated: c.truncated }).toEqual({ ...listed, fetchedAt: undefined });
    expect(c.viewer).toEqual(ALICE);

    // The same lookup request, and the same answer (the preview is the record, probe, counts and requestsFor).
    const since = isoSec(NOW - DEFAULT_SETTINGS.backfillDays * DAY_MS);
    const preview = (r: Extract<LookupRecord, { ok: true }>) => ({
      key: r.record.nameWithOwner, owner: r.record.owner, name: r.record.name, description: r.record.description, visibility: r.record.visibility,
      isArchived: r.record.isArchived, isFork: r.record.isFork, stars: r.record.stars, pushedAt: r.record.pushedAt, tracked: null, url: r.record.url,
      openPrs: r.probe.openPrs, openIssues: r.probe.openIssues, owned: r.owned, hidden: null,
      backfill: { since, commits: r.counts.commits, prs: r.counts.prs, issues: r.counts.issues, releases: r.counts.releases, requests: source.requestsFor(r.counts) },
    });
    const cases: [string, () => void][] = [
      ['bob/tool', () => {}],
      ['alice/app', () => {}],
      ['bob/nope', () => {}],
      ['bob/tool', () => (gql.state.size.prs = null)],
      ['bob/tool', () => (gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' })],
      ['bob/tool', () => (gql.state.errors['bob/tool'] = { type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', field: 'openIssues' })],
    ];
    for (const [path, arrange] of cases) {
      arrange();
      const l = await tracking.lookup(path);
      const byTracking = w.take();
      const r = await source.lookup(path, since);
      expect(asked(w.take()), path).toEqual(asked(byTracking));
      expect(r.ok ? { ok: true, repo: preview(r) } : { ok: false, key: r.path, ...r.access }, path).toEqual(l);
      if (r.ok) expect([r.counts.openPrs, r.counts.openIssues], path).toEqual([r.probe.openPrs, r.probe.openIssues]);
    }
    expect(source.requestsFor({ commits: 240, prs: 60, issues: 12, releases: 4, openPrs: 3, openIssues: 51 })).toBe(6);
  });
});
