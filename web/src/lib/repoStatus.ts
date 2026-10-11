/**
 * A repository's status in words, kept free of React so it's unit-tested (shared/repo-status.test.ts). The server
 * decides whether a repo is active and why (Repo.active, Repo.activeReason); these only say so.
 */
import type { Repo, RepoPreview, RepoStatus } from '../../../shared/api';
import { repoProvider } from '../../../shared/provider';
import type { ProviderRepo } from '../../../shared/provider';
import { ACTIVE_DAYS } from '../../../shared/repos';
import { fmtDateSmart } from './time';

export const STATUS_LABEL: Record<RepoStatus, string> = { auto: 'Automatic', active: 'Active', inactive: 'Inactive' };

type ReasonRepo = Pick<Repo, 'active' | 'activeReason' | 'lastActivityAt'> & ProviderRepo;

/** Why a repo is active or not, short, for titles: "Archived", "No activity since Mar 3, 2025". */
export function activeReasonText(repo: ReasonRepo, now = new Date()): string {
  switch (repo.activeReason) {
    case 'set': return repo.active ? 'Marked active' : 'Marked inactive';
    case 'archived': return 'Archived';
    case 'fork': return 'Fork (forks are off in Settings)';
    case 'pinned': return 'Pinned';
    case 'open': return `Open ${repoProvider(repo).pr.many}, issues or comment threads`;
    case 'recent': return `Activity in the last ${Math.round(ACTIVE_DAYS / 30)} months`;
    case 'quiet': return repo.lastActivityAt ? `No activity since ${fmtDateSmart(repo.lastActivityAt, now)}` : 'No activity yet';
  }
}

/** Whether to say "Inactive" beside a repo's badges: inactive for a reason they don't show already (Archived, Fork). */
export const inactiveBadge = (repo: Pick<Repo, 'active' | 'activeReason'>) =>
  !repo.active && repo.activeReason !== 'archived' && repo.activeReason !== 'fork';

/**
 * The Add dialog's word on a tracked repo that is inactive, with why ("It's inactive: no activity since Mar 3, 2025.");
 * null when it's active. A lookup's preview (a repo the list doesn't have yet) has only the status chosen.
 */
export function inactiveNote(repo: ReasonRepo | Pick<RepoPreview, 'status'>, now = new Date()): string | null {
  if (!('activeReason' in repo)) return repo.status === 'inactive' ? "It's marked inactive." : null;
  if (repo.active) return null;
  if (repo.activeReason === 'set') return "It's marked inactive.";
  const why = activeReasonText(repo, now);
  return `It's inactive: ${why[0]!.toLowerCase()}${why.slice(1)}.`;
}

/** The toast after a status change, from the server's answer: "app marked inactive", "app set to automatic (active)". */
export function statusToast(label: string, repo: Pick<Repo, 'status' | 'active'>): string {
  return repo.status === 'auto' ? `${label} set to automatic (${repo.active ? 'active' : 'inactive'})` : `${label} marked ${repo.status}`;
}
