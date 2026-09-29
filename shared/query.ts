// Query strings and paths in the form the web app writes them. Shared with the server, which stores saved views
// (path + query) and rewrites old ones when repository names change form.

import { repoFromPath, repoPath } from './repos';

/** Encodes one query value, keeping ',', '/' and '@' readable (lists, repo keys, file paths, commit diffs). */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2C/gi, ',').replace(/%2F/gi, '/').replace(/%40/g, '@');
}

/** The canonical key a repo reference names, or null to leave the reference as it is. */
export type RepoResolver = (repo: string) => string | null;

/** Percent-decodes, or null when the escapes are malformed. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A `repos` list with its entries resolved; the value itself when none changes. */
function rewriteList(value: string, resolve: RepoResolver): string {
  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  const keys = entries.map((e) => resolve(e) ?? e);
  return keys.some((k, i) => k !== entries[i]) ? [...new Set(keys)].join(',') : value;
}

/** "<repo>#<n>" or "<repo>@<oid>" (the `pr` and `diff` params) with its repo part resolved. */
function rewriteRef(value: string, resolve: RepoResolver): string {
  // Keys never contain '#' or '@', so the repo part ends at the first of them.
  const m = /^([^#@]+)([#@][\s\S]*)$/.exec(value);
  const key = m && resolve(m[1]!);
  return m && key ? key + m[2] : value;
}

/**
 * Rewrites the repo references in a query string to canonical keys: each entry of `repos` (a comma list; entries
 * that end up naming the same repo collapse) and the repo part of `pr` and `diff`. A rewritten param is re-encoded
 * like the web app writes it; every other byte stays as it was, so a query with nothing to rewrite comes back
 * unchanged. Used for saved views (migration and POST /views) and for legacy links in the address bar.
 */
export function rewriteRepoParams(query: string, resolve: RepoResolver): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? '' : pair.slice(0, eq);
      if (name !== 'repos' && name !== 'pr' && name !== 'diff') return pair;
      // Decoded like URLSearchParams does: '+' is a space.
      const value = decode(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (value === null) return pair;
      const next = name === 'repos' ? rewriteList(value, resolve) : rewriteRef(value, resolve);
      return next === value ? pair : `${name}=${encodeQueryValue(next)}`;
    })
    .join('&');
}

/** Rewrites a repository page path (`/repos/<name>`, or a key in another case) to the key's `repoPath`. */
export function rewriteRepoPath(path: string, resolve: RepoResolver): string {
  const repo = repoFromPath(path);
  const key = repo === undefined ? null : resolve(repo);
  return key !== null && key !== repo ? repoPath(key) : path;
}
