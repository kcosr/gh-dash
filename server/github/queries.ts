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
    login name avatarUrl
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
    login name avatarUrl
    repository(name: $name) { ...RepoFields ...ProbeFields }
  }
  ${RATE_LIMIT}
}
${REPO_FIELDS}
${PROBE_FIELDS}`;

export const VIEWER = `
query Viewer {
  viewer { login name avatarUrl }
  ${RATE_LIMIT}
}`;

const PR_FIELDS = `
fragment PrFields on PullRequest {
  number title body state isDraft url
  createdAt updatedAt mergedAt closedAt
  additions deletions changedFiles headRefName baseRefName
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
 * the backfill window).
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
  $withStars: Boolean!, $starsAfter: String
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
