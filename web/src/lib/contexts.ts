/**
 * The context switcher's state (design §7.1). A context is one source (its host) or All. It lives in the URL as
 * `source=<host>` (absent = All), carried across tabs like `repos`; this module keeps each context's last place (path +
 * query, the drawer and diff included) in localStorage, so switching back returns to exactly where you were.
 */
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { GITHUB_HOST, type ProviderKind, type Repo, type Source } from '../../../shared/api';
import { viewFromPath } from './urlState';

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

/** A context: a source's host, or 'all'. */
export type Ctx = string;
export const ALL: Ctx = 'all';

/** The context a URL's query is in: its `source` (lower-case), or All. */
export function ctxOf(search: string): Ctx {
  return new URLSearchParams(search).get('source')?.trim().toLowerCase() || ALL;
}

export const PLACES_KEY = 'gh-dash:places';

/** localStorage `gh-dash:places`: the last context, and each context's last place ("/path?query"). */
export interface Places {
  v: 1;
  last: Ctx;
  places: Record<Ctx, string>;
}

const EMPTY: Places = { v: 1, last: ALL, places: {} };

/** Parse the stored value; anything unexpected reads as no memory. */
export function parsePlaces(raw: string | null): Places {
  try {
    const v = JSON.parse(raw ?? '') as Partial<Places> | null;
    if (!v || v.v !== 1 || typeof v.last !== 'string' || !v.places || typeof v.places !== 'object') return EMPTY;
    const places: Record<Ctx, string> = {};
    for (const [k, p] of Object.entries(v.places)) if (typeof p === 'string' && p.startsWith('/')) places[k] = p;
    return { v: 1, last: v.last, places };
  } catch {
    return EMPTY;
  }
}

/**
 * The memory after visiting `pathname` + `search`: that becomes its context's place, and the context the last one.
 * Settings is context-free and never recorded. `keep`: the contexts to keep (the sources present, and All); others are
 * dropped, so a removed source doesn't linger.
 */
export function recordPlace(p: Places, pathname: string, search: string, keep?: readonly Ctx[]): Places {
  if (viewFromPath(pathname) === 'settings') return p;
  const ctx = ctxOf(search);
  const place = pathname + search;
  const stale = keep ? Object.keys(p.places).filter((k) => k !== ALL && k !== ctx && !keep.includes(k)) : [];
  if (p.last === ctx && p.places[ctx] === place && !stale.length) return p;
  const places: Record<Ctx, string> = { ...p.places, [ctx]: place };
  for (const k of stale) delete places[k];
  return { v: 1, last: ctx, places };
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

/** Where `/` goes: the last context's last place, else the PR list. */
export function homePlace(p: Places): string {
  return p.places[p.last] ?? '/prs';
}

// ---------------------------------------------------------------------------- storage

let cache: Places | null = null;

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
}

/** Forget the in-memory copy (tests). */
export function resetPlacesCache() {
  cache = null;
}

// ---------------------------------------------------------------------------- hooks

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
