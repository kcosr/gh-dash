import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useRepoMap } from '../api/hooks';
import { Icon } from './Icon';
import { RepoName } from './RepoName';
import { RepoMapCtx, useRepoMapCtx } from './repoMapContext';
import { repoLabel } from '../../../shared/repos';
import { OVERLAY_KEYS, keepRepoInScope, parseUrlState, patchSearch, viewFromPath } from '../lib/urlState';

/** Provides the repo map once for the whole app shell (see RepoMapCtx). */
export function RepoMapProvider({ children }: { children: ReactNode }) {
  const repos = useRepoMap();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const pathname = view === 'prs' || view === 'issues' || view === 'repos' || view === 'activity' || view === 'insights' ? location.pathname : '/activity';
  const params = new URLSearchParams(location.search);
  for (const k of OVERLAY_KEYS) params.delete(k);
  const search = params.toString();
  // Drawer and diff navigation must not re-render every chip in a long list. Cache one target per repo,
  // and keep this context stable until the actual filters (or repo metadata) change.
  const hrefFor = useMemo(() => {
    const listView = viewFromPath(pathname);
    const cur = parseUrlState(search, listView);
    const cache = new Map<string, string>();
    return (key: string) => {
      let href = cache.get(key);
      if (href) return href;
      href = pathname + patchSearch(search, listView, { repos: [key], pr: null, diff: null, ...keepRepoInScope(repos.get(key), cur) });
      cache.set(key, href);
      return href;
    };
  }, [pathname, search, repos]);
  const value = useMemo(() => ({ repos, hrefFor, navigate }), [repos, hrefFor, navigate]);
  return <RepoMapCtx.Provider value={value}>{children}</RepoMapCtx.Provider>;
}

/** Filter the current list to this repo (its key); detail pages lead to its activity. */
export function RepoChip({ repo, className = 'repo-chip' }: { repo: string; className?: string }) {
  const { repos, hrefFor, navigate } = useRepoMapCtx();
  const vis = repos.get(repo)?.visibility;
  const label = repoLabel(repo, repos);
  const href = hrefFor(repo);
  return (
    <a className={`${className} repo-filter`} href={href}
      title={`Filter to ${label}`} aria-label={`Filter to ${label}${vis === 'private' ? ' (private)' : vis === 'internal' ? ' (internal)' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        const here = window.location;
        // Normalize encoding/defaults while retaining `pr`/`diff`, so a link in the drawer or diff still closes it.
        if (href !== here.pathname + patchSearch(here.search, viewFromPath(here.pathname), {})) navigate(href);
      }}>
      {vis === 'private' && <Icon name="lock" title="Private" />}
      {vis === 'internal' && <Icon name="lock" title="Internal" />}
      <RepoName repo={repo} />
    </a>
  );
}
