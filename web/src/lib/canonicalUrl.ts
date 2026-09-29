/**
 * The address bar, made canonical in place once the repo list is loaded (always a replace, never a push):
 *  - legacy repo references (a bare name where the key is `owner/name`) become keys, so everything downstream only
 *    ever sees canonical keys. Entries that name no known repo are left alone;
 *  - the context (`source=`) is dropped when it names no source present, and follows a repo of another source that the
 *    URL opens (design §7.1).
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type RepoResolver, rewriteRepoParams, rewriteRepoPath } from '../../../shared/query';
import { repoResolver } from '../../../shared/repos';
import { usePresentSources, useRepos } from '../api/hooks';
import { parseDiffId, parseUrlState, patchSearch, repoFromPath, viewFromPath } from './urlState';
import type { UrlPatch } from './urlState';

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

/**
 * What the context rules know: the sources present, and each repo's source (by key). `complete`: every source present
 * is known (GET /sources has answered); until then a source missing from `hosts` may yet be one (set up, no repos yet).
 */
export interface ContextFacts {
  hosts: readonly string[];
  complete?: boolean;
  sourceOf: (key: string) => string | undefined;
}

/** The URL names a source that isn't known yet, and may still turn out to be one: wait before judging it. */
export function contextPending(search: string, facts: ContextFacts): boolean {
  const source = new URLSearchParams(search).get('source')?.trim().toLowerCase();
  return !!source && facts.complete === false && !facts.hosts.includes(source);
}

/**
 * The query with the context made canonical (keys must be canonical already), or null when it is:
 *  1. a `source` that names no source present is dropped (All), once every source is known; one in another case is
 *     lower-cased;
 *  2. in a source's context, a URL that opens a repo of another source (its page, the diff, the drawer, or a single
 *     `repos=` entry, in that order: the first known repo decides) takes the context to that repo's source. `repos=`
 *     keeps only that source's entries, or goes back to the default selection when none are left, so the list behind
 *     isn't empty. In All nothing follows.
 */
export function contextRewrite(pathname: string, search: string, facts: ContextFacts): string | null {
  const raw = new URLSearchParams(search).get('source');
  if (raw === null) return null;
  const view = viewFromPath(pathname);
  const s = parseUrlState(search, view);
  const done = (patch: UrlPatch) => {
    const next = patchSearch(search, view, patch);
    return next === search ? null : next;
  };
  if (!s.source || !facts.hosts.includes(s.source)) return contextPending(search, facts) ? null : done({ source: null });
  const diff = parseDiffId(s.diff);
  const named = [repoFromPath(pathname), diff?.repo, s.pr ? s.pr.slice(0, s.pr.lastIndexOf('#')) : undefined, s.repos?.length === 1 ? s.repos[0] : undefined];
  for (const key of named) {
    const src = key === undefined ? undefined : facts.sourceOf(key);
    if (src === undefined) continue;
    if (src === s.source) break;
    const patch: UrlPatch = { source: src };
    if (s.repos?.length) {
      const kept = s.repos.filter((k) => facts.sourceOf(k) === src);
      if (kept.length !== s.repos.length) patch.repos = kept.length ? kept : null;
    }
    return done(patch);
  }
  return raw === s.source ? null : done({});
}

/**
 * Mount once in the app shell. Replaces the history entry (never pushes), and does nothing until repos are loaded.
 * `settled`: the URL is canonical (repos loaded, nothing to rewrite), so it can be remembered as a context's place.
 */
export function useCanonicalRepoUrl(): { settled: boolean } {
  const { data } = useRepos();
  const present = usePresentSources();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const resolve = useMemo(() => (data ? repoResolver(data) : null), [data]);
  const facts = useMemo<ContextFacts | null>(() => {
    if (!data || !present) return null;
    const byKey = new Map(data.map((r) => [r.key, r.source]));
    return { hosts: present.sources.map((s) => s.host), complete: present.complete, sourceOf: (key) => byKey.get(key) };
  }, [data, present]);
  const next = useMemo(() => {
    if (!resolve || !facts) return null;
    const legacy = canonicalRepoUrl(pathname, search, resolve);
    const path = legacy?.pathname ?? pathname;
    const query = legacy?.search ?? search;
    const ctx = contextRewrite(path, query, facts);
    return legacy || ctx !== null ? { pathname: path, search: ctx ?? query } : null;
  }, [resolve, facts, pathname, search]);
  useEffect(() => {
    if (next) navigate({ ...next, hash }, { replace: true });
  }, [next, hash, navigate]);
  return { settled: !!resolve && !next && !!facts && !contextPending(search, facts) };
}
