/**
 * Legacy repo references in the address bar (a bare name where the key is `owner/name`) are rewritten to keys in
 * place, once the repo list is loaded, so everything downstream only ever sees canonical keys. Entries that name
 * no known repo are left alone.
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { repoPath, repoResolver } from '../../../shared/repos';
import { useRepos } from '../api/hooks';
import { encodeParams, parseDiffId, repoFromPath } from './urlState';

/** Swap the repo part (a prefix of `id`) for its key, or return `id` when it is already one (or unknown). */
function withKey(id: string, repo: string, resolve: (input: string) => string | null): string {
  const key = resolve(repo);
  return key !== null && key !== repo ? key + id.slice(repo.length) : id;
}

/**
 * The location with legacy repo references replaced by keys: `repos=` entries, the repo part of `pr=` / `diff=`, and
 * a `/repos/<name>` path. Null when nothing needs to change (the common case, and always after one rewrite).
 */
export function canonicalRepoUrl(pathname: string, search: string, resolve: (input: string) => string | null): { pathname: string; search: string } | null {
  let nextPath = pathname;
  const fromPath = repoFromPath(pathname);
  if (fromPath !== undefined) {
    const key = resolve(fromPath);
    if (key !== null && key !== fromPath) nextPath = repoPath(key);
  }

  let searchChanged = false;
  const pairs = [...new URLSearchParams(search)].map(([k, v]): [string, string] => {
    let next = v;
    if (k === 'repos') {
      const entries = v.split(',').map((e) => e.trim()).filter(Boolean);
      const resolved = entries.map((e) => resolve(e) ?? e);
      if (resolved.some((e, i) => e !== entries[i])) next = [...new Set(resolved)].join(',');
    } else if (k === 'pr') {
      const i = v.lastIndexOf('#');
      if (i > 0) next = withKey(v, v.slice(0, i), resolve);
    } else if (k === 'diff') {
      const t = parseDiffId(v);
      if (t) next = withKey(v, t.repo, resolve);
    }
    if (next !== v) searchChanged = true;
    return [k, next];
  });

  if (nextPath === pathname && !searchChanged) return null;
  return { pathname: nextPath, search: searchChanged ? `?${encodeParams(pairs)}` : search };
}

/** Mount once in the app shell. Replaces the history entry (never pushes), and does nothing until repos are loaded. */
export function useCanonicalRepoUrl(): void {
  const { data } = useRepos();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const resolve = useMemo(() => (data ? repoResolver(data) : null), [data]);
  useEffect(() => {
    const next = resolve && canonicalRepoUrl(pathname, search, resolve);
    if (next) navigate({ ...next, hash }, { replace: true });
  }, [resolve, pathname, search, hash, navigate]);
}
