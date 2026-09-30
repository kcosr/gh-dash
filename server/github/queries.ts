/** GraphQL documents. Every document is a read-only `query`; the client refuses anything else. */

const RATE_LIMIT = 'rateLimit { limit remaining resetAt cost }';

const ACTOR = 'login avatarUrl ... on User { name }';
const GIT_ACTOR = 'name email avatarUrl user { login name }';
const LABELS = 'labels(first: 20) { nodes { name color } }';

const REPO_FIELDS = `
fragment RepoFields on Repository {
  id name nameWithOwner owner { login } description url visibility isArchived isFork
  primaryLanguage { name color }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  defaultBranchRef { name }
  stargazerCount forkCount createdAt pushedAt
}`;

/** Open counts plus cheap "latest item" probes that tell the sync which sections changed. */
const PROBE_FIELDS = `
fragment ProbeFields on Repository {
  id
  openPrs: pullRequests(states: OPEN) { totalCount }
  openIssues: issues(states: OPEN) { totalCount }
  latestPr: pullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { updatedAt } }
  latestIssue: issues(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { updatedAt } }
  latestReleases: releases(first: 3, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft } }
  latestStar: stargazers(first: 1, orderBy: { field: STARRED_AT, direction: DESC }) { edges { starredAt } }
}`;

export const VIEWER_REPOS = `
query ViewerRepos($after: String) {
  viewer {
    id login name avatarUrl
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ...RepoFields }
    }
  }
  ${RATE_LIMIT}
}
${REPO_FIELDS}`;

export const REPO_PROBES = `
query RepoProbes($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Repository { ...ProbeFields } }
  ${RATE_LIMIT}
}
${PROBE_FIELDS}`;

export const VIEWER_REPO = `
query ViewerRepo($name: String!) {
  viewer {
    id login name avatarUrl
    repository(name: $name) { ...RepoFields ...ProbeFields }
  }
  ${RATE_LIMIT}
}
${REPO_FIELDS}
${PROBE_FIELDS}`;

/** Repos added by hand, by node id: their fields and probes, one request per chunk. Ones the token can't read come back null. */
export const MANUAL_REPOS = `
query ManualRepos($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Repository { ...RepoFields ...ProbeFields } }
  ${RATE_LIMIT}
}
${REPO_FIELDS}
${PROBE_FIELDS}`;

/** One tracked repo by node id (a single-repo sync). The viewer comes along: it is claimed before anything is written. */
export const REPO_NODE = `
query RepoNode($id: ID!) {
  viewer { id login name avatarUrl }
  node(id: $id) { ... on Repository { ...RepoFields ...ProbeFields } }
  ${RATE_LIMIT}
}
${REPO_FIELDS}
${PROBE_FIELDS}`;

/**
 * Everything "Add repository" shows before adding one, in one request: the repository (or why the token can't read
 * it), whether the viewer owns it, and the size of its first sync: default-branch commits and PRs / issues updated
 * since the backfill start, and its releases. `search` answers issueCount without `first`, and `history(since:)`
 * counts only commits since then (both checked against GitHub, 2026-09). The searches may fail on their own.
 */
export const REPO_LOOKUP = `
query RepoLookup($owner: String!, $name: String!, $since: GitTimestamp!, $prQ: String!, $issueQ: String!) {
  viewer { id login name avatarUrl }
  repository(owner: $owner, name: $name) {
    ...RepoFields ...ProbeFields viewerPermission
    defaultBranchRef { target { ... on Commit { history(first: 1, since: $since) { totalCount } } } }
    releases { totalCount }
  }
  prs: search(type: ISSUE, query: $prQ) { issueCount }
  issues: search(type: ISSUE, query: $issueQ) { issueCount }
  ${RATE_LIMIT}
}
${REPO_FIELDS}
${PROBE_FIELDS}`;

/** Repositories of others the viewer recently contributed to (suggestions for "Add repository"). */
export const REPO_SUGGESTIONS = `
query RepoSuggestions {
  viewer {
    id login name avatarUrl
    repositoriesContributedTo(
      first: 25, includeUserRepositories: false, contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, ISSUE],
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      nodes { id name nameWithOwner owner { login } description visibility isArchived isFork stargazerCount pushedAt }
    }
  }
  ${RATE_LIMIT}
}`;

export const VIEWER = `
query Viewer {
  viewer { id login name avatarUrl }
  ${RATE_LIMIT}
}`;

