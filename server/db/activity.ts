// Whether a repository is active: in the default selection and the sidebar's main list (shared/api.ts Repo.active).
// The rule is decided here once, at read time, for listRepos (Repo.active) and for the default scope (loadQueryCtx):
// the browser never recomputes it.

import type { RepoActiveReason, RepoStatus } from '../../shared/api';
import { ACTIVE_DAYS } from '../../shared/repos';
import { DAY_MS } from '../lib/time';
import type { Db } from './db';

// Stars are deliberately not activity: a star on an old repo must not bump it in the sidebar, nor make it active.
// Comment events carry milliseconds (gh-dash's own times): compared as text with whole seconds, off by a second at most.
const LAST_ACTIVITY = `nullif(max(
  ifnull(r.pushed_at, ''),
  ifnull((SELECT max(updated_at) FROM pull_requests WHERE repo_id = r.id), ''),
  ifnull((SELECT max(updated_at) FROM issues WHERE repo_id = r.id), ''),
  ifnull((SELECT max(published_at) FROM releases WHERE repo_id = r.id), ''),
  ifnull((SELECT max(at) FROM comment_events WHERE repo_id = r.id), '')
), '')`;

/** Columns the rule reads beyond the repo's own (on alias `r`): its last activity and unresolved gh-dash threads. */
export const ACTIVITY_COLS = `${LAST_ACTIVITY} AS last_activity_at,
  (SELECT count(*) FROM comment_threads WHERE repo_id = r.id AND status = 'open') AS open_threads`;

/** What the rule reads of a repo: its row with ACTIVITY_COLS. */
export interface ActivityRow {
  status: string;
  is_archived: number;
  is_fork: number;
  pinned: number;
  /** The code host's counts. */
  open_prs: number;
  open_issues: number;
  open_threads: number;
  last_activity_at: string | null;
}

/** A status as stored; anything else (the CHECK allows nothing else) reads as the rule's. */
export const repoStatus = (s: string): RepoStatus => (s === 'active' || s === 'inactive' ? s : 'auto');

/**
 * The activity rule, in its order: the user's status; archived, or a fork while forks are off, is inactive; pinned
 * (it overrides only quietness), anything open (pull requests, issues, gh-dash threads) or activity within
 * ACTIVE_DAYS of `now` is active; else quiet.
 */
export function repoActivity(r: ActivityRow, now: number, includeForks: boolean): { active: boolean; reason: RepoActiveReason } {
  const status = repoStatus(r.status);
  if (status !== 'auto') return { active: status === 'active', reason: 'set' };
  if (r.is_archived) return { active: false, reason: 'archived' };
  if (r.is_fork && !includeForks) return { active: false, reason: 'fork' };
  if (r.pinned) return { active: true, reason: 'pinned' };
  if (r.open_prs > 0 || r.open_issues > 0 || r.open_threads > 0) return { active: true, reason: 'open' };
  if (r.last_activity_at && Date.parse(r.last_activity_at) >= now - ACTIVE_DAYS * DAY_MS) return { active: true, reason: 'recent' };
  return { active: false, reason: 'quiet' };
}

/** Ids of the live repos active as of `now`: the default selection. */
export function activeRepoIds(db: Db, now: number, includeForks: boolean): number[] {
  const rows = db.all<ActivityRow & { id: number }>(
    `SELECT r.id, r.status, r.is_archived, r.is_fork, r.pinned, r.open_prs, r.open_issues, ${ACTIVITY_COLS}
     FROM repos r WHERE r.removed_at IS NULL`,
  );
  return rows.filter((r) => repoActivity(r, now, includeForks).active).map((r) => r.id);
}
