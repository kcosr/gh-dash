// Repository inventory queries and preferences as plain functions (see services/lists.ts). Adding and removing tracked
// repositories is sync/tracking.ts (Tracking, removeTrackedRepo).

import type { Repo, RepoQuery } from '../../shared/api';
import { selectRepos } from '../../shared/repos';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { getRepo, listRepos, setRepoPrefs } from '../db/repos';
import { getSettings } from '../db/settings';
import { HttpError } from '../lib/errors';

export interface RepoDeps {
  db: Db;
  config: Pick<Config, 'defaultTz'>;
}

const notFound = () => new HttpError(404, 'Repository not found');

/** The inventory (every live repo, on every source), or the selection `query` describes. */
export function queryRepos({ db, config }: RepoDeps, query: RepoQuery): Repo[] {
  return selectRepos(listRepos(db, config.defaultTz), query, getSettings(db).includeForks);
}

/** One repo by its key (or an owned github.com repo's short name); 404. */
export function repoDetail({ db, config }: RepoDeps, key: string): Repo {
  const repo = getRepo(db, key, config.defaultTz);
  if (!repo) throw notFound();
  return repo;
}

/** Pins or hides a repo (local preferences; nothing changes on the code host); 404. */
export function patchRepo({ db, config }: RepoDeps, key: string, prefs: { pinned?: boolean; hidden?: boolean }): Repo {
  if (!setRepoPrefs(db, key, prefs)) throw notFound();
  return repoDetail({ db, config }, key);
}
