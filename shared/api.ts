/**
 * API contract shared by the server (server/) and the web app (web/).
 *
 * All endpoints live under /api/v1. All timestamps are ISO-8601 UTC strings.
 *
 * Sources: the code hosts repositories are tracked on, each identified by its host: github.com (always there), and
 * any number of GitLab instances (e.g. "gitlab.example.com"). GET /sources lists them. Pull requests are GitHub pull
 * requests and GitLab merge requests alike (ids are "<repo>#<number>" for both), and "commits", "issues" and the rest
 * mean the same on both.
 *
 * Repos are identified by their key: "owner/name" on github.com (e.g. "kcosr/gh-dash"), and "<host>/<full path>" on
 * every other source (e.g. "gitlab.example.com/platform/team/app"). Every `repo` field and id carries it, and path
 * params take it URL-encoded as one segment (`kcosr%2Fgh-dash`, `gitlab.example.com%2Fplatform%2Fteam%2Fapp`). Keys
 * are opaque: read `Repo.source` for the host. Inputs (path params, `repos=` lists, set members, POST /sync `repo`)
 * also accept the short name of a github.com repository the authenticated user owns ("gh-dash"), which is how repos
 * were identified before keys had owners.
 *
 * Change policy: this file is the coordination point between agents. Additive,
 * optional fields are fine; renames/removals are not.
 */

/** The kind of code host a source is. Its words and URL shapes are in shared/provider.ts. */
export type ProviderKind = 'github' | 'gitlab';
/** The host of the built-in github.com source (`Repo.source`). Its keys are `owner/name`; every other source's carry the host. */
export const GITHUB_HOST = 'github.com';
/** 'internal': a GitHub Enterprise repository visible to every member of the enterprise. */
export type Visibility = 'public' | 'private' | 'internal';
export type VisibilityFilter = 'all' | Visibility;
/** How a repository came to be tracked: synced because the viewer owns it, or added by hand. */
export type TrackedBy = 'owned' | 'manual';
/** Repos by how they are tracked: 'mine' = owned (tracked automatically), 'others' = added by hand. */
export type Ownership = 'all' | 'mine' | 'others';
export type Who = 'me' | 'others' | 'everyone';
export type PrState = 'open' | 'merged' | 'closed';
export type PrStateFilter = PrState | 'all';
export type IssueState = 'open' | 'closed';
/** `comment`: local review comments (the comment event log): who opened, answered, resolved... which thread. */
export type EventType = 'commit' | 'pr' | 'issue' | 'release' | 'star' | 'comment';
export type Bucket = 'day' | 'week' | 'month';
export type GroupBy = 'day' | 'week' | 'month' | 'repo';
export type ListFormat = 'json' | 'md' | 'csv';

export const EVENT_TYPES: EventType[] = ['commit', 'pr', 'issue', 'release', 'star', 'comment'];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** A person. Commits can have an author with no linked account (login null; GitLab commits never have one). */
export interface Actor {
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  /**
   * True when this is the authenticated user of the source the item is on: that source's account by login, or a commit
   * email of it (settings.myEmails and GH_DASH_MY_EMAILS count on every source).
   */
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
  /**
   * Identity everywhere in the API and in URLs (`repos=` lists, path params, every `repo` field): "owner/name" on
   * github.com, "<host>/<full path>" on every other source (e.g. "gitlab.example.com/platform/team/app"). Opaque:
   * read `source` for the host rather than parsing it. `name` is the short name.
   */
  key: string;
  /** The source's host ("github.com", "gitlab.example.com"): which code host the repo is on. */
  source: string;
  provider: ProviderKind;
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
  /** 'owned': one of the authenticated user's repositories, tracked automatically; 'manual': added by hand. */
  trackedBy: TrackedBy;
  /** Manual repos: when they were added. */
  addedAt: string | null;
  /** Manual repos the token can no longer read: data kept, sync skips it until readable again. */
  unavailable: { since: string; reason: string } | null;
  /**
   * Local comments on its PRs, branches and commits (every author, never on the code host): removing the repo deletes
   * them.
   */
  commentCount: number;
}

export interface PullRequest {
  /** "<repo>#<number>", e.g. "kcosr/gh-dash#24" */
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
  /**
   * Local comment threads the PR's view shows: its own and its branch group (see "Branch groups"). On list items, the
   * detail and activity events alike; zero counts when none.
   */
  comments: CommentCounts;
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
  /** Local comment threads on this commit itself (not on a PR it landed through; zero counts when none). */
  comments: CommentCounts;
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
  | { type: 'star'; at: string; repo: string; actor: Actor }
  /**
   * A comment written, changed or deleted, or a thread resolved or reopened, in gh-dash (never on the code host). The
   * actor is a principal: no login or avatar, `isMe` for the dashboard's user, an agent otherwise.
   */
  | { type: 'comment'; kind: CommentEventKind; at: string; repo: string; actor: Actor; comment: CommentActivity };

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
  /** Extra commit emails that count as "me" on every source (commits with no linked account). */
  myEmails: string[];
  /**
   * Read-only: emails from the GH_DASH_MY_EMAILS env var (comma-separated). They always count as "me"
   * in addition to `myEmails`, so a deployment can configure identity without touching the DB.
   * Ignored in PATCH.
   */
  myEmailsFromEnv?: string[];
  includeForks: boolean; // default false: forks are synced but excluded from the default selection
  /** Size cap for the on-disk diff cache in MB (default 200; allowed 10..10000). Least recently viewed entries go first. */
  diffCacheMb: number;
}

