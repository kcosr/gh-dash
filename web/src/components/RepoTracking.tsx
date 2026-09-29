/** Repositories added by hand: the Remove confirmation, and the note on one the token can no longer read. */
import { useNavigate } from 'react-router';
import type { Repo } from '../../../shared/api';
import { repoProvider } from '../../../shared/provider';
import { repoFromPath } from '../../../shared/repos';
import { useRemoveRepo } from '../api/hooks';
import { fmtDateSmart } from '../lib/time';
import { removeRepoBody } from '../lib/tracking';
import { carrySearch, parseUrlState, patchSearch, viewFromPath } from '../lib/urlState';
import { cx } from '../lib/util';
import { Icon } from './Icon';
import { useRepoLabel } from './repoMapContext';
import { useToast } from './Toasts';
import { useSyncNow } from './TopBar';
import { useUI } from './ui';

/**
 * Remove a repository added by hand, after the confirmation (§5.6): it stops syncing and its data leaves this dashboard.
 * Afterwards a page about it goes back to Repositories, and a selection naming it drops it.
 */
export function useConfirmRemoveRepo(): (repo: Repo) => void {
  const { openConfirm } = useUI();
  const remove = useRemoveRepo();
  const toast = useToast();
  const label = useRepoLabel();
  const navigate = useNavigate();
  return (repo) => {
    const name = label(repo.key);
    openConfirm({
      title: `Remove ${name}?`,
      body: removeRepoBody(repo.commentCount, repoProvider(repo)),
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        await remove.mutateAsync(repo.key);
        toast(`Removed ${name}`);
        const { pathname, search } = window.location;
        // The removed repo leaves an explicit selection first, wherever we go next (it carries across tabs).
        const view = viewFromPath(pathname);
        const sel = parseUrlState(search, view).repos;
        const rest = sel?.includes(repo.key) ? patchSearch(search, view, { repos: sel.filter((k) => k !== repo.key) }) : search;
        if (repoFromPath(pathname) === repo.key) navigate(`/repos${carrySearch(rest)}`);
        else if (rest !== search) navigate({ pathname, search: rest }, { replace: true });
      },
    });
  };
}

/**
 * A repository added by hand that the token can no longer read: its data is kept and the sync skips it. "Sync now"
 * checks again; Remove deletes it. `compact` (cards): one line of text, the full reason in its tooltip.
 */
export function UnavailableNote({ repo, compact = false }: { repo: Repo; compact?: boolean }) {
  const sync = useSyncNow();
  const confirmRemove = useConfirmRemoveRepo();
  if (!repo.unavailable) return null;
  const text = `gh-dash can't read this repository since ${fmtDateSmart(repo.unavailable.since)}: ${repo.unavailable.reason.replace(/\.$/, '')}. Its data is kept.`;
  return (
    <div className={cx('unavail', compact && 'compact')} role="status">
      <Icon name="alert" />
      <span className="unavail-t" title={compact ? text : undefined}>{text}</span>
      <span className="unavail-acts">
        <button type="button" className="lnk" onClick={() => sync.run({ repo: repo.key })}>Sync now</button>
        {repo.trackedBy === 'manual' && <button type="button" className="lnk" onClick={() => confirmRemove(repo)}>Remove…</button>}
      </span>
    </div>
  );
}
