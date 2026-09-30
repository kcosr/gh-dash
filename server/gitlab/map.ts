import type { DiffFile, Label, Visibility } from '../../shared/api';
import type { ActorRecord, CommitRecord, IssueRecord, PrCommitRecord, PrRecord, ReleaseRecord, RepoProbe, RepoRecord, StarRecord } from '../db/records';
import { isoSec } from '../lib/time';
import type { RepoCandidateRecord, ViewerInfo } from '../provider/types';
import { countLines, hunks } from './patch';
import type {
  GqlCommit,
  GqlLabels,
  GqlMergeRequest,
  GqlProbe,
  GqlProject,
  GqlRelease,
  GqlUser,
  GqlViewer,
  GqlViewerAccount,
  RestCommit,
  RestDiff,
  RestIssue,
  RestProject,
  RestStarrer,
  RestUser,
} from './types';

// Mappers take `base`, the instance URL, where GitLab may answer with a path on the instance (uploaded avatars).

/**
 * A GitLab timestamp as the app stores them: UTC to the second ("2026-09-21T10:00:00Z"), so they compare as strings
 * with GitHub's and the sync's. REST commit dates carry the committer's UTC offset; other times have milliseconds.
 */
export function utc(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : isoSec(ms);
}

const utcOrNull = (value: string | null | undefined) => (value ? utc(value) : null);

/** For times GitLab's schema has as nullable but always sets (a project's creation, a commit's date). */
const EPOCH = '1970-01-01T00:00:00Z';

/** `internal` (visible to any signed-in user of the instance) is the app's 'internal', as GitHub Enterprise's. Unknown is private. */
export function mapVisibility(visibility: GqlProject['visibility']): Visibility {
  return visibility === 'public' ? 'public' : visibility === 'internal' ? 'internal' : 'private';
}

/** "#RRGGBB" (or "#RGB") as the app stores label colors, GitHub-style: lower-case hex without '#'. */
export function labelColor(color: string): string {
  const hex = color.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) return hex.replace(/./g, (c) => c + c);
  // GitLab only stores hex colors; anything else gets GitHub's neutral default rather than breaking the page.
  return /^[0-9a-f]{6}$/.test(hex) ? hex : 'ededed';
}

function mapLabels(labels: GqlLabels | null): Label[] {
  return (labels?.nodes ?? []).map((l) => ({ name: l.title, color: labelColor(l.color) }));
}

/** An absolute URL for a path on the instance; absolute URLs (Gravatar) pass through. */
function absolute(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, `${base}/`).href;
  } catch {
    return null;
  }
}

function mapUser(u: GqlUser | null, base: string): ActorRecord | null {
  return u ? { login: u.username, name: u.name || null, email: null, avatarUrl: absolute(u.avatarUrl, base) } : null;
}

function mapRestUser(u: RestUser | null, base: string): ActorRecord | null {
  return u ? { login: u.username, name: u.name || null, email: null, avatarUrl: absolute(u.avatar_url, base) } : null;
}

/** A commit message's first line and the rest, like GitHub's messageHeadline / messageBody. */
export function messageParts(message: string): { headline: string; body: string } {
  const [headline = '', ...rest] = message.replace(/\r\n/g, '\n').split('\n');
  return { headline: headline.trim(), body: rest.join('\n').replace(/^\n+/, '').trimEnd() };
}

export function mapViewer(u: GqlViewer, base: string): ViewerInfo {
  return { id: u.id, login: u.username, name: u.name || null, avatarUrl: absolute(u.avatarUrl, base) };
}

/** The viewer's public, commit and other addresses, lower-cased (commit emails are matched that way), once each. */
export function mapViewerEmails(u: GqlViewerAccount): string[] {
  const all = [u.publicEmail, u.commitEmail, ...(u.emails?.nodes ?? []).map((e) => e.email)];
  const clean = all.flatMap((e) => {
    const email = e?.trim().toLowerCase();
    return email?.includes('@') ? [email] : [];
  });
  return [...new Set(clean)];
}

/**
 * `headOid` is the default branch's head commit, which the sync compares to decide whether to walk the commits: a push
 * or force-push can move the head to a commit of the same time. `pushedAt` is when the branch last moved as that
 * commit's date, for display (lastActivityAt, which GitLab moves at most hourly, would hide pushes). Repositories
 * without commits have no head, and fall back to lastActivityAt.
 */