/**
 * Where the server's GitHub token currently comes from:
 *  - env: GITHUB_TOKEN in the process environment (or the headless env file); locks the choice.
 *  - file: a token file the user owns (config `tokenFile` / GITHUB_TOKEN_FILE), re-read on use.
 *  - gh-cli: the output of `gh auth token`.
 *  - glab: what `glab` has for a GitLab source's host (GitLab sources only).
 *  - app: a token handed to the server by the desktop app (pasted, optionally remembered in the OS keychain).
 *  - none: no usable token.
 */
export type TokenSource = 'env' | 'file' | 'gh-cli' | 'glab' | 'app' | 'none';

/**
 * Which source the user chose (persisted in config.json as `tokenSource`). `auto` is the headless default and
 * keeps the legacy order GITHUB_TOKEN > token file > gh. The desktop app starts with no choice (null) and
 * never falls back silently. GITHUB_TOKEN in the environment always wins (AccountStatus.locked). `glab` is for GitLab
 * sources only.
 */
export type TokenChoice = 'auto' | 'gh' | 'glab' | 'file' | 'app';

/**
 * Token kind, from its prefix: github_pat_ fine-grained, ghp_ classic, gho_ OAuth (what gh uses), ghu_/ghs_ app tokens.
 * GitLab: glpat- is a personal (or group/project) access token; OAuth when GitLab won't describe the token.
 */
export type TokenKind = 'fine-grained' | 'classic' | 'oauth' | 'app' | 'personal' | 'unknown';

/** Pre-filled fine-grained token page: read-only Metadata, Contents, Issues, Pull requests (repository access must be picked by hand). */
export const TOKEN_CREATE_URL =
  'https://github.com/settings/personal-access-tokens/new?name=gh-dash&description=Read-only+token+for+gh-dash&expires_in=366&metadata=read&contents=read&issues=read&pull_requests=read';

/** GET /api/v1/me: the github.com account (source 1). Other sources have accounts of their own. */
export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  tokenSource: TokenSource;
}

/** GET /api/v1/account: the GitHub account behind the current token. Never includes the token. */
export interface AccountStatus {
  /** Effective source right now. */
  source: TokenSource;
  /** The configured choice; null = desktop app with nothing chosen yet. */
  choice: TokenChoice | null;
  /** GITHUB_TOKEN is set in the environment: the source can't be changed from the app. */
  locked: boolean;
  /** Login the token belongs to (from the last validation); null when unknown or no token. */
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** Login this database was synced for (meta.viewer); null for a fresh database. */
  dbLogin: string | null;
  /** The token belongs to a different account than the database: sync is refused until resolved. */
  mismatch: boolean;
  kind: TokenKind | null;
  /** From GitHub-Authentication-Token-Expiration; null when the token doesn't expire or it's unknown. */
  expiresAt: string | null;
  /** Classic/OAuth scopes (X-OAuth-Scopes); null for fine-grained tokens or when unknown. */
  scopes: string[] | null;
  /** Owned repositories the token can see (total / private), from the last validation. */
  repos: { total: number; private: number } | null;
  /** Why there is no usable token, or why validation failed ("gh is not installed", "Bad credentials", ...). */
  error: string | null;
  /** GitHub CLI detection, for the one-click choice. `login` comes from gh's hosts.yml (no API call). */
  gh: { available: boolean; path: string | null; login: string | null };
  /** Configured token file path (not its contents); null when none. */
  tokenFile: string | null;
  /** When the token was last validated against GitHub. */
  checkedAt: string | null;
}

/**
 * A source's credential as this server holds it (never the token): GitHub's AccountStatus, generalised to every source.
 * GitLab's scopes, expiry and instance come from validating the token (2 requests); none of it is stored.
 */
export interface SourceAccount {
  /** Effective source right now. */
  source: TokenSource;
  /** The configured choice; null = nothing chosen (desktop), or nothing configured. */
  choice: TokenChoice | null;
  /** `env` is set in the environment: it is always used, and the choice can't be changed from the app. */
  locked: boolean;
  /** The variable that locks this source (GITHUB_TOKEN, a GitLab source's tokenEnv); null when none does. */
  env: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** The account this database was synced for, on this source; null before its first sync. */
  dbLogin: string | null;
  mismatch: boolean;
  kind: TokenKind | null;
  /** When the token stops working (ISO); null when it doesn't expire or it's unknown (GitLab OAuth tokens). */
  expiresAt: string | null;
  /** The token's scopes; null when unknown (GitHub fine-grained tokens, GitLab OAuth tokens). */
  scopes: string[] | null;
  /** GitLab: the scopes include api or write_repository, which gh-dash never needs. null for GitHub, or unknown. */
  canWrite: boolean | null;
  /** GitHub: owned repositories (total / private). GitLab: projects in the personal namespace (private unknown). */
  repos: { total: number; private: number | null } | null;
  /** The provider's CLI (gh, glab). `login` comes from its config without running it (gh only). */
  cli: { name: 'gh' | 'glab'; available: boolean; path: string | null; login: string | null } | null;
  /** Configured token file path (not its contents); null when none. */
  tokenFile: string | null;
  /** The GitLab instance's version; null for GitHub, or before a validation. */
  instance: { version: string; enterprise: boolean } | null;
  error: string | null;
  checkedAt: string | null;
}

/**
 * GET /api/v1/sources, /sources/:source: one code host this database tracks repositories on (github.com, or a GitLab
 * instance). Never includes a token. Sources are added and their credentials changed in config.json / the environment
 * (headless) or in the desktop app's Settings, never over HTTP; the API lists them, re-checks their credential and
 * removes an unconfigured one with its data.
 */
