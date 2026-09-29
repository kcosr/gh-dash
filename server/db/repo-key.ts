import type { Db } from './db';

// A repository's key is what the API and the web app call it: in URLs, `repos=` lists, sets, cursors and every
// `repo` field. Server code goes through the helpers below instead of naming a column, so the key is defined in
// one place. Currently it is the short name (`repos.name`).

/** SQL expression for the public key of the repos row aliased `alias`. */
export function repoKeySql(alias: string): string {
  return `${alias}.name`;
}

/**
 * Non-correlated subquery (with parentheses) for the ids of the live repos named by a JSON array of keys.
 * Binds one `?`: `JSON.stringify(keys)`. Use as `r.id IN ${REPO_IDS_FOR_KEYS}`.
 */
export const REPO_IDS_FOR_KEYS = '(SELECT id FROM repos WHERE removed_at IS NULL AND name IN (SELECT value FROM json_each(?)))';

/** Public key of a repos row read with `SELECT *`. */
export function repoKey(row: { name: string; name_with_owner: string }): string {
  return row.name;
}

export interface RepoRef {
  id: number;
  key: string;
  owner: string;
  name: string;
  /** The provider's path for the repo (GitHub `owner/name`), for requests to the provider. */
  path: string;
  nodeId: string;
  trackedBy: 'owned' | 'manual';
}

interface RefRow {
  id: number;
  name: string;
  name_with_owner: string;
  owner: string;
  node_id: string;
}

/** The live repo an API key names, or null. Currently an exact short-name match (case-sensitive); every repo is `owned`. */
export function resolveRepo(db: Db, key: string): RepoRef | null {
  const row = db.get<RefRow>('SELECT id, name, name_with_owner, owner, node_id FROM repos WHERE name = ? AND removed_at IS NULL', [key]);
  return row
    ? { id: row.id, key: repoKey(row), owner: row.owner, name: row.name, path: row.name_with_owner, nodeId: row.node_id, trackedBy: 'owned' }
    : null;
}

/** Input key → repo id for each input that names a live repo, in input order (inputs that name none are absent). */
export function resolveRepoIds(db: Db, keys: string[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const key of keys) {
    if (ids.has(key)) continue;
    const ref = resolveRepo(db, key);
    if (ref) ids.set(key, ref.id);
  }
  return ids;
}
