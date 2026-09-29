// A small GitHub GraphQL API for tests that run whole syncs (the manager, the HTTP API): the viewer's own repositories
// and other owners' ones, answered by name or node id. Every repo has at most a few pull requests and nothing else.
// Serve it with fakeGitHub({ '/graphql': gql.handler }) from ./github.

import type { GqlError, GqlProbe, GqlPullRequest, GqlRepo } from '../github/types';
import type { Handler } from './github';

export type RepoNode = GqlRepo & GqlProbe & { viewerPermission?: string };

const RATE = { limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z', cost: 1 };
const conn = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/** A repository as GitHub describes it (RepoFields and ProbeFields), node id `R_<key>` like the test rows. */
export function repoNode(key: string, over: Partial<RepoNode> = {}): RepoNode {
  const i = key.lastIndexOf('/');
  return {
    id: `R_${key}`, name: key.slice(i + 1), nameWithOwner: key, owner: { login: key.slice(0, i) }, description: null,
    url: `https://github.com/${key}`, visibility: 'PUBLIC', isArchived: false, isFork: false, primaryLanguage: null,
    repositoryTopics: { nodes: [] }, defaultBranchRef: { name: 'main' }, stargazerCount: 3, forkCount: 0,
    createdAt: '2025-01-01T00:00:00Z', pushedAt: '2026-09-20T00:00:00Z',
    openPrs: { totalCount: 0 }, openIssues: { totalCount: 0 }, latestPr: { nodes: [] }, latestIssue: { nodes: [] },
    latestReleases: { nodes: [] }, latestStar: { edges: [] }, ...over,
  };
}

export function prNode(key: string, number: number, title: string, at = '2026-09-25T10:00:00Z'): GqlPullRequest {
  return {
    number, title, body: '', state: 'MERGED', isDraft: false, url: `https://github.com/${key}/pull/${number}`, createdAt: at, updatedAt: at,
    mergedAt: at, closedAt: at, additions: 1, deletions: 0, changedFiles: 1, headRefName: 'fix', headRefOid: 'a'.repeat(40), baseRefName: 'main',
    author: { login: 'someone', avatarUrl: null }, mergedBy: { login: 'someone' }, labels: { nodes: [] }, closingIssuesReferences: { nodes: [] },
    commits: { totalCount: 0, nodes: [] },
  };
}

export function fakeGraphQL() {
  const state = {
    viewer: { id: 'U_alice', login: 'alice', name: 'Alice' as string | null, avatarUrl: null as string | null },
    /** The viewer's own repositories. */
    owned: [] as RepoNode[],
    /** Other owners' repositories the token can read. */
    others: [] as RepoNode[],
    /** Pull requests RepoDetail serves, by key. */
    prs: {} as Record<string, GqlPullRequest[]>,
    /** Errors for a repository, by node id or key: it reads as null with this error (or, with `path`, only that field). */
    errors: {} as Record<string, { type: string; message: string; field?: string }>,
    /** Operation names, with the node id or owner/name they asked for. */
    ops: [] as string[],
    /** What RepoLookup counts since the backfill start; a count of null makes that search fail. */
    size: { commits: 240, prs: 60 as number | null, issues: 12 as number | null, releases: 4 },
    /** Keys of repositories the viewer contributed to (RepoSuggestions). */
    suggested: [] as string[],
  };
  const all = () => [...state.owned, ...state.others];
  const find = (idOrKey: string) => all().find((r) => r.id === idOrKey || r.nameWithOwner.toLowerCase() === idOrKey.toLowerCase()) ?? null;

  /** A repository at `path`, or null with its error (a field error nulls just that field). */
  const read = (idOrKey: string, path: (string | number)[], errors: GqlError[]): RepoNode | null => {
    const repo = find(idOrKey);
    const err = state.errors[idOrKey] ?? (repo ? (state.errors[repo.id] ?? state.errors[repo.nameWithOwner]) : undefined);
    if (err && !err.field) {
      errors.push({ type: err.type, message: err.message, path });
      return null;
    }
    if (!repo) {
      errors.push({ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${idOrKey}'`, path });
      return null;
    }
    if (err?.field) {
      errors.push({ type: err.type, message: err.message, path: [...path, err.field] });
      return { ...repo, [err.field]: null } as RepoNode;
    }
    return repo;
  };

  const handler: Handler = ({ body }) => {
    const { query, variables: v } = body as { query: string; variables: Record<string, unknown> };
    const op = /query (\w+)/.exec(query)?.[1] ?? 'anonymous';
    const errors: GqlError[] = [];
    const viewer = state.viewer;
    let data: Record<string, unknown>;
    switch (op) {
      case 'Viewer':
        data = { viewer };
        break;
      case 'ViewerRepos':
        data = { viewer: { ...viewer, repositories: conn(state.owned) } };
        break;
      case 'ViewerRepo':
        data = { viewer: { ...viewer, repository: state.owned.find((r) => r.name === v.name) ?? null } };
        break;
      case 'ManualRepos':
      case 'RepoProbes':
        data = { nodes: (v.ids as string[]).map((id, i) => read(id, ['nodes', i], errors)) };
        break;
      case 'RepoNode':
        data = { viewer, node: read(String(v.id), ['node'], errors) };
        break;
      case 'RepoDetail': {
        const key = `${String(v.owner)}/${String(v.name)}`;
        const repo = read(key, ['repository'], errors);
        data = {
          repository: repo && {
            nameWithOwner: repo.nameWithOwner,
            defaultBranchRef: { name: 'main', target: { history: conn([]) } },
            pullRequests: conn(state.prs[repo.nameWithOwner] ?? []),
            issues: conn([]), openPrs: conn([]), openIssues: conn([]), releases: conn([]),
            stargazers: { totalCount: 0, pageInfo: conn([]).pageInfo, edges: [] },
          },
        };
        break;
      }
      case 'RepoLookup': {
        const repo = read(`${String(v.owner)}/${String(v.name)}`, ['repository'], errors);
        const search = (field: 'prs' | 'issues') => {
          const n = state.size[field];
          if (n === null) errors.push({ type: 'SERVICE_UNAVAILABLE', message: 'Search is unavailable', path: [field] });
          return n === null ? null : { issueCount: n };
        };
        data = {
          viewer,
          repository: repo && {
            ...repo, viewerPermission: 'READ', releases: { totalCount: state.size.releases },
            defaultBranchRef: repo.defaultBranchRef && { ...repo.defaultBranchRef, target: { history: { totalCount: state.size.commits } } },
          },
          prs: search('prs'),
          issues: search('issues'),
        };
        break;
      }
      case 'RepoSuggestions':
        data = { viewer: { ...viewer, repositoriesContributedTo: { nodes: state.suggested.map((k) => find(k)) } } };
        break;
      default:
        return { status: 200, body: { errors: [{ message: `fakeGraphQL: no ${op}` }] } };
    }
    state.ops.push(`${op}${v.id ? `:${String(v.id)}` : v.owner ? `:${String(v.owner)}/${String(v.name)}` : ''}`);
    return { body: { data: { ...data, rateLimit: RATE }, ...(errors.length ? { errors } : {}) } };
  };
  return { state, handler };
}
