/**
 * GraphQL documents. Every document is a read-only `query` (the client refuses anything else) and stays well under
 * GitLab's 10,000-character limit. GitLab's complexity (limit 250) counts each field once rather than once per node,
 * scaled by 1% per requested item, so page sizes are set in the sources by response time rather than complexity.
 */

const USER = 'username name avatarUrl';
const LABELS = 'labels(first: 20) { nodes { title color } }';

/**
 * `isForked` rather than `forkedFrom`, which is null when the upstream isn't visible to the token. The tree's
 * lastCommit is the default branch head: GitLab's lastActivityAt moves at most hourly, too coarse to tell pushes.
 */
export const PROJECT_FIELDS = `
fragment ProjectFields on Project {
  id path fullPath namespace { fullPath } description webUrl visibility archived isForked
  starCount forksCount createdAt lastActivityAt topics
  languages { name color }
  repository { rootRef tree { lastCommit { sha committedDate } } }
}`;

/**
 * Open counts plus cheap "latest item" probes that tell the sync which sections changed. Filters match round()'s. A
 * locked merge request (being merged) maps to open, so it is counted with the opened ones: without it, a project with
 * one would never match the sync's open count, which then re-lists the open ones and rechecks it every sync.
 */
export const PROBE_FIELDS = `
fragment ProbeFields on Project {
  id
  openMergeRequests: mergeRequests(state: opened) { count }
  lockedMergeRequests: mergeRequests(state: locked) { count }
  openIssues: issues(state: opened, types: [ISSUE]) { count }
  latestMergeRequest: mergeRequests(state: all, first: 1, sort: UPDATED_DESC) { nodes { updatedAt } }
  latestIssue: issues(state: all, types: [ISSUE], first: 1, sort: UPDATED_DESC) { nodes { updatedAt } }
  latestReleases: releases(first: 3, sort: CREATED_DESC) { nodes { tagName upcomingRelease } }
}`;

/** The account. Queries that list projects carry it along (the sync claims the account they were read for). */
const VIEWER_FIELDS = `currentUser { id ${USER} }`;

export const VIEWER = `
query Viewer {
  ${VIEWER_FIELDS}
}`;

/**
 * The account with the addresses its commits may carry, which is what "me" means on GitLab commits (they name no
 * account). Kept out of the sync's own queries: it is the one place a field the token may not read would fail.
 */
export const VIEWER_ACCOUNT = `
query ViewerAccount {
  currentUser { id ${USER} publicEmail commitEmail emails { nodes { email } } }
}`;

/** Projects in the viewer's personal namespace (archived ones included: GitLab's default). */
export const OWNED_PROJECTS = `
query OwnedProjects($after: String, $first: Int!) {
  ${VIEWER_FIELDS}
  projects(personal: true, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...ProjectFields }
  }
}
${PROJECT_FIELDS}`;

export const PROJECT = `
query Project($path: ID!) {
  ${VIEWER_FIELDS}
  project(fullPath: $path) { ...ProjectFields ...ProbeFields }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;

/** Tracked projects by global id (25 at a time); ones the token can no longer see are not listed. */
export const MANUAL_PROJECTS = `
query ManualProjects($ids: [ID!], $first: Int!) {
  projects(ids: $ids, first: $first) { nodes { ...ProjectFields ...ProbeFields } }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;

/** One tracked project by global id, with the viewer to claim. */
export const PROJECT_BY_NODE = `
query ProjectByNode($ids: [ID!], $first: Int!) {
  ${VIEWER_FIELDS}
  projects(ids: $ids, first: $first) { nodes { ...ProjectFields ...ProbeFields } }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;

/**
 * The Add dialog's lookup, in one request: the project and its probe, what the token may read of it, and the size of
 * its first sync (items updated since `$since`, all releases).
 */
export const PROJECT_LOOKUP = `
query ProjectLookup($path: ID!, $since: Time!) {
  ${VIEWER_FIELDS}
  project(fullPath: $path) {
    ...ProjectFields
    ...ProbeFields
    userPermissions { downloadCode readMergeRequest }
    issuesEnabled
    recentMergeRequests: mergeRequests(updatedAfter: $since) { count }
    recentIssues: issues(updatedAfter: $since, types: [ISSUE]) { count }
    releaseCount: releases { count }
  }
}
${PROJECT_FIELDS}
${PROBE_FIELDS}`;

export const PROBES = `
query Probes($ids: [ID!], $first: Int!) {
  projects(ids: $ids, first: $first) { nodes { ...ProbeFields } }
}
${PROBE_FIELDS}`;

/**
 * `commits` lists the MR's newest commits first; `workItemRelations` (issues the MR closes) is null while GitLab's
 * explicit_mr_work_item_relations flag is off. `mergeCommitSha` (with the MR's own commit SHAs) is what links the commits
 * on the target branch back to the MR (the commits themselves don't say). 19.3's MergeRequest has no `squashCommitSha`.
 */
const MR_FIELDS = `
fragment MrFields on MergeRequest {
  iid title description state draft webUrl
  createdAt updatedAt mergedAt closedAt
  sourceBranch targetBranch diffHeadSha mergeCommitSha commitCount
  author { ${USER} }
  mergeUser { username }
  diffStatsSummary { additions deletions fileCount }
  ${LABELS}
  commits(first: 20) { nodes { sha fullTitle committedDate webUrl authorName authorEmail author { ${USER} } } }
  workItemRelations(types: [CLOSES], first: 10) { nodes { workItem { iid title state webUrl } } }
}`;

export const MERGE_REQUESTS = `
query MergeRequests($path: ID!, $after: String, $first: Int!, $state: MergeRequestState!, $sort: MergeRequestSort!) {
  project(fullPath: $path) {
    mergeRequests(first: $first, after: $after, state: $state, sort: $sort) {
      pageInfo { hasNextPage endCursor }
      nodes { ...MrFields }
    }
  }
}
${MR_FIELDS}`;

/** Merge requests by number, whatever their state; ones that no longer exist are simply not listed. */
export const RECHECK_MERGE_REQUESTS = `
query RecheckMergeRequests($path: ID!, $iids: [String!], $first: Int!) {
  project(fullPath: $path) {
    mergeRequests(iids: $iids, state: all, first: $first) {
      pageInfo { hasNextPage endCursor }
      nodes { ...MrFields }
    }
  }
}
${MR_FIELDS}`;

export const RELEASES = `
query Releases($path: ID!, $after: String, $first: Int!) {
  project(fullPath: $path) {
    releases(first: $first, after: $after, sort: CREATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes {
        tagName name description releasedAt createdAt upcomingRelease
        author { ${USER} }
        links { selfUrl }
      }
    }
  }
}`;

/** What a merge request's diff is between, with its totals; the files come from REST (diff versions). */
export const MR_REVISION = `
query MrRevision($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      title webUrl targetBranch
      diffRefs { baseSha headSha startSha }
      diffStatsSummary { additions deletions fileCount }
    }
  }
}`;
