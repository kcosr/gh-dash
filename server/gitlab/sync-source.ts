import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import { isFatalSourceError } from '../provider/errors';
import type {
  BackfillCounts,
  LookupRecord,
  Page,
  ProbeResult,
  RecheckResult,
  RefreshResult,
  RepoCandidates,
  RepoRead,
  RoundRequest,
  RoundResult,
  SyncSource,
  TrackedRepo,
  ViewerAccount,
  ViewerInfo,
} from '../provider/types';
import { notFound, unreadable } from './access';
import { GitLabClient } from './client';
import {
  mapCandidate,
  mapCommit,
  mapIssue,
  mapMergeRequest,
  mapProbe,
  mapProject,
  mapRelease,
  mapStar,
  mapViewer,
  mapViewerEmails,
  releaseCreatedAt,
} from './map';
import {
  MANUAL_PROJECTS,
  MERGE_REQUESTS,
  OWNED_PROJECTS,
  PROBES,
  PROJECT,
  PROJECT_BY_NODE,
  PROJECT_LOOKUP,
  RECHECK_MERGE_REQUESTS,
  RELEASES,
  VIEWER,
  VIEWER_ACCOUNT,
} from './queries';
import { encodeSegment, GitLabRestClient, type RestPage } from './rest';
import { GitLabError, GitLabTransport, type GitLabOptions } from './transport';
import type {
  Connection,
  GqlProbe,
  GqlProject,
  GqlViewer,
  ManualProjectsData,
  MergeRequestsData,
  OwnedProjectsData,
  ProbesData,
  ProjectByNodeData,
  ProjectData,
  ProjectLookupData,
  ReleasesData,
  RestCommit,
  RestIssue,
  RestProject,
  RestStarrer,
  ViewerAccountData,
  ViewerData,
} from './types';

// Page sizes. GitLab caps a page at 100 items, and its complexity limit (250) isn't what binds here (see queries.ts):
// the sizes keep each request well inside GitLab's 30 s GraphQL timeout.
/** Merge requests carry nested labels, commits and closing issues, and Gitaly calls for their head and diff stats. */
const MR_PAGE = 25;
const ISSUE_PAGE = 50;
const RELEASE_PAGE = 20;
/** Each project costs Gitaly calls for its default branch and head commit. */
const PROJECT_PAGE = 50;
/** Projects probed, or read by global id, per request. */
const ID_CHUNK = 25;
/** Most projects the Add dialog lists: 10 REST pages of 100. */
const MAX_CANDIDATES = 1000;
const CANDIDATE_PAGE = 100;
/** Candidates offered as suggestions: the most recently active (the caller drops the ones already tracked). */
const SUGGESTED = 8;
const COMMIT_PAGE = 100;
const STAR_PAGE = 100;
/** Most starrers listed in one round; beyond, they're paged newest first (the sync doesn't diff unstars past 3000). */
const MAX_STARS = 3000;
/** Listings of a project's starrers tried before giving up on one whose count keeps moving. */
const STAR_LISTINGS = 2;
/**
 * Most logins a stars cursor keeps for its boundary time (stars in the same millisecond). A page holds 100, and more
 * than a handful in one millisecond isn't something GitLab produces; past the cap, a repeated star can end the sync's
 * pass early (it catches up on the next sync).
 */
const MAX_MARKED = 100;
/** Pages read to find the last page of starrers when GitLab doesn't count them (over 10,000): a binary search's worth. */
const STAR_SEEK_PAGES = 30;

type Order = 'updated' | 'created';
type StarsPage = Page<StarRecord> & { totalCount: number };

/**
 * Syncs from a GitLab instance: GraphQL for projects, merge requests and releases; REST where GraphQL falls short
 * (commits with stats, issues with who closed them, starrers). A round's sections are fetched in parallel, one request
 * each (stars: one per 100 starrers).
 *
 * Every read that lists projects or looks one up carries the viewer (`currentUser`) in the same request, for the sync to
 * claim. A project the token can't see is simply absent from GitLab's answers, and reads as 'not-found' (GitLab doesn't
 * say why: doesn't exist, or the account isn't a member).
 */
