/**
 * URL state -> API query params. Shared by data fetching and the Export modal /
 * "Copy API URL", so what you see is exactly what the API link returns.
 */
import { EVENT_TYPES } from '../../../shared/api';
import type { ActivityQuery, BranchQuery, IssueQuery, PrQuery, RepoQuery, ScopeQuery, StatsQuery, ThreadListQuery } from '../../../shared/api';
import { apiUrl } from '../api/client';
import type { Endpoint } from '../api/client';
import { resolveRange } from './range';
import { browserTz } from './time';
import { parseUrlState } from './urlState';
import type { UrlState, ViewName } from './urlState';

/** Earliest date we ever ask for when "all time" is meant (e.g. open PRs). */
export const ALL_TIME_FROM = '2008-01-01';

/** Which repos: the context, the selection, visibility and ownership. */
function repoScope(s: Pick<UrlState, 'source' | 'repos' | 'vis' | 'own'>): Pick<ScopeQuery, 'source' | 'repos' | 'visibility' | 'ownership'> {
  return {
    source: s.source ?? undefined,
    repos: s.repos === null ? undefined : s.repos.join(','),
    visibility: s.vis === 'all' ? undefined : s.vis,
    ownership: s.own === 'all' ? undefined : s.own,
  };
}

export function scopeParams(s: UrlState, opts: { q?: boolean } = {}): ScopeQuery {
  const r = resolveRange(s.range, s.from, s.to);
  return {
    ...repoScope(s),
    who: s.who,
    from: r.from,
    to: r.to,
    tz: browserTz(),
    q: opts.q === false || !s.q ? undefined : s.q,
  };
}

/**
 * The PR list as the UI fetches it. No `group`: grouping is client-side (it only shapes format=md). In the "No PR yet"
 * state no PRs are fetched (branchListParams is the list); the state is left out rather than made up.
 */
export function prFetchParams(s: UrlState): PrQuery {
  return { ...scopeParams(s), state: s.state === 'nopr' ? undefined : s.state, comments: s.comments ?? undefined };
}

/**
 * The PR list's "No PR yet" state as the UI fetches it and the export shows it: the branches with no PR yet in the same
 * scope (GET /branches, where `who` is the head commit's author and `q` a part of the name). The PR filters (comments,
 * releases) are PRs' own.
 */
export function branchListParams(s: UrlState): BranchQuery {
  return scopeParams(s);
}

export function issueListParams(s: UrlState): IssueQuery & { state: 'open' | 'closed' | 'all' } {
  return { ...scopeParams(s), state: s.state === 'merged' || s.state === 'nopr' ? 'open' : s.state };
}

export function repoListParams(s: UrlState): RepoQuery {
  return { scope: 'default', source: s.source ?? undefined, repos: s.repos?.join(','), visibility: s.vis, ownership: s.own === 'all' ? undefined : s.own, q: s.q || undefined, sort: s.sort };
}

/** The PR list as exported / shown in the API tab (`group` sets the Markdown headings). */
export function prListParams(s: UrlState): PrQuery {
  return { ...prFetchParams(s), group: s.group };
}

/**
 * The Comments list as the UI fetches it and the export shows it: the repo scope, search and filters, without `who` or
 * the date range (a thread stays open however old it is). File order is the client's (within the newest-first list).
 */
export function threadListParams(s: UrlState): ThreadListQuery {
  return {
    ...repoScope(s),
    q: s.q || undefined,
    status: s.status,
    kind: s.kind === 'all' ? undefined : s.kind,
    author: s.author ?? undefined,
    waiting: s.waiting ? 'you' : undefined,
    sort: s.threadSort === 'oldest' ? 'oldest' : undefined,
  };
}

/** The Comments tab's count: unresolved threads in the list's scope (not its filters). */
export function threadCountParams(s: Pick<UrlState, 'source' | 'repos' | 'vis' | 'own'>): ThreadListQuery {
  return { ...repoScope(s), status: 'open', limit: 1 };
}

/** The count for where the Comments tab leads (`href`, from viewHref): the scope the list opens with. */
export function tabCountParams(href: string): ThreadListQuery {
  const i = href.indexOf('?');
  return threadCountParams(parseUrlState(i < 0 ? '' : href.slice(i), 'comments'));
}

export function releaseListParams(s: UrlState): ScopeQuery {
  return scopeParams(s);
}

export function activityParams(s: UrlState): ActivityQuery {
  // An empty `types=` selects no events; byType still provides the chip counts.
  const all = s.types.length === EVENT_TYPES.length;
  return { ...scopeParams(s), types: all ? undefined : s.types.join(',') };
}

export function statsParams(s: UrlState): StatsQuery {
  return scopeParams(s, { q: false });
}

/**
 * A repo page's scope: that one repo, whatever the context and the visibility and ownership filters say (they narrow
 * lists of repos, not a page about one). The page and its API export both use it.
 */
export function repoPageScope(s: UrlState, key: string): UrlState {
  return { ...s, source: null, repos: [key], vis: 'all', own: 'all' };
}

export interface ExportTarget {
  endpoint: Endpoint;
  params: Record<string, string | number | undefined>;
  /** Whether the endpoint supports format=md. */
  md: boolean;
  /** An endpoint with Markdown that has no CSV. */
  csv?: false;
  label: string;
}

/** What the current view corresponds to in the API. */
export function exportTarget(view: ViewName, s: UrlState, repoKey?: string): ExportTarget {
  switch (view) {
    case 'issues':
      return { endpoint: 'issues', params: { ...issueListParams(s) }, md: true, label: 'issues' };
    case 'activity':
      return { endpoint: 'activity', params: { ...activityParams(s) }, md: true, label: 'activity feed' };
    case 'insights':
      return { endpoint: 'stats', params: { ...statsParams(s) }, md: false, label: 'insights' };
    case 'repo':
      return { endpoint: 'stats', params: { ...statsParams(repoKey ? repoPageScope(s, repoKey) : s) }, md: false, label: 'repository stats' };
    case 'repos':
      return { endpoint: 'repos', params: { ...repoListParams(s) }, md: false, label: 'repositories' };
    case 'settings':
      return { endpoint: 'settings', params: {}, md: false, label: 'settings' };
    case 'comments':
      return { endpoint: 'threads', params: { ...threadListParams(s) }, md: true, csv: false, label: 'comments' };
    case 'prs':
    default:
      // Branches have no Markdown or CSV form.
      if (s.state === 'nopr') return { endpoint: 'branches', params: { ...branchListParams(s) }, md: false, label: 'branches with no pull request yet' };
      return { endpoint: 'prs', params: { ...prListParams(s) }, md: true, label: 'pull requests' };
  }
}

export function exportUrl(t: ExportTarget, extra: Record<string, string | number | undefined> = {}): string {
  return apiUrl(t.endpoint, { ...t.params, ...extra });
}