export function mapProject(p: GqlProject, base: string): RepoRecord {
  const language = p.languages?.[0] ?? null;
  const last = p.repository?.tree?.lastCommit;
  return {
    nodeId: p.id,
    name: p.path,
    nameWithOwner: p.fullPath,
    owner: p.namespace?.fullPath ?? p.fullPath.slice(0, p.fullPath.lastIndexOf('/')),
    description: p.description || null,
    url: p.webUrl ?? `${base}/${p.fullPath}`,
    visibility: mapVisibility(p.visibility),
    isArchived: !!p.archived,
    isFork: p.isForked,
    languageName: language?.name ?? null,
    languageColor: language?.color ?? null,
    topics: p.topics ?? [],
    defaultBranch: p.repository?.rootRef ?? null,
    stars: p.starCount,
    forks: p.forksCount,
    createdAt: utc(p.createdAt ?? EPOCH),
    pushedAt: utcOrNull(last?.committedDate ?? p.lastActivityAt),
    headOid: last?.sha || null,
  };
}

/**
 * A project of the REST list of the token's memberships, as the Add dialog lists it. `pushedAt` is the last activity
 * (the list has no push time), and a fork counts only when its upstream is visible to the token.
 */
export function mapCandidate(p: RestProject): RepoCandidateRecord {
  return {
    nodeId: `gid://gitlab/Project/${p.id}`,
    name: p.path,
    nameWithOwner: p.path_with_namespace,
    owner: p.namespace.full_path,
    description: p.description || null,
    visibility: mapVisibility(p.visibility),
    isArchived: !!p.archived,
    isFork: !!p.forked_from_project,
    stars: p.star_count,
    pushedAt: utcOrNull(p.last_activity_at),
  };
}

/** GitLab has no cheap "latest star" (starrers are REST-only, listed oldest first): latestStarredAt stays null. */
export function mapProbe(p: GqlProbe): RepoProbe {
  return {
    // Locked (being merged) counts as open, as in mapMergeRequest.
    openPrs: (p.openMergeRequests?.count ?? 0) + (p.lockedMergeRequests?.count ?? 0),
    openIssues: p.openIssues?.count ?? 0,
    latestPrUpdatedAt: utcOrNull(p.latestMergeRequest?.nodes[0]?.updatedAt),
    latestIssueUpdatedAt: utcOrNull(p.latestIssue?.nodes[0]?.updatedAt),
    releaseTags: (p.latestReleases?.nodes ?? []).flatMap((r) => (r.tagName && !r.upcomingRelease ? [r.tagName] : [])),
    latestStarredAt: null,
  };
}

function mapMrCommit(c: GqlCommit, base: string): PrCommitRecord {
  return {
    oid: c.sha,
    headline: c.fullTitle ?? '',
    committedAt: utc(c.committedDate ?? EPOCH),
    url: c.webUrl,
    author: {
      login: c.author?.username ?? null,
      name: c.author?.name || c.authorName || null,
      email: c.authorEmail ? c.authorEmail.toLowerCase() : null,
      avatarUrl: absolute(c.author?.avatarUrl, base),
    },
  };
}

/** A commit id as stored: lower case; null when GitLab has none (a fast-forward merge makes no merge commit). */
const landed = (sha: string | null | undefined) => sha?.trim().toLowerCase() || null;

/**
 * `locked` (mid-merge) counts as open. Like GitHub's, closedAt is the merge time for a merged MR (GitLab keeps the
 * last close there, which a reopened-then-merged MR has too) and null for an open one.
 */
