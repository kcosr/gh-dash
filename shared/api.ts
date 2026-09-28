/**
 * API contract shared by the server (server/) and the web app (web/).
 *
 * All endpoints live under /api/v1. All timestamps are ISO-8601 UTC strings.
 * Repos are identified by their short name (e.g. "gh-dash"): the dashboard only
 * tracks repositories owned by the authenticated user, so names are unique.
 *
 * Change policy: this file is the coordination point between agents. Additive,
 * optional fields are fine; renames/removals are not.
 */

export type Visibility = 'public' | 'private';
export type VisibilityFilter = 'all' | Visibility;
export type Who = 'me' | 'others' | 'everyone';
export type PrState = 'open' | 'merged' | 'closed';
export type PrStateFilter = PrState | 'all';
export type IssueState = 'open' | 'closed';
export type EventType = 'commit' | 'pr' | 'issue' | 'release' | 'star';
export type Bucket = 'day' | 'week' | 'month';
export type GroupBy = 'day' | 'week' | 'month' | 'repo';
export type ListFormat = 'json' | 'md' | 'csv';

export const EVENT_TYPES: EventType[] = ['commit', 'pr', 'issue', 'release', 'star'];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** A person. Commits can have an author with no linked GitHub account (login null). */
export interface Actor {
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** True when this is the authenticated user (login match, or commit email in settings.myEmails). */
  isMe: boolean;
}

export interface Label {
  name: string;
  /** Hex without '#', as GitHub returns it (e.g. "a2eeef"). */
  color: string;
}

export interface RepoStats {
  openPrs: number;
  openIssues: number;
  mergedPrs30d: number;
  commits30d: number;
  newStars30d: number;
  /** Commits to the default branch per ISO week (Mon-start, server tz), 12 values, oldest first; last = current week. */
  weeklyCommits: number[];
}

export interface Repo {
  name: string;
  nameWithOwner: string;
  owner: string;
  description: string | null;
  url: string;
  visibility: Visibility;
  isArchived: boolean;
  isFork: boolean;
  language: { name: string; color: string | null } | null;
  topics: string[];
  defaultBranch: string | null;
  stars: number;
  forks: number;
  createdAt: string;
  pushedAt: string | null;
  /**
   * Latest of pushedAt and any PR / issue / release activity we have stored. Stars are deliberately
   * excluded: someone starring an old repo is not "activity" in it (drives sidebar ordering).
   */
  lastActivityAt: string | null;
  /** User preferences (stored locally, not on GitHub). */
  pinned: boolean;
  hidden: boolean;
  setIds: number[];
  stats: RepoStats;
  syncedAt: string | null;
}

export interface PullRequest {
  /** "<repo>#<number>", e.g. "gh-dash#24" */
  id: string;
  repo: string;
  number: number;
  title: string;
  /** Full markdown description (may be empty string). */
  body: string;
  state: PrState;
  isDraft: boolean;
  author: Actor;
  mergedBy: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** The date lists filter and sort on: mergedAt if merged, closedAt if closed, else createdAt. */
  activityAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  headRef: string;
  baseRef: string;
  labels: Label[];
  url: string;
}

export interface PullRequestDetail extends PullRequest {
  commits: { oid: string; headline: string; committedAt: string; url: string; author: Actor }[];
  closingIssues: { number: number; title: string; state: IssueState; url: string }[];
}

export interface Commit {
  oid: string;
  /** First 7 chars of oid. */
  shortOid: string;
  repo: string;
  headline: string;
  body: string;
  author: Actor;
  committedAt: string;
  url: string;
  additions: number;
  deletions: number;
  /** Set when the commit landed via a pull request (e.g. squash merge). */
  prNumber: number | null;
}

export interface Issue {
  /** "<repo>#<number>" */
  id: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author: Actor;
  closedBy: Actor | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  labels: Label[];
  url: string;
}

export interface Release {
  /** "<repo>@<tag>" */
  id: string;
  repo: string;
  tag: string;
  name: string | null;
  body: string;
  author: Actor | null;
  publishedAt: string;
  isPrerelease: boolean;
  url: string;
}

export interface Star {
  repo: string;
  user: Actor;
  starredAt: string;
}

/**
 * One row of the activity feed. The API returns raw events; the UI groups them
 * (e.g. several commits by the same person to the same repo on one day).
 * Commit events only include commits NOT associated with a PR (direct pushes);
 * PR merges are represented by the `pr`/`merged` event instead.
 */