/** `isCrossRepository`: the head branch is in another repo (a fork), so its name says nothing about this repo's branches. */
const PR_FIELDS = `
fragment PrFields on PullRequest {
  number title body state isDraft url
  createdAt updatedAt mergedAt closedAt
  additions deletions changedFiles headRefName headRefOid baseRefName isCrossRepository
  author { ${ACTOR} }
  mergedBy { login }
  ${LABELS}
  closingIssuesReferences(first: 10) { nodes { number title state url } }
  commits(first: 50) {
    totalCount
    nodes { commit { oid messageHeadline committedDate url author { ${GIT_ACTOR} } } }
  }
}`;

const ISSUE_FIELDS = `
fragment IssueFields on Issue {
  number title body state url createdAt updatedAt closedAt
  author { ${ACTOR} }
  ${LABELS}
  timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { ${ACTOR} } } } }
}`;

/**
 * One page of each requested section; sections are toggled with @include and paged independently.
 * `openPrs` / `openIssues` list every open item regardless of age (the updatedAt-ordered sections stop at
 * the backfill window). `branches` come by name: GitHub accepts an order for refs/heads/ and ignores it (see
 * diff-source.ts). GitHub prices a query by the requests its connections could take, a point per hundred; with no
 * connection inside, the branches add one: next to nothing on a round of other sections, a point on their own.
 */
export const REPO_DETAIL = `
query RepoDetail(
  $owner: String!, $name: String!,
  $withCommits: Boolean!, $commitsAfter: String, $since: GitTimestamp, $commitsFirst: Int!,
  $withPrs: Boolean!, $prsAfter: String, $prsFirst: Int!,
  $withIssues: Boolean!, $issuesAfter: String, $issuesFirst: Int!,
  $withOpenPrs: Boolean!, $openPrsAfter: String,
  $withOpenIssues: Boolean!, $openIssuesAfter: String,
  $withReleases: Boolean!, $releasesAfter: String,
  $withStars: Boolean!, $starsAfter: String,
  $withBranches: Boolean!, $branchesAfter: String
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef @include(if: $withCommits) {
      name
      target {
        ... on Commit {
          history(first: $commitsFirst, after: $commitsAfter, since: $since) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid messageHeadline messageBody committedDate url additions deletions
              author { ${GIT_ACTOR} }
              associatedPullRequests(first: 1) { nodes { number repository { nameWithOwner } } }
            }
          }
        }
      }
    }
    pullRequests(first: $prsFirst, after: $prsAfter, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $withPrs) {
      pageInfo { hasNextPage endCursor }
      nodes { ...PrFields }
    }
    issues(first: $issuesFirst, after: $issuesAfter, orderBy: { field: UPDATED_AT, direction: DESC }) @include(if: $withIssues) {
      pageInfo { hasNextPage endCursor }
      nodes { ...IssueFields }
    }
    openPrs: pullRequests(first: 50, after: $openPrsAfter, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) @include(if: $withOpenPrs) {
      pageInfo { hasNextPage endCursor }
      nodes { ...PrFields }
    }
    openIssues: issues(first: 50, after: $openIssuesAfter, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) @include(if: $withOpenIssues) {
      pageInfo { hasNextPage endCursor }
      nodes { ...IssueFields }
    }
    releases(first: 20, after: $releasesAfter, orderBy: { field: CREATED_AT, direction: DESC }) @include(if: $withReleases) {
      pageInfo { hasNextPage endCursor }
      nodes {
        tagName name description isDraft isPrerelease publishedAt createdAt url
        author { login name avatarUrl }
      }
    }
    stargazers(first: 100, after: $starsAfter, orderBy: { field: STARRED_AT, direction: DESC }) @include(if: $withStars) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login name avatarUrl } }
    }
    branches: refs(refPrefix: "refs/heads/", first: 100, after: $branchesAfter) @include(if: $withBranches) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { oid ... on Commit { committedDate author { ${GIT_ACTOR} } } } }
    }
  }
  ${RATE_LIMIT}
}
${PR_FIELDS}
${ISSUE_FIELDS}`;

/**
 * Re-reads specific PRs / issues by number (aliased `pr<N>` / `issue<N>`); used for items we have as open
 * that GitHub no longer lists as open. Missing items come back null with NOT_FOUND errors.
 */
export function recheckQuery(prNumbers: number[], issueNumbers: number[]): string {
  const fields = [
    ...prNumbers.map((n) => `pr${n}: pullRequest(number: ${n}) { repository { nameWithOwner } ...PrFields }`),
    ...issueNumbers.map((n) => `issue${n}: issue(number: ${n}) { repository { nameWithOwner } ...IssueFields }`),
  ];
  return `
query RecheckItems($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { ${fields.join('\n    ')} }
  ${RATE_LIMIT}
}
${prNumbers.length ? PR_FIELDS : ''}
${issueNumbers.length ? ISSUE_FIELDS : ''}`;
}
