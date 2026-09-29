import type { TrackedBy } from '../../shared/api';
import type { Db } from './db';
import { GITHUB_SOURCE_ID, sourceKey, type SourceRef } from './sources';

// A repository's key is what the API and the web app call it: in URLs, `repos=` lists, sets, cursors and every
// `repo` field. It is stored in `repos.key`, written by the upserts through `sourceKey` (db/sources.ts): the provider
// path ("owner/name") on github.com, "<host>/<full path>" on every other source ("gitlab.example.com/platform/app").
// GitHub keys have exactly one '/', prefixed keys at least two, and hosts are unique, so keys never collide across
// sources. Keys are opaque: code reads `repos.source_id` rather than parsing one. Server code goes through the helpers
// below instead of naming a column, so the key is defined in one place.
//
// Resolution (inputs from URLs, lists and request bodies), over live repos only:
//  1. the key itself, case-insensitively; or
//  2. an input without '/' naming one of the viewer's own github.com repos by its short name, case-insensitively (the
//     alias every link used before keys had owners; those were all GitHub, and a short name isn't unique across
//     sources).
// Nothing else: a bare name that only a repo added by hand, or a repo on another source, has resolves to nothing.
// shared/repos.ts `repoResolver` implements the same rule for the web app; repo-key.test.ts checks that both agree.

/** SQL expression for the public key of the repos row aliased `alias`. */
export function repoKeySql(alias: string): string {
  return `${alias}.key`;
}

/**
 * Non-correlated subquery (with parentheses) for the ids of the live repos named by a JSON array of keys or aliases.
 * Binds one `?`: `JSON.stringify(keys)`. Use as `r.id IN ${REPO_IDS_FOR_KEYS}`.
 */
export const REPO_IDS_FOR_KEYS = `(SELECT x.id FROM repos x JOIN json_each(?) k
  ON x.key = k.value COLLATE NOCASE
  OR (instr(k.value, '/') = 0 AND x.source_id = ${GITHUB_SOURCE_ID} AND x.tracked_by = 'owned' AND x.name = k.value COLLATE NOCASE)
  WHERE x.removed_at IS NULL)`;

/** Public key of a repos row read with `SELECT *`. */
export function repoKey(row: { key: string }): string {
  return row.key;
}

export interface RepoRef {
  id: number;
  /** The source the repo is on (sources.id). */
  sourceId: number;
  key: string;
  owner: string;
  name: string;
  /** The provider's path for the repo (GitHub `owner/name`, GitLab's full path), for requests to the provider. */
  path: string;
  nodeId: string;
  trackedBy: TrackedBy;
}

interface RefRow {
  id: number;
  source_id: number;
  key: string;
  name: string;
  name_with_owner: string;
  owner: string;
  node_id: string;
  tracked_by: string;
}

const RESOLVE = `SELECT id, source_id, key, name, name_with_owner, owner, node_id, tracked_by FROM repos
  WHERE id IN ${REPO_IDS_FOR_KEYS} ORDER BY id LIMIT 1`;

/** The live repo an API key (or an owned github.com repo's short name) names, or null. */
export function resolveRepo(db: Db, key: string): RepoRef | null {
  const row = db.get<RefRow>(RESOLVE, [JSON.stringify([key])]);
  return row
    ? {
        id: row.id, sourceId: row.source_id, key: repoKey(row), owner: row.owner, name: row.name, path: row.name_with_owner,
        nodeId: row.node_id, trackedBy: row.tracked_by === 'manual' ? 'manual' : 'owned',
      }
    : null;
}

/**
 * The live repo `input` names on the source `src`: its key, or its path there (`platform/app` for
 * `gitlab.example.com/platform/app`; on github.com the key, or an owned repo's short name). null when that names no repo
 * on `src`, including one on another source.
 */
export function resolveRepoOn(db: Db, input: string, src: SourceRef): RepoRef | null {
  for (const key of new Set([sourceKey(src, input), input])) {
    const ref = resolveRepo(db, key);
    if (ref?.sourceId === src.id) return ref;
  }
  return null;
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