export class GitLabSyncSource implements SyncSource {
  readonly kind = 'gitlab';
  readonly points = null;
  /** Starrers are REST-only and listed oldest first: the probe can't tell the newest star (latestStarredAt is null). */
  readonly probesStars = false;
  /** A commit doesn't say which MR brought it (prNumber is null). */
  readonly linksCommits = false;
  private readonly transport: GitLabTransport;
  private readonly graphql: GitLabClient;
  private readonly rest: GitLabRestClient;

  constructor(opts: GitLabOptions) {
    // The sync can wait out a throttle's Retry-After (GitLab's windows are a minute or so); a person isn't waiting.
    this.transport = new GitLabTransport(opts, { maxAttempts: 5, maxRetryWaitMs: 120_000 });
    this.graphql = new GitLabClient(this.transport);
    this.rest = new GitLabRestClient(this.transport);
  }

  get rateLimit() {
    return this.transport.rateLimit;
  }

  get requests(): number {
    return this.transport.requests;
  }

  private get base(): string {
    return this.transport.base;
  }

  /**
   * The token's account with its addresses. The addresses are best effort: if GitLab refuses the query that reads them
   * (a field the token's scope can't see), the account is read without them, and "me" on commits falls back to the
   * configured addresses.
   */
  async viewer(): Promise<ViewerAccount> {
    let data: ViewerAccountData;
    try {
      data = await this.graphql.query<ViewerAccountData>(VIEWER_ACCOUNT);
    } catch (err) {
      if (!(err instanceof GitLabError) || err.kind !== 'graphql') throw err;
      return { ...(await this.currentUser()), emails: [] };
    }
    const user = this.account(data.currentUser);
    return { ...user, emails: mapViewerEmails(data.currentUser!) };
  }

  /**
   * Projects in the viewer's personal namespace; group projects are for explicit tracking, not "mine". The viewer comes
   * with every page; one that changes mid-list fails the list as 'auth'.
   */
  async ownedRepos(): Promise<{ viewer: ViewerInfo; repos: RepoRecord[] }> {
    const repos: RepoRecord[] = [];
    let viewer: ViewerInfo | null = null;
    let after: string | null = null;
    do {
      const data: OwnedProjectsData = await this.graphql.query<OwnedProjectsData>(OWNED_PROJECTS, { after, first: PROJECT_PAGE });
      const page = this.account(data.currentUser);
      if (viewer && viewer.id !== page.id) {
        throw new GitLabError('auth', `The GitLab token's account changed while listing projects (${viewer.login}, then ${page.login})`);
      }
      viewer = page;
      repos.push(...data.projects.nodes.map((p) => mapProject(p, this.base)));
      after = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
    } while (after);
    return { viewer: viewer!, repos };
  }

  /**
   * Projects added by hand, by global id (which follows renames and transfers), 25 to a request. One GitLab doesn't
   * list is 'not-found': deleted, or the token lost its membership (GitLab doesn't say which). A request that fails for
   * a reason other than the token or a rate limit leaves its projects out, and says why in `errors`.
   */
  async refresh(repos: TrackedRepo[]): Promise<RefreshResult> {
    const out: RefreshResult = { reads: new Map(), errors: [] };
    for (let i = 0; i < repos.length; i += ID_CHUNK) {
      const chunk = repos.slice(i, i + ID_CHUNK);
      try {
        const data = await this.graphql.query<ManualProjectsData>(MANUAL_PROJECTS, { ids: chunk.map((r) => r.nodeId), first: chunk.length });
        const listed = new Map(data.projects.nodes.map((p) => [p.id, p]));
        for (const t of chunk) out.reads.set(t.nodeId, this.read(listed.get(t.nodeId), t));
      } catch (err) {
        if (!(err instanceof GitLabError) || isFatalSourceError(err)) throw err;
        out.errors.push(`projects ${i + 1}-${i + chunk.length} of ${repos.length}: ${err.message}`);
      }
    }
    return out;
  }