export interface Source {
  /** Identity: 'github.com', 'gitlab.example.com'. Also `Repo.source`, `SourceSyncStatus.source`, and the id in the paths. */
  host: string;
  kind: ProviderKind;
  /** Display name: 'GitHub', 'GitLab', or the host when there are several GitLab sources. */
  name: string;
  /** Base URL of the instance, relative root included ('https://github.com', 'https://gitlab.example.com'). */
  url: string;
  /**
   * This server syncs it: github.com always, a GitLab source when this server's config (config.json / the environment)
   * names it. A source in the database that another server configured is listed with `configured: false`.
   */
  configured: boolean;
  /** DELETE would remove it now: not github.com, and not while it is configured on this server. */
  removable: boolean;
  /** The account its data belongs to (claimed by its first sync); null before that. */
  viewer: { login: string; name: string | null; avatarUrl: string | null } | null;
  /** Its credential as this server holds it; null when the source isn't configured here. */
  account: SourceAccount | null;
  sync: SourceSyncStatus;
  /** Live repositories on it: tracked automatically, added by hand, and (of both) hidden from the default selection. */
  repos: { owned: number; added: number; hidden: number };
}

/**
 * A GitLab source tested before it is added, or a new credential for one before it is used (the desktop app's
 * test-source). Nothing was saved to test it. Never includes the token.
 */
export interface SourceCheck {
  /** The token was found and GitLab accepted it, and nothing stands in the way of using it (`conflict`). */
  ok: boolean;
  /** The source's identity, from the URL: 'gitlab.example.com'. */
  host: string;
  /** The URL as it would be saved: relative root kept, no trailing slash. */
  url: string;
  /** Who the token is for, its scopes and expiry, the instance's version; or why there is no usable token (`error`). */
  account: SourceAccount;
  /** Why it can't be used as it is: already added, or this database's data on that host is another account's. */
  conflict: string | null;
}

/** Where an instance setting's value came from. */
export type ConfigSource = 'default' | 'file' | 'env';

/** GET /api/v1/instance: how this server is running. Secrets are never included, only whether they're set. */
export interface InstanceInfo {
  version: string;
  /** Running inside the desktop app. */
  desktop: boolean;
  /**
   * Base URL other clients (browser tabs, curl, scripts) can use for this API, e.g. "http://127.0.0.1:4780".
   * null when nothing listens on the network (desktop app with the local API off). Links to /api/docs etc. use it.
   */
  apiUrl: string | null;
  /**
   * Where agents reach MCP: `<apiUrl>/mcp` on a headless server; in the desktop app its Local API's while that serves
   * MCP (which it may do with the REST API off, apiUrl then null). null when nothing serves it.
   */
  mcpUrl: string | null;
  auth: { password: boolean; apiKey: boolean };
  /** config.json path (whether or not it exists); null when config files are disabled. */
  configPath: string | null;
  /** Effective instance settings and where each came from, for display. */
  settings: {
    host: { value: string; source: ConfigSource };
    port: { value: number; source: ConfigSource };
    dbPath: { value: string; source: ConfigSource };
    cacheDbPath: { value: string; source: ConfigSource };
    sync: { value: boolean; source: ConfigSource };
    allowedHosts: { value: string[]; source: ConfigSource };
    tokenFile: { value: string | null; source: ConfigSource };
    defaultTz: { value: string; source: ConfigSource };
    /** The glab executable when it isn't on PATH or in a standard location (GitLab sources); null when unset. */
    glabPath: { value: string | null; source: ConfigSource };
    /** The GitLab sources this server is configured with, and where each came from (config.json, or GH_DASH_GITLAB_URL). */
    sources: { host: string; from: ConfigSource }[];
  };
}

/**
 * GET /api/v1/sync/status. One sync runs at a time; inside it, each source syncs on its own (`sources`). The run-level
 * fields (running, trigger, progress, the last run, the next one) cover every source: `lastResult.errors` names the
 * source of every error but github.com's. `rateLimit`, `tokenSource` and `viewer` are github.com's, as they always
 * were; `sources` has each source's own.
 */
export interface SyncStatus {
  running: boolean;
  trigger: 'manual' | 'scheduled' | 'startup' | null;
  /** The run's progress: its sources' added up. */
  progress: { done: number; total: number; current: string | null } | null;
  lastSyncAt: string | null;
  lastSyncDurationMs: number | null;
  lastResult: { newItems: number; errors: string[] } | null;
  nextSyncAt: string | null;
  /** github.com's. */
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  /** github.com's. */
  tokenSource: TokenSource;
  /** github.com's account. */
  viewer: string | null;
  /** Key of the one repository a single-repo sync is syncing (e.g. one just added); null for a full sync. */
  repo?: string | null;
  /** Every source this database knows, github.com first: each one's part of the sync. */
  sources: SourceSyncStatus[];
}

/** One source's part of the sync (SyncStatus.sources). */
export interface SourceSyncStatus {
  /** The source's host: 'github.com', 'gitlab.example.com'. */
  source: string;
  /** Its part of the current run is still going. */
  running: boolean;
  progress: { done: number; total: number; current: string | null } | null;
  /** When its last sync (all its repositories, or one) ended. */
  lastSyncAt: string | null;
  lastResult: { newItems: number; errors: string[] } | null;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  tokenSource: TokenSource;
  /** The account its data belongs to. */
  viewer: string | null;
  /**
   * Why it isn't syncing: it isn't configured on this server, it has no token (why not), or the token is for another
   * account than its data's. null when nothing stands in the way.
   */
  problem: string | null;
}

// ---------------------------------------------------------------------------
// Adding and removing repositories
// ---------------------------------------------------------------------------

/** A repository the token can read, as offered by the Add dialog. */
export interface RepoCandidate {
  key: string;
  owner: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  isArchived: boolean;
  isFork: boolean;
  stars: number;
  pushedAt: string | null;
  /** How it is tracked already, or null when it isn't. */
  tracked: TrackedBy | null;
}

