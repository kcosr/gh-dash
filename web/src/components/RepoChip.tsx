import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePresentSources, useRepoMap } from '../api/hooks';
import { Icon } from './Icon';
import { RepoName } from './RepoName';
import { RepoMapCtx, ReposCtx, SourceCtx, useRepoMapCtx, useSourceCtx } from './repoMapContext';
import type { SourceContext } from './repoMapContext';
import { SourceBadge } from './SourceBadge';
import { repoLabel } from '../../../shared/repos';
import { ALL, ctxOf, readPlaces } from '../lib/contexts';
import { OVERLAY_KEYS, keepRepoInScope, parseUrlState, patchSearch, viewFromPath } from '../lib/urlState';

/** Provides the repo map and the sources (with the context) once for the whole app shell (see RepoMapCtx, SourceCtx). */
export function RepoMapProvider({ children }: { children: ReactNode }) {
  const repos = useRepoMap();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const present = usePresentSources();
  const sources = useMemo(() => present?.sources ?? [], [present]);
  // Settings is context-free: it keeps showing the context you came from, and its tabs lead back to it.
  const ctx = view === 'settings' ? readPlaces().last : ctxOf(location.search);
  const sourceCtx = useMemo<SourceContext>(() => {
    const byHost = new Map(sources.map((s) => [s.host, s]));
    const current = ctx === ALL ? null : byHost.get(ctx) ?? null;
    const multi = sources.length > 1;
    return { sources, byHost, multi, current, badges: multi && !current };
  }, [sources, ctx]);
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
  return (
    <ReposCtx.Provider value={repos}>
      <SourceCtx.Provider value={sourceCtx}><RepoMapCtx.Provider value={value}>{children}</RepoMapCtx.Provider></SourceCtx.Provider>
    </ReposCtx.Provider>
  );
}

/** Filter the current list to this repo (its key); detail pages lead to its activity. */
export function RepoChip({ repo, className = 'repo-chip' }: { repo: string; className?: string }) {
  const { repos, hrefFor, navigate } = useRepoMapCtx();
  const { badges } = useSourceCtx();
  const r = repos.get(repo);
  const vis = r?.visibility;
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
      {badges && r && <SourceBadge host={r.source} />}
      {vis === 'private' && <Icon name="lock" title="Private" />}
      {vis === 'internal' && <Icon name="lock" title="Internal" />}
      <RepoName repo={repo} />
    </a>
  );
}