export function mapMergeRequest(m: GqlMergeRequest, base: string): PrRecord {
  const state = m.state === 'merged' ? 'merged' : m.state === 'closed' ? 'closed' : 'open';
  const updatedAt = utc(m.updatedAt);
  const mergedAt = state === 'merged' ? utc(m.mergedAt ?? m.updatedAt) : null;
  const closedAt = state === 'merged' ? mergedAt : state === 'closed' ? utcOrNull(m.closedAt) : null;
  const createdAt = utc(m.createdAt);
  // GitLab lists an MR's newest commits first; GitHub (and the drawer) go oldest first.
  const commits = (m.commits?.nodes ?? []).map((c) => mapMrCommit(c, base)).reverse();
  const stats = m.diffStatsSummary;
  return {
    number: Number(m.iid),
    title: m.title,
    body: m.description ?? '',
    state,
    isDraft: m.draft,
    author: mapUser(m.author, base),
    // For an open MR mergeUser is whoever set auto-merge.
    mergedBy: state === 'merged' ? (m.mergeUser?.username ?? null) : null,
    createdAt,
    updatedAt,
    mergedAt,
    closedAt,
    activityAt: state === 'merged' ? mergedAt! : state === 'closed' ? (closedAt ?? updatedAt) : createdAt,
    additions: stats?.additions ?? 0,
    deletions: stats?.deletions ?? 0,
    changedFiles: stats?.fileCount ?? 0,
    commitCount: m.commitCount ?? commits.length,
    headRef: m.sourceBranch,
    headOid: m.diffHeadSha ?? '',
    baseRef: m.targetBranch,
    // No source project (a fork deleted since) differs from the target too: the branch was never this project's.
    crossRepo: m.sourceProjectId !== m.targetProjectId,
    labels: mapLabels(m.labels),
    closingIssues: (m.workItemRelations?.nodes ?? []).flatMap(({ workItem: w }) =>
      w ? [{ number: Number(w.iid), title: w.title, state: w.state === 'OPEN' ? ('open' as const) : ('closed' as const), url: w.webUrl ?? '' }] : [],
    ),
    url: m.webUrl ?? '',
    commits,
    // Only a merged MR has landed commits; the sync links the target branch's commits to it through them.
    mergeCommitOid: state === 'merged' ? landed(m.mergeCommitSha) : null,
    // 19.3's GraphQL MergeRequest has no squash SHA, so squash-merged MRs are linked only through `mergeCommitSha` and
    // the MR's own commit SHAs.
    squashCommitOid: null,
  };
}

export function mapIssue(i: RestIssue, base: string): IssueRecord {
  const state = i.state === 'closed' ? 'closed' : 'open';
  const createdAt = utc(i.created_at);
  const updatedAt = utc(i.updated_at);
  const closedAt = state === 'closed' ? utcOrNull(i.closed_at) : null;
  return {
    number: i.iid,
    title: i.title,
    body: i.description ?? '',
    state,
    author: mapRestUser(i.author, base),
    closedBy: state === 'closed' ? mapRestUser(i.closed_by, base) : null,
    createdAt,
    updatedAt,
    closedAt,
    activityAt: state === 'closed' ? (closedAt ?? updatedAt) : createdAt,
    labels: i.labels.map((l) => ({ name: l.name, color: labelColor(l.color) })),
    url: i.web_url,
  };
}

/**
 * GitLab gives no GitLab account for a commit's author, only the name and email (lower-cased, as "me" matches on it).
 * prNumber stays null: which MR brought a commit is known from the MR side, not from the commit.
 */
export function mapCommit(c: RestCommit): CommitRecord {
  const { headline, body } = messageParts(c.message ?? c.title);
  return {
    oid: c.id,
    headline,
    body,
    author: { login: null, name: c.author_name || null, email: c.author_email ? c.author_email.toLowerCase() : null, avatarUrl: null },
    committedAt: utc(c.committed_date),
    url: c.web_url,
    additions: c.stats?.additions ?? 0,
    deletions: c.stats?.deletions ?? 0,
    prNumber: null,
  };
}

/** Upcoming releases (release date still ahead) map to null, as GitHub's drafts do. GitLab has no pre-release flag. */
export function mapRelease(r: GqlRelease, base: string): ReleaseRecord | null {
  if (r.upcomingRelease || !r.tagName) return null;
  const publishedAt = r.releasedAt ?? r.createdAt;
  if (!publishedAt) return null;
  return {
    tag: r.tagName,
    name: r.name || null,
    body: r.description ?? '',
    author: mapUser(r.author, base),
    publishedAt: utc(publishedAt),
    isPrerelease: false,
    url: r.links?.selfUrl ?? '',
  };
}

/** When the release was created (upcoming ones included), for the sync's backfill window. */
export function releaseCreatedAt(r: GqlRelease): string | null {
  return utcOrNull(r.createdAt ?? r.releasedAt);
}

export function mapStar(s: RestStarrer, base: string): StarRecord {
  return { login: s.user.username, name: s.user.name || null, avatarUrl: absolute(s.user.avatar_url, base), starredAt: utc(s.starred_since) };
}

/**
 * A file of a diff version or commit diff. GitLab has no per-file counts, so they're counted from the hunks; a file
 * over the instance's diff limits (collapsed, too_large) has no patch and counts 0.
 */
export function mapDiffFile(d: RestDiff): DiffFile {
  const patch = d.collapsed || d.too_large ? null : hunks(d.diff);
  return {
    path: d.new_path,
    previousPath: d.renamed_file ? d.old_path : null,
    status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
    ...countLines(patch),
    patch,
  };
}
