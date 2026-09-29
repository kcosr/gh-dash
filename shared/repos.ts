import { GITHUB_HOST, type Repo, type RepoQuery } from './api';

/** What the helpers below need of a repo (the API's `Repo` has all of it; without `owner` the key's is used). */
export type RepoIdent = Pick<Repo, 'key' | 'name' | 'trackedBy' | 'source'> & Partial<Pick<Repo, 'owner'>>;

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
 *  2. an input without '/' naming an owned github.com repo by its short name, case-insensitive (links from before keys
 *     had owners were all GitHub; a short name isn't unique across sources).
 * Nothing else: a bare name that matches only a manually added repo, or a repo on another source, resolves to null.
 * Returns the canonical key. (The server implements the same rule in SQL: REPO_IDS_FOR_KEYS.)
 */
export function repoResolver<R extends RepoIdent>(repos: RepoSource<R>): (input: string) => string | null {
  const byKey = new Map<string, string>();
  const byOwnedName = new Map<string, string>();
  for (const r of list(repos)) {
    const k = r.key.toLowerCase();
    if (!byKey.has(k)) byKey.set(k, r.key);
    const n = r.name.toLowerCase();
    if (r.trackedBy === 'owned' && r.source === GITHUB_HOST && !byOwnedName.has(n)) byOwnedName.set(n, r.key);
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
 * How a repo is displayed, in two parts: `owner` is shown muted before the name, and is null for a repo you own
 * (its bare name is enough) and for a key without an owner. Anything else keeps its owner: the repo's own (on GitLab
 * the namespace path, `platform/team`), so a source's host is never shown as part of a name (the source badge says
 * it). A key that is no longer in the list is split at its last '/', after dropping a leading host (a first segment
 * with a '.', in a key with two '/' or more), so nested paths stay whole.
 */
export function repoParts<R extends RepoIdent>(key: string, repos: RepoSource<R>): { owner: string | null; name: string } {
  const r = repos instanceof Map ? repos.get(key) : (repos as readonly R[]).find((x) => x.key === key);
  if (r?.trackedBy === 'owned') return { owner: null, name: r.name };
  if (r?.owner) return { owner: r.owner, name: r.name };
  const first = key.indexOf('/');
  const hosted = first > 0 && key.indexOf('/', first + 1) > 0 && key.slice(0, first).includes('.');
  return splitKey(hosted ? key.slice(first + 1) : key);
}

/**
 * Plain-text name of a repo for attributes, titles and copied text: the short name for a repo you own, the whole
 * `owner/name` for anything else (and for a key that is no longer in the list). The text `<RepoName>` shows.
 */
export function repoLabel<R extends RepoIdent>(key: string, repos: RepoSource<R>): string {
  const { owner, name } = repoParts(key, repos);
  return owner === null ? name : `${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// "<repo>#<n>" and "<repo>!<n>" references typed into the command palette
// ---------------------------------------------------------------------------

/** `key#123` (a GitHub PR) or `key!123` (a GitLab MR), where the repo part is a key (`owner/name`, possibly nested) or a bare name. */
export const REPO_REF_RE = /^([\w.-]+(?:\/[\w.-]+)*)([#!])(\d+)$/;

/** Match a palette query against `REPO_REF_RE`. `number` stays a string: it is typed as a prefix. */
export function matchRepoRef(text: string): { repo: string; sep: '#' | '!'; number: string } | null {
  const m = REPO_REF_RE.exec(text);
  return m ? { repo: m[1]!, sep: m[2] as '#' | '!', number: m[3]! } : null;
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

/**
 * The repos a palette reference means (`repoRefKeys` over narrowing pools, the first that matches wins):
 *  - `name!n` is a GitLab MR: GitLab repos only, the context's first. None: null, it isn't a reference (so a GitHub
 *    user's `x!12` stays a text search);
 *  - `name#n` is a GitHub PR: GitHub repos of the context, then any of the context's (GitLab users type `#` too), then
 *    GitHub repos, then any. None: [], the server decides.
 * `context`: the context's source host; null in All.
 */
export function paletteRefKeys<R extends RepoIdent & Pick<Repo, 'provider'>>(
  ref: { repo: string; sep: '#' | '!' },
  repos: RepoSource<R>,
  context: string | null,
): string[] | null {
  const all = list(repos);
  const here = (pool: readonly R[]) => (context ? pool.filter((r) => r.source === context) : null);
  const ofKind = all.filter((r) => r.provider === (ref.sep === '!' ? 'gitlab' : 'github'));
  const pools = ref.sep === '!' ? [here(ofKind), ofKind] : [here(ofKind), here(all), ofKind, all];
  for (const pool of pools) {
    const keys = pool ? repoRefKeys(ref.repo, pool) : [];
    if (keys.length) return keys;
  }
  return ref.sep === '!' ? null : [];
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

/** GitHub's input: `owner/name`, a github.com URL or a git@github.com address (`parseRepoInput`, by its source's name). */
export const parseGitHubInput = parseRepoInput;

// ---------------------------------------------------------------------------
// Adding a repository on any source (design section 4.8)
// ---------------------------------------------------------------------------

/** A GitLab path segment: a group, subgroup or project path (GitLab refuses one that starts with '-'). */
const SEGMENT_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
/** A host name as a key's first segment may carry it: labels of letters, digits and hyphens, at least one dot. */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A source as the input parsers know it: its host, and its web URL with any relative root ("https://example.com/gitlab"). */
export interface InputSource {
  host: string;
  baseUrl: string;
}

/**
 * Where an input points: the host it names (lower-case, without the port; www.github.com is github.com) and the rest.
 * - `https://host[:port]/path` (or http): `web`, `rest` is the URL's path (query and fragment dropped).
 * - `git@host:path`, `ssh://[user@]host[:port]/path`: `rest` is the path (ssh paths have no relative root).
 * - `host/path`, a key: when `host` is github.com (or www.) or one of `known`, `rest` is the path after it.
 * - anything else names no host: `host` is null and `rest` the whole input.
 * null when an address doesn't parse, or carries credentials.
 */
function locate(t: string, known: readonly string[]): { host: string | null; rest: string; web: boolean } | null {
  const hostOf = (h: string) => {
    const host = h.toLowerCase().replace(/\.$/, '');
    return host === 'www.github.com' ? GITHUB_HOST : host;
  };
  if (/^(?:https?|ssh):\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    const ssh = /^ssh:/i.test(t);
    if (url.password || (url.username && !ssh)) return null;
    return { host: hostOf(url.hostname), rest: ssh ? url.pathname.slice(1) : url.pathname, web: !ssh };
  }
  const scp = /^[\w.-]+@([^:/\s]+):(.+)$/.exec(t);
  if (scp) return { host: hostOf(scp[1]!), rest: scp[2]!, web: false };
  const slash = t.indexOf('/');
  const first = slash < 0 ? '' : hostOf(t.slice(0, slash));
  if (first && (first === GITHUB_HOST || known.some((k) => k.toLowerCase() === first))) {
    return { host: first, rest: t.slice(slash + 1).replace(/[?#].*$/, ''), web: false };
  }
  return { host: null, rest: t, web: false };
}

/**
 * The host an input names, if any: a URL's or ssh address's host (lower-case, without the port), or a key's first
 * segment when it is github.com or one of `known` (the sources' hosts). With `guess`, also a key's first segment that
 * reads like a host name (`gitlab.example.com/group/project`: at least two segments follow), for an error that says the
 * host isn't a source rather than that the input isn't a path. null: the input names no host (`group/project`).
 */
export function inputHost(text: string, known: readonly string[] = [], opts: { guess?: boolean } = {}): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const at = locate(t, known);
  if (at?.host) return at.host;
  if (!opts.guess) return null;
  const segments = t.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/');
  const first = segments[0]!.toLowerCase();
  return segments.length >= 3 && HOST_RE.test(first) ? first : null;
}

/** The source an input's URL, ssh address or key names among `sources` (what the Add dialog switches to); else null. */
export function sourceForInput<S extends { host: string }>(text: string, sources: readonly S[]): S | null {
  const host = inputHost(text, sources.map((s) => s.host));
  return host === null ? null : (sources.find((s) => s.host.toLowerCase() === host) ?? null);
}

/**
 * A GitLab project's path (`group[/subgroup…]/project`, as typed) from what the user entered for `source`:
 * - the path itself;
 * - its key, `<host>/group/…/project`;
 * - a web URL, `https://<host>[/relative root]/group/…/project[/-/…][.git]` (the root must be `source`'s);
 * - an ssh address, `git@<host>:group/…/project.git` or `ssh://git@<host>[:port]/group/…/project.git`.
 * Segments are letters, digits, `_`, `.` and `-` (not first; never `.` or `..`), so a path can't contain '#', '@', ',',
 * '%', '?' or whitespace. null for anything else, including an address on another host.
 */
export function parseGitLabInput(text: string, source: InputSource): { path: string } | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  const at = locate(t, [source.host]);
  if (!at || (at.host !== null && at.host !== source.host.toLowerCase())) return null;
  let rest = at.rest;
  if (at.web) {
    let root: string;
    try {
      root = new URL(source.baseUrl).pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
    if (rest !== root && !rest.startsWith(`${root}/`)) return null;
    rest = rest.slice(root.length + 1);
  }
  // A page of the project (/-/merge_requests/3, /-/tree/main) names the project before it.
  const page = rest.search(/(?:^|\/)-(?:\/|$)/);
  if (page >= 0) rest = rest.slice(0, page);
  const segments = rest.replace(/\/+$/, '').split('/');
  if (segments.length < 2) return null;
  segments[segments.length - 1] = segments.at(-1)!.replace(/\.git$/i, '');
  if (!segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) return null;
  return { path: segments.join('/') };
}

// ---------------------------------------------------------------------------
// The repository list
// ---------------------------------------------------------------------------

/** Keys of the repos in the default selection: not archived, not hidden, not a fork (unless `includeForks`). */
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
  const sources = query.source?.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) ?? [];
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
    && (!sources.length || sources.includes(r.source))
    && (!query.visibility || query.visibility === 'all' || r.visibility === query.visibility)
    && (!query.ownership || query.ownership === 'all' || (query.ownership === 'mine') === (r.trackedBy === 'owned'))
    && (!text || `${r.key} ${r.description ?? ''} ${r.topics.join(' ')} ${r.language?.name ?? ''}`.toLowerCase().includes(text)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.hidden) - Number(b.hidden) || compare(a, b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
