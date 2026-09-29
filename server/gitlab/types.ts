/**
 * Shapes of GitLab's responses: GraphQL for the documents in queries.ts, REST for the endpoints the sources call (only
 * the fields used). Nullability follows GitLab's schema, where most fields and every connection are nullable.
 */

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<T> {
  pageInfo: GqlPageInfo;
  nodes: T[];
}

/** UserCore. `avatarUrl` is a path on the instance for uploaded avatars (absolute only for Gravatar). */
export interface GqlUser {
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GqlViewer extends GqlUser {
  /** Global id, "gid://gitlab/User/N". */
  id: string;
}

/** The viewer with the addresses its commits may carry (each nullable: hidden, or not set). */
export interface GqlViewerAccount extends GqlViewer {
  publicEmail: string | null;
  /** The address new commits are made with: a private noreply one for accounts that hide their email. */
  commitEmail: string | null;
  emails: { nodes: { email: string }[] } | null;
}

export interface GqlLabels {
  /** `color` is "#rrggbb". */
  nodes: { title: string; color: string }[];
}

export interface GqlProject {
  /** Global id, "gid://gitlab/Project/N". */
  id: string;
  /** Last segment of the full path. */
  path: string;
  fullPath: string;
  namespace: { fullPath: string } | null;
  description: string | null;
  webUrl: string | null;
  visibility: 'public' | 'internal' | 'private' | null;
  /** True when the project or any of its ancestor groups is archived. */
  archived: boolean | null;
  isForked: boolean;
  starCount: number;
  forksCount: number;
  createdAt: string | null;
  lastActivityAt: string | null;
  topics: string[] | null;
  /** Ordered by share, largest first; empty until GitLab has detected them. */
  languages: { name: string; color: string | null }[] | null;
  repository: {
    rootRef: string | null;
    /** The default branch's tree; its lastCommit is the branch head. */
    tree: { lastCommit: { sha: string; committedDate: string | null } | null } | null;
  } | null;
}

export interface GqlProbe {
  id: string;
  openMergeRequests: { count: number } | null;
  /** Merge requests being merged: open, as far as the sync is concerned (mapMergeRequest). */
  lockedMergeRequests: { count: number } | null;
  openIssues: { count: number } | null;
  latestMergeRequest: { nodes: { updatedAt: string }[] } | null;
  latestIssue: { nodes: { updatedAt: string }[] } | null;
  latestReleases: { nodes: { tagName: string | null; upcomingRelease: boolean | null }[] } | null;
}

export interface GqlCommit {
  sha: string;
  /** The whole first line (`title` truncates long ones). */
  fullTitle: string | null;
  committedDate: string | null;
  webUrl: string;
  authorName: string | null;
  authorEmail: string | null;
  /** The GitLab user with the author's email, if any. */
  author: GqlUser | null;
}

export interface GqlWorkItem {
  iid: string;
  title: string;
  state: 'OPEN' | 'CLOSED';
  webUrl: string | null;
}

export interface GqlMergeRequest {
  /** Numeric, but a String in GitLab's schema. */
  iid: string;
  title: string;
  description: string | null;
  /** 'locked' is a transient state while GitLab merges. */
  state: 'opened' | 'closed' | 'locked' | 'merged';
  draft: boolean;
  webUrl: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  /** When it was last closed; null for merged ones. */
  closedAt: string | null;
  sourceBranch: string;
  targetBranch: string;
  diffHeadSha: string | null;
  commitCount: number | null;
  author: GqlUser | null;
  /** Who merged it, or who set it to auto-merge while it's open. */
  mergeUser: { username: string } | null;
  diffStatsSummary: { additions: number; deletions: number; fileCount: number } | null;
  /** The merge commit on the target branch, and the squash commit; set once merged (a fast-forward merge has no merge commit). */
  mergeCommitSha: string | null;
  squashCommitSha: string | null;
  labels: GqlLabels | null;
  commits: { nodes: GqlCommit[] } | null;
  /** null while GitLab's explicit_mr_work_item_relations feature flag is off (the 19.3 default). */
  workItemRelations: { nodes: { workItem: GqlWorkItem | null }[] } | null;
}

export interface GqlRelease {
  tagName: string | null;
  name: string | null;
  description: string | null;
  releasedAt: string | null;
  createdAt: string | null;
  /** Its release date is still in the future. */
  upcomingRelease: boolean | null;
  author: GqlUser | null;
  links: { selfUrl: string | null } | null;
}

/** What the Add dialog's lookup adds to a project: what the token may read, and the counts sizing its first sync. */
export interface GqlLookup {
  /** Null while GitLab shows the token no permissions. */
  userPermissions: { downloadCode: boolean | null; readMergeRequest: boolean | null } | null;
  /** False when the feature is turned off or the token's role can't read issues. */
  issuesEnabled: boolean | null;
  recentMergeRequests: { count: number } | null;
  recentIssues: { count: number } | null;
  releaseCount: { count: number } | null;
}

export interface ViewerData {
  currentUser: GqlViewer | null;
}

export interface ViewerAccountData {
  currentUser: GqlViewerAccount | null;
}

/** The viewer rides along with the list, so the sync can claim it without a request of its own. */
export interface OwnedProjectsData {
  currentUser: GqlViewer | null;
  projects: Connection<GqlProject>;
}

export interface ProjectData {
  currentUser: GqlViewer | null;
  project: (GqlProject & GqlProbe) | null;
}

/** Projects by global id; ones the token can't see (or that are gone) are simply not listed. */
export interface ManualProjectsData {
  projects: { nodes: (GqlProject & GqlProbe)[] };
}

export interface ProjectByNodeData {
  currentUser: GqlViewer | null;
  projects: { nodes: (GqlProject & GqlProbe)[] };
}

export interface ProjectLookupData {
  currentUser: GqlViewer | null;
  project: (GqlProject & GqlProbe & GqlLookup) | null;
}

export interface ProbesData {
  projects: { nodes: GqlProbe[] };
}

export interface MergeRequestsData {
  project: { mergeRequests: Connection<GqlMergeRequest> | null } | null;
}

export interface ReleasesData {
  project: { releases: Connection<GqlRelease> | null } | null;
}

export interface MrRevisionData {
  project: {
    mergeRequest: {
      title: string;
      webUrl: string | null;
      targetBranch: string;
      /** `baseSha` (the merge base) is null when the branches share no history. */
      diffRefs: { baseSha: string | null; headSha: string; startSha: string } | null;
      diffStatsSummary: { additions: number; deletions: number; fileCount: number } | null;
    } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// REST (v4)
// ---------------------------------------------------------------------------

export interface RestUser {
  username: string;
  name: string | null;
  avatar_url: string | null;
}

/** A project of `GET /projects` (the full entity: the simple one has no visibility). */
export interface RestProject {
  id: number;
  path: string;
  path_with_namespace: string;
  description: string | null;
  visibility: 'public' | 'internal' | 'private';
  archived?: boolean;
  /** Present for a fork whose upstream the token can see. */
  forked_from_project?: { id: number } | null;
  star_count: number;
  last_activity_at: string | null;
  /** `kind` is 'user' for a personal namespace (its full_path is the username). */
  namespace: { kind: 'user' | 'group'; full_path: string };
}

export interface RestIssue {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: RestUser | null;
  author: RestUser | null;
  /** Objects with with_labels_details=true; `color` is "#rrggbb". */
  labels: { name: string; color: string }[];
  web_url: string;
}

export interface RestCommit {
  id: string;
  title: string;
  message: string | null;
  author_name: string | null;
  author_email: string | null;
  /** With the committer's UTC offset, not in UTC. */
  committed_date: string;
  web_url: string;
  parent_ids: string[];
  stats?: { additions: number; deletions: number; total: number };
}

export interface RestStarrer {
  starred_since: string;
  user: RestUser;
}

/** One diff version of a merge request: GitLab adds one per push (and when the target branch moves), never changes it. */
export interface RestVersion {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string | null;
  start_commit_sha: string;
}

/** A file of a diff. GitLab gives no per-file line counts. */
export interface RestDiff {
  diff: string;
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  /** Over the instance's diff limits: `diff` is empty. */
  collapsed?: boolean;
  too_large?: boolean;
}

export interface RestVersionFull extends RestVersion {
  diffs: RestDiff[];
}

export interface RestTokenInfo {
  id: number;
  name: string;
  revoked: boolean;
  active: boolean;
  scopes: string[];
  user_id: number;
  created_at: string;
  last_used_at: string | null;
  /** A date ("2026-12-31"); null for a token that never expires. */
  expires_at: string | null;
}
