import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Repo } from '../../../shared/api';
import { useRepoMap } from '../api/hooks';
import { Icon } from './Icon';
import { patchSearch, viewFromPath } from '../lib/urlState';

/**
 * The repo map, provided once by the app shell. Chips read it from context instead of each
 * subscribing its own react-query observer (a 1,000-row PR list would otherwise create 1,000).
 */
const RepoMapCtx = createContext<{
  repos: Map<string, Repo>;
  hrefFor: (name: string) => string;
  navigate: ReturnType<typeof useNavigate>;
} | null>(null);

export function RepoMapProvider({ children }: { children: ReactNode }) {
  const repos = useRepoMap();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const pathname = view === 'prs' || view === 'issues' || view === 'repos' || view === 'activity' || view === 'insights' ? location.pathname : '/activity';
  const params = new URLSearchParams(location.search);
  params.delete('pr');
  const search = params.toString();
  // Drawer navigation must not re-render every chip in a long list. Cache one target per repo,
  // and keep this context stable until the actual filters (or repo metadata) change.
  const hrefFor = useMemo(() => {
    const base = new URLSearchParams(search);
    const cache = new Map<string, string>();
    return (name: string) => {
      let href = cache.get(name);
      if (href) return href;
      const vis = base.get('vis');
      const repo = repos.get(name);
      const conflict = repo && (vis === 'public' || vis === 'private') && vis !== repo.visibility;
      href = pathname + patchSearch(search, viewFromPath(pathname), { repos: [name], pr: null, ...(conflict ? { vis: 'all' } : {}) });
      cache.set(name, href);
      return href;
    };
  }, [pathname, search, repos]);
  const value = useMemo(() => ({ repos, hrefFor, navigate }), [repos, hrefFor, navigate]);
  return <RepoMapCtx.Provider value={value}>{children}</RepoMapCtx.Provider>;
}

/** Filter the current list to this repo; detail pages lead to its activity. */
export function RepoChip({ name, className = 'repo-chip' }: { name: string; className?: string }) {
  const context = useContext(RepoMapCtx);
  if (!context) throw new Error('RepoChip outside RepoMapProvider');
  const { repos, hrefFor, navigate } = context;
  const priv = repos.get(name)?.visibility === 'private';
  const href = hrefFor(name);
  return (
    <a className={`${className} repo-filter`} href={href}
      title={`Filter to ${name}`} aria-label={`Filter to ${name}${priv ? ' (private)' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        const here = window.location;
        // Normalize encoding/defaults while retaining `pr`, so a drawer link still closes it.
        if (href !== here.pathname + patchSearch(here.search, viewFromPath(here.pathname), {})) navigate(href);
      }}>
      {priv && <Icon name="lock" title="Private" />}
      {name}
    </a>
  );
}