  async repoByNode(repo: TrackedRepo): Promise<{ viewer: ViewerInfo; read: RepoRead }> {
    const data = await this.graphql.query<ProjectByNodeData>(PROJECT_BY_NODE, { ids: [repo.nodeId], first: 1 });
    const viewer = this.account(data.currentUser);
    return { viewer, read: this.read(data.projects.nodes.find((p) => p.id === repo.nodeId), repo) };
  }

  /** Any project by its full path, with the viewer. */
  async repo(path: string): Promise<{ viewer: ViewerInfo; found: { record: RepoRecord; probe: RepoProbe } | null }> {
    const { currentUser, project } = await this.graphql.query<ProjectData>(PROJECT, { path });
    const viewer = this.account(currentUser);
    return { viewer, found: project ? { record: mapProject(project, this.base), probe: mapProbe(project) } : null };
  }

  /**
   * A chunk that fails for a reason other than the token or a rate limit leaves its projects unprobed (absent), and
   * says why in `errors` ("projects 26-50 of 60: …").
   */
  async probes(repos: RepoRecord[]): Promise<ProbeResult> {
    const out: ProbeResult = { probes: new Map(), errors: [] };
    for (let i = 0; i < repos.length; i += ID_CHUNK) {
      const ids = repos.slice(i, i + ID_CHUNK).map((r) => r.nodeId);
      try {
        const data = await this.graphql.query<ProbesData>(PROBES, { ids, first: ids.length });
        for (const p of data.projects.nodes) out.probes.set(p.id, mapProbe(p));
      } catch (err) {
        if (!(err instanceof GitLabError) || isFatalSourceError(err)) throw err;
        out.errors.push(`projects ${i + 1}-${i + ids.length} of ${repos.length}: ${err.message}`);
      }
    }
    return out;
  }

  async round(repo: RepoRecord, req: RoundRequest): Promise<RoundResult> {
    const out: RoundResult = {};
    await Promise.all([
      req.commits && this.commits(repo, req.commits.after, req.commits.since).then((p) => (out.commits = p)),
      req.prs && this.mergeRequests(repo, req.prs.after, 'all', 'updated').then((p) => (out.prs = p)),
      req.openPrs && this.mergeRequests(repo, req.openPrs.after, 'opened', 'created').then((p) => (out.openPrs = p)),
      req.issues && this.issues(repo, req.issues.after, 'all', 'updated').then((p) => (out.issues = p)),
      req.openIssues && this.issues(repo, req.openIssues.after, 'opened', 'created').then((p) => (out.openIssues = p)),
      req.releases && this.releases(repo, req.releases.after).then((p) => (out.releases = p)),
      req.stars && this.stars(repo, req.stars.after).then((p) => (out.stars = p)),
    ]);
    return out;
  }

  async recheck(repo: RepoRecord, prs: number[], issues: number[]): Promise<RecheckResult> {
    const out: RecheckResult = { prs: new Map(), issues: new Map() };
    for (let i = 0; i < prs.length; i += MR_PAGE) {
      const chunk = prs.slice(i, i + MR_PAGE);
      const data = await this.graphql.query<MergeRequestsData>(RECHECK_MERGE_REQUESTS, {
        path: repo.nameWithOwner,
        iids: chunk.map(String),
        first: chunk.length,
      });
      const found = new Map(nodes(existing(data, repo).mergeRequests).map((m) => [Number(m.iid), m]));
      for (const n of chunk) {
        const m = found.get(n);
        out.prs.set(n, m ? mapMergeRequest(m, this.base) : null);
      }
    }
    for (let i = 0; i < issues.length; i += ISSUE_PAGE) {
      const chunk = issues.slice(i, i + ISSUE_PAGE);
      const query = { ...ISSUE_FILTER, state: 'all', 'iids[]': chunk, per_page: chunk.length };
      const listed = await this.rest.json<RestIssue[]>(`/projects/${projectId(repo)}/issues`, { query });
      const found = new Map(listed.map((issue) => [issue.iid, issue]));
      for (const n of chunk) {
        const issue = found.get(n);
        out.issues.set(n, issue ? mapIssue(issue, this.base) : null);
      }
    }
    return out;
  }

