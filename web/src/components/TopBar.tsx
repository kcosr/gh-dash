import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { isUnreachable } from '../api/client';
import { useAccount, useStartSync, useSyncStatus, useUnresolvedCount, useWorkSources } from '../api/hooks';
import { PROVIDERS } from '../../../shared/provider';
import type { PrWords } from '../../../shared/provider';
import { getTheme, setTheme } from '../lib/storage';
import type { Theme } from '../lib/storage';
import { fmtNum, fmtTime, relFuture, relLong } from '../lib/time';
import { ALL, ctxOf, usePlaces, useSwitchContext, viewHref } from '../lib/contexts';
import { GITHUB_HOST } from '../../../shared/api';
import { firstTrouble, hostNames, sourceSettingsLink, troubleLabel } from '../lib/sources';
import { threadCountParams } from '../lib/apiQuery';
import { parseUrlState, viewFromPath } from '../lib/urlState';
import type { UrlState } from '../lib/urlState';
import { useNow } from '../lib/util';
import { MOD_K } from './bits';
import { Icon, ProviderIcon } from './Icon';
import type { IconName } from './Icon';
import { useRepoLabel, useSourceCtx, useWords } from './repoMapContext';
import { sourceTitle } from './SourceBadge';
import { useToast } from './Toasts';
import { useUI } from './ui';

const NAV: { path: string; label: (w: PrWords) => string; icon: IconName; views: string[] }[] = [
  { path: '/prs', label: (w) => w.nav, icon: 'merge', views: ['prs'] },
  { path: '/comments', label: () => 'Comments', icon: 'comment', views: ['comments'] },
  { path: '/issues', label: () => 'Issues', icon: 'issue', views: ['issues'] },
  { path: '/activity', label: () => 'Activity', icon: 'pulse', views: ['activity'] },
  { path: '/repos', label: () => 'Repositories', icon: 'book', views: ['repos', 'repo'] },
  { path: '/insights', label: () => 'Insights', icon: 'chart', views: ['insights'] },
];

export function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(getTheme);
  const toggle = () => {
    const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    set(next);
  };
  return [theme, toggle];
}

/** Trigger a manual sync with toasts for the edge cases. */
export function useSyncNow() {
  const start = useStartSync();
  const toast = useToast();
  const label = useRepoLabel();
  return {
    pending: start.isPending,
    /**
     * `repo`: sync only that repository (for one added by hand, this also checks again whether it can be read).
     * `source`: sync only that source (a host); without it, every source with a token.
     */
    run: (body: { full?: boolean; repo?: string; source?: string } = {}) =>
      start.mutate(body, {
        onSuccess: () => toast(body.full ? 'Full resync started' : body.repo ? `Syncing ${label(body.repo)}…` : 'Sync started'),
        onError: (e) => {
          const status = (e as { status?: number }).status;
          if (status === 409) toast('A sync is already running');
          // No token (or the account doesn't match): the server's message says what to do.
          else if (status === 503 && !isUnreachable(e)) toast((e as Error).message, { error: true, ms: 6000 });
          else toast(`Sync failed: ${(e as Error).message}`, { error: true });
        },
      }),
  };
}

/**
 * `(path) => href` for a link to a top-level view (a tab, the brand, the palette's "Go to"): the view as you left it in
 * this context, under the current scope (see viewHref).
 */
export function useViewHref(): (path: string) => string {
  const { pathname, search } = useLocation();
  const { current } = useSourceCtx();
  const places = usePlaces();
  // Settings is context-free (its URL has none): its tabs lead back to the context you came from.
  const ctx = viewFromPath(pathname) === 'settings' ? current?.host ?? ALL : ctxOf(search);
  return useCallback((path: string) => viewHref(places, ctx, path, pathname, search), [places, ctx, pathname, search]);
}

