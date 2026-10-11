/** A repository's actions menu: the same on the Repositories tab (its "…") and in the sidebar (a row's "…", or right-click). */
import { useNavigate } from 'react-router';
import type { Repo } from '../../../shared/api';
import { repoProvider } from '../../../shared/provider';
import { usePatchRepo } from '../api/hooks';
import { repoLinkSearch } from '../lib/urlState';
import { Menu } from '../workbench';
import type { MenuEntry } from '../workbench';
import { Icon } from './Icon';
import { useConfirmRemoveRepo } from './RepoTracking';
import { statusItems, useSetRepoStatus } from './RepoStatusMenu';
import { useRepoLabel, useSourceCtx } from './repoMapContext';
import { useSyncNow } from './TopBar';

/** `onNavigate`: called after going to another page from the menu (the mobile sidebar closes then). */
export function useRepoMenuItems(repo: Repo, onNavigate?: () => void): MenuEntry[] {
  const navigate = useNavigate();
  const patch = usePatchRepo();
  const setStatus = useSetRepoStatus();
  const sync = useSyncNow();
  const confirmRemove = useConfirmRemoveRepo();
  const { current } = useSourceCtx();
  const activity = `/activity?${repoLinkSearch(repo.key, current?.host ?? null)}`;
  return [
    { id: 'pin', icon: 'pin', label: repo.pinned ? 'Unpin' : 'Pin', onSelect: () => patch.mutate({ key: repo.key, patch: { pinned: !repo.pinned } }) },
    { id: 'sync', icon: 'refresh', label: 'Sync now', onSelect: () => sync.run({ repo: repo.key }) },
    onNavigate
      ? { id: 'activity', icon: 'activity', label: 'Activity in this repo', onSelect: () => { navigate(activity); onNavigate(); } }
      : { id: 'activity', icon: 'activity', label: 'Activity in this repo', href: activity },
    { id: 'external', icon: 'external', label: `Open on ${repoProvider(repo).name}`, href: repo.url, external: true },
    { type: 'separator' },
    ...statusItems(repo, setStatus),
    ...(repo.trackedBy === 'manual' ? [
      { type: 'separator' as const },
      { id: 'remove', icon: 'trash' as const, label: 'Remove…', danger: true, onSelect: () => confirmRemove(repo) },
    ] : []),
  ];
}

/** The menu behind a "…" button; `className` styles the button (`pin-btn` on the Repositories tab, `repo-more` in the sidebar). */
export function RepoMenu({ repo, className = 'pin-btn', onNavigate }: { repo: Repo; className?: string; onNavigate?: () => void }) {
  const label = useRepoLabel()(repo.key);
  const items = useRepoMenuItems(repo, onNavigate);
  return (
    <Menu label={`Actions for ${label}`} trigger={(props) => (
      <button {...props} type="button" className={className} aria-label={`More actions for ${label}`} title="More"><Icon name="dots" /></button>
    )} items={items} />
  );
}
