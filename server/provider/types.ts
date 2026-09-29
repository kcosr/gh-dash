// The contract between a code host (GitHub, GitLab) and the provider-neutral parts of the server: the sync engine,
// the tracking API behind "Add repository", and the diff service. A source speaks its own API and returns the
// normalized records of db/records.ts and the shared Diff types; everything downstream (database, HTTP API, web app)
// only ever sees those.
//
// Failures are SourceErrors (provider/errors.ts), classified by `kind`: 'auth' and 'rate-limit' stop the source's
// whole sync run (isFatalSourceError), anything else fails the one call. Access problems are AccessFailures
// (provider/access.ts), built by the source in its own words.
//
// Repositories are named to a source by their provider path (RepoRecord.nameWithOwner: GitHub "owner/name", GitLab
// "group/subgroup/project"), never by this app's key, and by node id once tracked.

import type { Diff, DiffFile, ProviderKind } from '../../shared/api';
import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import type { AccessFailure } from './access';

export type { ProviderKind };

/** The account a source's token belongs to. */
export interface ViewerInfo {
  /** Provider-stable id (unlike the login, it survives a rename); null if the provider has none. */
  id: string | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** The viewer with the addresses its commits may carry: "me" on commits that name no account (GitLab's never do). */
export interface ViewerAccount extends ViewerInfo {
  /** Lower-cased. Empty when the provider shows the token none. */
  emails: string[];
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  /** When the budget refills (ISO), if known. */
  resetAt: string | null;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * A repository this app already tracks, as a source is asked about it: by node id, which follows renames and
 * transfers, and by the path it was last stored under, which names it when the provider no longer shows it.
 */
export interface TrackedRepo {
  nodeId: string;
  /** RepoRecord.nameWithOwner as last stored. */
  path: string;
}

/**
 * A tracked repository read by node id.
 * - ok: `record` is what the provider answered. Fields the token may not read are listed in `denied`: their values in
 *   `record` are placeholders, and the sync keeps the stored ones (a denied default branch is not an empty
 *   repository). `problem` says why the read was partial, else null. A partial read has no probe (the sync then
 *   treats every section as changed) and the sync records `problem` as the repo's error for the run.
 * - not ok: the provider returned no repository. The sync marks a repo added by hand unavailable with
 *   `reasonOf(access)`, and one the viewer owns as not found.
 */
export type RepoRead =
  | { ok: true; record: RepoRecord; probe: RepoProbe | null; denied: (keyof RepoRecord)[]; problem: string | null }
  | { ok: false; access: AccessFailure };

/**
 * Tracked repositories re-read by node id. Every node id asked for is either in `reads` or left out by a request that
 * failed; `errors` says why, one line per failed request, which the sync reports as "manual repos: <line>".
 */
export interface RefreshResult {
  reads: Map<string, RepoRead>;
  errors: string[];
}

/**
 * Cheap change indicators, keyed by RepoRecord.nodeId. Repos that couldn't be probed are absent (the sync then treats
 * every section as changed); `errors` says why, one line per failed request, which the sync reports as "probe: <line>".
 */
export interface ProbeResult {
  probes: Map<string, RepoProbe>;
  errors: string[];
}

/** One page of a section. Cursors are opaque to the caller (GraphQL cursors, REST page numbers, …). */
export interface Page<T> {
  items: T[];
  /** When true, `endCursor` is set: the next page's cursor. */
  hasMore: boolean;
  endCursor: string | null;
}

/**
 * The sections of a repo the sync pages through, each with the cursor to continue from (null: first page).
 * Orders matter: the sync's stop conditions rely on them.
 */
export interface RoundRequest {
  /** Default-branch history committed since `since`, newest first. */
  commits?: { after: string | null; since: string };
  /** Every PR, most recently updated first. */
  prs?: { after: string | null };
  /** Every issue (not PRs), most recently updated first. */
  issues?: { after: string | null };
  /** Open PRs only, newest first. */
  openPrs?: { after: string | null };
  /** Open issues only, newest first. */
  openIssues?: { after: string | null };
  /** Releases, newest first. Drafts/unpublished releases are left out of `items`. */
  releases?: { after: string | null };
  /** Stargazers, most recent first. */
  stars?: { after: string | null };
}

/** One page of each section that was requested; sections that weren't requested are absent. */
export interface RoundResult {
  commits?: Page<CommitRecord>;
  prs?: Page<PrRecord>;
  issues?: Page<IssueRecord>;
  openPrs?: Page<PrRecord>;
  openIssues?: Page<IssueRecord>;
  /** `oldestCreatedAt`: creation time of the page's oldest release, drafts included (the backfill window stops paging). */
  releases?: Page<ReleaseRecord> & { oldestCreatedAt: string | null };
  /** `totalCount`: the provider's stargazer count, to detect unstars. */
  stars?: Page<StarRecord> & { totalCount: number };
}

/** PRs and issues re-read by number: null when it no longer exists in this repo (deleted or transferred). */
export interface RecheckResult {
  prs: Map<number, PrRecord | null>;
  issues: Map<number, IssueRecord | null>;
}

/** A repository the Add dialog offers: what its list shows, and the node id to compare with what is tracked. */
export type RepoCandidateRecord = Pick<
  RepoRecord,
  'nodeId' | 'name' | 'nameWithOwner' | 'owner' | 'description' | 'visibility' | 'isArchived' | 'isFork' | 'stars' | 'pushedAt'
>;

export interface RepoCandidates {
  /** The account the lists belong to: the tracking API checks it against the source's claimed viewer. */
  viewer: ViewerInfo;
  /**
   * Repositories of others the token can read (as a collaborator, organization or group member), most recently active
   * first. The viewer's own are left out: they're tracked automatically.
   */
  items: RepoCandidateRecord[];
  /** A few of them (or others) the viewer was recently active in, as suggestions; the caller drops tracked ones. */
  suggested: RepoCandidateRecord[];
  /** More exist than `items` lists. */
  truncated: boolean;
}

/**
 * The size of a repository's first sync: items since the backfill start, and the open ones (listed whatever their age).
 * null where the provider can't count cheaply (GitLab commits); the UI shows "size unknown".
 */
export interface BackfillCounts {
  commits: number | null;
  prs: number | null;
  issues: number | null;
  /** All releases, not only recent ones. */
  releases: number;
  openPrs: number;
  openIssues: number;
}

/**
 * Whether the token can read a repository, looked up by path for the Add dialog.
 * - ok: its record and probe (what adding it stores), whether the viewer owns it (then it's tracked automatically and
 *   can't be added by hand), and the size of its first sync.
 * - not ok: why not. `path` is the provider's spelling when it showed the repository, else the path asked for.
 * Both carry the viewer, which the tracking API checks before answering.
 */
export type LookupRecord =
  | { ok: true; viewer: ViewerInfo; record: RepoRecord; probe: RepoProbe; owned: boolean; counts: BackfillCounts }
  | { ok: false; viewer: ViewerInfo; path: string; access: AccessFailure };

export interface SyncSource {
  readonly kind: ProviderKind;
  /** Latest rate-limit reading, if the provider reports one (self-managed GitLab usually doesn't). */
  readonly rateLimit: RateLimitInfo | null;
  /** Requests made so far, for the run log. */
  readonly requests: number;
  /** GraphQL points spent so far (GitHub); null for providers without a point budget. */
  readonly points: number | null;
  /**
   * Whether RepoProbe.latestStarredAt is filled (GitHub). When not (GitLab: always null), the sync plans an
   * incremental stars pass whenever the repo's star count moved since the last one.
   */
  readonly probesStars: boolean;
  /**
   * Whether CommitRecord.prNumber is filled (GitHub). When not (GitLab: always null), the sync links commits to merged
   * PRs itself, from PrRecord.mergeCommitOid / squashCommitOid and the PRs' commits.
   */
  readonly linksCommits: boolean;

  /** The token's account, with its commit email addresses. */
  viewer(): Promise<ViewerAccount>;
  /**
   * Every repository the viewer owns (what the "my repositories" rule tracks), with the viewer the list belongs to.
   * A source that reads the viewer with each page fails with 'auth' if it changes mid-list.
   */
  ownedRepos(): Promise<{ viewer: ViewerInfo; repos: RepoRecord[] }>;
  /** Repositories added by hand, re-read by node id in as few requests as the provider allows. Nothing asked, nothing spent. */
  refresh(repos: TrackedRepo[]): Promise<RefreshResult>;
  /** One tracked repository by node id, for a single-repo sync, with the viewer to claim before writing. */
  repoByNode(repo: TrackedRepo): Promise<{ viewer: ViewerInfo; read: RepoRead }>;
  /**
   * One of the viewer's repositories that isn't tracked yet (say, just created), with its probe, for a single-repo
   * sync; `found` is null when there is none. GitHub takes the repo's short name; GitLab a full path. The viewer comes
   * with it, found or not, to claim before writing.
   */
  repo(path: string): Promise<{ viewer: ViewerInfo; found: { record: RepoRecord; probe: RepoProbe } | null }>;
  /** Probes for `repos`; see ProbeResult. Nothing asked, nothing spent. */
  probes(repos: RepoRecord[]): Promise<ProbeResult>;
  /**
   * One page of each requested section of `repo`. GitHub answers them all in one request; others may fan out. A
   * repository that can no longer be read at all rejects with a SourceError whose `access` says why.
   */
  round(repo: RepoRecord, req: RoundRequest): Promise<RoundResult>;
  /**
   * Re-reads PRs and issues by number; the maps have exactly the numbers asked for. A repository that is gone rejects
   * rather than reporting everything deleted. Nothing asked, nothing spent.
   */
  recheck(repo: RepoRecord, prs: number[], issues: number[]): Promise<RecheckResult>;
  /** What the Add dialog offers; see RepoCandidates. The tracking API caches it per token. */
  candidates(): Promise<RepoCandidates>;
  /** Looks a repository up by provider path, counting its first sync from `since` (ISO); see LookupRecord. */
  lookup(path: string, since: string): Promise<LookupRecord>;
  /** About how many requests a first sync of that size costs; null when it can't be told (say, a count is unknown). */
  requestsFor(counts: BackfillCounts): number | null;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/** The repository a diff request is for. */
export interface DiffRepo {
  /** The repo's key in this app's API (what Diff.repo carries). */
  key: string;
  owner: string;
  name: string;
  /** Provider path: GitHub "owner/name", GitLab "group/subgroup/project". */
  path: string;
}

/** Where a PR stands: what its diff is computed between, plus its own fields that the diff header shows. */
export interface PrRevision {
  /** Full SHAs here and below: 40 hex characters, or 64 in a SHA-256 repository. */
  headOid: string;
  /** Target branch name. */
  baseRef: string;
  /** The merge base: the diff's left side (three-dot, like the host's "Files changed" / "Changes"). */
  baseOid: string;
  title: string;
  totalFiles: number;
  additions: number;
  deletions: number;
  /** The host's web page for the PR's changes. */
  url: string;
  /** Source-private state carried from prRevision to prFiles (GitHub: the PR's ETag). */
  readonly handle?: unknown;
}

export type BlobResult = { kind: 'file'; bytes: Uint8Array } | { kind: 'not-file' } | { kind: 'too-large' };

/** A commit's diff as a source produces it; the diff service adds the fields it owns. */
export type CommitDiff = Omit<Diff, 'kind' | 'repo' | 'number' | 'fetchedAt'>;

/**
 * Fetches diffs and file contents on demand. Failures are SourceErrors (a missing PR/commit/file is 'not-found').
 * Caching, revalidation, request deduplication and the mapping to HTTP errors belong to the diff service.
 */
export interface DiffSource {
  readonly kind: ProviderKind;
  /** Requests made so far, for logging what a build cost. */
  readonly requests: number;
  readonly rateLimit: RateLimitInfo | null;
  /** How to fix an authentication failure, appended to the error the API returns. */
  readonly authHint: string;
  /** Most files a PR or commit diff lists; totalFiles reports the real count beyond it. */
  readonly maxFiles: number;
  /** Whether the PR's head is still `knownHead`, if the source can tell cheaply (GitHub: a free 304); null if not. */
  prHeadIs(repo: DiffRepo, number: number, knownHead: string, signal: AbortSignal): Promise<boolean | null>;
  /** The PR's current revision, without its files. */
  prRevision(repo: DiffRepo, number: number, signal: AbortSignal): Promise<PrRevision>;
  /**
   * The PR's files as one consistent snapshot, starting from `rev`. Returns the revision the files belong to, which is
   * newer than `rev` when the PR moved and the source started over. A PR that keeps moving fails as 'transient'.
   */
  prFiles(repo: DiffRepo, number: number, rev: PrRevision, signal: AbortSignal): Promise<{ rev: PrRevision; files: DiffFile[] }>;
  /** A commit's diff against its first parent. `ref` is a full (40 or 64 hex characters) or abbreviated SHA. */
  commit(repo: DiffRepo, ref: string, signal: AbortSignal): Promise<CommitDiff>;
  /** Raw contents of `path` at a commit, for expanding diff context; files over `maxBytes` aren't read. */
  blob(repo: DiffRepo, sha: string, path: string, maxBytes: number, signal: AbortSignal): Promise<BlobResult>;
}
