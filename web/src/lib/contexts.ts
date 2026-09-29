/**
 * The context switcher's state (design §7.1). A context is one source (its host) or All. It lives in the URL as
 * `source=<host>` (absent = All), carried across tabs like `repos`; this module keeps each context's last place (path +
 * query, the drawer and diff included) in localStorage, so switching back returns to exactly where you were. It also
 * keeps, per context, each list view's last settings (the query less the drawer and diff), so a tab leads back to the
 * view as you left it.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { GITHUB_HOST, type ProviderKind, type Repo, type Source } from '../../../shared/api';
import { OVERLAY_KEYS, SCOPE_KEYS, carrySearch, orderedSearch, paramsExcept, viewFromPath } from './urlState';

/** A source as the switcher shows it. */
export interface SourceInfo {
  host: string;
  kind: ProviderKind;
  /** 'GitHub', 'GitLab', or the host while there are several GitLab sources (the server names them the same way). */
  name: string;
}

/**
 * The sources present (design §7.1): each source with a live repo, and each one `/sources` says is set up here, so a
 * source added a moment ago is there before its first repos land: a GitLab this server configures, github.com while it
 * has a token. (github.com with neither stays out: a GitLab-only user never sees an empty GitHub.) github.com first,
 * then by host. `sources`: GET /sources, or null while it loads (the repos alone decide until then).
 */
export function presentSources(
  repos: readonly Pick<Repo, 'source' | 'provider'>[],
  sources: readonly Pick<Source, 'host' | 'kind' | 'configured' | 'account'>[] | null = null,
): SourceInfo[] {
  const kinds = new Map<string, ProviderKind>();
  for (const r of repos) if (!kinds.has(r.source)) kinds.set(r.source, r.provider);
  for (const s of sources ?? []) {
    const setUp = s.kind === 'github' ? !!s.account && s.account.source !== 'none' : s.configured;
    if (setUp && !kinds.has(s.host)) kinds.set(s.host, s.kind);
  }
  const hosts = [...kinds.keys()].sort((a, b) => Number(b === GITHUB_HOST) - Number(a === GITHUB_HOST) || a.localeCompare(b));
  const gitlabs = hosts.filter((h) => kinds.get(h) === 'gitlab').length;
  return hosts.map((host) => {
    const kind = kinds.get(host)!;
    return { host, kind, name: kind === 'github' ? 'GitHub' : gitlabs > 1 ? host : 'GitLab' };
  });
}

