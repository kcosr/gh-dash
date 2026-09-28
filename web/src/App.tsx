import { QueryClient, QueryClientProvider, useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation, useRouteError } from 'react-router';
import { useRepos, useSyncStatus } from './api/hooks';
import { CommandPalette } from './components/CommandPalette';
import { PrDrawer } from './components/Drawer';
import { ExportModal } from './components/ExportModal';
import { PromptDialog } from './components/PromptDialog';
import { FirstSyncCard, NoTokenCard } from './components/Setup';
import { Sidebar } from './components/Sidebar';
import { useSidebarResize } from './components/SidebarResize';
import { ToastProvider, useToast } from './components/Toasts';
import { TopBar, useSyncNow, useTheme } from './components/TopBar';
import { UIProvider, useUI } from './components/ui';
import { hasBlockingLayer, isTypingTarget, topLayer } from './lib/layers';
import { plural } from './lib/time';
import { repoFromPath, useUrlState } from './lib/urlState';
import { cx } from './lib/util';
import { preloadMarkdown } from './components/Markdown';
import { RepoMapProvider } from './components/RepoChip';
import { Icon } from './components/Icon';
import { PullRequestsView } from './views/PullRequests';

// The home view (/prs) is in the main bundle; the others are split out and preloaded when the
// browser is idle after the first render, so navigating to them is instant. Route changes run in
// a transition, so while a chunk is still loading the current view stays on screen (no flash).
const loaders = {
  activity: () => import('./views/Activity'),
  repos: () => import('./views/Repositories'),
  repo: () => import('./views/RepoDetail'),
  insights: () => import('./views/Insights'),
  settings: () => import('./views/Settings'),
};
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

/** Invalidate everything when a sync finishes, and toast the result. */
function useSyncWatcher() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: st } = useSyncStatus();
  const wasRunning = useRef<boolean | null>(null);
  const lastDone = useRef({ done: -1, at: 0 });

  useEffect(() => {
    if (!st) return;
    const prev = wasRunning.current;
    wasRunning.current = st.running;
    if (prev && !st.running) {
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'sync-status' });
      const n = st.lastResult?.newItems ?? 0;
      const errs = st.lastResult?.errors.length ?? 0;
      toast(`Synced · ${n.toLocaleString()} new ${plural(n, 'item')}${errs ? ` · ${errs} ${plural(errs, 'error')}` : ''}`, { error: errs > 0 });
    }
    // During the very first sync, refresh lists as repos land (throttled).
    if (st.running && !st.lastSyncAt && st.progress && st.progress.done !== lastDone.current.done && Date.now() - lastDone.current.at > 5000) {
      lastDone.current = { done: st.progress.done, at: Date.now() };
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'sync-status' });
    }
  }, [st, qc, toast]);
}

function useGlobalKeys() {
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
      if (hasBlockingLayer() || isTypingTarget(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        const el = document.getElementById('q') ?? document.getElementById('repoQ');
        if (el) { e.preventDefault(); (el as HTMLInputElement).focus(); (el as HTMLInputElement).select(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ui]);
}

function Shell() {
  const { s, view } = useUrlState();
  const ui = useUI();
  const [theme, toggleTheme] = useTheme();
  const sync = useSyncNow();
  const status = useSyncStatus();
  const repos = useRepos();
  useSyncWatcher();
  useGlobalKeys();
  usePreloadWhenIdle();
  const name = repoFromPath(useLocation().pathname);
  useEffect(() => {
    const t = { prs: 'Pull requests', activity: 'Activity', repos: 'Repositories', repo: name ?? 'Repository', insights: 'Insights', settings: 'Settings' }[view];
    document.title = `${t} · gh-dash`;
  }, [view, name]);

  const noData = repos.isSuccess && repos.data.length === 0;
  const setup = noData && view !== 'settings'
    ? status.data?.tokenSource === 'none' ? 'token' : 'first'
    : null;
  const hasSide = !setup && view !== 'repos' && view !== 'repo' && view !== 'settings';
  const drawer = !setup && s.pr ? s.pr : null;
  const sidebar = useSidebarResize(hasSide, !!drawer);

  return (
    <>
      <div ref={sidebar.frame} style={sidebar.style} className={cx('app', !hasSide && 'no-side', drawer && 'has-drawer', sidebar.dragging && 'resizing-sidebar')}>
        <TopBar theme={theme} onToggleTheme={toggleTheme} />
        {hasSide && <div className="sidebar-pane"><Sidebar />{sidebar.separator}</div>}
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
        {drawer && <PrDrawer key={drawer} id={drawer} />}
      </div>
      {ui.paletteOpen && <CommandPalette onClose={ui.closePalette} onSync={() => sync.run()} onToggleTheme={toggleTheme} />}
      {ui.exportTab && <ExportModal initialTab={ui.exportTab} onClose={ui.closeExport} />}
      {ui.prompt && <PromptDialog req={ui.prompt} onClose={ui.closePrompt} />}
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
  const chunk = error instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(error.message);
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
      { path: 'activity', element: <ActivityView /> },
      { path: 'repos', element: <RepositoriesView /> },
      { path: 'repos/:name', element: <RepoDetailView /> },
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
