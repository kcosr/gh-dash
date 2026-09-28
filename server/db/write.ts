import type { Db, Param } from './db';
import type {
  ActorRecord,
  CommitRecord,
  IssueRecord,
  PrRecord,
  ReleaseRecord,
  RepoProbe,
  RepoRecord,
  StarRecord,
} from './records';

function upsertSql(table: string, columns: string[], conflict: string[]): string {
  const updates = columns.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(${conflict.join(', ')}) DO UPDATE SET ${updates.join(', ')} RETURNING id`;
}

const actorCols = (prefix: string) => [`${prefix}_login`, `${prefix}_name`, `${prefix}_avatar`];
const actorVals = (a: ActorRecord | null): Param[] => [a?.login ?? null, a?.name ?? null, a?.avatarUrl ?? null];

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

const REPO_COLS = [
  'node_id', 'name', 'name_with_owner', 'owner', 'description', 'url', 'visibility', 'is_archived', 'is_fork',
  'language_name', 'language_color', 'topics', 'default_branch', 'stars', 'forks', 'created_at', 'pushed_at', 'removed_at',
];
const UPSERT_REPO = upsertSql('repos', REPO_COLS, ['node_id']);

/** Upserts a repo by GitHub node id (so renames keep local prefs and data); returns the local id. */
export function upsertRepo(db: Db, r: RepoRecord, now: string): number {
  // A different repo (deleted, or renamed away) may still hold this name.
  db.run(`UPDATE repos SET name = name || '~' || id, removed_at = coalesce(removed_at, ?) WHERE name = ? AND node_id <> ?`, [
    now,
    r.name,
    r.nodeId,
  ]);
  const row = db.get<{ id: number }>(UPSERT_REPO, [
    r.nodeId, r.name, r.nameWithOwner, r.owner, r.description, r.url, r.visibility, Number(r.isArchived), Number(r.isFork),
    r.languageName, r.languageColor, JSON.stringify(r.topics), r.defaultBranch, r.stars, r.forks, r.createdAt, r.pushedAt, null,
  ]);
  return row!.id;
}

export function markReposRemoved(db: Db, keepNodeIds: string[], now: string): number {
  return db.run(
    `UPDATE repos SET removed_at = ? WHERE removed_at IS NULL AND node_id NOT IN (SELECT value FROM json_each(?))`,
    [now, JSON.stringify(keepNodeIds)],
  ).changes;
}

export function applyProbe(db: Db, repoId: number, p: RepoProbe): void {
  db.run('UPDATE repos SET open_prs = ?, open_issues = ? WHERE id = ?', [p.openPrs, p.openIssues, repoId]);
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

export interface SyncStateRow {
  repo_id: number;
  commits_pushed_at: string | null;
  commits_branch: string | null;
  /** Newest commit of the last complete default-branch walk. */
  commits_head: string | null;
  prs_hwm: string | null;
  issues_hwm: string | null;
  releases_synced_at: string | null;
  stars_synced_at: string | null;
  stars_full_at: string | null;
  synced_at: string | null;
  last_error: string | null;
}

export type SyncStatePatch = Partial<Omit<SyncStateRow, 'repo_id'>>;

export function getSyncState(db: Db, repoId: number): SyncStateRow {
  db.run('INSERT OR IGNORE INTO sync_state (repo_id) VALUES (?)', [repoId]);
  return db.get<SyncStateRow>('SELECT * FROM sync_state WHERE repo_id = ?', [repoId])!;
}

export function updateSyncState(db: Db, repoId: number, patch: SyncStatePatch): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  db.run('INSERT OR IGNORE INTO sync_state (repo_id) VALUES (?)', [repoId]);
  db.run(`UPDATE sync_state SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE repo_id = ?`, [
    ...entries.map(([, v]) => v as Param),
    repoId,
  ]);
}

// ---------------------------------------------------------------------------
// Entities. Each upsert returns true when the row is new.
// ---------------------------------------------------------------------------

const UPSERT_PR = upsertSql(
  'pull_requests',
  [
    'repo_id', 'number', 'title', 'body', 'state', 'is_draft', ...actorCols('author'), 'merged_by', 'created_at', 'updated_at',
    'merged_at', 'closed_at', 'activity_at', 'additions', 'deletions', 'changed_files', 'commit_count', 'head_ref', 'base_ref',
    'labels', 'closing_issues', 'url',
  ],
  ['repo_id', 'number'],
);

export function upsertPr(db: Db, repoId: number, p: PrRecord): boolean {
  const isNew = !db.get('SELECT 1 FROM pull_requests WHERE repo_id = ? AND number = ?', [repoId, p.number]);
  const { id } = db.get<{ id: number }>(UPSERT_PR, [
    repoId, p.number, p.title, p.body, p.state, Number(p.isDraft), ...actorVals(p.author), p.mergedBy, p.createdAt, p.updatedAt,
    p.mergedAt, p.closedAt, p.activityAt, p.additions, p.deletions, p.changedFiles, p.commitCount, p.headRef, p.baseRef,
    JSON.stringify(p.labels), JSON.stringify(p.closingIssues), p.url,
  ])!;
  db.run('DELETE FROM pr_commits WHERE pr_id = ?', [id]);
  p.commits.forEach((c, i) => {
    db.run(
      `INSERT INTO pr_commits (pr_id, position, oid, headline, committed_at, url, author_login, author_name, author_email, author_avatar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, i, c.oid, c.headline, c.committedAt, c.url, c.author.login, c.author.name, c.author.email, c.author.avatarUrl],
    );
  });
  return isNew;
}

