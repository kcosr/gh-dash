import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useStartSync, useSyncStatus } from '../api/hooks';
import { getTheme, setTheme } from '../lib/storage';
import type { Theme } from '../lib/storage';
import { fmtNum, fmtTime, relFuture, relLong } from '../lib/time';
import { carrySearch, viewFromPath } from '../lib/urlState';
import { useNow } from '../lib/util';
import { MOD_K } from './bits';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useToast } from './Toasts';
import { useUI } from './ui';

const NAV: { path: string; label: string; icon: IconName; views: string[] }[] = [
  { path: '/prs', label: 'Pull requests', icon: 'merge', views: ['prs'] },
  { path: '/activity', label: 'Activity', icon: 'pulse', views: ['activity'] },
  { path: '/repos', label: 'Repositories', icon: 'book', views: ['repos', 'repo'] },
  { path: '/insights', label: 'Insights', icon: 'chart', views: ['insights'] },
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
  return {
    pending: start.isPending,
    run: (body: { full?: boolean; repo?: string } = {}) =>
      start.mutate(body, {
        onSuccess: () => toast(body.full ? 'Full resync started' : 'Sync started'),
        onError: (e) => toast((e as { status?: number }).status === 409 ? 'A sync is already running' : `Sync failed: ${(e as Error).message}`, { error: (e as { status?: number }).status !== 409 }),
      }),
  };
}

export function TopBar({ theme, onToggleTheme, onOpenSidebar, sidebarOpen = false }: {
  theme: Theme; onToggleTheme: () => void; onOpenSidebar?: () => void; sidebarOpen?: boolean;
}) {
  const location = useLocation();
  const view = viewFromPath(location.pathname);
  const { openPalette } = useUI();
  const carry = carrySearch(location.search);

  return (
    <header className="topbar">
      {onOpenSidebar && <button type="button" className="btn icon" onClick={onOpenSidebar}
        aria-label="Open sidebar" aria-haspopup="dialog" aria-controls="mobile-sidebar" aria-expanded={sidebarOpen}>
        <Icon name="list" />
      </button>}
      <Link to={`/prs${carry}`} className="brand" aria-label="gh-dash home">
        <span className="mark"><Icon name="pulse" /></span><span className="brand-name">gh-dash</span>
      </Link>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => {
          const on = n.views.includes(view);
          return (
            <Link key={n.path} to={`${n.path}${carry}`} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <span className="spacer" />
      <button type="button" className="top-search" onClick={openPalette} aria-label="Search repos, PRs, views">
        <Icon name="search" />
        <span>Search repos, PRs, views…</span>
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

function SyncStatus({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return <div className="sync" title={[label, title].filter(Boolean).join(' · ')}>{children}<span className="sync-text">{label}</span></div>;
}

function SyncIndicator() {
  const { data: st, isError } = useSyncStatus();
  const now = useNow(20_000);
  if (isError) {
    return <SyncStatus label="Server unreachable" title="The gh-dash server is not responding"><span className="dot err" /></SyncStatus>;
  }
  if (!st) return <SyncStatus label="Loading sync status"><span className="dot off" /></SyncStatus>;

  const tip: string[] = [];
  if (st.nextSyncAt && !st.running) tip.push(`Next automatic sync ${relFuture(st.nextSyncAt, now)} (${fmtTime(st.nextSyncAt)})`);
  if (!st.nextSyncAt && !st.running) tip.push('Automatic sync is off');
  if (st.rateLimit) tip.push(`API quota ${fmtNum(st.rateLimit.remaining)} / ${fmtNum(st.rateLimit.limit)}`);
  if (st.lastResult?.errors.length) tip.push(`${st.lastResult.errors.length} error(s) in the last sync`);

  if (st.running) {
    const p = st.progress;
    return (
      <SyncStatus label={p && p.total ? `Syncing ${p.done}/${p.total} repos…` : 'Syncing…'} title={[p?.current ? `Syncing ${p.current}` : null, ...tip].filter(Boolean).join(' · ')}>
        <span className="spin"><Icon name="sync" /></span>
      </SyncStatus>
    );
  }
  if (st.tokenSource === 'none') {
    return <SyncStatus label="No token" title="No GitHub token found. See Settings."><span className="dot warn" /></SyncStatus>;
  }
  return (
    <SyncStatus label={st.lastSyncAt ? `Synced ${relLong(st.lastSyncAt, now)}` : 'Never synced'} title={tip.join(' · ')}>
      <span className={`dot${st.lastResult?.errors.length ? ' warn' : ''}${st.lastSyncAt ? '' : ' off'}`} />
    </SyncStatus>
  );
}

function SyncButton() {
  const { data: st } = useSyncStatus();
  const sync = useSyncNow();
  const disabled = !!st?.running || sync.pending || st?.tokenSource === 'none';
  return (
    <button
      type="button"
      className="btn sync-trigger"
      aria-label="Sync now"
      disabled={disabled}
      onClick={() => sync.run()}
      title={st?.tokenSource === 'none' ? 'Set GITHUB_TOKEN or run `gh auth login` first' : 'Fetch what changed on GitHub'}
    >
      <Icon name="sync" />
      <span className="sync-label">Sync now</span>
    </button>
  );
}
