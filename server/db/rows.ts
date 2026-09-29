import type { Actor, Commit, Issue, Label, PullRequest, PullRequestDetail, Release, Star } from '../../shared/api';
import type { ClosingIssueRecord } from './records';
import type { IsMe } from './filters';

/** Row shapes as selected by the list queries (entity columns plus the joined repo name). */

export interface PrRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: PullRequest['state'];
  is_draft: number;
  author_login: string | null;
  author_name: string | null;
  author_avatar: string | null;
  merged_by: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  activity_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commit_count: number;
  head_ref: string;
  base_ref: string;
  labels: string;
  closing_issues: string;
  url: string;
  /** Local comment threads, where the query counts them (PR lists and details, not activity events). */
  threads?: number;
  unresolved_threads?: number;
}

export interface CommitRow {
  id: number;
  repo: string;
  oid: string;
  headline: string;
  body: string;
  author_login: string | null;
  author_name: string | null;
  author_email: string | null;
  author_avatar: string | null;
  committed_at: string;
  url: string;
  additions: number;
  deletions: number;
  pr_number: number | null;
}

export interface IssueRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: Issue['state'];
  author_login: string | null;
  author_name: string | null;
  author_avatar: string | null;
  closed_by_login: string | null;
  closed_by_name: string | null;
  closed_by_avatar: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  activity_at: string;
  labels: string;
  url: string;
}

export interface ReleaseRow {
  id: number;
  repo: string;
  tag: string;
  name: string | null;
  body: string;
  author_login: string | null;
  author_name: string | null;
  author_avatar: string | null;
  published_at: string;
  is_prerelease: number;
  url: string;
}

export interface StarRow {
  id: number;
  repo: string;
  login: string;
  name: string | null;
  avatar: string | null;
  starred_at: string;
}

export interface PrCommitRow {
  oid: string;
  headline: string;
  committed_at: string;
  url: string;
  author_login: string | null;
  author_name: string | null;
  author_email: string | null;
  author_avatar: string | null;
}

function toActor(isMe: IsMe, login: string | null, name: string | null, avatarUrl: string | null, email?: string | null): Actor {
  return { login, name, avatarUrl, isMe: isMe(login, email) };
}

function optionalActor(isMe: IsMe, login: string | null, name: string | null, avatarUrl: string | null): Actor | null {
  return login === null ? null : toActor(isMe, login, name, avatarUrl);
}

export function toPr(r: PrRow, isMe: IsMe): PullRequest {
  return {
    id: `${r.repo}#${r.number}`,
    repo: r.repo,
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    isDraft: !!r.is_draft,
    author: toActor(isMe, r.author_login, r.author_name, r.author_avatar),
    mergedBy: r.merged_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mergedAt: r.merged_at,
    closedAt: r.closed_at,
    activityAt: r.activity_at,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changed_files,
    commitCount: r.commit_count,
    headRef: r.head_ref,
    baseRef: r.base_ref,
    labels: JSON.parse(r.labels) as Label[],
    url: r.url,
    ...(r.threads === undefined ? {} : { comments: { threads: r.threads, unresolved: r.unresolved_threads ?? 0 } }),
  };
}

export function toPrDetail(r: PrRow, commits: PrCommitRow[], isMe: IsMe): PullRequestDetail {
  return {
    ...toPr(r, isMe),
    commits: commits.map((c) => ({
      oid: c.oid,
      headline: c.headline,
      committedAt: c.committed_at,
      url: c.url,
      author: toActor(isMe, c.author_login, c.author_name, c.author_avatar, c.author_email),
    })),
    closingIssues: JSON.parse(r.closing_issues) as ClosingIssueRecord[],
  };
}

export function toCommit(r: CommitRow, isMe: IsMe): Commit {
  return {
    oid: r.oid,
    shortOid: r.oid.slice(0, 7),
    repo: r.repo,
    headline: r.headline,
    body: r.body,
    author: toActor(isMe, r.author_login, r.author_name, r.author_avatar, r.author_email),
    committedAt: r.committed_at,
    url: r.url,
    additions: r.additions,
    deletions: r.deletions,
    prNumber: r.pr_number,
  };
}

export function toIssue(r: IssueRow, isMe: IsMe): Issue {
  return {
    id: `${r.repo}#${r.number}`,
    repo: r.repo,
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    author: toActor(isMe, r.author_login, r.author_name, r.author_avatar),
    closedBy: optionalActor(isMe, r.closed_by_login, r.closed_by_name, r.closed_by_avatar),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    labels: JSON.parse(r.labels) as Label[],
    url: r.url,
  };
}

export function toRelease(r: ReleaseRow, isMe: IsMe): Release {
  return {
    id: `${r.repo}@${r.tag}`,
    repo: r.repo,
    tag: r.tag,
    name: r.name,
    body: r.body,
    author: optionalActor(isMe, r.author_login, r.author_name, r.author_avatar),
    publishedAt: r.published_at,
    isPrerelease: !!r.is_prerelease,
    url: r.url,
  };
}

/** Stars are always by others (`who=me` never matches them), so isMe is false even for self-stars. */
export function toStar(r: StarRow): Star {
  return { repo: r.repo, user: { login: r.login, name: r.name, avatarUrl: r.avatar, isMe: false }, starredAt: r.starred_at };
}