  /**
   * The projects the token's account is a member of that aren't in its personal namespace (those are tracked
   * automatically), most recently active first, up to 1000 (10 REST requests, and the viewer beside them). The full
   * project entity is listed rather than the simple one, which has no visibility. The most recently active few double as
   * suggestions; the caller drops the ones it tracks.
   */
  async candidates(): Promise<RepoCandidates> {
    const listing = this.rest.all<RestProject>('/projects', MAX_CANDIDATES, {
      query: { membership: true, archived: false, order_by: 'last_activity_at', sort: 'desc', per_page: CANDIDATE_PAGE },
    });
    const [viewer, { items: listed, total }] = await Promise.all([this.currentUser(), listing]);
    const mine = viewer.login.toLowerCase();
    const items = listed
      .filter((p) => !(p.namespace.kind === 'user' && p.namespace.full_path.toLowerCase() === mine))
      .map(mapCandidate);
    return { viewer, items, suggested: items.slice(0, SUGGESTED), truncated: listed.length >= MAX_CANDIDATES && (total === null || total > MAX_CANDIDATES) };
  }

  /**
   * Whether the token can read a project, in one request: its record and probe, the counts that size its first sync,
   * and what the token may read of it. Commits since `since` aren't counted (GitLab can't do that cheaply): null.
   * A project the token sees but whose code, merge requests or issues it can't read is 'permission'. `owned` is a
   * project in the viewer's personal namespace, which is what the sync tracks as theirs.
   */
  async lookup(path: string, since: string): Promise<LookupRecord> {
    const { currentUser, project } = await this.graphql.query<ProjectLookupData>(PROJECT_LOOKUP, { path, since });
    const viewer = this.account(currentUser);
    if (!project) return { ok: false, viewer, path, access: notFound(path) };
    const denied = unreadable(project.fullPath, project);
    if (denied) return { ok: false, viewer, path: project.fullPath, access: denied };
    const record = mapProject(project, this.base);
    const probe = mapProbe(project);
    const counts: BackfillCounts = {
      commits: null,
      prs: project.recentMergeRequests?.count ?? null,
      issues: project.recentIssues?.count ?? null,
      releases: project.releaseCount?.count ?? 0,
      openPrs: probe.openPrs,
      openIssues: probe.openIssues,
    };
    return { ok: true, viewer, record, probe, owned: record.owner.toLowerCase() === viewer.login.toLowerCase(), counts };
  }

  /**
   * Null: the size of a first sync depends on its commits, which GitLab can't count cheaply (lookup reports them as
   * unknown), and the Add dialog then shows "size unknown".
   */
  requestsFor(_counts: BackfillCounts): number | null {
    return null;
  }

  /** The project as read by node id, or why not. */
  private read(project: (GqlProject & GqlProbe) | undefined, tracked: TrackedRepo): RepoRead {
    if (!project) return { ok: false, access: notFound(tracked.path) };
    return { ok: true, record: mapProject(project, this.base), probe: mapProbe(project), denied: [], problem: null };
  }

  /** The account of a response that carried `currentUser`. GitLab answers a bad token with a 401, but never sync as nobody. */
  private account(user: GqlViewer | null): ViewerInfo {
    if (!user) throw new GitLabError('auth', 'GitLab did not recognise the token (no current user)');
    return mapViewer(user, this.base);
  }

