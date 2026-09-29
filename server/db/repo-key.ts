import type { TrackedBy } from '../../shared/api';
import type { Db } from './db';

// A repository's key is what the API and the web app call it: in URLs, `repos=` lists, sets, cursors and every
// `repo` field. It is `repos.name_with_owner` exactly as GitHub spells it ("owner/name"; nested for GitLab groups
// later). Server code goes through the helpers below instead of naming a column, so the key is defined in one place.
//
// Resolution (inputs from URLs, lists and request bodies), over live repos only:
//  1. the key itself, case-insensitively; or
//  2. an input without '/' naming one of the viewer's own repos by its short name, case-insensitively (the alias
//     every link used before keys had owners).
// Nothing else: a bare name that only a repo added by hand has resolves to nothing. shared/repos.ts `repoResolver`
// implements the same rule for the web app; repo-key.test.ts checks that both agree.

/** SQL expression for the public key of the repos row aliased `alias`. */
export function repoKeySql(alias: string): string {
  return `${alias}.name_with_owner`;
}

/**
 * Non-correlated subquery (with parentheses) for the ids of the live repos named by a JSON array of keys or aliases.
 * Binds one `?`: `JSON.stringify(keys)`. Use as `r.id IN ${REPO_IDS_FOR_KEYS}`.
 */
export const REPO_IDS_FOR_KEYS = `(SELECT x.id FROM repos x JOIN json_each(?) k
  ON x.name_with_owner = k.value COLLATE NOCASE
  OR (instr(k.value, '/') = 0 AND x.tracked_by = 'owned' AND x.name = k.value COLLATE NOCASE)
  WHERE x.removed_at IS NULL)`;

/** Public key of a repos row read with `SELECT *`. */
export function repoKey(row: { name: string; name_with_owner: string }): string {
  return row.name_with_owner;
}

export interface RepoRef {
  id: number;
  key: string;
  owner: string;
  name: string;
  /** The provider's path for the repo (GitHub `owner/name`), for requests to the provider. */
  path: string;
  nodeId: string;
  trackedBy: TrackedBy;
}

interface RefRow {
  id: number;
  name: string;
  name_with_owner: string;
  owner: string;
  node_id: string;
  tracked_by: string;
}

const RESOLVE = `SELECT id, name, name_with_owner, owner, node_id, tracked_by FROM repos WHERE id IN ${REPO_IDS_FOR_KEYS} ORDER BY id LIMIT 1`;

/** The live repo an API key (or an owned repo's short name) names, or null. */
export function resolveRepo(db: Db, key: string): RepoRef | null {
  const row = db.get<RefRow>(RESOLVE, [JSON.stringify([key])]);
  return row
    ? {
        id: row.id, key: repoKey(row), owner: row.owner, name: row.name, path: row.name_with_owner, nodeId: row.node_id,
        trackedBy: row.tracked_by === 'manual' ? 'manual' : 'owned',
      }
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
