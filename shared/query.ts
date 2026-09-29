// Query strings and paths in the form the web app writes them. Shared with the server, which stores saved views
// (path + query) and rewrites old ones when repository names change form.

/** Encodes one query value, keeping ',', '/' and '@' readable (lists, repo keys, file paths, commit diffs). */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2C/gi, ',').replace(/%2F/gi, '/').replace(/%40/g, '@');
}

/** The repo key a (legacy) repo reference names, or null to leave the reference as it is. */
export type RepoResolver = (repo: string) => string | null;

/** Percent-decodes, or null when the escapes are malformed. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** "<repo>#<n>" or "<repo>@<oid>" (the `pr` and `diff` params) with its repo part resolved. */
function rewriteRef(value: string, resolve: RepoResolver): string {
  const m = /^([^#@]+)([#@][\s\S]*)$/.exec(value);
  const key = m && resolve(m[1]!);
  return m && key ? key + m[2] : value;
}

/**
 * Rewrites the repo references in a query string: each entry of `repos` (a comma list) and the repo part of `pr`
 * and `diff`. A rewritten param is re-encoded like the web app writes it; every other byte stays as it was, so a
 * query with nothing to resolve comes back unchanged.
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
      const next = name === 'repos'
        ? value.split(',').map((entry) => resolve(entry.trim()) ?? entry).join(',')
        : rewriteRef(value, resolve);
      return next === value ? pair : `${name}=${encodeQueryValue(next)}`;
    })
    .join('&');
}

/** Rewrites a repository page path, `/repos/<name>`, to `/repos/<key>` (each key segment encoded). */
export function rewriteRepoPath(path: string, resolve: RepoResolver): string {
  const m = /^\/repos\/([^/]+)\/?$/.exec(path);
  const segment = m && decode(m[1]!);
  const key = segment && resolve(segment);
  return key ? `/repos/${key.split('/').map(encodeURIComponent).join('/')}` : path;
}
