// Repository inventory queries and preferences as plain functions (see services/lists.ts). Adding and removing tracked
// repositories is sync/tracking.ts (Tracking, removeTrackedRepo).

import type { Repo, RepoQuery, RepoStatus } from '../../shared/api';
import { selectRepos } from '../../shared/repos';
import { parseSources, requireSources } from '../api/scope';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { getRepo, listRepos, setRepoPrefs } from '../db/repos';
import { HttpError } from '../lib/errors';

export interface RepoDeps {
  db: Db;
  config: Pick<Config, 'defaultTz'>;
  /** The clock (AppDeps.now): Date.now by default. */
  now?: () => number;
}

const notFound = () => new HttpError(404, 'Repository not found');

/**
 * The inventory (every live repo, on every source), or the selection `query` describes. `query.source` (a comma list of
 * hosts) narrows it to those sources; 400 for a host that isn't a source of this database.
 */
export function queryRepos({ db, config, now }: RepoDeps, query: RepoQuery): Repo[] {
  requireSources(db, parseSources(query.source));
  return selectRepos(listRepos(db, config.defaultTz, now?.()), query);
}

/** One repo by its key (or an owned github.com repo's short name); 404. */
export function repoDetail({ db, config, now }: RepoDeps, key: string): Repo {
  const repo = getRepo(db, key, config.defaultTz, now?.());
  if (!repo) throw notFound();
  return repo;
}

/**
 * Pins a repo or sets its status (local preferences; nothing changes on the code host); 404. The Repo returned says
 * whether it is active now: either can change that.
 */
export function patchRepo(deps: RepoDeps, key: string, prefs: { pinned?: boolean; status?: RepoStatus }): Repo {
  if (!setRepoPrefs(deps.db, key, prefs)) throw notFound();
  return repoDetail(deps, key);
}