export type ActivityEvent =
  | { type: 'commit'; at: string; repo: string; actor: Actor; commit: Commit }
  | { type: 'pr'; kind: 'opened' | 'merged' | 'closed'; at: string; repo: string; actor: Actor; pr: PullRequest }
  | { type: 'issue'; kind: 'opened' | 'closed'; at: string; repo: string; actor: Actor; issue: Issue }
  | { type: 'release'; at: string; repo: string; actor: Actor | null; release: Release }
  | { type: 'star'; at: string; repo: string; actor: Actor };

export interface RepoSet {
  id: number;
  name: string;
  repos: string[];
}

export interface SavedView {
  id: number;
  name: string;
  /** App route, e.g. "/prs" */
  path: string;
  /** URL query string without '?', e.g. "state=merged&who=me&range=30d" */
  query: string;
}

export interface Settings {
  syncIntervalMinutes: number; // default 30; allowed 5..1440
  backfillDays: number; // default 365; how far back the first sync reaches for commits/PRs/issues
  /** Extra commit emails that count as "me" (commits with no linked GitHub account). */
  myEmails: string[];
  /**
   * Read-only: emails from the GH_DASH_MY_EMAILS env var (comma-separated). They always count as "me"
   * in addition to `myEmails`, so a deployment can configure identity without touching the DB.
   * Ignored in PATCH.
   */
  myEmailsFromEnv?: string[];
  includeForks: boolean; // default false: forks are synced but excluded from the default scope
}

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  tokenSource: 'env' | 'gh-cli' | 'none';
}

export interface SyncStatus {
  running: boolean;
  trigger: 'manual' | 'scheduled' | 'startup' | null;
  progress: { done: number; total: number; current: string | null } | null;
  lastSyncAt: string | null;
  lastSyncDurationMs: number | null;
  lastResult: { newItems: number; errors: string[] } | null;
  nextSyncAt: string | null;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  tokenSource: 'env' | 'gh-cli' | 'none';
  viewer: string | null;
}

// ---------------------------------------------------------------------------
// Query parameters (all optional; all sent as URL query strings)
// ---------------------------------------------------------------------------

/**
 * Scope shared by every list/stats endpoint.
 *  - repos: comma-separated repo names. Omitted => the default scope: all repos
 *    that are not archived, not hidden, and (unless settings.includeForks) not forks.
 *    An explicitly empty value (`repos=`) means "no repos" and returns nothing.
 *  - visibility: default 'all'.
 *  - who: default 'everyone'. 'me' matches Actor.isMe. Stars are always by others.
 *  - from / to: 'YYYY-MM-DD' (interpreted in `tz`; `to` is inclusive through the end of that day),
 *    a full ISO datetime, or a relative offset like '-7d' / '-12w' / '-3m' (from now).
 *    Default range: last 30 days.
 *  - tz: IANA timezone used for date-only bounds and for day/week/month bucketing. Default: server tz.
 *  - q: full-text search (SQLite FTS5 over titles, bodies, commit messages, release notes).
 */
export interface ScopeQuery {
  repos?: string;
  visibility?: VisibilityFilter;
  who?: Who;
  from?: string;
  to?: string;
  tz?: string;
  q?: string;
}

export interface PageQuery {
  /** Default 200, max 1000. */
  limit?: number;
  /** Opaque cursor from a previous response's nextCursor. */
  cursor?: string;
  /** 'md' and 'csv' return text/markdown or text/csv instead of JSON (all pages, ignoring limit/cursor). */
  format?: ListFormat;
}

export interface PrQuery extends ScopeQuery, PageQuery {
  state?: PrStateFilter; // default 'all'
  labels?: string; // comma-separated; PR must have at least one
  /** Only affects format=md headings. Default 'week'. */
  group?: GroupBy;
}

export interface ActivityQuery extends ScopeQuery, PageQuery {
  /** Comma-separated EventType list. Default: all types. */
  types?: string;
}

export interface IssueQuery extends ScopeQuery, PageQuery {
  state?: IssueState | 'all';
}

/** Repository inventory by default; scope=default uses the dashboard's usual selection. */
export interface RepoQuery {
  /** Explicit names override scope; an empty string selects nothing. */
  repos?: string;
  scope?: 'all' | 'default';
  visibility?: VisibilityFilter;
  q?: string;
  sort?: 'activity' | 'stars' | 'open' | 'name';
}