  private async currentUser(): Promise<ViewerInfo> {
    return this.account((await this.graphql.query<ViewerData>(VIEWER)).currentUser);
  }

  /**
   * Default-branch commits since `since`, newest first, over REST (GraphQL's have no stats). Offset pages of a moving
   * branch would shift under a push, so later pages list from the head commit the first page saw: the cursor is
   * "<page>:<head sha>".
   */
  private async commits(repo: RepoRecord, after: string | null, since: string): Promise<Page<CommitRecord>> {
    const pinned = after ? commitCursor(after) : null;
    const ref = pinned?.head ?? repo.defaultBranch;
    if (!ref) return { items: [], hasMore: false, endCursor: null };
    const res = await this.rest.page<RestCommit[]>(`/projects/${projectId(repo)}/repository/commits`, {
      query: { ref_name: ref, since, with_stats: true, per_page: COMMIT_PAGE, page: pinned?.page ?? 1 },
    });
    const head = pinned?.head ?? res.body[0]?.id;
    // GitLab offers a next page whenever this one is full, so a next page can be empty: an empty page ends the walk.
    const next = res.body.length > 0 && head ? res.nextPage : null;
    return { items: res.body.map(mapCommit), hasMore: next !== null, endCursor: next === null ? null : `${next}:${head}` };
  }

  private async mergeRequests(repo: RepoRecord, after: string | null, state: 'all' | 'opened', order: Order): Promise<Page<PrRecord>> {
    const sort = order === 'updated' ? 'UPDATED_DESC' : 'CREATED_DESC';
    const data = await this.graphql.query<MergeRequestsData>(MERGE_REQUESTS, { path: repo.nameWithOwner, after, first: MR_PAGE, state, sort });
    return toPage(existing(data, repo).mergeRequests, (m) => mapMergeRequest(m, this.base));
  }

  /**
   * Over REST, which (unlike GraphQL) says who closed an issue; the cursor is the next page number. Offset pages have a
   * gap: an issue that leaves the list mid-walk (deleted, moved, retyped, or closed during the open pass) moves the rest
   * up one, and the issue after it is skipped this time (an update only moves issues to the front: seen twice, not
   * skipped). A skipped issue's open/closed state is caught on a later sync by the open-count check and recheck;
   * other edits wait for its next update or a full sync. Pages aren't overlapped to close the gap.
   */
  private async issues(repo: RepoRecord, after: string | null, state: 'all' | 'opened', order: Order): Promise<Page<IssueRecord>> {
    const res = await this.rest.page<RestIssue[]>(`/projects/${projectId(repo)}/issues`, {
      query: { ...ISSUE_FILTER, state, order_by: `${order}_at`, sort: 'desc', per_page: ISSUE_PAGE, page: after ? pageCursor(after) : 1 },
    });
    const next = res.body.length > 0 ? res.nextPage : null;
    return { items: res.body.map((i) => mapIssue(i, this.base)), hasMore: next !== null, endCursor: next === null ? null : String(next) };
  }

  /** Upcoming releases (release date ahead) are left out like drafts, but count for `oldestCreatedAt`. */
  private async releases(repo: RepoRecord, after: string | null): Promise<Page<ReleaseRecord> & { oldestCreatedAt: string | null }> {
    const data = await this.graphql.query<ReleasesData>(RELEASES, { path: repo.nameWithOwner, after, first: RELEASE_PAGE });
    const conn = existing(data, repo).releases;
    const all = nodes(conn);
    const last = all.at(-1);
    return {
      items: all.flatMap((r) => mapRelease(r, this.base) ?? []),
      hasMore: !!conn?.pageInfo.hasNextPage,
      endCursor: conn?.pageInfo.endCursor ?? null,
      oldestCreatedAt: last ? releaseCreatedAt(last) : null,
    };
  }