/** The app's root (`/`, `/?query`): the redirect to a place, never a place itself. */
const isRoot = (place: string) => /^\/+(?:[?#]|$)/.test(place);

/** A context: a source's host, or 'all'. */
export type Ctx = string;
export const ALL: Ctx = 'all';

/** The context a URL's query is in: its `source` (lower-case), or All. */
export function ctxOf(search: string): Ctx {
  return new URLSearchParams(search).get('source')?.trim().toLowerCase() || ALL;
}

export const PLACES_KEY = 'gh-dash:places';

/** The views with a tab in the top bar. Settings and a repo's page are not: they aren't remembered as views. */
export type TabView = 'prs' | 'issues' | 'activity' | 'repos' | 'insights';
const TAB_VIEWS: readonly TabView[] = ['prs', 'issues', 'activity', 'repos', 'insights'];

/** The tab a path is (`/prs`, `/prs/`), else undefined: a repo's page (`/repos/<key>`), Settings, and unknown paths. */
const tabOf = (pathname: string) => TAB_VIEWS.find((t) => pathname.replace(/\/+$/, '').toLowerCase() === `/${t}`);

/** localStorage `gh-dash:places`: the last context, each context's last place ("/path?query"), and its views' last. */
export interface Places {
  v: 1;
  last: Ctx;
  places: Record<Ctx, string>;
  /** Each context's tab views' last places, less the overlay params (added later: a stored value may lack it). */
  views: Record<Ctx, Partial<Record<TabView, string>>>;
}

const EMPTY: Places = { v: 1, last: ALL, places: {}, views: {} };

/** Parse the stored value; anything unexpected reads as no memory. */
export function parsePlaces(raw: string | null): Places {
  try {
    const v = JSON.parse(raw ?? '') as { v?: unknown; last?: unknown; places?: unknown; views?: unknown } | null;
    if (!v || v.v !== 1 || typeof v.last !== 'string' || !v.places || typeof v.places !== 'object') return EMPTY;
    const places: Record<Ctx, string> = {};
    // `/` is where the app starts, not a place: it redirects to one (see recordPlace).
    for (const [k, p] of Object.entries(v.places)) if (typeof p === 'string' && p.startsWith('/') && !isRoot(p)) places[k] = p;
    return { v: 1, last: v.last, places, views: parseViews(v.views) };
  } catch {
    return EMPTY;
  }
}

/** The views stored: what isn't a tab's own place ("/prs", "/prs?query") reads as nothing, not as an error. */
function parseViews(raw: unknown): Places['views'] {
  const views: Places['views'] = {};
  if (!raw || typeof raw !== 'object') return views;
  for (const [ctx, byView] of Object.entries(raw)) {
    if (!byView || typeof byView !== 'object') continue;
    const mine: Partial<Record<TabView, string>> = {};
    for (const t of TAB_VIEWS) {
      const place: unknown = (byView as Record<string, unknown>)[t];
      if (typeof place === 'string' && (place === `/${t}` || place.startsWith(`/${t}?`))) mine[t] = place;
    }
    if (Object.keys(mine).length) views[ctx] = mine;
  }
  return views;
}

/**
 * The memory after visiting `pathname` + `search`: that becomes its context's place, and the context the last one.
 * Settings is context-free and never recorded. Nor is `/`: it only redirects to the last place, and a render can still
 * be at `/` for a moment while that navigation is pending; recorded, switching to its context would land on `/` and be
 * sent to another context (or back to `/`). A tab's list view is also that context's last place of the view, without
 * the drawer and diff; a repo's page is not (it's no tab). `keep`: the contexts to keep (the sources present, and All);
 * others are dropped, so a removed source doesn't linger.
 */
export function recordPlace(p: Places, pathname: string, search: string, keep?: readonly Ctx[]): Places {
  if (viewFromPath(pathname) === 'settings' || isRoot(pathname)) return p;
  const ctx = ctxOf(search);
  const place = pathname + search;
  const tab = tabOf(pathname);
  const seen = tab && `/${tab}${orderedSearch(paramsExcept(search, OVERLAY_KEYS))}`;
  const stale = keep ? [...new Set([...Object.keys(p.places), ...Object.keys(p.views)])].filter((k) => k !== ALL && k !== ctx && !keep.includes(k)) : [];
  if (p.last === ctx && p.places[ctx] === place && (!tab || p.views[ctx]?.[tab] === seen) && !stale.length) return p;
  const places: Record<Ctx, string> = { ...p.places, [ctx]: place };
  const views: Places['views'] = { ...p.views };
  if (tab && seen) views[ctx] = { ...views[ctx], [tab]: seen };
  for (const k of stale) { delete places[k]; delete views[k]; }
  return { v: 1, last: ctx, places, views };
}

/**
 * Where switching to `ctx` goes: its last place; with none, the view you're on (the PR list from a repo page or
 * Settings) with only the context in the query.
 */
export function placeFor(p: Places, ctx: Ctx, pathname: string): string {
  const stored = p.places[ctx];
  if (stored) return stored;
  const view = viewFromPath(pathname);
  const path = view === 'repo' || view === 'settings' ? '/prs' : pathname;
  return ctx === ALL ? path : `${path}?source=${encodeURIComponent(ctx)}`;
}

/**
 * Where a link to a top-level view goes (`path`: '/prs', '/issues', …) from the page at `pathname` + `search`: the view
 * as `ctx` last left it (its own settings: state, grouping, density …) under the scope of the page you're on. The
 * page's scope wins, so a param dropped here stays dropped. Settings has no scope: the remembered place goes as stored.
 * With nothing remembered (or no tab, like Settings) the view with the scope alone: the page's, or from Settings the
 * context's. `ctx`: the page's context, or on Settings the last one.
 */
export function viewHref(p: Places, ctx: Ctx, path: string, pathname: string, search: string): string {
  const tab = tabOf(path);
  const fromSettings = viewFromPath(pathname) === 'settings';
  const remembered = tab && p.views[ctx]?.[tab];
  if (tab && remembered) {
    const own = paramsExcept(remembered.replace(/^[^?]*/, ''), fromSettings ? OVERLAY_KEYS : [...OVERLAY_KEYS, ...SCOPE_KEYS]);
    const scope = fromSettings ? [] : [...new URLSearchParams(carrySearch(search))];
    return `/${tab}${orderedSearch([...scope, ...own])}`;
  }
  if (tab && fromSettings) return path + (ctx === ALL ? '' : `?source=${encodeURIComponent(ctx)}`);
  return path + carrySearch(search);
}

/** Where `/` goes: the last context's last place, else the PR list. */
export function homePlace(p: Places): string {
  return p.places[p.last] ?? '/prs';
}

// ---------------------------------------------------------------------------- storage

let cache: Places | null = null;
/** Counts writes, for `usePlaces`. */
let version = 0;
const listeners = new Set<() => void>();

/**
 * The memory. `fresh` reads storage again: before writing, and when switching, so another tab's places (it shares the
 * storage) aren't overwritten with this tab's older copy. Renders use the copy.
 */
export function readPlaces(opts: { fresh?: boolean } = {}): Places {
  if (!cache || opts.fresh) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(PLACES_KEY); } catch { /* private mode */ }
    cache = parsePlaces(raw);
  }
  return cache;
}

function writePlaces(p: Places) {
  cache = p;
  try { localStorage.setItem(PLACES_KEY, JSON.stringify(p)); } catch { /* private mode */ }
  version++;
  for (const l of listeners) l();
}

/** Forget the in-memory copy (tests). */
export function resetPlacesCache() {
  cache = null;
}

// ---------------------------------------------------------------------------- hooks

const subscribe = (onChange: () => void) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; };

/** The memory for rendering, which follows it: links built from it (the tabs) are redrawn when a place is recorded. */
export function usePlaces(): Places {
  useSyncExternalStore(subscribe, () => version);
  return readPlaces();
}

/**
 * Mount once in the shell: record every place as it's visited. `settled` is false while the URL is about to be
 * rewritten (a legacy key, an unknown source, the context following a repo), or can't be judged yet (repos not loaded):
 * such a URL is never a context's place, or switching back would land on it and be moved again. `keep`: the contexts
 * present, once known.
 */
export function useContextMemory(settled: boolean, keep: readonly Ctx[] | null): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!settled) return;
    const cur = readPlaces({ fresh: true });
    const next = recordPlace(cur, pathname, search, keep ?? undefined);
    if (next !== cur) writePlaces(next);
  }, [settled, pathname, search, keep]);
}

/** Switch context: one client-side navigation (a push, so Back returns to the previous context) to its last place. */
export function useSwitchContext(): (ctx: Ctx) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback((ctx: Ctx) => navigate(placeFor(readPlaces({ fresh: true }), ctx, pathname)), [navigate, pathname]);
}
