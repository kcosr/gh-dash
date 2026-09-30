import type { Db } from '../db/db';

/** A branch's head commit author as the sync records it; null when the code host said nothing of it. */
export interface BranchAuthor {
  login?: string | null;
  name?: string | null;
  email?: string | null;
}

/**
 * Stores branch `name` of repo `repo` (a key) as the sync would: head `head` (a full SHA), committed at `at`, by `by`
 * (alice by default; her avatar comes with a login). Written directly, so the read side's tests needn't the sync's writes.
 */
export function addBranch(
  db: Db,
  repo: string,
  name: string,
  { head, at = '2026-09-25T12:00:00Z', by = { login: 'alice', name: 'Alice' } }: { head: string; at?: string | null; by?: BranchAuthor | null },
): void {
  db.run(
    `INSERT INTO branches (repo_id, name, head_oid, committed_at, author_login, author_name, author_email, author_avatar, first_seen_at)
     VALUES ((SELECT id FROM repos WHERE key = ?), ?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z')`,
    [repo, name, head, at, by?.login ?? null, by?.name ?? null, by?.email ?? null, by?.login ? `https://avatars.example/${by.login}` : null],
  );
}

/** Notes that the sync listed repo `repo`'s branches at `at`, completely or not (a capped listing). */
export function branchesSynced(db: Db, repo: string, complete: boolean, at = '2026-09-27T12:00:00Z'): void {
  db.run(
    `INSERT INTO sync_state (repo_id, branches_synced_at, branches_complete) VALUES ((SELECT id FROM repos WHERE key = ?), ?, ?)
     ON CONFLICT (repo_id) DO UPDATE SET branches_synced_at = excluded.branches_synced_at, branches_complete = excluded.branches_complete`,
    [repo, at, Number(complete)],
  );
}