const UPSERT_COMMIT = upsertSql(
  'commits',
  [
    'repo_id', 'oid', 'headline', 'body', ...actorCols('author'), 'author_email', 'committed_at', 'url', 'additions', 'deletions',
    'pr_number',
  ],
  ['repo_id', 'oid'],
);

function commitExists(db: Db, repoId: number, oid: string): boolean {
  return !!db.get('SELECT 1 FROM commits WHERE repo_id = ? AND oid = ?', [repoId, oid]);
}

export function upsertCommit(db: Db, repoId: number, c: CommitRecord): boolean {
  const isNew = !commitExists(db, repoId, c.oid);
  db.get(UPSERT_COMMIT, [
    repoId, c.oid, c.headline, c.body, ...actorVals(c.author), c.author.email, c.committedAt, c.url, c.additions, c.deletions,
    c.prNumber,
  ]);
  return isNew;
}

/**
 * After a walk of the default branch that covered the whole window since `since`: removes stored commits in
 * that window the walk did not return (rewritten by a force push, or left on a previous default branch).
 */
export function pruneCommits(db: Db, repoId: number, since: string, seenOids: string[]): number {
  return db.run('DELETE FROM commits WHERE repo_id = ? AND committed_at >= ? AND oid NOT IN (SELECT value FROM json_each(?))', [
    repoId,
    since,
    JSON.stringify(seenOids),
  ]).changes;
}

const UPSERT_ISSUE = upsertSql(
  'issues',
  [
    'repo_id', 'number', 'title', 'body', 'state', ...actorCols('author'), ...actorCols('closed_by'), 'created_at', 'updated_at',
    'closed_at', 'activity_at', 'labels', 'url',
  ],
  ['repo_id', 'number'],
);

export function upsertIssue(db: Db, repoId: number, i: IssueRecord): boolean {
  const isNew = !db.get('SELECT 1 FROM issues WHERE repo_id = ? AND number = ?', [repoId, i.number]);
  db.get(UPSERT_ISSUE, [
    repoId, i.number, i.title, i.body, i.state, ...actorVals(i.author), ...actorVals(i.closedBy), i.createdAt, i.updatedAt,
    i.closedAt, i.activityAt, JSON.stringify(i.labels), i.url,
  ]);
  return isNew;
}

const UPSERT_RELEASE = upsertSql(
  'releases',
  ['repo_id', 'tag', 'name', 'body', ...actorCols('author'), 'published_at', 'is_prerelease', 'url'],
  ['repo_id', 'tag'],
);

export function releaseExists(db: Db, repoId: number, tag: string): boolean {
  return !!db.get('SELECT 1 FROM releases WHERE repo_id = ? AND tag = ?', [repoId, tag]);
}

export function upsertRelease(db: Db, repoId: number, r: ReleaseRecord): boolean {
  const isNew = !releaseExists(db, repoId, r.tag);
  db.get(UPSERT_RELEASE, [repoId, r.tag, r.name, r.body, ...actorVals(r.author), r.publishedAt, Number(r.isPrerelease), r.url]);
  return isNew;
}

const UPSERT_STAR = upsertSql('stars', ['repo_id', 'login', 'name', 'avatar', 'starred_at'], ['repo_id', 'login']);

export function starExists(db: Db, repoId: number, login: string): boolean {
  return !!db.get('SELECT 1 FROM stars WHERE repo_id = ? AND login = ?', [repoId, login]);
}

export function upsertStar(db: Db, repoId: number, s: StarRecord): boolean {
  const isNew = !starExists(db, repoId, s.login);
  db.get(UPSERT_STAR, [repoId, s.login, s.name, s.avatarUrl, s.starredAt]);
  return isNew;
}

export function storedStarInfo(db: Db, repoId: number): { count: number; latest: string | null } {
  return db.get<{ count: number; latest: string | null }>(
    'SELECT count(*) AS count, max(starred_at) AS latest FROM stars WHERE repo_id = ?',
    [repoId],
  )!;
}

/** Removes stars whose login is no longer among the stargazers (unstars). Returns the number removed. */
export function deleteStarsExcept(db: Db, repoId: number, logins: string[]): number {
  return db.run('DELETE FROM stars WHERE repo_id = ? AND login NOT IN (SELECT value FROM json_each(?))', [
    repoId,
    JSON.stringify(logins),
  ]).changes;
}

/** Numbers of the PRs / issues we have stored as open for a repo. */
export function storedOpenNumbers(db: Db, repoId: number, table: 'pull_requests' | 'issues'): number[] {
  return db.all<{ number: number }>(`SELECT number FROM ${table} WHERE repo_id = ? AND state = 'open'`, [repoId]).map((r) => r.number);
}

/** Removes a PR or issue that no longer exists in the repo (deleted or transferred). */
export function deleteItem(db: Db, repoId: number, table: 'pull_requests' | 'issues', number: number): void {
  db.run(`DELETE FROM ${table} WHERE repo_id = ? AND number = ?`, [repoId, number]);
}
