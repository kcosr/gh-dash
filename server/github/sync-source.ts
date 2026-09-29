// GitHub behind the provider-neutral SyncSource: the GraphQL requests the sync has always made (the owned list, repos
// added by hand, probes, one REPO_DETAIL per round, rechecks by number), and the Add dialog's candidates and lookup.
// Request shapes and counts are the sync's and the tracking API's own; sync-source.test.ts compares them request for
// request. The database is none of this file's business: it reads, the sync decides and writes.

import type { TokenKind } from '../../shared/api';
import type { RepoProbe, RepoRecord } from '../db/records';
import { chunked, pool } from '../lib/pool';
import { type AccessFailure, reasonOf } from '../provider/access';
import { isFatalSourceError } from '../provider/errors';
import type {
  BackfillCounts,
  LookupRecord,
  Page,
  ProbeResult,
  RateLimitInfo,
  RecheckResult,
  RefreshResult,
  RepoCandidateRecord,
  RepoCandidates,
  RepoRead,
  RoundRequest,
  RoundResult,
  SyncSource,
  TrackedRepo,
  ViewerAccount,
  ViewerInfo,
} from '../provider/types';
import { accessFailure, notFound } from './access';
import { type ClientOptions, GitHubClient, GitHubError } from './client';
import { mapCommit, mapIssue, mapProbe, mapPullRequest, mapRelease, mapRepo, mapStar, RECORD_FIELDS } from './map';
import {
  MANUAL_REPOS,
  recheckQuery,
  REPO_DETAIL,
  REPO_LOOKUP,
  REPO_NODE,
  REPO_PROBES,
  REPO_SUGGESTIONS,
  VIEWER,
  VIEWER_REPO,
  VIEWER_REPOS,
} from './queries';
import { GitHubRestClient } from './rest';
import type {
  Connection,
  GqlError,
  GqlIssue,
  GqlProbe,
  GqlPullRequest,
  GqlRepo,
  GqlRepoSummary,
  GqlViewer,
  ManualReposData,
  RecheckData,
  RepoDetailData,
  RepoLookupData,
  RepoNodeData,
  RepoProbesData,
  RepoSuggestionsData,
  ViewerData,
  ViewerRepoData,
  ViewerReposData,
} from './types';

/** Repos probed, or added by hand re-read, per request; up to this many requests at a time. */
const NODE_CHUNK = 25;
const NODE_REQUESTS = 4;
/** Most PRs and most issues re-read by number per request. */
const RECHECK_CHUNK = 50;
/** Page sizes of REPO_DETAIL's sections that take one (open items: 50, releases: 20 and stars: 100 are in the query). */
const COMMITS_FIRST = 100;
const PRS_FIRST = 50;
const ISSUES_FIRST = 50;
/** At most this many of the token's repositories are offered (10 REST pages). */
const MAX_CANDIDATES = 1000;

/** A first sync pages commits by 100 and PRs / issues by 50, all in the same rounds; open items take their own. */
export function backfillRequests(commits: number, prs: number, issues: number, openPrs: number, openIssues: number): number {
  return Math.max(1, Math.ceil(commits / 100), Math.ceil(prs / 50), Math.ceil(issues / 50)) + Math.ceil(openPrs / 50) + Math.ceil(openIssues / 50);
}

export interface GitHubSyncSourceOptions extends ClientOptions {
  /**
   * The kind of `token` (server/token.ts `tokenKind`): what the access messages suggest when a repository can't be
   * read. null gives the hints for any token.
   */
  tokenKind?: TokenKind | null;
}

/**
 * Syncs from github.com over GraphQL; only the Add dialog's list of candidates is REST. One round is one REPO_DETAIL
 * request whatever sections it asks for.
 */
export class GitHubSyncSource implements SyncSource {
  readonly kind = 'github';
  /** RepoProbe.latestStarredAt is the newest star (stargazers order by STARRED_AT). */
  readonly probesStars = true;
  /** Commits come with the PR that brought them (associatedPullRequests). */
  readonly linksCommits = true;
  /** Every sync request goes through it: its counters are the run's. */
  private readonly client: GitHubClient;
  private readonly rest: GitHubRestClient;
  private readonly tokenKind: TokenKind | null;

