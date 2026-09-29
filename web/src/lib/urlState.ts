/**
 * URL = source of truth for every filter. One parser (with per-view defaults) and one
 * writer. Setters replace history entries while typing and push them for clicks.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { EVENT_TYPES } from '../../../shared/api';
import { encodeQueryValue } from '../../../shared/query';
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
  /** Diff open over the list and drawer: "<repo>#<n>" (a PR) or "<repo>@<oid>" (a commit). */
  diff: string | null;
  /** Path of the file in view in the open diff (only with `diff`). */
  file: string | null;
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

const decodeSegment = (seg: string) => { try { return decodeURIComponent(seg); } catch { return seg; } };

/**
 * Repo key on /repos/<owner>/<name> (a single segment is a bare key/alias), each segment URL-decoded.
 * Usable outside the matched route, e.g. in overlays.
 */
export function repoFromPath(pathname: string): string | undefined {
  const m = /^\/repos\/([^/].*?)\/?$/.exec(pathname);
  return m ? m[1]!.split('/').map(decodeSegment).join('/') : undefined;
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
    diff: null,
    file: null,
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
  const diff = p.get('diff');
  const diffOk = parseDiffId(diff) !== null;
  return {
    repos: reposRaw === null ? null : list(reposRaw),
    vis: oneOf(p.get('vis'), ['all', 'public', 'private', 'internal'] as const, d.vis),
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
    diff: diffOk ? diff : null,
    file: diffOk ? p.get('file') || null : null,
    sort: oneOf(p.get('sort'), ['activity', 'stars', 'open', 'name'] as const, d.sort),
    layout: oneOf(p.get('layout'), ['grid', 'list'] as const, d.layout),
  };
}

/** Param order in written URLs (unknown params are kept at the end). */
const ORDER = ['repos', 'vis', 'who', 'range', 'from', 'to', 'state', 'group', 'density', 'rel', 'types', 'q', 'sort', 'layout', 'pr', 'diff', 'file'];

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
  if (s.diff) {
    out.push(['diff', s.diff]);
    if (s.file) out.push(['file', s.file]);
  }
  return out;
}

/** Encode keeping ',', '/' and '@' readable (lists, file paths, commit diffs); '#', '&', spaces etc. are escaped. */
export function encodeParams(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeQueryValue(v)}`).join('&');
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

/** Params for what's open on top of a view (details, diff): never part of a saved view. */
export const OVERLAY_KEYS = ['pr', 'diff', 'file'];

/** Canonical query string (sorted, without `pr`/`diff`/`file`) for comparing saved views. */
export function canonicalQuery(query: string): string {
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  for (const k of OVERLAY_KEYS) p.delete(k);
  const pairs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b));
  return encodeParams(pairs);
}

export type DiffTarget =
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'commit'; repo: string; oid: string };

/** A PR's diff param is its id ("<repo>#<n>", like `pr`); a commit's is "<repo>@<oid>". */
export const commitDiffId = (repo: string, oid: string) => `${repo}@${oid}`;

/** Parse a `diff` param; null when malformed. Commit oids may be abbreviated (7–40 hex chars). */
export function parseDiffId(id: string | null): DiffTarget | null {
  const m = id ? /^([^#@\s]+)(?:#([1-9]\d{0,9})|@([0-9a-f]{7,40}))$/i.exec(id) : null;
  if (!m) return null;
  return m[2] ? { kind: 'pr', repo: m[1], number: Number(m[2]) } : { kind: 'commit', repo: m[1], oid: m[3] };
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
