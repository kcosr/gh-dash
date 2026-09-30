// A small GitHub GraphQL API for tests that run whole syncs (the manager, the HTTP API) or a GitHubSyncSource: the
// viewer's own repositories and other owners' ones, answered by name or node id, with the pull requests, issues,
// commits, releases, stargazers and branches a test gives them (none by default). Connections page by their `first`
// and `after` (cursors are item offsets); `pageSize` makes every page smaller, to walk the cursors.
// Serve it with fakeGitHub({ '/graphql': gql.handler }) from ./github.

import type { GqlBranch, GqlCommit, GqlError, GqlIssue, GqlProbe, GqlPullRequest, GqlRelease, GqlRepo, GqlStarEdge } from '../github/types';
import type { Handler } from './github';

export type RepoNode = GqlRepo & GqlProbe & { viewerPermission?: string };

const RATE = { limit: 5000, remaining: 4990, resetAt: '2099-01-01T00:00:00Z', cost: 1 };

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
    mergedAt: at, closedAt: at, additions: 1, deletions: 0, changedFiles: 1, headRefName: 'fix', headRefOid: 'a'.repeat(40), baseRefName: 'main', isCrossRepository: false,
    author: { login: 'someone', avatarUrl: null }, mergedBy: { login: 'someone' }, labels: { nodes: [] }, closingIssuesReferences: { nodes: [] },
    commits: { totalCount: 0, nodes: [] },
  };
}

/** An open issue (Partial `over` for a closed one). */
export function issueNode(key: string, number: number, title: string, at = '2026-09-25T10:00:00Z', over: Partial<GqlIssue> = {}): GqlIssue {
  return {
    number, title, body: '', state: 'OPEN', url: `https://github.com/${key}/issues/${number}`, createdAt: at, updatedAt: at, closedAt: null,
    author: { login: 'someone', avatarUrl: null }, labels: { nodes: [] }, timelineItems: { nodes: [] }, ...over,
  };
}

/** A default-branch commit whose oid is `c` repeated; `pr`: the PR of this repo that brought it. */
export function commitNode(key: string, c: string, at: string, pr: number | null = null): GqlCommit {
  const oid = c.repeat(40).slice(0, 40);
  return {
    oid, messageHeadline: `Commit ${c}`, messageBody: '', committedDate: at, url: `https://github.com/${key}/commit/${oid}`, additions: 1, deletions: 0,
    author: { name: 'Someone', email: 'someone@example.com', avatarUrl: null, user: { login: 'someone', name: null } },
    associatedPullRequests: { nodes: pr === null ? [] : [{ number: pr, repository: { nameWithOwner: key } }] },
  };
}

/** A published release (`isDraft` in `over` for a draft, which has no publishedAt). */
export function releaseNode(key: string, tag: string, at: string, over: Partial<GqlRelease> = {}): GqlRelease {
  const draft = !!over.isDraft;
  return {
    tagName: tag, name: tag, description: '', isDraft: draft, isPrerelease: false, publishedAt: draft ? null : at, createdAt: at,
    url: `https://github.com/${key}/releases/tag/${tag}`, author: { login: 'someone', name: null, avatarUrl: null }, ...over,
  };
}

export const starEdge = (login: string, at: string): GqlStarEdge => ({ starredAt: at, node: { login, name: null, avatarUrl: null } });

/** A branch whose head is `c` repeated, committed `at` by `login` (null: an author GitHub linked to no account). */
export function branchNode(name: string, c: string, at: string, login: string | null = 'someone'): GqlBranch {
  const email = `${login ?? 'Nobody'}@Example.com`;
  return { name, target: { oid: c.repeat(40).slice(0, 40), committedDate: at, author: { name: login ?? 'Nobody', email, avatarUrl: null, user: login ? { login, name: null } : null } } };
}

