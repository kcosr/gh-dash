import { QueryClient, QueryClientProvider, useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, useRouteError } from 'react-router';
import { qk, refetchAfterSync, useRepos, useSyncStatus } from './api/hooks';
import { CommandPalette } from './components/CommandPalette';
import { DiffView } from './components/DiffView';
import { PrDrawer } from './components/Drawer';
import { ExportModal } from './components/ExportModal';
import { PromptDialog } from './components/PromptDialog';
import { AddRepoDialog } from './components/AddRepoDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FirstSyncCard, NoTokenCard } from './components/Setup';
import { Sidebar } from './components/Sidebar';
import { useSidebarResize } from './components/SidebarResize';
import { MobileSidebar, useCompactSidebar } from './components/MobileSidebar';
import { ToastProvider, useToast } from './components/Toasts';
import { TopBar, useSyncNow, useTheme } from './components/TopBar';
import { UIProvider, useUI } from './components/ui';
import { hasBlockingLayer, isTypingTarget, topLayer } from './lib/layers';
import { useCanonicalRepoUrl } from './lib/canonicalUrl';
import { getSidebarHidden, setSidebarHidden } from './lib/storage';
import { plural } from './lib/time';
import { repoLabel } from '../../shared/repos';
import { repoFromPath, useUrlState } from './lib/urlState';
import { cx, isChunkLoadError } from './lib/util';
import { preloadMarkdown } from './components/Markdown';
import { RepoMapProvider } from './components/RepoChip';
import { Icon } from './components/Icon';
import { PullRequestsView } from './views/PullRequests';

// The home view (/prs) is in the main bundle; the others are split out and preloaded when the
// browser is idle after the first render, so navigating to them is instant. Route changes run in
// a transition, so while a chunk is still loading the current view stays on screen (no flash).
const loaders = {
  issues: () => import('./views/Issues'),
  activity: () => import('./views/Activity'),
  repos: () => import('./views/Repositories'),
  repo: () => import('./views/RepoDetail'),
  insights: () => import('./views/Insights'),
  settings: () => import('./views/Settings'),
};
const IssuesView = lazy(() => loaders.issues().then((m) => ({ default: m.IssuesView })));
const ActivityView = lazy(() => loaders.activity().then((m) => ({ default: m.ActivityView })));
const RepositoriesView = lazy(() => loaders.repos().then((m) => ({ default: m.RepositoriesView })));
const RepoDetailView = lazy(() => loaders.repo().then((m) => ({ default: m.RepoDetailView })));
const InsightsView = lazy(() => loaders.insights().then((m) => ({ default: m.InsightsView })));
const SettingsView = lazy(() => loaders.settings().then((m) => ({ default: m.SettingsView })));

function preloadAll() {
  for (const load of Object.values(loaders)) load().catch(() => { /* retried on navigation */ });
  preloadMarkdown();
}

/**
 * Preload the other views once the first screen's data has arrived (no API request in flight),
 * so the lazy chunks never compete with it; at the latest a few seconds after startup.
 */
function usePreloadWhenIdle() {
  const fetching = useIsFetching();
  const sawFetch = useRef(false);
  const done = useRef(false);
  if (fetching > 0) sawFetch.current = true;
  const ready = sawFetch.current && fetching === 0;
  useEffect(() => {
    if (done.current) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const run = () => { if (!done.current) { done.current = true; preloadAll(); } };
    const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 1000 }) : window.setTimeout(cb, 50));
    const t = window.setTimeout(() => idle(run), ready ? 0 : 4000);
    return () => clearTimeout(t);
  }, [ready]);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

/** Invalidate synced data when a sync finishes, and toast the result. */
function useSyncWatcher() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: st } = useSyncStatus();
  const wasRunning = useRef<boolean | null>(null);
  const lastDone = useRef({ done: -1, at: 0 });
  const lastToken = useRef<string | null>(null);

  useEffect(() => {
    if (!st) return;
    // The token changed on the server (gh auth login, a new token file, the desktop app): refresh the account.
    const token = `${st.tokenSource}:${st.viewer ?? ''}`;
    if (lastToken.current !== null && lastToken.current !== token) {
      void qc.invalidateQueries({ queryKey: qk.account });
      void qc.invalidateQueries({ queryKey: qk.me });
    }
    lastToken.current = token;
    const prev = wasRunning.current;
    wasRunning.current = st.running;
    if (prev && !st.running) {
      qc.invalidateQueries({ predicate: refetchAfterSync });
      const n = st.lastResult?.newItems ?? 0;
      const errs = st.lastResult?.errors.length ?? 0;
      toast(`Synced · ${n.toLocaleString()} new ${plural(n, 'item')}${errs ? ` · ${errs} ${plural(errs, 'error')}` : ''}`, { error: errs > 0 });
    }
    // During the very first sync, refresh lists as repos land (throttled).
    if (st.running && !st.lastSyncAt && st.progress && st.progress.done !== lastDone.current.done && Date.now() - lastDone.current.at > 5000) {
      lastDone.current = { done: st.progress.done, at: Date.now() };
      qc.invalidateQueries({ predicate: refetchAfterSync });
    }
  }, [st, qc, toast]);
}

