import type { Repo, RepoQuery } from './api';

/** What the helpers below need of a repo (the API's `Repo` has all of it). */
export type RepoIdent = Pick<Repo, 'key' | 'name' | 'trackedBy'>;

/** Repositories as a list, or as a map keyed by `Repo.key` (what the web's `useRepoMap` returns). */
type RepoSource<R extends RepoIdent> = readonly R[] | ReadonlyMap<string, R>;

// ---------------------------------------------------------------------------
// Keys (docs: T2 design section 2)
// ---------------------------------------------------------------------------

/**
 * Split a key for display. The owner is everything before the LAST '/' (GitLab groups nest), null for a bare key.
 * Never use this for identity: compare whole keys. Prefer `Repo.owner` / `Repo.name` when the object is at hand.
 */
export function splitKey(key: string): { owner: string | null; name: string } {
  const i = key.lastIndexOf('/');
  return i < 0 ? { owner: null, name: key } : { owner: key.slice(0, i), name: key.slice(i + 1) };
}

/** The SPA route of a repo's page: `/repos/<owner>/<name>`, each segment URL-encoded (a bare key gives `/repos/<name>`). */
export function repoPath(key: string): string {
  return `/repos/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const decodeSegment = (seg: string) => { try { return decodeURIComponent(seg); } catch { return seg; } };

/**
 * The repo named by a repo page path, `/repos/<owner>/<name>` (a single segment is a bare key or alias), each segment
 * URL-decoded; undefined for any other path. The inverse of `repoPath`.
 */
export function repoFromPath(pathname: string): string | undefined {
  const m = /^\/repos\/([^/].*?)\/?$/.exec(pathname);
  return m ? m[1]!.split('/').map(decodeSegment).join('/') : undefined;
}

const list = <R extends RepoIdent>(repos: RepoSource<R>): readonly R[] => (repos instanceof Map ? [...repos.values()] : (repos as readonly R[]));

/**
 * The resolution rule for a repo named in a URL, a saved list or a reference (docs section 2.2), over live repos:
 *  1. an exact key, case-insensitive; or
 *  2. an input without '/' naming an owned repo by its short name, case-insensitive.
 * Nothing else: a bare name that matches only a manually added repo resolves to null.
 * Returns the canonical key. (The server implements the same rule in SQL: REPO_IDS_FOR_KEYS.)
 */
export function repoResolver<R extends RepoIdent>(repos: RepoSource<R>): (input: string) => string | null {
  const byKey = new Map<string, string>();
  const byOwnedName = new Map<string, string>();
  for (const r of list(repos)) {
    const k = r.key.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, r.key);
    const n = r.name.toLowerCase();
    if (r.trackedBy === 'owned' && !byOwnedName.has(n)) byOwnedName.set(n, r.key);
  }
  return (input) => {
    const lower = input.toLowerCase();
    return byKey.get(lower) ?? (input.includes('/') ? null : byOwnedName.get(lower) ?? null);
  };
}

export function resolveRepoKey<R extends RepoIdent>(input: string, repos: RepoSource<R>): string | null {
  return repoResolver(repos)(input);
}

/**
 * Plain-text name of a repo for attributes, titles and copied text: the short name for a repo you own, the whole
 * `owner/name` for anything else (and for a key that is no longer in the list).
 */
export function repoLabel<R extends RepoIdent>(key: string, repos: RepoSource<R>): string {
  const r = repos instanceof Map ? repos.get(key) : (repos as readonly R[]).find((x) => x.key === key);
  return r && r.trackedBy === 'owned' ? r.name : key;
}

// ---------------------------------------------------------------------------
// "<repo>#<n>" references typed into the command palette
// ---------------------------------------------------------------------------

/** `key#123`, where the repo part is a key (`owner/name`, possibly nested) or a bare name. */
export const REPO_REF_RE = /^([\w.-]+(?:\/[\w.-]+)*)#(\d+)$/;

/** Match a palette query against `REPO_REF_RE`. `number` stays a string: it is typed as a prefix. */
export function matchRepoRef(text: string): { repo: string; number: string } | null {
  const m = REPO_REF_RE.exec(text);
  return m ? { repo: m[1]!, number: m[2]! } : null;
}

/**
 * The repos a reference's repo part can mean: the one `resolveRepoKey` finds, else every tracked repo with that short
 * name (the palette is a search, not a key). Empty when nothing matches.
 */
export function repoRefKeys<R extends RepoIdent>(part: string, repos: RepoSource<R>): string[] {
  const key = resolveRepoKey(part, repos);
  if (key) return [key];
  const lower = part.toLowerCase();
  return list(repos).filter((r) => r.name.toLowerCase() === lower).map((r) => r.key);
}

// ---------------------------------------------------------------------------
// Adding a repository: what the user types (docs section 4.2)
// ---------------------------------------------------------------------------

const OWNER_RE = /^[A-Za-z0-9-]+$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function ownerName(owner: string | undefined, name: string | undefined): { owner: string; name: string } | null {
  if (!owner || !name) return null;
  name = name.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}

/**
 * `owner/name`, `https://github.com/owner/name[/anything][.git]`, `github.com/owner/name` or
 * `git@github.com:owner/name[.git]` -> { owner, name }; null for anything else, including other hosts.
 * Characters are limited to those GitHub allows, so a parsed repo can't contain '#', '@', ',', '%' or whitespace.
 */
export function parseRepoInput(text: string): { owner: string; name: string } | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;

  const ssh = /^git@([^:/\s]+):(.+)$/i.exec(t);
  if (ssh) {
    if (ssh[1]!.toLowerCase() !== 'github.com') return null;
    const [owner, name, ...rest] = ssh[2]!.replace(/\/+$/, '').split('/');
    return rest.length ? null : ownerName(owner, name);
  }

  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(t);
  if (url) {
    // A pasted browser address may carry a query or fragment; they don't name anything.
    const [owner, name] = url[1]!.replace(/[?#].*$/, '').split('/');
    return ownerName(owner, name);
  }
  // Anything else with a scheme or a host (gitlab.com/o/n, ssh://...) has too many segments or a bad owner below.
  const [owner, name, ...rest] = t.replace(/\/+$/, '').split('/');
  return rest.length ? null : ownerName(owner, name);
}

// ---------------------------------------------------------------------------
// The repository list
// ---------------------------------------------------------------------------

/** Keys of the repos in the default scope: not archived, not hidden, not a fork (unless `includeForks`). */
export function defaultRepoScope(repos: Repo[], includeForks = false): string[] {
  return repos.filter((r) => !r.isArchived && !r.hidden && (!r.isFork || includeForks)).map((r) => r.key);
}

/** Shared by the repository tab and its API export so scope, search and ordering agree. */
export function selectRepos(repos: Repo[], query: RepoQuery, includeForks = false): Repo[] {
  let selected: Set<string> | null;
  if (query.repos !== undefined) {
    // Entries are keys or aliases (a bare name of an owned repo); ones that name no repo select nothing.
    const resolve = repoResolver(repos);
    selected = new Set(query.repos.split(',').map((e) => e.trim()).filter(Boolean).map(resolve).filter((k): k is string => k !== null));
  } else {
    selected = query.scope === 'default' ? new Set(defaultRepoScope(repos, includeForks)) : null;
  }
  const text = query.q?.trim().toLowerCase() ?? '';
  const activity = (r: Repo) => r.lastActivityAt ?? r.pushedAt ?? r.createdAt;
  const compare = (a: Repo, b: Repo) => {
    switch (query.sort) {
      case 'stars': return b.stars - a.stars;
      case 'open': return b.stats.openPrs - a.stats.openPrs;
      case 'name': return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
      default: return activity(b).localeCompare(activity(a));
    }
  };
  return repos.filter((r) => (!selected || selected.has(r.key))
    && (!query.visibility || query.visibility === 'all' || r.visibility === query.visibility)
    && (!query.ownership || query.ownership === 'all' || (query.ownership === 'mine') === (r.trackedBy === 'owned'))
    && (!text || `${r.key} ${r.description ?? ''} ${r.topics.join(' ')} ${r.language?.name ?? ''}`.toLowerCase().includes(text)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.hidden) - Number(b.hidden) || compare(a, b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