/** GET /repo-candidates: the token's repositories of other owners, and ones the user recently contributed to. */
export interface RepoCandidatesResponse {
  /** Repositories you collaborate on or reach through an organization, most recently pushed first (at most 1000). */
  items: RepoCandidate[];
  /** Repositories of others you recently contributed to that aren't tracked yet. */
  suggested: RepoCandidate[];
  /** More repositories exist than `items` lists. */
  truncated: boolean;
  fetchedAt: string;
}

/**
 * Why a repository can't be added (or synced): 'not-found' (doesn't exist, or the token can't see it), 'sso' (the
 * organization requires SAML single sign-on), 'org-policy' (an organization policy refuses the token),
 * 'permission' (the token sees the repository but not its pull requests, issues or code).
 */
export type AccessProblem = 'not-found' | 'sso' | 'org-policy' | 'permission';

export interface RepoPreview extends RepoCandidate {
  url: string;
  openPrs: number;
  openIssues: number;
  /** The viewer owns it: tracked automatically, so Add is refused. */
  owned: boolean;
  /** When tracked: whether it is left out of the default selection. */
  hidden: boolean | null;
  /**
   * What the first sync would fetch: items since `since` (null: unknown; GitLab doesn't count commits), and about how
   * many requests to the code host (null: unknown).
   */
  backfill: { since: string; commits: number | null; prs: number | null; issues: number | null; releases: number; requests: number | null };
  /**
   * Parts the code host doesn't show this token, though the repository can be added: on GitLab, merge requests or
   * issues turned off on the project, or hidden at the token's role. Nothing of them is synced (their backfill counts
   * are 0). Absent when all are there.
   */
  unavailable?: ('prs' | 'issues')[];
}

/** GET /repo-lookup: whether the token can read a repository, with a preview when it can. */
export type RepoLookup =
  | { ok: true; repo: RepoPreview }
  | { ok: false; key: string; problem: AccessProblem; message: string; hint: string | null };

/** POST /repos: the repository as tracked now, and whether its first sync started or waits for the current one. */
export interface AddRepoResponse {
  repo: Repo;
  sync: 'started' | 'queued';
}

// ---------------------------------------------------------------------------
// Query parameters (all optional; all sent as URL query strings)
// ---------------------------------------------------------------------------

/**
 * Scope shared by every list/stats endpoint.
 *  - repos: comma-separated repo keys ("owner/name" on github.com, "<host>/<path>" elsewhere; a github.com repo you own
 *    also works by its short name). Omitted => the default selection: all repos that are not archived, not hidden, and
 *    (unless settings.includeForks) not forks. An explicitly empty value (`repos=`) means "no repos" and returns nothing.
 *  - source: comma-separated source hosts ("github.com", "gitlab.example.com"): only repos on those sources. Omitted
 *    (or empty) => every source. It narrows `repos` and the default selection alike. A host that isn't a source is a
 *    400.
 *  - visibility: default 'all'.
 *  - ownership: default 'all'; 'mine' = repositories you own, 'others' = repositories added by hand.
 *  - who: default 'everyone'. 'me' matches Actor.isMe, judged per source. Stars are always by others.
 *  - from / to: 'YYYY-MM-DD' (interpreted in `tz`; `to` is inclusive through the end of that day),
 *    a full ISO datetime, or a relative offset like '-7d' / '-12w' / '-3m' (from now).
 *    Default range: last 30 days.
 *  - tz: IANA timezone used for date-only bounds and for day/week/month bucketing. Default: server tz.
 *  - q: full-text search (SQLite FTS5 over titles, bodies, commit messages, release notes).
 */