export function TopBar({ theme, onToggleTheme, onOpenSidebar, sidebarOpen = false, onToggleSidebar, sidebarHidden = false }: {
  theme: Theme; onToggleTheme: () => void; onOpenSidebar?: () => void; sidebarOpen?: boolean;
  /** Desktop: show or hide the sidebar pane. */
  onToggleSidebar?: () => void; sidebarHidden?: boolean;
}) {
  const location = useLocation();
  const view = viewFromPath(location.pathname);
  const { openPalette } = useUI();
  const w = useWords().pr;
  const { current, multi } = useSourceCtx();
  const hrefTo = useViewHref();
  // The repos the tabs lead to: the Comments tab counts what its list would show (Settings: the context's default).
  const scope = view === 'settings' ? { source: current?.host ?? null, repos: null, vis: 'all' as const, own: 'all' as const } : parseUrlState(location.search, view);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector('[aria-current="page"]');
    if (!nav || !active) return;
    const reveal = () => active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    // Font loading and responsive layout can resize the tabs after navigation.
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    for (const link of nav.children) observer.observe(link);
    return () => observer.disconnect();
  }, [view]);

  return (
    <header className={multi ? 'topbar has-ctx' : 'topbar'}>
      {onOpenSidebar && <button type="button" className="btn icon" onClick={onOpenSidebar}
        aria-label="Open sidebar" aria-haspopup="dialog" aria-controls="mobile-sidebar" aria-expanded={sidebarOpen}>
        <Icon name="list" />
      </button>}
      {onToggleSidebar && <button id="sidebar-toggle" type="button" className="btn icon ghost" onClick={onToggleSidebar}
        title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar ([)`} aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
        aria-controls={sidebarHidden ? undefined : 'sidebar'} aria-expanded={!sidebarHidden}>
        <Icon name="list" />
      </button>}
      <Link to={hrefTo('/prs')} className="brand" aria-label="gh-dash home">
        <span className="mark"><Icon name="pulse" /></span><span className="brand-name">gh-dash</span>
      </Link>
      <ContextSwitcher />
      <nav ref={navRef} className="nav" aria-label="Main">
        {NAV.map((n) => {
          const on = n.views.includes(view);
          return (
            <Link key={n.path} to={hrefTo(n.path)} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
              <Icon name={n.icon} />
              {n.label(w)}
              {n.path === '/comments' && <UnresolvedCount scope={scope} />}
            </Link>
          );
        })}
      </nav>
      <span className="spacer" />
      <button type="button" className="top-search" onClick={openPalette} aria-label={`Search repos, ${w.shortMany}, views`}>
        <Icon name="search" />
        <span>Search repos, {w.shortMany}, views…</span>
        <kbd>{MOD_K}</kbd>
      </button>
      <SyncIndicator />
      <SyncButton />
      <button type="button" className="btn icon ghost" onClick={onToggleTheme} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-label="Toggle theme">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <Link to="/settings" className={`btn icon ghost${view === 'settings' ? ' on' : ''}`} title="Settings: token, sync interval, your commit emails" aria-label="Settings">
        <Icon name="sliders" />
      </Link>
    </header>
  );
}

/** The Comments tab's quiet count: unresolved threads in the tabs' scope (the context, the repo selection); none at 0. */
function UnresolvedCount({ scope }: { scope: Pick<UrlState, 'source' | 'repos' | 'vis' | 'own'> }) {
  const { data: n } = useUnresolvedCount(threadCountParams(scope));
  if (!n) return null;
  return <span className="n" title={`${n.toLocaleString()} unresolved`}>{n.toLocaleString()}<span className="sr-only"> unresolved</span></span>;
}

/**
 * GitHub | GitLab | All (design §7.1): a quiet segmented control, shown only with two sources or more. Each context
 * keeps its own place; switching is one navigation to it. Names give way to the marks on narrow screens (tooltips keep
 * them).
 */
function ContextSwitcher() {
  const { sources, multi, current } = useSourceCtx();
  const switchTo = useSwitchContext();
  const view = viewFromPath(useLocation().pathname);
  if (!multi) return null;
  const on = current?.host ?? ALL;
  const options = [
    ...sources.map((s) => ({ value: s.host, kind: s.kind, name: s.name, title: `${sourceTitle(s)}: only its repositories` })),
    { value: ALL, kind: null, name: 'All', title: 'All sources' },
  ];
  return (
    <div className="seg ctx-switch" role="group" aria-label="Source">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === on ? 'on' : undefined} aria-pressed={o.value === on}
          title={o.title} aria-label={o.name}
          // On Settings (context-free) the current one also leads back to its place.
          onClick={() => { if (o.value !== on || view === 'settings') switchTo(o.value); }}>
          {o.kind && <ProviderIcon kind={o.kind} />}
          <span className={o.kind ? 'ctx-name' : undefined}>{o.name}</span>
        </button>
      ))}
    </div>
  );
}

function SyncStatus({ label, title, to, children }: { label: string; title?: string; to?: string; children: ReactNode }) {
  const tip = [label, title].filter(Boolean).join(' · ');
  if (to) return <Link to={to} className="sync" title={tip}>{children}<span className="sync-text">{label}</span></Link>;
  return <div className="sync" title={tip}>{children}<span className="sync-text">{label}</span></div>;
}

function SyncIndicator() {
  const { data: st, isError } = useSyncStatus();
  const repoLabel = useRepoLabel();
  const { data: account } = useAccount();
  const sources = useWorkSources();
  const { current } = useSourceCtx();
  const now = useNow(20_000);
  if (isError) {
    return <SyncStatus label="Server unreachable" title="The gh-dash server is not responding"><span className="dot err" /></SyncStatus>;
  }
  if (!st) return <SyncStatus label="Loading sync status"><span className="dot off" /></SyncStatus>;

  // A source's context shows that source's own status; All shows the run's (every source together), and names the
  // first source that can't sync.
  const scope = current ? sources.find((s) => s.host === current.host) ?? null : null;
  const part = scope?.status ?? null;
  const running = part ? part.running : st.running;
  const progress = part ? part.progress : st.progress;
  const lastSyncAt = part ? part.lastSyncAt : st.lastSyncAt;
  const errors = (part ? part.lastResult : st.lastResult)?.errors.length ?? 0;
  const rateLimit = part ? part.rateLimit : st.rateLimit;

  const tip: string[] = [];
  if (st.nextSyncAt && !st.running) tip.push(`Next automatic sync ${relFuture(st.nextSyncAt, now)} (${fmtTime(st.nextSyncAt)})`);
  if (!st.nextSyncAt && !st.running) tip.push('Automatic sync is off');
  if (rateLimit) tip.push(`API quota ${fmtNum(rateLimit.remaining)} / ${fmtNum(rateLimit.limit)}`);
  if (errors) tip.push(`${errors} error(s) in the last sync`);

  if (running) {
    const p = progress;
    // A single-repo sync (a repo just added, or "Sync now" in its menu) names the repo instead of counting "0/1 repos".
    const label = st.repo ? `Syncing ${repoLabel(st.repo)}…` : p && p.total ? `Syncing ${p.done}/${p.total} repos…` : 'Syncing…';
    return (
      <SyncStatus label={label} title={[!st.repo && p?.current ? `Syncing ${repoLabel(p.current)}` : null, ...tip].filter(Boolean).join(' · ')}>
        <span className="spin"><Icon name="sync" /></span>
      </SyncStatus>
    );
  }
  const bad = scope ?? firstTrouble(sources);
  if (bad?.trouble) {
    const github = bad.host === GITHUB_HOST;
    const named = !scope && sources.length > 1;
    const title = github && bad.trouble === 'mismatch' && account?.mismatch
      ? `The GitHub token is for ${account.login ?? 'another account'}, but this database belongs to ${account.dbLogin ?? 'another account'}. Syncing is paused: see Settings.`
      : github && bad.trouble === 'no-token' ? 'No GitHub token. Connect an account in Settings.'
        // In All the last sync is the run's; the source's own problem is what needs saying.
        : [bad.status.problem, named && lastSyncAt ? `Last synced ${relLong(lastSyncAt, now)}` : null].filter(Boolean).join(' · ');
    return (
      <SyncStatus label={troubleLabel(bad, named)} title={title} to={github ? '/settings' : sourceSettingsLink(bad.host)}>
        <span className="dot warn" />
      </SyncStatus>
    );
  }
  return (
    <SyncStatus label={lastSyncAt ? `Synced ${relLong(lastSyncAt, now)}` : 'Never synced'} title={tip.join(' · ')}>
      <span className={`dot${errors ? ' warn' : ''}${lastSyncAt ? '' : ' off'}`} />
    </SyncStatus>
  );
}

/**
 * "Sync now" for the current context (design §7.9): a source's context syncs that source alone, All syncs every
 * source with a token. `tip` says which, or why it can't.
 */
export function useContextSync() {
  const sync = useSyncNow();
  const { data: st } = useSyncStatus();
  const { current } = useSourceCtx();
  const sources = useWorkSources().filter((s) => s.trouble !== 'not-configured');
  const scope = current ? sources.find((s) => s.host === current.host) ?? null : null;
  // The one source the button is about: the context's, or the only one there is.
  const only = scope ?? (sources.length === 1 ? sources[0]! : null);
  const tip = only?.trouble === 'no-token'
    ? (only.host === GITHUB_HOST ? 'No GitHub token yet: connect an account in Settings' : `No ${PROVIDERS[only.kind].name} token yet: connect one in Settings`)
    : only?.trouble === 'mismatch' ? only.status.problem ?? 'The token belongs to another account'
      : `Fetch what changed on ${only ? PROVIDERS[only.kind].name : sources.length ? hostNames(sources) : 'GitHub'}`;
  return {
    tip,
    // Enabled without a token too: the server resolves one afresh, or answers why it can't sync.
    disabled: !!st?.running || sync.pending,
    run: () => sync.run(current ? { source: current.host } : {}),
  };
}

function SyncButton() {
  const sync = useContextSync();
  return (
    <button type="button" className="btn sync-trigger" aria-label="Sync now" disabled={sync.disabled} onClick={sync.run} title={sync.tip}>
      <Icon name="sync" />
      <span className="sync-label">Sync now</span>
    </button>
  );
}