export interface StatsQuery extends ScopeQuery {
  /** Default: 'day' if range <= 45 days, 'week' if <= 190 days, else 'month'. */
  bucket?: Bucket;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ListResponse<T> {
  items: T[];
  nextCursor: string | null;
  /** Total matching items across all pages. */
  total: number;
}

export interface Facets {
  /** Count per repo for the current filters, computed IGNORING the `repos` filter (drives sidebar counts). */
  byRepo: Record<string, number>;
  /** Activity only: count per type for the current filters, computed IGNORING the `types` filter. */
  byType?: Partial<Record<EventType, number>>;
  /**
   * Activity only: count per local day ('YYYY-MM-DD' in the request tz) for the current filters
   * (all filters apply, including `types`) — i.e. exactly the events the feed lists, before UI grouping.
   * Drives the ActivityStrip so its bars match the feed's day headers.
   */
  byDay?: Record<string, number>;
}

export interface PrListResponse extends ListResponse<PullRequest> {
  facets: Facets;
}

export interface ActivityResponse extends ListResponse<ActivityEvent> {
  facets: Facets;
}

export interface Tile {
  /** null when there is no data (e.g. no merged PRs => no median). */
  value: number | null;
  /** Same metric over the immediately preceding period of equal length. */
  previous: number | null;
  /** The range split into 12 equal slices, oldest first. */
  spark: number[];
}

export interface StatsBucket {
  /** Bucket start: 'YYYY-MM-DD' in the requested tz (week buckets start Monday). */
  start: string;
  commits: number; // all commits to default branches (including PR merge/squash commits)
  commitsMine: number;
  prsOpened: number;
  prsMerged: number;
  prsMergedMine: number;
  issuesOpened: number;
  issuesClosed: number;
  releases: number;
  stars: number;
  /** Median hours from PR creation to merge for PRs merged in this bucket; null if none. */
  medianHoursToMerge: number | null;
}

export interface StatsResponse {
  range: { from: string; to: string; prevFrom: string; prevTo: string; bucket: Bucket; tz: string };
  tiles: {
    prsMerged: Tile;
    commits: Tile;
    newStars: Tile;
    medianHoursToMerge: Tile;
    issuesClosed: Tile;
    activeRepos: Tile; // repos with >= 1 commit/PR/issue/release event in the range
  };
  /** One entry per bucket covering the whole range, zero-filled. */
  series: StatsBucket[];
  /** Daily, zero-filled over the range. `total` = cumulative stars across in-scope public repos at end of day. */
  stars: { date: string; total: number; added: number }[];
  /** Daily commit counts over the range, zero-filled (who filter applies). */
  commitCalendar: { date: string; count: number }[];
  /** Sorted by total desc; every in-scope repo with any activity in range. */
  byRepo: { repo: string; commits: number; prsMerged: number; issues: number; releases: number; stars: number; total: number }[];
  /** Top people by activity in range (who filter applies). */
  contributors: { actor: Actor; commits: number; prsMerged: number; total: number }[];
}

// ---------------------------------------------------------------------------
// Endpoint index (for reference; implemented in server/, consumed in web/src/api)
// ---------------------------------------------------------------------------
//
// GET    /api/health                           -> { ok: true, version: string }
// GET    /api/v1/me                            -> Me
// GET    /api/v1/repos          RepoQuery      -> { items: Repo[] }          (unfiltered: all repos incl. archived/hidden/forks)
// GET    /api/v1/repos/:name                   -> Repo
// PATCH  /api/v1/repos/:name   {pinned?, hidden?} -> Repo
// GET    /api/v1/sets                          -> { items: RepoSet[] }
// POST   /api/v1/sets          {name, repos}   -> RepoSet
// PATCH  /api/v1/sets/:id      {name?, repos?} -> RepoSet
// DELETE /api/v1/sets/:id                      -> 204
// GET    /api/v1/views                         -> { items: SavedView[] }
// POST   /api/v1/views         {name, path, query} -> SavedView
// DELETE /api/v1/views/:id                     -> 204
// GET    /api/v1/prs            PrQuery        -> PrListResponse | text/markdown | text/csv
// GET    /api/v1/prs/:repo/:number             -> PullRequestDetail
// GET    /api/v1/activity       ActivityQuery  -> ActivityResponse | text/markdown | text/csv
// GET    /api/v1/commits        ScopeQuery&PageQuery -> ListResponse<Commit>
// GET    /api/v1/issues         IssueQuery     -> ListResponse<Issue>
// GET    /api/v1/releases       ScopeQuery&PageQuery -> ListResponse<Release>
// GET    /api/v1/stars          ScopeQuery&PageQuery -> ListResponse<Star>
// GET    /api/v1/stats          StatsQuery     -> StatsResponse
// GET    /api/v1/sync/status                   -> SyncStatus
// POST   /api/v1/sync           {repo?: string, full?: boolean} -> 202 SyncStatus (409 if already running)
// GET    /api/v1/settings                      -> Settings
// PATCH  /api/v1/settings       Partial<Settings> -> Settings
// GET    /api/v1/openapi.json                  -> OpenAPI 3.1 document
// GET    /api/docs                             -> human-readable API docs page (no external CDN)
//
// Errors: non-2xx responses have JSON body { error: string, details?: unknown }.
