import type { IssueState, Label, PrState, Visibility } from '../../shared/api';

/** Normalized rows produced by the GitHub mappers and written by db/write.ts. */

export interface ActorRecord {
  login: string | null;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface RepoRecord {
  nodeId: string;
  name: string;
  nameWithOwner: string;
  owner: string;
  description: string | null;
  url: string;
  visibility: Visibility;
  isArchived: boolean;
  isFork: boolean;
  languageName: string | null;
  languageColor: string | null;
  topics: string[];
  defaultBranch: string | null;
  stars: number;
  forks: number;
  createdAt: string;
  pushedAt: string | null;
  /**
   * The default branch's head commit, when the source reads it with the record (GitLab): the sync then plans the commit
   * walk by it, since a push can move the head without moving its commit's time. null = the source reads it but found
   * none (an empty or unreadable repository); absent = the source doesn't read it (GitHub, whose pushedAt moves with
   * every push). Not stored with the repo: the sync keeps it as sync_state.commits_head.
   */
  headOid?: string | null;
}

/** Cheap change indicators fetched with the repo list, used to decide what to sync. */
export interface RepoProbe {
  openPrs: number;
  openIssues: number;
  latestPrUpdatedAt: string | null;
  latestIssueUpdatedAt: string | null;
  releaseTags: string[];
  latestStarredAt: string | null;
}

export interface PrCommitRecord {
  oid: string;
  headline: string;
  committedAt: string;
  url: string;
  author: ActorRecord;
}

export interface ClosingIssueRecord {
  number: number;
  title: string;
  state: IssueState;
  url: string;
}

export interface PrRecord {
  number: number;
  title: string;
  body: string;
  state: PrState;
  isDraft: boolean;
  author: ActorRecord | null;
  mergedBy: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  activityAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  headRef: string;
  /** Head commit; keys the diff cache. Internal: not part of the API's PullRequest. */
  headOid: string;
  baseRef: string;
  labels: Label[];
  closingIssues: ClosingIssueRecord[];
  url: string;
  commits: PrCommitRecord[];
  /**
   * What a merge put on the target branch: the merge commit, and the squashed commit when the PR was squashed. Null when
   * not merged, or when the provider doesn't say (GitHub, whose commits carry their PR number). A source that doesn't
   * link commits (SyncSource.linksCommits false) fills them, and the sync links commits to PRs from them.
   */
  mergeCommitOid: string | null;
  squashCommitOid: string | null;
}

export interface CommitRecord {
  oid: string;
  headline: string;
  body: string;
  author: ActorRecord;
  committedAt: string;
  url: string;
  additions: number;
  deletions: number;
  prNumber: number | null;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author: ActorRecord | null;
  closedBy: ActorRecord | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  activityAt: string;
  labels: Label[];
  url: string;
}

export interface ReleaseRecord {
  tag: string;
  name: string | null;
  body: string;
  author: ActorRecord | null;
  publishedAt: string;
  isPrerelease: boolean;
  url: string;
}

export interface StarRecord {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  starredAt: string;
}
