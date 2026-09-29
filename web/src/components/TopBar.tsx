import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { isUnreachable } from '../api/client';
import { useAccount, useStartSync, useSyncStatus } from '../api/hooks';
import { getTheme, setTheme } from '../lib/storage';
import type { Theme } from '../lib/storage';
import { fmtNum, fmtTime, relFuture, relLong } from '../lib/time';
import { carrySearch, viewFromPath } from '../lib/urlState';
import { useNow } from '../lib/util';
import { MOD_K } from './bits';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useRepoLabel } from './repoMapContext';
import { useToast } from './Toasts';
import { useUI } from './ui';

const NAV: { path: string; label: string; icon: IconName; views: string[] }[] = [
  { path: '/prs', label: 'Pull requests', icon: 'merge', views: ['prs'] },
  { path: '/issues', label: 'Issues', icon: 'issue', views: ['issues'] },
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
  const label = useRepoLabel();
  return {
    pending: start.isPending,
    /** `repo`: sync only that repository (for one added by hand, this also checks again whether it can be read). */
    run: (body: { full?: boolean; repo?: string } = {}) =>
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

export function TopBar({ theme, onToggleTheme, onOpenSidebar, sidebarOpen = false, onToggleSidebar, sidebarHidden = false }: {
  theme: Theme; onToggleTheme: () => void; onOpenSidebar?: () => void; sidebarOpen?: boolean;
  /** Desktop: show or hide the sidebar pane. */
  onToggleSidebar?: () => void; sidebarHidden?: boolean;
}) {
  const location = useLocation();
  const view = viewFromPath(location.pathname);
  const { openPalette } = useUI();
  const carry = carrySearch(location.search);
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
    <header className="topbar">
      {onOpenSidebar && <button type="button" className="btn icon" onClick={onOpenSidebar}
        aria-label="Open sidebar" aria-haspopup="dialog" aria-controls="mobile-sidebar" aria-expanded={sidebarOpen}>
        <Icon name="list" />
      </button>}
      {onToggleSidebar && <button id="sidebar-toggle" type="button" className="btn icon ghost" onClick={onToggleSidebar}
        title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar ([)`} aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
        aria-controls={sidebarHidden ? undefined : 'sidebar'} aria-expanded={!sidebarHidden}>
        <Icon name="list" />
      </button>}
      <Link to={`/prs${carry}`} className="brand" aria-label="gh-dash home">
        <span className="mark"><Icon name="pulse" /></span><span className="brand-name">gh-dash</span>
      </Link>
      <nav ref={navRef} className="nav" aria-label="Main">
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

function SyncStatus({ label, title, to, children }: { label: string; title?: string; to?: string; children: ReactNode }) {
  const tip = [label, title].filter(Boolean).join(' · ');
  if (to) return <Link to={to} className="sync" title={tip}>{children}<span className="sync-text">{label}</span></Link>;
  return <div className="sync" title={tip}>{children}<span className="sync-text">{label}</span></div>;
}

function SyncIndicator() {
  const { data: st, isError } = useSyncStatus();
  const repoLabel = useRepoLabel();
  const { data: account } = useAccount();
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
    // A single-repo sync (a repo just added, or "Sync now" in its menu) names the repo instead of counting "0/1 repos".
    const label = st.repo ? `Syncing ${repoLabel(st.repo)}…` : p && p.total ? `Syncing ${p.done}/${p.total} repos…` : 'Syncing…';
    return (
      <SyncStatus label={label} title={[!st.repo && p?.current ? `Syncing ${repoLabel(p.current)}` : null, ...tip].filter(Boolean).join(' · ')}>
        <span className="spin"><Icon name="sync" /></span>
      </SyncStatus>
    );
  }
  if (account?.mismatch) {
    const title = `The GitHub token is for ${account.login ?? 'another account'}, but this database belongs to ${account.dbLogin ?? 'another account'}. Syncing is paused: see Settings.`;
    return <SyncStatus label="Account mismatch" title={title} to="/settings"><span className="dot warn" /></SyncStatus>;
  }
  if (st.tokenSource === 'none') {
    return <SyncStatus label="No token" title="No GitHub token. Connect an account in Settings." to="/settings"><span className="dot warn" /></SyncStatus>;
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
  // Enabled without a token too: the server resolves one afresh, or answers why it can't sync.
  const disabled = !!st?.running || sync.pending;
  return (
    <button
      type="button"
      className="btn sync-trigger"
      aria-label="Sync now"
      disabled={disabled}
      onClick={() => sync.run()}
      title={st?.tokenSource === 'none' ? 'No GitHub token yet: connect an account in Settings' : 'Fetch what changed on GitHub'}
    >
      <Icon name="sync" />
      <span className="sync-label">Sync now</span>
    </button>
  );
}