export interface ScopeQuery {
  repos?: string;
  source?: string;
  visibility?: VisibilityFilter;
  ownership?: Ownership;
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
  /** Only PRs with local comment threads: any, or at least one unresolved. */
  comments?: CommentFilter;
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

/** Repository inventory by default; scope=default narrows it to the default selection. */
export interface RepoQuery {
  /** Explicit repo keys (or a github.com repo you own by its short name) override scope; an empty string selects nothing. */
  repos?: string;
  scope?: 'all' | 'default';
  /** Comma-separated source hosts: only repos on those sources (omitted: every source; a host that isn't one: 400). */
  source?: string;
  visibility?: VisibilityFilter;
  ownership?: Ownership;
  /** Case-insensitive substring of the repo key, description, topics or language. */
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
// Diffs: fetched from the repo's code host (GitHub or GitLab) when a user opens one, cached in a separate
// on-disk cache database. Never part of the background sync.
// ---------------------------------------------------------------------------

export type DiffFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface DiffFile {
  /** Path on the new side (for a removed file, the path it had). */
  path: string;
  /** Old path for renamed/copied files; null otherwise. */
  previousPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  /**
   * Unified-diff hunks as the code host returns them: starts at the first "@@" line, with no
   * "diff --git" / "---" / "+++" header lines. null when the code host omits the patch
   * (binary files, or text diffs too large for the API).
   */
  patch: string | null;
}

export interface Diff {
  kind: 'pr' | 'commit' | 'branch';
  repo: string;
  /** PR number for kind 'pr'; null for commits and branches. */
  number: number | null;
  /** For kind 'branch': the branch, compared against `baseRef`. Absent for PRs and commits. */
  branch?: string;
  /** For kind 'branch': the repo's default branch, which the branch is compared against. Absent for PRs and commits. */
  baseRef?: string;
  /** PR title, commit headline, or the branch's name. */
  title: string;
  /**
   * Old side of every file: the merge base for a PR or branch (three-dot), the first parent for a commit (null for a
   * root commit).
   */
  baseOid: string | null;
  /** New side of every file: the PR head, the commit itself, or the branch's head. */
  headOid: string;
  /** In the code host's order. */
  files: DiffFile[];
  /** Files the code host reports as changed; exceeds files.length when it caps the list (GitHub: 3000 files). */
  totalFiles: number;
  additions: number;
  deletions: number;
  /** When this diff was fetched from the code host (earlier than the request when served from the cache). */
  fetchedAt: string;
  /**
   * The PR's "Files changed" tab (GitLab: the merge request's changes page), the commit page, or the branch's compare
   * page on the code host.
   */
  url: string;
  /**
   * Set when this cached copy was served because the code host couldn't be asked whether it's still current
   * (no token, rate limit, outage). Never set for refresh=1, which fails instead.
   */
  stale?: true;
}

export interface DiffCacheStats {
  entries: number;
  /** Bytes used by cached diffs and file contents. */
  bytes: number;
  /** Current cap (Settings.diffCacheMb in bytes). */
  maxBytes: number;
}

// ---------------------------------------------------------------------------
// Comments: local review threads on PR, branch and commit diffs. Stored in gh-dash only, never posted to
// GitHub. Placement in a later revision of a PR's or branch's diff: shared/comment-placement.ts.
//
// Branch groups. A branch's review (its diff against the default branch, before or without a PR) and the PRs from it
// share their threads: what matters is the line of work, not which PR (if any) was open when a comment was made. A
// thread's `branch` says which branch's line of work it belongs to. A same-repo PR from the branch being merged ends
// one line of work: the branch name may be reused for something else afterwards. So a branch's threads fall into
// groups split at the merge times of the same-repo PRs from it, and a thread is shown with the group it was made in
// (by created_at):
//  - the branch's review shows its current group: threads made after the branch's last merge;
//  - a PR from the branch shows its own threads (always), and the group it belongs to: threads made after the branch's
//    last merge before the PR's end (merged_at, else closed_at; an open PR has none), up to its first merge at or
//    after it (the PR's own merge time, for a merged PR). A closed PR, and a new PR later opened from the same branch,
//    so see each other's threads until a merge separates them.
// A comment made on a PR after its merge stays that PR's own: it is about what was merged, not the branch's next line
// of work. A PR from a fork shares nothing: its head branch is another repo's. A branch deleted and made again without a
// merge in between can't be told apart from the old one, and keeps its threads.
// ---------------------------------------------------------------------------

/** Who wrote a comment: the dashboard's own user ('self', id 1, "You") or an agent acting through the API. */
export type PrincipalKind = 'self' | 'agent';

export interface Principal {
  id: number;
  kind: PrincipalKind;
  name: string;
}

/**
 * An agent that writes comments through MCP (GET /agents): a principal of kind 'agent' with a token. The token is shown
 * once, when it is made (desktop: Settings → Agents; headless: the `agents` command), and is stored only as a hash.
 * Revoking it keeps the agent's comments, attributed to it. Its token and the sources it may reach are changed there
 * too, never over HTTP.
 */
export interface Agent {
  /** The principal's id. */
  id: number;
  name: string;
  /** The token's first characters, to tell tokens apart; null once revoked. */
  tokenPrefix: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /**
   * The built-in agent, "Agent": who MCP requests without a token act as while the desktop app doesn't require agent
   * tokens. It has no token (no prefix, nothing to regenerate or revoke), and is listed once it has done something or
   * is limited to some sources.
   */
  builtIn: boolean;
  /**
   * The sources it may reach through MCP, by host (github.com first, then as they were added); null for every source,
   * those added later included. A source deleted since is left out, and never widens it: an agent left with none reaches
   * nothing. Out of reach, a repository reads to the agent as one gh-dash doesn't track, and a thread as one that doesn't
   * exist. The REST API is the user's own, and isn't limited.
   */
  sources: string[] | null;
}

/** What happened to a comment or thread (the comment event log, shown in Activity as type 'comment'). */
export type CommentEventKind = 'thread_opened' | 'replied' | 'edited' | 'comment_deleted' | 'resolved' | 'reopened' | 'thread_deleted';

/** A comment event in the Activity feed. Events outlive their thread and comment: what they were is copied in. */
export interface CommentActivity {
  eventId: number;
  threadId: number;
  /** The comment it is about (its first, for thread_opened); null for resolved, reopened and thread_deleted. */
  commentId: number | null;
  /** False once the thread is deleted. */
  live: boolean;
  /** Who did it (also the event's `actor`, as a name without a login: `isMe` for you, an agent otherwise). */
  by: Principal;
  /**
   * What the thread is on; `title` is the PR's title or the commit's headline, null when not synced (and for a branch,
   * whose name says it).
   */
  target:
    | { kind: 'pr'; number: number; title: string | null }
    | { kind: 'branch'; branch: string; title: null }
    | { kind: 'commit'; oid: string; title: string | null };
  /** The revision the thread was made on. */
  commitOid: string;
  path: string | null;
  side: CommentSide | null;
  startLine: number | null;
  endLine: number | null;
  /**
   * The comment's text for comment events, the thread's first comment for thread events: plain, at most 280 chars.
   * null once that comment or its thread is deleted (and on the delete events): the log keeps what happened, not what
   * deleted comments said.
   */
  excerpt: string | null;
  /**
   * The diff that shows the thread now (ThreadListItem.view), to open the event at: `target`, unless the thread is a
   * branch thread of an earlier line of work, or has left its branch's group since. null once the thread is deleted.
   */
  view: ThreadView | null;
}

/** A branch of a tracked repo, as GET /branches/:repo lists it. */
export interface BranchSummary {
  name: string;
  /** The commit the branch points to. */
  headOid: string;
  /** The head commit's committer date; null when the code host doesn't say. */
  committedAt: string | null;
  /**
   * The newest synced PR from this branch of the same repo, if any: a branch with an open PR is usually reviewed there
   * (its threads are shared: see "Branch groups").
   */
  pr: { number: number; state: PrState; title: string } | null;
}

export interface BranchListResponse {
  /** Newest head commit first; the default branch is left out (it is what branches are compared against). */
  items: BranchSummary[];
  /** The repo's default branch. */
  defaultBranch: string;
  /** The code host has more matching branches than were listed (narrow them with `q`). */
  more: boolean;
}

/** Which side of the diff a line thread is on: the old file (deletions) or the new one (additions). */
export type CommentSide = 'old' | 'new';
export type ThreadStatus = 'open' | 'resolved';
/** PR list filter: PRs with any comment thread, or with at least one unresolved. */
export type CommentFilter = 'any' | 'unresolved';

export interface CommentCounts {
  threads: number;
  /** Threads still open. */
  unresolved: number;
}

/**
 * Where a thread is anchored. Three levels:
 *  - the whole PR or commit: path, side, lines and snippet all null;
 *  - a file: path set, the rest null;
 *  - lines: everything set; startLine..endLine (inclusive, 1-based) on `side`, numbered as in that side's file.
 */
export interface ThreadAnchor {
  /** DiffFile.path of the file (its path on the new side). */
  path: string | null;
  side: CommentSide | null;
  startLine: number | null;
  endLine: number | null;
  /**
   * The anchored lines' text as they were, joined with "\n" (one entry per line, so endLine - startLine + 1
   * lines). Keeps an outdated thread readable once its revision is gone, and relocates it in a later one.
   */
  snippet: string | null;
}

export interface ThreadComment {
  id: number;
  author: Principal;
  /** Markdown. */
  body: string;
  createdAt: string;
  /** Last edit of the body; null when never edited. */
  editedAt: string | null;
}

export interface CommentThread extends ThreadAnchor {
  id: number;
  /**
   * What it was made on: a PR's diff, a branch's (compared against the default branch, before or without a PR), or a
   * commit's.
   */
  kind: 'pr' | 'branch' | 'commit';
  repo: string;
  /** PR number for kind 'pr'; null otherwise. */
  number: number | null;
  /**
   * The branch whose line of work the thread belongs to (see "Branch groups" below): always set for kind 'branch'; for
   * kind 'pr', the PR's head branch when the PR is from a branch of the same repo (null for a PR from a fork, or one made
   * before the sync knew which); null for commits.
   */
  branch: string | null;
  /** The revision the thread was made on: the diff's headOid then (the PR head, the branch head, or the commit itself). */
  commitOid: string;
  /** The diff's baseOid then (merge base, or first parent); null when not given or for a root commit. */
  baseOid: string | null;
  status: ThreadStatus;
  resolvedAt: string | null;
  /** Who resolved it; null while open. Threads resolved before this was recorded (schema v8) read as the dashboard user. */
  resolvedBy: Principal | null;
  createdAt: string;
  /** Last activity: a comment added, edited or deleted, or the status changed. */
  updatedAt: string;
  /** Oldest first; never empty (the first comment opens the thread, and deleting it deletes the thread). */
  comments: ThreadComment[];
}

/** POST /commits/:repo/:oid/threads (and the base of NewPrThread). Anchor fields omitted = null. */
export interface NewThread extends Partial<ThreadAnchor> {
  /** A commit thread is on its commit: optional, and if sent it must be the commit's own oid. */
  commitOid?: string;
  baseOid?: string | null;
  /** The first comment. */
  body: string;
}

/** POST /prs/:repo/:number/threads. */
export interface NewPrThread extends NewThread {
  /** The headOid of the diff the thread is made on. */
  commitOid: string;
}

/** POST /branches/:repo/:branch/threads: as for a PR, `commitOid` is the headOid of the branch diff it is made on. */
export type NewBranchThread = NewPrThread;

export type ThreadStatusFilter = ThreadStatus | 'all';
/** Threads on PRs, on branches, on commits, or all of them. */
export type ThreadKindFilter = 'pr' | 'branch' | 'commit' | 'all';
/** By last activity (`updatedAt`): newest first, or oldest first. */
export type ThreadSort = 'recent' | 'oldest';

/**
 * GET /threads: every thread in scope, across PRs, branches and commits. The scope is source, repos, visibility and
 * ownership (not `who` or the date range: a thread stays open however old it is); `q` matches comment bodies and file
 * paths.
 */
export interface ThreadListQuery extends Pick<ScopeQuery, 'repos' | 'source' | 'visibility' | 'ownership' | 'q'>, PageQuery {
  /** Default 'open'. */
  status?: ThreadStatusFilter;
  /** Default 'all'. */
  kind?: ThreadKindFilter;
  /** Default 'recent'. */
  sort?: ThreadSort;
  /** 'md' returns every matching thread as text/markdown; there is no CSV (400). */
  format?: Exclude<ListFormat, 'csv'>;
  /** Who opened the thread: 'self' (you), 'agents' (any agent), or one agent's principal id. Default: anyone. */
  author?: 'self' | 'agents' | number;
  /** 'you': open threads whose last comment isn't yours (someone is waiting on you). */
  waiting?: 'you';
}

/** Where an agent asks the app to look (MCP `show`): a thread, or a file of a PR's, branch's or commit's diff. */
export interface ShowTarget {
  repo: string;
  /** A PR number, a branch, or a full commit oid: the diff to open. */
  pr?: number;
  branch?: string;
  commit?: string;
  threadId?: number;
  path?: string;
}

/**
 * GET /stream (text/event-stream): what the server tells open windows as it happens. `comments`: a thread changed, so
 * lists, counts and the diff's threads are refetched. `show`: an agent asks the window to open something (a chip,
 * unless the window follows agents). `agents`: an agent was added, given a new token or revoked.
 */
export type StreamMessage =
  | {
      type: 'comments';
      repo: string;
      kind: CommentThread['kind'];
      number: number | null;
      /** The thread's branch (CommentThread.branch): views of that branch, and of PRs from it, list it too. */
      branch: string | null;
      commitOid: string;
      threadId: number;
      event: CommentEventKind;
      by: Principal;
    }
  | { type: 'show'; id: string; agent: Principal; target: ShowTarget; message: string | null; at: string }
  | { type: 'agents' };

/** A thread in GET /threads: the thread, and what it is on. */
export interface ThreadListItem extends CommentThread {
  /**
   * The PR's title or the commit's headline; null when that isn't synced (a thread can outlive its PR's row), and for a
   * branch thread (`branch` names it). A commit the sync doesn't hold takes its headline from a synced PR that lists it
   * (the newest one), else null.
   */
  targetTitle: string | null;
  /** The PR's state; null for a branch or commit thread, or a PR that isn't synced. */
  prState: PrState | null;
  /**
   * The PR or commit on its code host (the synced row's url, else built from the repo's url), or the branch's compare
   * page against the repo's default branch. Never null.
   */
  targetUrl: string;
  /**
   * A PR thread made on an earlier push than the PR's current head (false for branches and commits, whose current head
   * the sync doesn't know, or when the PR's head isn't known).
   */
  earlierPush: boolean;
  /**
   * The diff to open the thread at: its own PR, branch or commit, except a branch thread made no later than a merge of
   * its branch (an earlier line of work), which the merged PR that ended that line of work shows, while the sync holds it.
   */
  view: ThreadView;
}

/**
 * Which diff shows a thread (ThreadListItem.view): the PR, branch or commit to open it at. The branch's review shows only
 * its current group ("Branch groups"), so a branch thread of an earlier line of work is shown by the merged PR that
 * ended it.
 */
export type ThreadView = { kind: 'pr'; number: number } | { kind: 'branch'; branch: string } | { kind: 'commit'; oid: string };

export interface ThreadListResponse extends ListResponse<ThreadListItem> {
  /** Threads per status in the same scope and filters, ignoring `status` (the status control's counts). */
  counts: Record<ThreadStatus, number>;
}

// ---------------------------------------------------------------------------
// Endpoint index (for reference; implemented in server/, consumed in web/src/api)
// ---------------------------------------------------------------------------
//
// GET    /api/health                           -> { ok: true, version: string }
// GET    /api/v1/me                            -> Me         (the github.com account; other sources' accounts: /sources)
// GET    /api/v1/sources                       -> { items: Source[] }   (github.com first; includes sources this server doesn't
//          configure. Never calls a provider. Tokens are never included.)
// GET    /api/v1/sources/:source               -> Source    (:source = the host, any case; 404 when it isn't a source here)
// POST   /api/v1/sources/:source/check         -> Source    (re-resolve and re-validate its token now: github.com 1 GraphQL point, GitLab
//          2 requests. 404 unknown source; 503 when there is no token to check, with the reason as the message and the Source as `details`.)
// DELETE /api/v1/sources/:source               -> 204       (removes the source and all its data, and its cached diffs. 404 unknown source;
//          409 for github.com, and while this server still has the source configured: remove it in Settings (desktop app) or from
//          config.json / GH_DASH_GITLAB_URL first. Nothing adds a source or writes a credential over HTTP.)
// GET    /api/v1/repos          RepoQuery      -> { items: Repo[] }          (unfiltered: all repos incl. archived/hidden/forks)
// GET    /api/v1/repos/:repo                   -> Repo      (:repo = key, URL-encoded: kcosr%2Fgh-dash, gitlab.example.com%2Fgroup%2Fproject;
//          or a github.com repo you own by its short name)
// PATCH  /api/v1/repos/:repo   {pinned?, hidden?} -> Repo
// GET    /api/v1/repo-candidates {refresh?: '1', source?} -> RepoCandidatesResponse   (cached 5 min per source and token)
// GET    /api/v1/repo-lookup   {repo, source?} -> RepoLookup   (400 when `repo` names no repository on the source)
// POST   /api/v1/repos         {repo, source?, includeInDefault?} -> 201 AddRepoResponse
//          400 bad input, or a host that isn't a source here (or isn't configured on this server); 404/403 { details:
//          { problem, hint } }; 409 { details: { key, trackedBy, hidden } } (you own it, or it's tracked already) or a
//          token for another account; 429 rate limited; 503 no token.
//          `source` is a host (default github.com); an address or key on another source's host in `repo` wins.
// DELETE /api/v1/repos/:repo   {source?}      -> 204   (409 for a repo you own; deletes its data from this dashboard;
//          with `source`, :repo may also be the repo's path there, e.g. group%2Fproject)
// GET    /api/v1/sets                          -> { items: RepoSet[] }
// POST   /api/v1/sets          {name, repos}   -> RepoSet
// PATCH  /api/v1/sets/:id      {name?, repos?} -> RepoSet
// DELETE /api/v1/sets/:id                      -> 204
// GET    /api/v1/views                         -> { items: SavedView[] }
// POST   /api/v1/views         {name, path, query} -> SavedView  (repo references in path and query are stored as keys)
// DELETE /api/v1/views/:id                     -> 204
// GET    /api/v1/prs            PrQuery        -> PrListResponse | text/markdown | text/csv   (items carry `comments` counts, as do PRs in activity events)
// GET    /api/v1/prs/:repo/:number             -> PullRequestDetail
// GET    /api/v1/activity       ActivityQuery  -> ActivityResponse | text/markdown | text/csv   (PR and commit events carry `comments` counts)
// GET    /api/v1/commits        ScopeQuery&PageQuery -> ListResponse<Commit>   (items carry `comments` counts of the commit's own threads)
// GET    /api/v1/issues         IssueQuery     -> ListResponse<Issue>
// GET    /api/v1/releases       ScopeQuery&PageQuery -> ListResponse<Release>
// GET    /api/v1/stars          ScopeQuery&PageQuery -> ListResponse<Star>
// GET    /api/v1/stats          StatsQuery     -> StatsResponse
// GET    /api/v1/sync/status                   -> SyncStatus
// POST   /api/v1/sync           {repo?: string, full?: boolean, source?: string} -> 202 SyncStatus (409 if already
//          running, 503 no token, 404 when `repo` is a key nothing tracks or `source` a host that isn't a source here,
//          400 when that source isn't configured on this server). `source` (a host) syncs that source alone; with
//          `repo`, the repo may be given by its path there. Without either, every source with a token.
// GET    /api/v1/prs/:repo/:number/diff  {refresh?: '1'} -> Diff
// GET    /api/v1/commits/:repo/:oid/diff {refresh?: '1'} -> Diff     (oid: 7-64 hex chars; need not be synced)
//          Diffs come from the repo's own source. Diff errors: 404 unknown repo/PR/commit, 503 no token for the source (or a source
//          this server doesn't configure), 429 rate limit, 502 other failure of the code host.
//          refresh=1 re-checks the code host for a PR's current head instead of using the last synced one.
// GET    /api/v1/branches/:repo {q?, refresh?: '1'} -> BranchListResponse   (the code host's branches, newest first, at most
//          100; `q` narrows them by name. Cached for a minute per repo and q unless refresh=1.)
// GET    /api/v1/branches/:repo/:branch/diff {refresh?: '1'} -> Diff   (kind 'branch': :branch, URL-encoded, against the
//          repo's default branch, three-dot. 400 for an invalid name or the default branch itself; 404 unknown repo or a
//          branch the code host doesn't have. refresh=1 asks the code host even when the cached copy looks current.)
// GET    /api/v1/blob/:repo     {ref, path}    -> text/plain file contents at a commit (for expanding diff context);
//          404 missing, 415 binary, 413 too large
// GET    /api/v1/diff-cache                    -> DiffCacheStats
// DELETE /api/v1/diff-cache                    -> DiffCacheStats (after clearing)
// GET    /api/v1/prs/:repo/:number/threads {format?: 'md'} -> { items: CommentThread[] } | text/markdown
// POST   /api/v1/prs/:repo/:number/threads NewPrThread -> CommentThread   (404 unless the PR is synced)
// GET    /api/v1/commits/:repo/:oid/threads {format?: 'md'} -> { items: CommentThread[] } | text/markdown  (oid: full SHA)
// POST   /api/v1/commits/:repo/:oid/threads NewThread -> CommentThread
// GET    /api/v1/branches/:repo/:branch/threads {format?: 'md'} -> { items: CommentThread[] } | text/markdown   (the
//          branch's current group: see "Branch groups". PR threads' lists include their branch's group the same way.)
// POST   /api/v1/branches/:repo/:branch/threads NewBranchThread -> CommentThread   (400 for the default branch; the
//          branch need not exist on the code host any more)
// GET    /api/v1/threads    ThreadListQuery    -> ThreadListResponse | text/markdown   (every thread in scope, across PRs,
//          branches and commits: status open by default, newest activity first; format=md groups them per PR, branch
//          or commit)
// GET    /api/v1/threads/:id                   -> CommentThread
// GET    /api/v1/agents                        -> { items: Agent[] }   (made, revoked and limited to sources only by the
//          desktop app or the headless `agents` command, never over HTTP)
// GET    /api/v1/stream                        -> text/event-stream of StreamMessage (`data: <json>`; a comment line every
//          25 s keeps proxies from closing it)
// POST   /mcp                                  -> MCP over Streamable HTTP (JSON responses), `Authorization: Bearer <agent
//          token>`; the agent's comments are attributed to it. GET /mcp: 405.
// PATCH  /api/v1/threads/:id   {status}        -> CommentThread
// DELETE /api/v1/threads/:id                   -> 204
// POST   /api/v1/threads/:id/comments {body}   -> CommentThread (with the reply)
// PATCH  /api/v1/comments/:id  {body}          -> CommentThread  (own comments only, else 403)
// DELETE /api/v1/comments/:id                  -> { thread: CommentThread | null }  (the first comment takes its thread along: null)
// GET    /api/v1/account                       -> AccountStatus   (github.com's credential; a source's is Source.account)
// POST   /api/v1/account/check                 -> AccountStatus (re-resolve and re-validate the token now)
//          GET /account never calls GitHub (a new token is validated in the background); InstanceInfo.apiUrl is the
//          request's origin on a network listener, the Local API's URL (or null) on the desktop socket.
// GET    /api/v1/instance                      -> InstanceInfo
// GET    /api/v1/settings                      -> Settings
// PATCH  /api/v1/settings       Partial<Settings> -> Settings
// GET    /api/v1/openapi.json                  -> OpenAPI 3.1 document
// GET    /api/docs                             -> human-readable API docs page (no external CDN)
//          /api/health, /api/docs and /api/v1/openapi.json need no auth (they contain no data).
//          Every request must carry an allowed Host (loopback, IP literal, or config allowedHosts), else 421.
//
// Errors: non-2xx responses have JSON body { error: string, details?: unknown }.