  constructor(opts: GitHubSyncSourceOptions) {
    const { tokenKind = null, ...client } = opts;
    this.client = new GitHubClient(client);
    // REST keeps its own defaults (fewer attempts, short waits): only the Add dialog uses it, and a person is waiting.
    this.rest = new GitHubRestClient({ token: opts.token, ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }), ...(opts.sleep && { sleep: opts.sleep }) });
    this.tokenKind = tokenKind;
  }

  get rateLimit(): RateLimitInfo | null {
    const rl = this.client.rateLimit;
    return rl ? { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt } : null;
  }

  get requests(): number {
    return this.client.requests + this.rest.requests;
  }

  get points(): number {
    return this.client.pointsUsed;
  }

  /**
   * The same request as the sync manager's viewer check (VIEWER), without emails: GitHub commits carry their author's
   * account, so "me" goes by login (and the configured myEmails), and the account's email may need a user scope that
   * gh's tokens don't have.
   */
  async viewer(): Promise<ViewerAccount> {
    const { viewer } = await this.client.query<ViewerData>(VIEWER);
    return { ...viewerInfo(viewer), emails: [] };
  }

  /** VIEWER_REPOS, page by page. Every page carries the viewer: one that isn't the first page's fails as 'auth'. */
  async ownedRepos(): Promise<{ viewer: ViewerInfo; repos: RepoRecord[] }> {
    const repos: RepoRecord[] = [];
    let viewer: ViewerInfo | null = null;
    let after: string | null = null;
    do {
      const data: ViewerReposData = await this.client.query<ViewerReposData>(VIEWER_REPOS, { after });
      if (viewer && data.viewer.id !== viewer.id) {
        throw new GitHubError('auth', `The GitHub token changed accounts while its repositories were listed (@${viewer.login}, then @${data.viewer.login})`);
      }
      // The last page's: a rename between pages keeps the id.
      viewer = viewerInfo(data.viewer);
      const conn = data.viewer.repositories;
      repos.push(...conn.nodes.map(mapRepo));
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
    return { viewer: viewer!, repos };
  }

  /**
   * MANUAL_REPOS for 25 repos a request, 4 requests at a time. A request that fails for a reason that isn't fatal
   * leaves its repos out and adds its message to `errors`; a fatal one (token, rate limit) starts no more requests and
   * is rethrown once the ones in flight have settled.
   */
  async refresh(repos: TrackedRepo[]): Promise<RefreshResult> {
    const out: RefreshResult = { reads: new Map(), errors: [] };
    await pool(chunked(repos, NODE_CHUNK), NODE_REQUESTS, async (chunk) => {
      let res: { data: ManualReposData; errors: GqlError[] };
      try {
        res = await this.client.queryPartial<ManualReposData>(MANUAL_REPOS, { ids: chunk.map((t) => t.nodeId) });
      } catch (err) {
        if (isFatalSourceError(err)) throw err;
        out.errors.push(message(err));
        return;
      }
      chunk.forEach((t, i) => out.reads.set(t.nodeId, this.read(res.data.nodes[i] ?? null, res.errors, ['nodes', i], t.path)));
    });
    return out;
  }

  /** REPO_NODE: the repo by node id, and the viewer. */
  async repoByNode(repo: TrackedRepo): Promise<{ viewer: ViewerInfo; read: RepoRead }> {
    const { data, errors } = await this.client.queryPartial<RepoNodeData>(REPO_NODE, { id: repo.nodeId });
    return { viewer: viewerInfo(data.viewer), read: this.read(data.node, errors, ['node'], repo.path) };
  }

  /**
   * VIEWER_REPO: one of the viewer's own repositories by its short name. GitHub answers a name it doesn't know with a
   * NOT_FOUND error beside the viewer: that is `found: null`, not a failure.
   */
  async repo(name: string): Promise<{ viewer: ViewerInfo; found: { record: RepoRecord; probe: RepoProbe } | null }> {
    const data = await this.client.query<ViewerRepoData>(VIEWER_REPO, { name }, { allowNotFound: true });
    const node = data.viewer.repository;
    return { viewer: viewerInfo(data.viewer), found: node ? { record: mapRepo(node), probe: mapProbe(node) } : null };
  }

  /**
   * REPO_PROBES for 25 repos a request, 4 requests at a time. A node the token can't read loses only its own probe; a
   * request that fails loses its repos' (the message goes to `errors`); a fatal failure is rethrown as in refresh().
   */
  async probes(repos: RepoRecord[]): Promise<ProbeResult> {
    const out: ProbeResult = { probes: new Map(), errors: [] };
    await pool(chunked(repos.map((r) => r.nodeId), NODE_CHUNK), NODE_REQUESTS, async (ids) => {
      try {
        const { data, errors } = await this.client.queryPartial<RepoProbesData>(REPO_PROBES, { ids });
        data.nodes.forEach((n, i) => {
          if (n && !errors.some((e) => e.path?.[0] === 'nodes' && e.path[1] === i)) out.probes.set(n.id, mapProbe(n));
        });
      } catch (err) {
        if (isFatalSourceError(err)) throw err;
        out.errors.push(message(err));
      }
    });
    return out;
  }

  /**
   * One REPO_DETAIL request with each requested section switched on (@include) at its cursor. Sections that weren't
   * asked for are sent switched off, with null cursors.
   */
  async round(repo: RepoRecord, req: RoundRequest): Promise<RoundResult> {
    if (!Object.values(req).some(Boolean)) return {};
    const data = await this.client
      .query<RepoDetailData>(REPO_DETAIL, {
        owner: repo.owner,
        name: repo.name,
        withCommits: !!req.commits,
        commitsAfter: req.commits?.after ?? null,
        since: req.commits?.since ?? null,
        commitsFirst: COMMITS_FIRST,
        withPrs: !!req.prs,
        prsAfter: req.prs?.after ?? null,
        prsFirst: PRS_FIRST,
        withIssues: !!req.issues,
        issuesAfter: req.issues?.after ?? null,
        issuesFirst: ISSUES_FIRST,
        withOpenPrs: !!req.openPrs,
        openPrsAfter: req.openPrs?.after ?? null,
        withOpenIssues: !!req.openIssues,
        openIssuesAfter: req.openIssues?.after ?? null,
        withReleases: !!req.releases,
        releasesAfter: req.releases?.after ?? null,
        withStars: !!req.stars,
        starsAfter: req.stars?.after ?? null,
      })
      .catch((err: unknown) => this.lost(err, repo));
    const r = data.repository;
    if (!r) throw new GitHubError('not-found', 'repository not found');

    const out: RoundResult = {};
    if (req.commits) {
      // An empty repository (no default branch) has no history: an empty last page.
      const hist = r.defaultBranchRef?.target?.history;
      out.commits = hist ? page(hist, (n) => mapCommit(n, r.nameWithOwner)) : { items: [], hasMore: false, endCursor: null };
    }
    if (req.prs) out.prs = page(r.pullRequests!, mapPullRequest);
    if (req.issues) out.issues = page(r.issues!, mapIssue);
    if (req.openPrs) out.openPrs = page(r.openPrs!, mapPullRequest);
    if (req.openIssues) out.openIssues = page(r.openIssues!, mapIssue);
    if (req.releases) {
      const conn = r.releases!;
      // Drafts are left out of the items but not of oldestCreatedAt: the sync's backfill window stops on them too.
      const all = page(conn, mapRelease);
      out.releases = { ...all, items: all.items.flatMap((rel) => rel ?? []), oldestCreatedAt: conn.nodes.at(-1)?.createdAt ?? null };
    }
    if (req.stars) {
      const conn = r.stargazers!;
      out.stars = { ...page({ pageInfo: conn.pageInfo, nodes: conn.edges }, mapStar), totalCount: conn.totalCount };
    }
    return out;
  }

  /**
   * recheckQuery by 50 PRs and 50 issues a request (both in the same request). A PR or issue GitHub answers from
   * another repository was transferred there: null here, like one that no longer exists.
   */
  async recheck(repo: RepoRecord, prs: number[], issues: number[]): Promise<RecheckResult> {
    const out: RecheckResult = { prs: new Map(), issues: new Map() };
    for (let i = 0; i < prs.length || i < issues.length; i += RECHECK_CHUNK) {
      const prChunk = prs.slice(i, i + RECHECK_CHUNK);
      const issueChunk = issues.slice(i, i + RECHECK_CHUNK);
      const data = await this.client
        .query<RecheckData>(recheckQuery(prChunk, issueChunk), { owner: repo.owner, name: repo.name }, { allowNotFound: true })
        .catch((err: unknown) => this.lost(err, repo));
      const found = data.repository;
      if (!found) throw new GitHubError('not-found', 'repository not found');
      const here = (alias: string) => {
        const node = found[alias];
        return node && node.repository.nameWithOwner === repo.nameWithOwner ? node : null;
      };
      for (const n of prChunk) {
        const node = here(`pr${n}`);
        out.prs.set(n, node ? mapPullRequest(node as GqlPullRequest) : null);
      }
      for (const n of issueChunk) {
        const node = here(`issue${n}`);
        out.issues.set(n, node ? mapIssue(node as GqlIssue) : null);
      }
    }
    return out;
  }

  /**
   * The token's repositories of other owners (collaborator or organization member, most recently pushed first, up to
   * 1000: up to 10 REST requests) and the ones of others the viewer recently contributed to (1 GraphQL request).
   */
  async candidates(): Promise<RepoCandidates> {
    const [repos, suggestions] = await Promise.all([
      this.rest.paginate<RestRepo[], RestRepo>('/user/repos', (page) => page, MAX_CANDIDATES, {
        query: { affiliation: 'collaborator,organization_member', sort: 'pushed', per_page: 100 },
      }),
      this.client.query<RepoSuggestionsData>(REPO_SUGGESTIONS),
    ]);
    const items = repos.items.map(fromRest);
    return {
      viewer: viewerInfo(suggestions.viewer),
      items,
      suggested: suggestions.viewer.repositoriesContributedTo.nodes.flatMap((n) => (n ? [fromGql(n)] : [])),
      truncated: items.length >= MAX_CANDIDATES,
    };
  }

  /**
   * REPO_LOOKUP, one request: the repository with its probe, whether the token may read it, and the size of its first
   * sync. The PR and issue counts are searches, which may fail on their own (then null).
   */
  async lookup(path: string, since: string): Promise<LookupRecord> {
    const m = /^([^/]+)\/([^/]+)$/.exec(path);
    if (!m) throw new Error(`Not a GitHub repository path (owner/name): ${path}`);
    const [, owner, name] = m as unknown as [string, string, string];
    const day = since.slice(0, 10);
    const { data, errors } = await this.client.queryPartial<RepoLookupData>(
      REPO_LOOKUP,
      { owner, name, since, prQ: `repo:${path} is:pr updated:>=${day}`, issueQ: `repo:${path} is:issue updated:>=${day}` },
      { optional: ['prs', 'issues'] },
    );
    const viewer = viewerInfo(data.viewer);
    const r = data.repository;
    const failure = accessFailure(errors, ['repository'], path, this.tokenKind);
    if (failure || !r) return { ok: false, viewer, path: r?.nameWithOwner ?? path, access: failure ?? notFound(path, this.tokenKind) };
    const record = mapRepo(r);
    return {
      ok: true,
      viewer,
      record,
      probe: mapProbe(r),
      owned: record.owner.toLowerCase() === viewer.login.toLowerCase(),
      counts: {
        // No default branch: an empty repository, nothing to page.
        commits: r.defaultBranchRef ? (r.defaultBranchRef.target?.history?.totalCount ?? null) : 0,
        prs: data.prs?.issueCount ?? null,
        issues: data.issues?.issueCount ?? null,
        releases: r.releases.totalCount,
        openPrs: r.openPrs.totalCount,
        openIssues: r.openIssues.totalCount,
      },
    };
  }

  /** REPO_DETAIL rounds for the dated sections, plus the open ones' own; releases share the rounds. */
  requestsFor(c: BackfillCounts): number | null {
    if (c.commits === null || c.prs === null || c.issues === null) return null;
    return backfillRequests(c.commits, c.prs, c.issues, c.openPrs, c.openIssues);
  }

  /**
   * A repository read by node id, at `at` of a partial response (['nodes', i] or ['node']); `path` names it where
   * GitHub's answer can't. Fields the token may not read come back null with a FORBIDDEN error: their RepoRecord keys
   * are `denied` (their values here are placeholders), the probe is left out and `problem` says why, so the sync keeps
   * what it has for them and reports the repo as failed.
   */
  private read(node: (GqlRepo & GqlProbe) | null, errors: GqlError[], at: (string | number)[], path: string): RepoRead {
    const kind = this.tokenKind;
    if (!node) return { ok: false, access: accessFailure(errors, at, path, kind) ?? notFound(path, kind) };
    const inside = errors.filter((e) => !!e.path && e.path.length > at.length && at.every((x, i) => e.path![i] === x));
    const record = mapRepo(node);
    if (!inside.length) return { ok: true, record, probe: mapProbe(node), denied: [], problem: null };
    const failure = accessFailure(errors, at, path, kind);
    return {
      ok: true,
      record,
      probe: null,
      denied: [...new Set(inside.flatMap((e) => RECORD_FIELDS[String(e.path![at.length])] ?? []))],
      problem: failure ? reasonOf(failure) : inside.map((e) => e.message).join('; '),
    };
  }

  /**
   * A request about `repo` failed: when GitHub refused the repository (NOT_FOUND or FORBIDDEN), the same error with
   * `access` saying why (provider/access `accessLost` then tells a lost repository from a section it may not read).
   */
  private lost(err: unknown, repo: RepoRecord): never {
    if (!(err instanceof GitHubError) || (err.kind !== 'not-found' && err.kind !== 'forbidden')) throw err;
    const access: AccessFailure | null = accessFailure(err.errors, ['repository'], repo.nameWithOwner, this.tokenKind);
    throw new GitHubError(err.kind, err.message, { status: err.status, resetAt: err.resetAt, errors: err.errors, access });
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const viewerInfo = (v: GqlViewer): ViewerInfo => ({ id: v.id, login: v.login, name: v.name, avatarUrl: v.avatarUrl });

/** A GraphQL connection as a Page. GitHub gives an endCursor with every next page; without one there's nowhere to go. */
function page<N, T>(conn: Connection<N>, map: (node: N) => T): Page<T> {
  const { hasNextPage, endCursor } = conn.pageInfo;
  return { items: conn.nodes.map(map), hasMore: hasNextPage && !!endCursor, endCursor };
}

/** GET /user/repos, the fields used. */
interface RestRepo {
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  visibility?: 'public' | 'private' | 'internal';
  private: boolean;
  archived: boolean;
  fork: boolean;
  stargazers_count: number;
  pushed_at: string | null;
}

const fromRest = (r: RestRepo): RepoCandidateRecord => ({
  nodeId: r.node_id, name: r.name, nameWithOwner: r.full_name, owner: r.owner.login, description: r.description,
  visibility: r.visibility ?? (r.private ? 'private' : 'public'), isArchived: r.archived, isFork: r.fork, stars: r.stargazers_count, pushedAt: r.pushed_at,
});

const fromGql = (r: GqlRepoSummary): RepoCandidateRecord => ({
  nodeId: r.id, name: r.name, nameWithOwner: r.nameWithOwner, owner: r.owner.login, description: r.description || null,
  visibility: r.visibility === 'PUBLIC' ? 'public' : r.visibility === 'INTERNAL' ? 'internal' : 'private',
  isArchived: r.isArchived, isFork: r.isFork, stars: r.stargazerCount, pushedAt: r.pushedAt,
});