  /**
   * Starrers, most recent first. GitLab can't list them that way (it pages them oldest first, by id), so:
   * - up to MAX_STARS: every page in this round, sorted here, as one page the sync can diff for unstars. Offset pages
   *   shift when someone unstars mid-listing, skipping a starrer whose star the sync would then delete, so a listing
   *   whose X-Total moved is read again (once; then 'transient');
   * - beyond: one page a round from the last page backwards. New stars land after the pages still to read, but an
   *   unstar further back shifts starrers already handed out into the next page, where the sync would stop at them as
   *   known: the cursor ("<page>:<ms>:<login>,<login>…") keeps the next page to read, the time of the oldest star
   *   handed out and everyone handed out at that time, and later pages leave those and anything newer out.
   * `totalCount` is GitLab's count of that same list, which leaves out private profiles and blocked users, so it can
   * be below the project's star count; GitLab stops counting at 10,000, where the star count stands in.
   */
  private async stars(repo: RepoRecord, after: string | null): Promise<StarsPage> {
    const path = `/projects/${projectId(repo)}/starrers`;
    const read = (page: number) => this.rest.page<RestStarrer[]>(path, { query: { per_page: STAR_PAGE, page } });
    if (after) {
      const cursor = starCursor(after);
      return this.starPage(repo, cursor.page, await read(cursor.page), cursor.oldest);
    }
    for (let listing = 1; ; listing++) {
      const first = await read(1);
      const total = first.total;
      if (first.nextPage !== null && (total === null || total > MAX_STARS)) {
        const last = total === null ? await this.lastStarPage(repo, first, read) : { n: Math.ceil(total / STAR_PAGE), res: null };
        return this.starPage(repo, last.n, last.res ?? (await read(last.n)), null);
      }
      const items = [...first.body];
      let steady = true;
      for (let res = first, n = 1; res.nextPage !== null && res.nextPage > n && n < MAX_STARS / STAR_PAGE; ) {
        n = res.nextPage;
        res = await read(n);
        items.push(...res.body);
        steady &&= res.total === total;
      }
      if (steady) return { items: newestFirst(items).map((s) => mapStar(s, this.base)), hasMore: false, endCursor: null, totalCount: total ?? items.length };
      if (listing >= STAR_LISTINGS) throw new GitLabError('transient', `The starrers of ${repo.nameWithOwner} kept changing while being listed`);
    }
  }

  /**
   * Page `n` of the starrers, newest first, without the ones handed out already (`mark` and newer); the next round
   * reads page n - 1 with the mark moved to the oldest star of this page.
   */
  private starPage(repo: RepoRecord, n: number, res: RestPage<RestStarrer[]>, mark: StarMark | null): StarsPage {
    const fresh = newestFirst(res.body).filter((s) => !mark || olderThan(s, mark));
    const next = fresh.length ? markOf(fresh, mark) : mark;
    const endCursor = n > 1 ? `${n - 1}${next ? `:${next.at}:${next.logins.join(',')}` : ''}` : null;
    return { items: fresh.map((s) => mapStar(s, this.base)), hasMore: n > 1, endCursor, totalCount: res.total ?? repo.stars };
  }

  /**
   * The last page of starrers when GitLab doesn't count them (over 10,000). The project's star count gives a first
   * guess, but it also counts hidden profiles and can be pages too high (or lag behind), so the last page with
   * starrers is then found by binary search between one known to have starrers (page 1 to start with) and one known to
   * be empty, doubling while there is none.
   */
  private async lastStarPage(repo: RepoRecord, first: RestPage<RestStarrer[]>, read: (page: number) => Promise<RestPage<RestStarrer[]>>) {
    let full = { n: 1, res: first };
    let empty: number | null = null;
    let n = Math.max(2, Math.ceil(repo.stars / STAR_PAGE));
    for (let reads = 0; reads < STAR_SEEK_PAGES; reads++) {
      const res = await read(n);
      if (res.body.length === 0) empty = n;
      else if (res.nextPage === null) return { n, res };
      else full = { n, res };
      if (empty !== null && empty - full.n <= 1) return full;
      n = empty === null ? full.n * 2 : Math.floor((full.n + empty) / 2);
    }
    throw new GitLabError('transient', `Could not find the newest starrers of ${repo.nameWithOwner}`);
  }
}