export function fakeGraphQL() {
  const state = {
    viewer: { id: 'U_alice', login: 'alice', name: 'Alice' as string | null, avatarUrl: null as string | null },
    /** The viewer's own repositories. */
    owned: [] as RepoNode[],
    /** Other owners' repositories the token can read. */
    others: [] as RepoNode[],
    /** A repository's items by key, in the order GitHub lists them (PRs and issues: most recently updated first). */
    prs: {} as Record<string, GqlPullRequest[]>,
    issues: {} as Record<string, GqlIssue[]>,
    commits: {} as Record<string, GqlCommit[]>,
    releases: {} as Record<string, GqlRelease[]>,
    stars: {} as Record<string, GqlStarEdge[]>,
    /** A repository's branches, by name (GitHub's order). */
    branches: {} as Record<string, GqlBranch[]>,
    /** PRs and issues transferred to another repository: `<key>#<number>` → its key now (a recheck finds them there). */
    moved: {} as Record<string, string>,
    /** When set, no page holds more than this many items. */
    pageSize: null as number | null,
    /**
     * Answer as GitHub does: REPO_DETAIL with only the sections it asks for (@include), and RecheckItems. Off, as the
     * tests written before it expect: every section, and no rechecks. (The sync reads an open-items section it starts
     * in the round that finishes the dated one, without having asked for it.)
     */
    strict: false,
    /** Errors for a repository, by node id or key: it reads as null with this error (or, with `path`, only that field). */
    errors: {} as Record<string, { type: string; message: string; field?: string }>,
    /** Operation names, with the node id or owner/name they asked for. */
    ops: [] as string[],
    /** What RepoLookup counts since the backfill start; a count of null makes that search fail. */
    size: { commits: 240, prs: 60 as number | null, issues: 12 as number | null, releases: 4 },
    /** Keys of repositories the viewer contributed to (RepoSuggestions). */
    suggested: [] as string[],
    /** What every answer says of the token's GraphQL budget. */
    rateLimit: { ...RATE },
  };
  const all = () => [...state.owned, ...state.others];
  const find = (idOrKey: string) => all().find((r) => r.id === idOrKey || r.nameWithOwner.toLowerCase() === idOrKey.toLowerCase()) ?? null;

  /** One page of `items` from the cursor `after`: `first` of them, or fewer with `pageSize`. */
  const paged = <T>(items: T[], first: number, after: unknown) => {
    const start = after ? Number(after) : 0;
    const nodes = items.slice(start, start + Math.min(first, state.pageSize ?? first));
    const end = start + nodes.length;
    return { pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length ? String(end) : null }, nodes };
  };

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

  /** REPO_DETAIL's answer for `repo`: one page of each section switched on (strict), or of every section. */
  const detail = (repo: RepoNode, vars: Record<string, unknown>) => {
    const v = state.strict ? vars : { ...vars, ...Object.fromEntries(Object.keys(vars).filter((k) => k.startsWith('with')).map((k) => [k, true])) };
    const key = repo.nameWithOwner;
    const prs = state.prs[key] ?? [];
    const issues = state.issues[key] ?? [];
    const stars = state.stars[key] ?? [];
    const history = () => paged((state.commits[key] ?? []).filter((c) => !v.since || c.committedDate >= String(v.since)), Number(v.commitsFirst), v.commitsAfter);
    return {
      nameWithOwner: key,
      ...(v.withCommits ? { defaultBranchRef: repo.defaultBranchRef && { name: repo.defaultBranchRef.name, target: { history: history() } } } : {}),
      ...(v.withPrs ? { pullRequests: paged(prs, Number(v.prsFirst), v.prsAfter) } : {}),
      ...(v.withIssues ? { issues: paged(issues, Number(v.issuesFirst), v.issuesAfter) } : {}),
      ...(v.withOpenPrs ? { openPrs: paged(prs.filter((p) => p.state === 'OPEN'), 50, v.openPrsAfter) } : {}),
      ...(v.withOpenIssues ? { openIssues: paged(issues.filter((i) => i.state === 'OPEN'), 50, v.openIssuesAfter) } : {}),
      ...(v.withReleases ? { releases: paged(state.releases[key] ?? [], 20, v.releasesAfter) } : {}),
      ...(v.withStars ? (({ nodes, pageInfo }) => ({ stargazers: { totalCount: stars.length, pageInfo, edges: nodes } }))(paged(stars, 100, v.starsAfter)) : {}),
      ...(v.withBranches ? { branches: paged(state.branches[key] ?? [], 100, v.branchesAfter) } : {}),
    };
  };

  /** RecheckItems: `pr<N>` / `issue<N>` of `repo` by number, from where they are now; null with NOT_FOUND if nowhere. */
  const recheck = (repo: RepoNode, query: string, errors: GqlError[]) => {
    const fields = [...query.matchAll(/(\w+): (pullRequest|issue)\(number: (\d+)\)/g)].map((m) => ({ alias: m[1]!, pr: m[2] === 'pullRequest', number: Number(m[3]) }));
    return Object.fromEntries(
      fields.map(({ alias, pr, number }) => {
        const at = state.moved[`${repo.nameWithOwner}#${number}`] ?? repo.nameWithOwner;
        const item = ((pr ? state.prs[at] : state.issues[at]) ?? []).find((n) => n.number === number);
        if (!item) errors.push({ type: 'NOT_FOUND', message: `Could not resolve to a${pr ? ' PullRequest' : 'n Issue'} with the number of ${number}.`, path: ['repository', alias] });
        return [alias, item ? { ...item, repository: { nameWithOwner: at } } : null];
      }),
    );
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
        data = { viewer: { ...viewer, repositories: paged(state.owned, 100, v.after) } };
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
        const repo = read(`${String(v.owner)}/${String(v.name)}`, ['repository'], errors);
        data = { repository: repo && detail(repo, v) };
        break;
      }
      case 'RecheckItems': {
        if (!state.strict) return { status: 200, body: { errors: [{ message: `fakeGraphQL: no ${op}` }] } };
        const repo = read(`${String(v.owner)}/${String(v.name)}`, ['repository'], errors);
        data = { repository: repo && recheck(repo, query, errors) };
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
    return { body: { data: { ...data, rateLimit: state.rateLimit }, ...(errors.length ? { errors } : {}) } };
  };
  return { state, handler };
}