function useGlobalKeys(openSidebarSearch?: () => void, toggleSidebar?: () => void) {
  const ui = useUI();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.togglePalette();
        return;
      }
      if (e.key === 'Escape') {
        const top = topLayer();
        if (top) { e.preventDefault(); top.close(); return; }
        const el = document.activeElement as HTMLElement | null;
        if (el && el !== document.body) el.blur();
        return;
      }
      if (isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Also while the diff view is open (it's where the room helps most), but not behind a dialog.
      if (e.key === '[' && toggleSidebar && !ui.paletteOpen && !ui.prompt && !ui.exportTab && !ui.addRepo && !ui.confirm) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (hasBlockingLayer()) return;
      if (e.key === '/') {
        const el = ['q', 'repoQ'].map((id) => document.getElementById(id)).find((el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
        if (el) { e.preventDefault(); (el as HTMLInputElement).focus(); (el as HTMLInputElement).select(); }
        else if (openSidebarSearch) { e.preventDefault(); openSidebarSearch(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ui, openSidebarSearch, toggleSidebar]);
}

function Shell() {
  const { s, view } = useUrlState();
  const ui = useUI();
  const [theme, toggleTheme] = useTheme();
  const sync = useSyncNow();
  const status = useSyncStatus();
  const repos = useRepos();
  useSyncWatcher();
  usePreloadWhenIdle();
  useCanonicalRepoUrl();
  const repoKey = repoFromPath(useLocation().pathname);
  const name = repoKey && repoLabel(repoKey, repos.data ?? []);
  useEffect(() => {
    const t = { prs: 'Pull requests', issues: 'Issues', activity: 'Activity', repos: 'Repositories', repo: name || 'Repository', insights: 'Insights', settings: 'Settings' }[view];
    document.title = `${t} · gh-dash`;
  }, [view, name]);

  const noData = repos.isSuccess && repos.data.length === 0;
  const setup = noData && view !== 'settings'
    ? status.data?.tokenSource === 'none' ? 'token' : 'first'
    : null;
  const hasSide = !setup && view !== 'repo' && view !== 'settings';
  const drawer = !setup && s.pr ? s.pr : null;
  const diff = !setup && s.diff ? s.diff : null;
  const compact = useCompactSidebar();
  // Narrow screens open the sidebar as a full-screen panel; on desktop it can be hidden (saved in the browser).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sideHidden, setSideHidden] = useState(getSidebarHidden);
  const [searchSide, setSearchSide] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState(false);
  useEffect(() => setSidebarOpen(false), [compact, view, drawer]);
  useEffect(() => {
    const close = () => setSidebarOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);
  const mobileOpen = hasSide && compact && sidebarOpen;
  const canHideSide = hasSide && !compact;
  const desktopSide = canHideSide && !sideHidden;
  const hidOnRequest = useRef(false);
  const toggleSide = () => {
    hidOnRequest.current = !sideHidden;
    setSideHidden(!sideHidden);
    setSidebarHidden(!sideHidden);
  };
  // Hiding the pane with focus inside it (or from the palette opened there, which can't return focus
  // to a removed control) drops focus to the page: put it on the toggle instead.
  useEffect(() => {
    if (!hidOnRequest.current) return;
    hidOnRequest.current = false;
    const el = document.activeElement;
    if (!el || el === document.body) document.getElementById('sidebar-toggle')?.focus();
  }, [sideHidden]);
  // "/" with no filter in view searches repositories: show the hidden pane, then focus its search.
  useEffect(() => {
    if (!searchSide || !desktopSide) return;
    document.getElementById('repoQ')?.focus();
    setSearchSide(false);
  }, [searchSide, desktopSide]);
  useGlobalKeys(
    hasSide && compact ? () => { setSidebarSearch(true); setSidebarOpen(true); }
      : canHideSide && sideHidden ? () => { setSearchSide(true); toggleSide(); } : undefined,
    canHideSide ? toggleSide : undefined,
  );
  const sidebar = useSidebarResize(desktopSide, !!drawer);

  return (
    <>
      <div ref={sidebar.frame} style={sidebar.style} inert={mobileOpen} className={cx('app', !desktopSide && 'no-side', drawer && 'has-drawer', diff && 'has-diff', sidebar.dragging && 'resizing-sidebar')}>
        <TopBar theme={theme} onToggleTheme={toggleTheme} sidebarOpen={mobileOpen}
          onOpenSidebar={hasSide && compact ? () => { setSidebarSearch(false); setSidebarOpen(true); } : undefined}
          onToggleSidebar={canHideSide ? toggleSide : undefined} sidebarHidden={sideHidden} />
        {desktopSide && <div id="sidebar" className="sidebar-pane"><Sidebar />{sidebar.separator}</div>}
        {setup ? (
          <main className="main tint">
            <div className="scroll">
              {setup === 'token' ? <NoTokenCard /> : <FirstSyncCard status={status.data} onSync={() => sync.run()} />}
            </div>
          </main>
        ) : (
          // Only visible on a first load straight into a split-out view (an empty main column
          // while its chunk arrives); later navigations keep the previous view until ready.
          <Suspense fallback={<main className="main" aria-busy="true" />}>
            <Outlet />
          </Suspense>
        )}
        {drawer && <PrDrawer key={drawer} id={drawer} compact={compact} />}
        {/* A PR's diff id is its drawer id: keep the sibling keys distinct. */}
        {diff && <DiffView key={`diff:${diff}`} id={diff} compact={compact} />}
      </div>
      {mobileOpen && <MobileSidebar focusSearch={sidebarSearch} onClose={() => setSidebarOpen(false)} />}
      {ui.paletteOpen && <CommandPalette onClose={ui.closePalette} onRun={() => setSidebarOpen(false)} onSync={() => sync.run()} onToggleTheme={toggleTheme}
        onToggleSidebar={canHideSide ? toggleSide : undefined} sidebarHidden={sideHidden} />}
      {ui.exportTab && <ExportModal initialTab={ui.exportTab} onClose={ui.closeExport} />}
      {ui.prompt && <PromptDialog req={ui.prompt} onClose={ui.closePrompt} />}
      {ui.addRepo && <AddRepoDialog onClose={ui.closeAddRepo} />}
      {ui.confirm && <ConfirmDialog req={ui.confirm} onClose={ui.closeConfirm} />}
    </>
  );
}

function AppShell() {
  return (
    <UIProvider>
      <RepoMapProvider>
        <Shell />
      </RepoMapProvider>
    </UIProvider>
  );
}

/** A view failed to render or its code failed to load (e.g. the app was redeployed): keep the shell. */
function ViewError() {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  return (
    <main className="main">
      <div className="scroll">
        <div className="empty">
          <span className="ic err"><Icon name="alert" /></span>
          <h3>{chunk ? 'This page could not be loaded' : 'Something went wrong in this view'}</h3>
          <p>{chunk ? 'The app may have been updated, or the server is unreachable.' : error instanceof Error ? error.message : String(error)}</p>
          <button type="button" className="btn" onClick={() => window.location.reload()}><Icon name="sync" />Reload</button>
        </div>
      </div>
    </main>
  );
}

/** The shell itself failed: a plain full-page message rather than a blank page. */
function AppError() {
  const error = useRouteError();
  return (
    <div className="setup">
      <div className="setup-card center">
        <span className="ic"><Icon name="alert" /></span>
        <h2>gh-dash hit an error</h2>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}><Icon name="sync" />Reload</button>
      </div>
    </div>
  );
}

function RedirectHome() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/prs', search }} replace />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <AppError />,
    children: [
      { index: true, element: <RedirectHome /> },
      { path: 'prs', element: <PullRequestsView /> },
      { path: 'issues', element: <IssuesView /> },
      { path: 'activity', element: <ActivityView /> },
      { path: 'repos', element: <RepositoriesView /> },
      { path: 'repos/*', element: <RepoDetailView /> },
      { path: 'insights', element: <InsightsView /> },
      { path: 'settings', element: <SettingsView /> },
      { path: '*', element: <Navigate to="/prs" replace /> },
    ].map((r) => ({ ...r, errorElement: <ViewError /> })),
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
