/**
 * Legacy repo references in the address bar (a bare name where the key is `owner/name`) are rewritten to keys in
 * place, once the repo list is loaded, so everything downstream only ever sees canonical keys. Entries that name
 * no known repo are left alone.
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type RepoResolver, rewriteRepoParams, rewriteRepoPath } from '../../../shared/query';
import { repoResolver } from '../../../shared/repos';
import { useRepos } from '../api/hooks';

/**
 * The location with legacy repo references replaced by keys: `repos=` entries, the repo part of `pr=` / `diff=`, and
 * a `/repos/<name>` path (the same rewrite the server applies to saved views). Params it doesn't rewrite keep their
 * bytes. Null when nothing needs to change (the common case, and always after one rewrite).
 */
export function canonicalRepoUrl(pathname: string, search: string, resolve: RepoResolver): { pathname: string; search: string } | null {
  const query = search.replace(/^\?/, '');
  const nextPath = rewriteRepoPath(pathname, resolve);
  const nextQuery = rewriteRepoParams(query, resolve);
  if (nextPath === pathname && nextQuery === query) return null;
  return { pathname: nextPath, search: nextQuery === query ? search : `?${nextQuery}` };
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
