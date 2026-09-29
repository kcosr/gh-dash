import type {
  ActorRecord,
  CommitRecord,
  IssueRecord,
  PrRecord,
  ReleaseRecord,
  RepoProbe,
  RepoRecord,
  StarRecord,
} from '../db/records';
import type {
  GqlActor,
  GqlCommit,
  GqlGitActor,
  GqlIssue,
  GqlLabels,
  GqlProbe,
  GqlPullRequest,
  GqlRelease,
  GqlRepo,
  GqlStarEdge,
} from './types';

function mapActor(a: GqlActor | null | undefined): ActorRecord | null {
  if (!a) return null;
  return { login: a.login, name: a.name ?? null, email: null, avatarUrl: a.avatarUrl ?? null };
}

function mapGitActor(a: GqlGitActor | null | undefined): ActorRecord {
  return {
    login: a?.user?.login ?? null,
    name: a?.user?.name || a?.name || null,
    email: a?.email ? a.email.toLowerCase() : null,
    avatarUrl: a?.avatarUrl ?? null,
  };
}

function mapLabels(l: GqlLabels | null | undefined) {
  return (l?.nodes ?? []).map((n) => ({ name: n.name, color: n.color }));
}

export function mapRepo(r: GqlRepo): RepoRecord {
  return {
    nodeId: r.id,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    owner: r.owner.login,
    description: r.description || null,
    url: r.url,
    visibility: r.visibility === 'PUBLIC' ? 'public' : r.visibility === 'INTERNAL' ? 'internal' : 'private',
    isArchived: r.isArchived,
    isFork: r.isFork,
    languageName: r.primaryLanguage?.name ?? null,
    languageColor: r.primaryLanguage?.color ?? null,
    topics: r.repositoryTopics?.nodes.map((n) => n.topic.name) ?? [],
    defaultBranch: r.defaultBranchRef?.name ?? null,
    stars: r.stargazerCount,
    forks: r.forkCount,
    createdAt: r.createdAt,
    pushedAt: r.pushedAt,
  };
}

export function mapProbe(p: GqlProbe): RepoProbe {
  return {
    openPrs: p.openPrs.totalCount,
    openIssues: p.openIssues.totalCount,
    latestPrUpdatedAt: p.latestPr.nodes[0]?.updatedAt ?? null,
    latestIssueUpdatedAt: p.latestIssue.nodes[0]?.updatedAt ?? null,
    releaseTags: p.latestReleases.nodes.filter((n) => !n.isDraft).map((n) => n.tagName),
    latestStarredAt: p.latestStar.edges[0]?.starredAt ?? null,
  };
}

export function mapPullRequest(p: GqlPullRequest): PrRecord {
  const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : 'open';
  const activityAt = state === 'merged' ? p.mergedAt! : state === 'closed' ? (p.closedAt ?? p.updatedAt) : p.createdAt;
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    state,
    isDraft: p.isDraft,
    author: mapActor(p.author),
    mergedBy: p.mergedBy?.login ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    mergedAt: p.mergedAt,
    closedAt: p.closedAt,
    activityAt,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    commitCount: p.commits.totalCount,
    headRef: p.headRefName,
    headOid: p.headRefOid,
    baseRef: p.baseRefName,
    labels: mapLabels(p.labels),
    closingIssues: (p.closingIssuesReferences?.nodes ?? []).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state === 'OPEN' ? 'open' : 'closed',
      url: i.url,
    })),
    url: p.url,
    commits: p.commits.nodes.map(({ commit: c }) => ({
      oid: c.oid,
      headline: c.messageHeadline,
      committedAt: c.committedDate,
      url: c.url,
      author: mapGitActor(c.author),
    })),
  };
}

/** `nameWithOwner` of the repo being synced; PRs from other repos (e.g. a fork's upstream) are ignored. */
export function mapCommit(c: GqlCommit, nameWithOwner: string): CommitRecord {
  const pr = c.associatedPullRequests?.nodes.find((n) => n.repository.nameWithOwner === nameWithOwner);
  return {
    oid: c.oid,
    headline: c.messageHeadline,
    body: c.messageBody ?? '',
    author: mapGitActor(c.author),
    committedAt: c.committedDate,
    url: c.url,
    additions: c.additions,
    deletions: c.deletions,
    prNumber: pr?.number ?? null,
  };
}

export function mapIssue(i: GqlIssue): IssueRecord {
  const state = i.state === 'OPEN' ? 'open' : 'closed';
  const closer = i.timelineItems?.nodes.at(-1)?.actor;
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state,
    author: mapActor(i.author),
    closedBy: state === 'closed' ? mapActor(closer) : null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    closedAt: i.closedAt,
    activityAt: state === 'closed' ? (i.closedAt ?? i.updatedAt) : i.createdAt,
    labels: mapLabels(i.labels),
    url: i.url,
  };
}

/** Drafts (and anything unpublished) map to null. */
export function mapRelease(r: GqlRelease): ReleaseRecord | null {
  if (r.isDraft || !r.publishedAt) return null;
  return {
    tag: r.tagName,
    name: r.name || null,
    body: r.description ?? '',
    author: r.author ? { login: r.author.login, name: r.author.name, email: null, avatarUrl: r.author.avatarUrl } : null,
    publishedAt: r.publishedAt,
    isPrerelease: r.isPrerelease,
    url: r.url,
  };
}

export function mapStar(e: GqlStarEdge): StarRecord {
  return { login: e.node.login, name: e.node.name || null, avatarUrl: e.node.avatarUrl, starredAt: e.starredAt };
}
