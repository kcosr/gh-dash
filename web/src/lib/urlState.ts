/**
 * URL = source of truth for every filter. One parser (with per-view defaults) and one
 * writer. Setters replace history entries while typing and push them for clicks.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { EVENT_TYPES } from '../../../shared/api';
import type { EventType, GroupBy, PrStateFilter, VisibilityFilter, Who } from '../../../shared/api';
import { RANGE_IDS, resolveRange } from './range';
import type { RangeId, ResolvedRange } from './range';
import { isValidDateOnly } from './time';

export type ViewName = 'prs' | 'issues' | 'activity' | 'repos' | 'repo' | 'insights' | 'settings';
export type Density = 'titles' | 'summary' | 'full';
export type RepoSort = 'activity' | 'stars' | 'open' | 'name';
export type RepoLayout = 'grid' | 'list';

export interface UrlState {
  /** null = default scope (param absent); [] = explicitly nothing. */
  repos: string[] | null;
  vis: VisibilityFilter;
  who: Who;
  range: RangeId;
  from: string | null;
  to: string | null;
  state: PrStateFilter;
  group: GroupBy;
  density: Density;
  rel: boolean;
  types: EventType[];
  q: string;
  /** "<repo>#<n>" open in the drawer. */
  pr: string | null;
  // /repos only
  sort: RepoSort;
  layout: RepoLayout;
}

export type UrlPatch = Partial<UrlState>;

export function viewFromPath(pathname: string): ViewName {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/issues') return 'issues';
  if (p.startsWith('/activity')) return 'activity';
  if (p === '/repos') return 'repos';
  if (p.startsWith('/repos/')) return 'repo';
  if (p.startsWith('/insights')) return 'insights';
  if (p.startsWith('/settings')) return 'settings';
  return 'prs';
}

/** Repo name on /repos/:name (usable outside the matched route, e.g. in overlays). */
export function repoFromPath(pathname: string): string | undefined {
  const m = /^\/repos\/([^/]+)\/?$/.exec(pathname);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

export function defaultsFor(view: ViewName): UrlState {
  return {
    repos: null,
    vis: 'all',
    who: view === 'prs' ? 'me' : 'everyone',
    range: view === 'insights' ? '90d' : '30d',
    from: null,
    to: null,
    state: view === 'issues' ? 'open' : 'merged',
    group: 'week',
    density: 'summary',
    rel: true,
    types: [...EVENT_TYPES],
    q: '',
    pr: null,
    sort: 'activity',
    layout: 'grid',
  };
}

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T =>
  v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

const list = (v: string) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];

