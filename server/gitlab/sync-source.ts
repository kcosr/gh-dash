import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import { isFatalSourceError } from '../provider/errors';
import type { Page, RecheckResult, RoundRequest, RoundResult, SyncSource, ViewerInfo } from '../provider/types';
import { GitLabClient } from './client';
import { mapCommit, mapIssue, mapMergeRequest, mapProbe, mapProject, mapRelease, mapStar, mapViewer, releaseCreatedAt } from './map';
import { MERGE_REQUESTS, OWNED_PROJECTS, PROBES, PROJECT, RECHECK_MERGE_REQUESTS, RELEASES, VIEWER } from './queries';
import { encodeSegment, GitLabRestClient, type RestPage } from './rest';
import { GitLabError, GitLabTransport, type GitLabOptions } from './transport';
import type {
  Connection,
  MergeRequestsData,
  OwnedProjectsData,
  ProbesData,
  ProjectData,
  ReleasesData,
  RestCommit,
  RestIssue,
  RestStarrer,
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
/** Projects probed per request. */
const PROBE_CHUNK = 25;
const COMMIT_PAGE = 100;
const STAR_PAGE = 100;
/** Most starrers listed in one round; beyond, they're paged newest first (the sync doesn't diff unstars past 3000). */
const MAX_STARS = 3000;
/** Listings of a project's starrers tried before giving up on one whose count keeps moving. */
const STAR_LISTINGS = 2;
/** Pages tried to find the last page of starrers when GitLab doesn't count them (over 10,000). */
const STAR_SEEK_PAGES = 10;

type Order = 'updated' | 'created';
type StarsPage = Page<StarRecord> & { totalCount: number };

/**
 * Syncs from a GitLab instance: GraphQL for projects, merge requests and releases; REST where GraphQL falls short
 * (commits with stats, issues with who closed them, starrers). A round's sections are fetched in parallel, one request
 * each (stars: one per 100 starrers).
 */
export class GitLabSyncSource implements SyncSource {
  readonly kind = 'gitlab';
  private readonly transport: GitLabTransport;
  private readonly graphql: GitLabClient;
  private readonly rest: GitLabRestClient;
  /**
   * Why the last probes() call left projects out, one line per failed chunk ("projects 26-50 of 60: …"), for the
   * sync to report. Not part of SyncSource yet (see NOTES): probes() can only answer with the probes it got.
   */
  probeErrors: string[] = [];

  constructor(opts: GitLabOptions) {
    // The sync can wait out a throttle's Retry-After (GitLab's windows are a minute or so); a person isn't waiting.
    this.transport = new GitLabTransport(opts, { maxAttempts: 5, maxRetryWaitMs: 120_000 });
    this.graphql = new GitLabClient(this.transport);
    this.rest = new GitLabRestClient(this.transport);
  }

  get rateLimit() {
    return this.transport.rateLimit;
  }

  private get base(): string {
    return this.transport.base;
  }

  async viewer(): Promise<ViewerInfo> {
    const data = await this.graphql.query<ViewerData>(VIEWER);
    // GitLab answers a bad token with a 401, but never sync as nobody.
    if (!data.currentUser) throw new GitLabError('auth', 'GitLab did not recognise the token (no current user)');
    return mapViewer(data.currentUser, this.base);
  }

  /** Projects in the viewer's personal namespace; group projects are for explicit tracking, not "mine". */
  async ownedRepos(): Promise<RepoRecord[]> {
    const out: RepoRecord[] = [];
    let after: string | null = null;
    do {
      const data: OwnedProjectsData = await this.graphql.query<OwnedProjectsData>(OWNED_PROJECTS, { after, first: PROJECT_PAGE });
      out.push(...data.projects.nodes.map((p) => mapProject(p, this.base)));
      after = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async repo(path: string): Promise<{ record: RepoRecord; probe: RepoProbe } | null> {
    const { project } = await this.graphql.query<ProjectData>(PROJECT, { path });
    return project ? { record: mapProject(project, this.base), probe: mapProbe(project) } : null;
  }

  /**
   * A chunk that fails for a reason other than the token or a rate limit leaves its projects unprobed (absent), and
   * says why in probeErrors.
   */
  async probes(repos: RepoRecord[]): Promise<Map<string, RepoProbe>> {
    const out = new Map<string, RepoProbe>();
    this.probeErrors = [];
    for (let i = 0; i < repos.length; i += PROBE_CHUNK) {
      const ids = repos.slice(i, i + PROBE_CHUNK).map((r) => r.nodeId);
      try {
        const data = await this.graphql.query<ProbesData>(PROBES, { ids, first: ids.length });
        for (const p of data.projects.nodes) out.set(p.id, mapProbe(p));
      } catch (err) {
        if (!(err instanceof GitLabError) || isFatalSourceError(err)) throw err;
        this.probeErrors.push(`projects ${i + 1}-${i + ids.length} of ${repos.length}: ${err.message}`);
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
   * - beyond: one page a round from the last page backwards, the cursor being the next page to read. Reading
   *   backwards, an unstar mid-way only shifts an already-read starrer into the next page (seen twice), and new stars
   *   land after the pages being read.
   * `totalCount` is GitLab's count of that same list, which leaves out private profiles and blocked users, so it can
   * be below the project's star count; GitLab stops counting at 10,000, where the star count stands in.
   */
  private async stars(repo: RepoRecord, after: string | null): Promise<StarsPage> {
    const path = `/projects/${projectId(repo)}/starrers`;
    const read = (page: number) => this.rest.page<RestStarrer[]>(path, { query: { per_page: STAR_PAGE, page } });
    if (after) {
      const n = pageCursor(after);
      return this.starPage(repo, n, await read(n));
    }
    for (let listing = 1; ; listing++) {
      const first = await read(1);
      const total = first.total;
      if (first.nextPage !== null && (total === null || total > MAX_STARS)) {
        const last = total === null ? await this.lastStarPage(repo, read) : { n: Math.ceil(total / STAR_PAGE), res: null };
        return this.starPage(repo, last.n, last.res ?? (await read(last.n)));
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

  /** Page `n` of the starrers, newest first; the next round reads page n - 1. */
  private starPage(repo: RepoRecord, n: number, res: RestPage<RestStarrer[]>): StarsPage {
    const items = newestFirst(res.body).map((s) => mapStar(s, this.base));
    return { items, hasMore: n > 1, endCursor: n > 1 ? String(n - 1) : null, totalCount: res.total ?? repo.stars };
  }

  /**
   * The last page of starrers when GitLab doesn't count them (over 10,000): estimated from the project's star count,
   * which also counts hidden profiles and so tends to overshoot, then found by stepping back over empty pages (or on,
   * should the count be behind).
   */
  private async lastStarPage(repo: RepoRecord, read: (page: number) => Promise<RestPage<RestStarrer[]>>) {
    let n = Math.max(1, Math.ceil(repo.stars / STAR_PAGE));
    for (let tries = 0; tries < STAR_SEEK_PAGES && n >= 1; tries++) {
      const res = await read(n);
      if (res.body.length > 0 && res.nextPage === null) return { n, res };
      n = res.body.length > 0 && res.nextPage! > n ? res.nextPage! : n - 1;
    }
    throw new GitLabError('transient', `Could not find the newest starrers of ${repo.nameWithOwner}`);
  }
}

/**
 * Starrers newest first: by their full star time (mapped stars keep whole seconds, which would tie), and on a tie in
 * the reverse of GitLab's order (it lists them oldest first). Sorted before mapping for that reason.
 */
const newestFirst = (starrers: RestStarrer[]) => [...starrers].reverse().sort((a, b) => Date.parse(b.starred_since) - Date.parse(a.starred_since));

/** Issues proper (not incidents, tasks or test cases), with label colors; the same set the probe counts. */
const ISSUE_FILTER = { issue_type: 'issue', with_labels_details: true } as const;

/** A connection's nodes; GitLab answers null for one the token can't read (say, merge requests turned off). */
const nodes = <T>(conn: Connection<T> | null): T[] => conn?.nodes ?? [];

function toPage<N, T>(conn: Connection<N> | null, map: (node: N) => T): Page<T> {
  return { items: nodes(conn).map(map), hasMore: !!conn?.pageInfo.hasNextPage, endCursor: conn?.pageInfo.endCursor ?? null };
}

/** The project of a response: null when it no longer exists or the token can no longer see it. */
function existing<P>(data: { project: P | null }, repo: RepoRecord): P {
  if (!data.project) throw new GitLabError('not-found', `GitLab project not found: ${repo.nameWithOwner}`);
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

function commitCursor(cursor: string): { page: number; head: string } {
  const m = /^(\d+):([0-9a-f]{40,64})$/.exec(cursor);
  if (!m) throw new Error(`Invalid commits cursor: ${cursor}`);
  return { page: Number(m[1]), head: m[2]! };
}
