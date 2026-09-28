/** Shapes of the GraphQL responses for the documents in queries.ts. */

export interface GqlRateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
  cost: number;
}

export interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GqlActor {
  login: string;
  avatarUrl: string | null;
  name?: string | null;
}

export interface GqlGitActor {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  user: { login: string; name: string | null } | null;
}

export interface GqlLabels {
  nodes: { name: string; color: string }[];
}

export interface GqlViewer {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GqlRepo {
  id: string;
  name: string;
  nameWithOwner: string;
  owner: { login: string };
  description: string | null;
  url: string;
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  isArchived: boolean;
  isFork: boolean;
  primaryLanguage: { name: string; color: string | null } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  defaultBranchRef: { name: string } | null;
  stargazerCount: number;
  forkCount: number;
  createdAt: string;
  pushedAt: string | null;
}

export interface GqlProbe {
  id: string;
  openPrs: { totalCount: number };
  openIssues: { totalCount: number };
  latestPr: { nodes: { updatedAt: string }[] };
  latestIssue: { nodes: { updatedAt: string }[] };
  latestReleases: { nodes: { tagName: string; isDraft: boolean }[] };
  latestStar: { edges: { starredAt: string }[] };
}

export interface ViewerReposData {
  viewer: GqlViewer & { repositories: { pageInfo: GqlPageInfo; nodes: GqlRepo[] } };
  rateLimit: GqlRateLimit;
}

export interface RepoProbesData {
  nodes: (GqlProbe | null)[];
  rateLimit: GqlRateLimit;
}

export interface ViewerRepoData {
  viewer: GqlViewer & { repository: (GqlRepo & GqlProbe) | null };
  rateLimit: GqlRateLimit;
}

export interface ViewerData {
  viewer: GqlViewer;
  rateLimit: GqlRateLimit;
}

export interface GqlCommit {
  oid: string;
  messageHeadline: string;
  messageBody: string;
  committedDate: string;
  url: string;
  additions: number;
  deletions: number;
  author: GqlGitActor | null;
  associatedPullRequests: { nodes: { number: number; repository: { nameWithOwner: string } }[] } | null;
}

export interface GqlPullRequest {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  author: GqlActor | null;
  mergedBy: { login: string } | null;
  labels: GqlLabels | null;
  closingIssuesReferences: { nodes: { number: number; title: string; state: 'OPEN' | 'CLOSED'; url: string }[] } | null;
  commits: {
    totalCount: number;
    nodes: {
      commit: { oid: string; messageHeadline: string; committedDate: string; url: string; author: GqlGitActor | null };
    }[];
  };
}

export interface GqlIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: GqlActor | null;
  labels: GqlLabels | null;
  timelineItems: { nodes: ({ actor?: GqlActor | null } | null)[] } | null;
}

export interface GqlRelease {
  tagName: string;
  name: string | null;
  description: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string | null;
  createdAt: string;
  url: string;
  author: { login: string; name: string | null; avatarUrl: string | null } | null;
}

export interface GqlStarEdge {
  starredAt: string;
  node: { login: string; name: string | null; avatarUrl: string | null };
}

export interface Connection<T> {
  pageInfo: GqlPageInfo;
  nodes: T[];
}

export interface RepoDetailData {
  repository: {
    nameWithOwner: string;
    defaultBranchRef?: { name: string; target: { history?: Connection<GqlCommit> } | null } | null;
    pullRequests?: Connection<GqlPullRequest>;
    issues?: Connection<GqlIssue>;
    openPrs?: Connection<GqlPullRequest>;
    openIssues?: Connection<GqlIssue>;
    releases?: Connection<GqlRelease>;
    stargazers?: { totalCount: number; pageInfo: GqlPageInfo; edges: GqlStarEdge[] };
  } | null;
  rateLimit: GqlRateLimit;
}

type InRepo<T> = T & { repository: { nameWithOwner: string } };

/** Response of recheckQuery(): `pr<N>` / `issue<N>` aliases, null when the item no longer exists. */
export interface RecheckData {
  repository: Record<string, InRepo<GqlPullRequest> | InRepo<GqlIssue> | null> | null;
  rateLimit: GqlRateLimit;
}