/**
 * Starrers newest first: by their full star time (mapped stars keep whole seconds, which would tie), and on a tie in
 * the reverse of GitLab's order (it lists them oldest first). Sorted before mapping for that reason.
 */
const newestFirst = (starrers: RestStarrer[]) => [...starrers].reverse().sort((a, b) => Date.parse(b.starred_since) - Date.parse(a.starred_since));

/** How far a backward walk through the starrers got: the oldest time handed out, and everyone handed out at it. */
interface StarMark {
  at: number;
  logins: string[];
}

/** Whether `s` wasn't handed out yet: older than the mark, or at its very millisecond but not among its logins. */
function olderThan(s: RestStarrer, mark: StarMark): boolean {
  const at = Date.parse(s.starred_since);
  return at < mark.at || (at === mark.at && !mark.logins.includes(s.user.username));
}

/**
 * The mark after handing out `fresh` (newest first, not empty): its oldest time, with the logins at it so far, in
 * GitLab's order reversed. Capped, it keeps the last ones, listed first by GitLab: an unstar shifts those back first.
 */
function markOf(fresh: RestStarrer[], previous: StarMark | null): StarMark {
  const at = Date.parse(fresh.at(-1)!.starred_since);
  const logins = fresh.filter((s) => Date.parse(s.starred_since) === at).map((s) => s.user.username);
  const kept = previous?.at === at ? previous.logins : [];
  return { at, logins: [...kept, ...logins].slice(-MAX_MARKED) };
}

/** Issues proper (not incidents, tasks or test cases), with label colors; the same set the probe counts. */
const ISSUE_FILTER = { issue_type: 'issue', with_labels_details: true } as const;

/** A connection's nodes; GitLab answers null for one the token can't read (say, merge requests turned off). */
const nodes = <T>(conn: Connection<T> | null): T[] => conn?.nodes ?? [];

function toPage<N, T>(conn: Connection<N> | null, map: (node: N) => T): Page<T> {
  return { items: nodes(conn).map(map), hasMore: !!conn?.pageInfo.hasNextPage, endCursor: conn?.pageInfo.endCursor ?? null };
}

/** The project of a response, or a 'not-found' error with the access failure the sync stores for a repo it lost. */
function existing<P>(data: { project: P | null }, repo: RepoRecord): P {
  if (!data.project) throw new GitLabError('not-found', `GitLab project not found: ${repo.nameWithOwner}`, { access: notFound(repo.nameWithOwner) });
  return data.project;
}

/** The project's numeric id for REST paths (it survives renames), from its global id. */
function projectId(repo: RepoRecord): string {
  return /^gid:\/\/gitlab\/Project\/(\d+)$/.exec(repo.nodeId)?.[1] ?? encodeSegment(repo.nameWithOwner);
}

function pageCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) throw new Error(`Invalid page cursor: ${cursor}`);
  return Number(cursor);
}

/** GitLab usernames have no commas, so the boundary's logins are comma-separated. */
function starCursor(cursor: string): { page: number; oldest: StarMark | null } {
  const m = /^(\d+)(?::(\d+):(.+))?$/.exec(cursor);
  if (!m) throw new Error(`Invalid stars cursor: ${cursor}`);
  return { page: Number(m[1]), oldest: m[2] ? { at: Number(m[2]), logins: m[3]!.split(',') } : null };
}

function commitCursor(cursor: string): { page: number; head: string } {
  const m = /^(\d+):([0-9a-f]{40,64})$/.exec(cursor);
  if (!m) throw new Error(`Invalid commits cursor: ${cursor}`);
  return { page: Number(m[1]), head: m[2]! };
}
