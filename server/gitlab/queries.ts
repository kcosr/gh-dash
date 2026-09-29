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

/** Open counts plus cheap "latest item" probes that tell the sync which sections changed. Filters match round()'s. */
export const PROBE_FIELDS = `
fragment ProbeFields on Project {
  id
  openMergeRequests: mergeRequests(state: opened) { count }
  openIssues: issues(state: opened, types: [ISSUE]) { count }
  latestMergeRequest: mergeRequests(state: all, first: 1, sort: UPDATED_DESC) { nodes { updatedAt } }
  latestIssue: issues(state: all, types: [ISSUE], first: 1, sort: UPDATED_DESC) { nodes { updatedAt } }
  latestReleases: releases(first: 3, sort: CREATED_DESC) { nodes { tagName upcomingRelease } }
}`;

export const VIEWER = `
query Viewer {
  currentUser { id ${USER} }
}`;

/** Projects in the viewer's personal namespace (archived ones included: GitLab's default). */
export const OWNED_PROJECTS = `
query OwnedProjects($after: String, $first: Int!) {
  projects(personal: true, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ...ProjectFields }
  }
}
${PROJECT_FIELDS}`;

export const PROJECT = `
query Project($path: ID!) {
  project(fullPath: $path) { ...ProjectFields ...ProbeFields }
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
 * explicit_mr_work_item_relations flag is off.
 */
const MR_FIELDS = `
fragment MrFields on MergeRequest {
  iid title description state draft webUrl
  createdAt updatedAt mergedAt closedAt
  sourceBranch targetBranch diffHeadSha commitCount
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
