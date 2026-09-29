// The contract between a code host (GitHub today, GitLab next) and the provider-neutral parts of the server: the sync
// engine and the diff service. A source speaks its own API and returns the normalized records of db/records.ts and the
// shared Diff types; everything downstream (database, HTTP API, web app) only ever sees those.
//
// Nothing implements these yet: the GitHub code is moved behind them in later changes (diffs first, then the sync).

import type { Diff, DiffFile } from '../../shared/api';
import type { CommitRecord, IssueRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';

export type ProviderKind = 'github' | 'gitlab';

/** The account a source's token belongs to. */
export interface ViewerInfo {
  /** Provider-stable id (unlike the login, it survives a rename); null if the provider has none. */
  id: string | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
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

/** One page of a section. Cursors are opaque to the caller (GraphQL cursors, REST page numbers, …). */
export interface Page<T> {
  items: T[];
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

export interface SyncSource {
  readonly kind: ProviderKind;
  /** Latest rate-limit reading, if the provider reports one (self-managed GitLab usually doesn't). */
  readonly rateLimit: RateLimitInfo | null;
  viewer(): Promise<ViewerInfo>;
  /** Every repository the viewer owns: what the "my repositories" rule tracks. */
  ownedRepos(): Promise<RepoRecord[]>;
  /**
   * One repository by its provider path (GitHub "owner/name", GitLab "group/subgroup/project"), with its probe; null
   * when it doesn't exist or the token can't see it.
   */
  repo(path: string): Promise<{ record: RepoRecord; probe: RepoProbe } | null>;
  /** Cheap change indicators, keyed by RepoRecord.nodeId. Repos that couldn't be probed are absent. */
  probes(repos: RepoRecord[]): Promise<Map<string, RepoProbe>>;
  /** One page of each requested section of `repo`. GitHub answers them all in one request; others may fan out. */
  round(repo: RepoRecord, req: RoundRequest): Promise<RoundResult>;
  recheck(repo: RepoRecord, prs: number[], issues: number[]): Promise<RecheckResult>;
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
  /** A commit's diff against its first parent. `ref` is a full or abbreviated SHA. */
  commit(repo: DiffRepo, ref: string, signal: AbortSignal): Promise<CommitDiff>;
  /** Raw contents of `path` at a commit, for expanding diff context; files over `maxBytes` aren't read. */
  blob(repo: DiffRepo, sha: string, path: string, maxBytes: number, signal: AbortSignal): Promise<BlobResult>;
}
