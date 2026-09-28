/**
 * URL state -> API query params. Shared by data fetching and the Export modal /
 * "Copy API URL", so what you see is exactly what the API link returns.
 */
import { EVENT_TYPES } from '../../../shared/api';
import type { ActivityQuery, PrQuery, ScopeQuery, StatsQuery } from '../../../shared/api';
import { apiUrl } from '../api/client';
import type { Endpoint } from '../api/client';
import { resolveRange } from './range';
import { browserTz } from './time';
import type { UrlState, ViewName } from './urlState';

/** Earliest date we ever ask for when "all time" is meant (e.g. open PRs). */
export const ALL_TIME_FROM = '2008-01-01';

export function scopeParams(s: UrlState, opts: { q?: boolean } = {}): ScopeQuery {
  const r = resolveRange(s.range, s.from, s.to);
  return {
    repos: s.repos === null ? undefined : s.repos.join(','),
    visibility: s.vis === 'all' ? undefined : s.vis,
    who: s.who,
    from: r.from,
    to: r.to,
    tz: browserTz(),
    q: opts.q === false || !s.q ? undefined : s.q,
  };
}

/** The PR list as the UI fetches it. No `group`: grouping is client-side (it only shapes format=md). */
export function prFetchParams(s: UrlState): PrQuery {
  return { ...scopeParams(s), state: s.state };
}

/** The PR list as exported / shown in the API tab (`group` sets the Markdown headings). */
export function prListParams(s: UrlState): PrQuery {
  return { ...prFetchParams(s), group: s.group };
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

export interface ExportTarget {
  endpoint: Endpoint;
  params: Record<string, string | number | undefined>;
  /** Whether the endpoint supports format=md. */
  md: boolean;
  label: string;
}

/** What the current view corresponds to in the API. */
export function exportTarget(view: ViewName, s: UrlState, repoName?: string): ExportTarget {
  switch (view) {
    case 'activity':
      return { endpoint: 'activity', params: { ...activityParams(s) }, md: true, label: 'activity feed' };
    case 'insights':
      return { endpoint: 'stats', params: { ...statsParams(s) }, md: false, label: 'insights' };
    case 'repo':
      return { endpoint: 'stats', params: { ...statsParams({ ...s, repos: repoName ? [repoName] : s.repos }) }, md: false, label: 'repository stats' };
    case 'repos':
      return { endpoint: 'repos', params: {}, md: false, label: 'repositories' };
    case 'settings':
      return { endpoint: 'settings', params: {}, md: false, label: 'settings' };
    case 'prs':
    default:
      return { endpoint: 'prs', params: { ...prListParams(s) }, md: true, label: 'pull requests' };
  }
}

export function exportUrl(t: ExportTarget, extra: Record<string, string | number | undefined> = {}): string {
  return apiUrl(t.endpoint, { ...t.params, ...extra });
}
