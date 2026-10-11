/** A repository's status (Automatic / Active / Inactive): the menu items, the change and its toast, and a menu button. */
import type { Repo, RepoStatus } from '../../../shared/api';
import { usePatchRepo } from '../api/hooks';
import { activeReasonText, STATUS_LABEL, statusToast } from '../lib/repoStatus';
import { Button, Menu, useToast } from '../workbench';
import type { MenuItem } from '../workbench';
import { Icon } from './Icon';
import { useRepoLabel } from './repoMapContext';

/** Set a repo's status, then say what it is now (the server's answer). */
export function useSetRepoStatus(): (repo: Repo, status: RepoStatus) => void {
  const patch = usePatchRepo();
  const toast = useToast();
  const label = useRepoLabel();
  return (repo, status) => {
    if (status === repo.status) return;
    void patch.mutateAsync({ key: repo.key, patch: { status } })
      .then((r) => toast(statusToast(label(r.key), r)))
      .catch((error: Error) => toast(`Couldn't update ${label(repo.key)}: ${error.message}`, { tone: 'error' }));
  };
}

/** The three choices, the current one checked. Automatic says what the activity rule makes of the repo, chosen or not. */
export function statusItems(repo: Repo, set: (repo: Repo, status: RepoStatus) => void): MenuItem[] {
  return (['auto', 'active', 'inactive'] as const).map((status) => ({
    id: `status-${status}`,
    label: STATUS_LABEL[status],
    hint: status === 'auto' ? (repo.autoActive ? 'active' : 'inactive') : undefined,
    checked: repo.status === status,
    onSelect: () => set(repo, status),
  }));
}

/** A button saying whether the repo is active (why, in its title) that opens the three choices. */
export function RepoStatusMenu({ repo, size }: { repo: Repo; size?: 'sm' }) {
  const set = useSetRepoStatus();
  const label = useRepoLabel()(repo.key);
  const state = repo.active ? 'Active' : 'Inactive';
  return (
    <Menu label={`${label}: active or inactive`} trigger={(props) => (
      <Button {...props} size={size} title={activeReasonText(repo)} aria-label={`${label}: ${state.toLowerCase()}`}>
        {state}<Icon name="chevron" />
      </Button>
    )} items={statusItems(repo, set)} />
  );
}