export function parseUrlState(search: string, view: ViewName): UrlState {
  const p = new URLSearchParams(search);
  const d = defaultsFor(view);
  const reposRaw = p.get('repos');
  let range = oneOf(p.get('range'), RANGE_IDS, d.range);
  const from = p.get('from'), to = p.get('to');
  const customOk = isValidDateOnly(from) && isValidDateOnly(to);
  if (range === 'custom' && !customOk) range = d.range;
  const typesRaw = p.get('types');
  const typesValid = typesRaw === null ? [] : list(typesRaw).filter((t): t is EventType => (EVENT_TYPES as string[]).includes(t));
  // `types=` (empty) is an explicit "none"; a value naming no known type (typo, old link) is ignored.
  const typesDefault = typesRaw === null || (typesValid.length === 0 && typesRaw.trim() !== '');
  const pr = p.get('pr');
  return {
    repos: reposRaw === null ? null : list(reposRaw),
    vis: oneOf(p.get('vis'), ['all', 'public', 'private'] as const, d.vis),
    who: oneOf(p.get('who'), ['me', 'others', 'everyone'] as const, d.who),
    range,
    from: range === 'custom' ? from : null,
    to: range === 'custom' ? to : null,
    state: oneOf(p.get('state'), view === 'issues' ? ['open', 'closed', 'all'] as const : ['open', 'merged', 'closed', 'all'] as const, d.state),
    group: oneOf(p.get('group'), ['day', 'week', 'month', 'repo'] as const, d.group),
    density: oneOf(p.get('density'), ['titles', 'summary', 'full'] as const, d.density),
    rel: p.get('rel') !== '0',
    // keep canonical EVENT_TYPES order
    types: typesDefault ? d.types : EVENT_TYPES.filter((t) => typesValid.includes(t)),
    q: p.get('q') ?? '',
    pr: pr && /^[^#\s]+#\d+$/.test(pr) ? pr : null,
    sort: oneOf(p.get('sort'), ['activity', 'stars', 'open', 'name'] as const, d.sort),
    layout: oneOf(p.get('layout'), ['grid', 'list'] as const, d.layout),
  };
}

/** Param order in written URLs (unknown params are kept at the end). */
const ORDER = ['repos', 'vis', 'who', 'range', 'from', 'to', 'state', 'group', 'density', 'rel', 'types', 'q', 'sort', 'layout', 'pr'];

/** Serialize a full state to params, omitting defaults for the view. */
function toParams(s: UrlState, view: ViewName): [string, string][] {
  const d = defaultsFor(view);
  const out: [string, string][] = [];
  if (s.repos !== null) out.push(['repos', s.repos.join(',')]);
  if (s.vis !== d.vis) out.push(['vis', s.vis]);
  if (s.who !== d.who) out.push(['who', s.who]);
  if (s.range === 'custom' && s.from && s.to) out.push(['range', 'custom'], ['from', s.from], ['to', s.to]);
  else if (s.range !== d.range && s.range !== 'custom') out.push(['range', s.range]);
  if (s.state !== d.state) out.push(['state', s.state]);
  if (s.group !== d.group) out.push(['group', s.group]);
  if (s.density !== d.density) out.push(['density', s.density]);
  if (!s.rel) out.push(['rel', '0']);
  if (s.types.length !== d.types.length) out.push(['types', s.types.join(',')]);
  if (s.q) out.push(['q', s.q]);
  if (s.sort !== d.sort) out.push(['sort', s.sort]);
  if (s.layout !== d.layout) out.push(['layout', s.layout]);
  if (s.pr) out.push(['pr', s.pr]);
  return out;
}

/** Encode keeping ',' readable; '#', '&', spaces etc. are escaped. */
export function encodeParams(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`).join('&');
}

/** Apply a patch to a search string for a view; returns "?..." or "". */
export function patchSearch(search: string, view: ViewName, patch: UrlPatch): string {
  const cur = parseUrlState(search, view);
  const next = { ...cur, ...patch };
  if (patch.range && patch.range !== 'custom') { next.from = null; next.to = null; }
  const pairs = toParams(next, view);
  // keep params we don't know about
  const known = new Set(ORDER);
  // Retired repository toggles: selection is now controlled entirely by the sidebar.
  known.add('archived');
  known.add('forks');
  for (const [k, v] of new URLSearchParams(search)) if (!known.has(k)) pairs.push([k, v]);
  const qs = encodeParams(pairs);
  return qs ? `?${qs}` : '';
}

/** Scope params carried across top-level navigation. */
export const SCOPE_KEYS = ['repos', 'vis', 'who', 'range', 'from', 'to'];

export function carrySearch(search: string, keys = SCOPE_KEYS): string {
  const p = new URLSearchParams(search);
  const pairs: [string, string][] = [];
  for (const k of keys) { const v = p.get(k); if (v !== null) pairs.push([k, v]); }
  const qs = encodeParams(pairs);
  return qs ? `?${qs}` : '';
}

/** Canonical query string (sorted, without `pr`) for comparing saved views. */
export function canonicalQuery(query: string): string {
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  p.delete('pr');
  const pairs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  return encodeParams(pairs);
}

export function useUrlState() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const s = useMemo(() => parseUrlState(location.search, view), [location.search, view]);
  const range: ResolvedRange = useMemo(() => resolveRange(s.range, s.from, s.to), [s.range, s.from, s.to]);

  // Successive set() calls in one tick must build on each other.
  const latest = useRef(location.search);
  latest.current = location.search;

  const set = useCallback(
    (patch: UrlPatch, opts: { replace?: boolean } = {}) => {
      const search = patchSearch(latest.current, view, patch);
      if (search === latest.current) return;
      latest.current = search;
      navigate({ pathname: location.pathname, search }, { replace: !!opts.replace });
    },
    [navigate, location.pathname, view],
  );

  return { s, set, view, range, location, navigate };
}
