import { type RepoResolver, rewriteRepoParams, rewriteRepoPath } from '../../shared/query';
import type { Db } from './db';

interface Migration {
  version: number;
  /** Destructive migrations (drops/rebuilds) never run from a GH_DASH_SYNC=off instance. */
  destructive: boolean;
  /**
   * Rebuilds a table other tables reference. Foreign key enforcement is suspended around the batch (with it on,
   * DROP TABLE deletes the rows first, and that cascades into every child table), and the batch commits only if
   * `PRAGMA foreign_key_check` finds nothing.
   */
  rebuild?: boolean;
  sql: string;
  /** Data step run right after `sql`, in the same transaction, for rewrites SQL can't express. */
  up?: (db: Db) => void;
}

function ftsTable(table: string, columns: string[]): string {
  const cols = columns.join(', ');
  const newVals = columns.map((c) => `new.${c}`).join(', ');
  const oldVals = columns.map((c) => `old.${c}`).join(', ');
  const fts = `${table}_fts`;
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(${cols}, content='${table}', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER ${table}_fts_ai AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.id, ${newVals});
END;
CREATE TRIGGER ${table}_fts_ad AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.id, ${oldVals});
END;
CREATE TRIGGER ${table}_fts_au AFTER UPDATE OF ${cols} ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.id, ${oldVals});
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.id, ${newVals});
END;`;
}

const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  name_with_owner TEXT NOT NULL,
  owner TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  language_name TEXT,
  language_color TEXT,
  topics TEXT NOT NULL DEFAULT '[]',
  default_branch TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  open_prs INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  removed_at TEXT
);

CREATE TABLE sync_state (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  commits_pushed_at TEXT,
  commits_branch TEXT,
  prs_hwm TEXT,
  issues_hwm TEXT,
  releases_synced_at TEXT,
  stars_synced_at TEXT,
  stars_full_at TEXT,
  synced_at TEXT,
  last_error TEXT
);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  is_draft INTEGER NOT NULL DEFAULT 0,
  author_login TEXT,
  author_name TEXT,
  author_avatar TEXT,
  merged_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  activity_at TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER NOT NULL DEFAULT 0,
  commit_count INTEGER NOT NULL DEFAULT 0,
  head_ref TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',
  closing_issues TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX pull_requests_activity_at ON pull_requests(activity_at);
CREATE INDEX pull_requests_created_at ON pull_requests(created_at);
CREATE INDEX pull_requests_merged_at ON pull_requests(merged_at);

CREATE TABLE pr_commits (
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  oid TEXT NOT NULL,
  headline TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  url TEXT NOT NULL,
  author_login TEXT,
  author_name TEXT,
  author_email TEXT,
  author_avatar TEXT,
  PRIMARY KEY (pr_id, position)
) WITHOUT ROWID;

CREATE TABLE commits (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  oid TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_login TEXT,
  author_name TEXT,
  author_email TEXT,
  author_avatar TEXT,
  committed_at TEXT NOT NULL,
  url TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  pr_number INTEGER,
  UNIQUE (repo_id, oid)
);
CREATE INDEX commits_committed_at ON commits(committed_at);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  author_login TEXT,
  author_name TEXT,
  author_avatar TEXT,
  closed_by_login TEXT,
  closed_by_name TEXT,
  closed_by_avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  activity_at TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX issues_activity_at ON issues(activity_at);
CREATE INDEX issues_created_at ON issues(created_at);
CREATE INDEX issues_closed_at ON issues(closed_at);

CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL DEFAULT '',
  author_login TEXT,
  author_name TEXT,
  author_avatar TEXT,
  published_at TEXT NOT NULL,
  is_prerelease INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  UNIQUE (repo_id, tag)
);
CREATE INDEX releases_published_at ON releases(published_at);

CREATE TABLE stars (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  starred_at TEXT NOT NULL,
  UNIQUE (repo_id, login)
);
CREATE INDEX stars_starred_at ON stars(starred_at);

CREATE TABLE repo_sets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE repo_set_members (
  set_id INTEGER NOT NULL REFERENCES repo_sets(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (set_id, repo_id)
) WITHOUT ROWID;

CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${ftsTable('pull_requests', ['title', 'body'])}
${ftsTable('issues', ['title', 'body'])}
${ftsTable('commits', ['headline', 'body'])}
${ftsTable('releases', ['tag', 'name', 'body'])}
`;

// Explicit `repos=` lists (and per-repo queries) make SQLite drive from repos; without this index it read
// each repo's whole commit history to apply the date range.
const V2 = `CREATE INDEX IF NOT EXISTS commits_repo_committed_at ON commits(repo_id, committed_at);`;

// Head commit of the last complete default-branch walk: incremental walks stop there (not at the first stored
// commit, which after an interrupted walk would leave a gap).
const V3 = `ALTER TABLE sync_state ADD COLUMN commits_head TEXT;`;

// PR head commit as of the last sync: diffs are cached by it, so an unchanged PR needs no GitHub request.
const V4 = `ALTER TABLE pull_requests ADD COLUMN head_oid TEXT;`;

// Repositories are keyed by owner/name, so that repos of other owners can be tracked next to the viewer's own:
// the short name stops being unique (its inline UNIQUE can only go with a rebuild, as can the visibility CHECK,
// which gains GitHub Enterprise 'internal'). Uniqueness moves to a partial index on the key over live rows, so a
// removed row never blocks a key. Every existing row was synced from the viewer's own repositories: 'owned'.
// tracked_by has no CHECK so that later tracking kinds need no rebuild.
const REPOS_REBUILD = `
CREATE TABLE repos_new (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_with_owner TEXT NOT NULL,
  owner TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  language_name TEXT,
  language_color TEXT,
  topics TEXT NOT NULL DEFAULT '[]',
  default_branch TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  open_prs INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  removed_at TEXT,
  tracked_by TEXT NOT NULL DEFAULT 'owned',
  added_at TEXT,
  unavailable_at TEXT,
  unavailable_reason TEXT
);
INSERT INTO repos_new (id, node_id, name, name_with_owner, owner, description, url, visibility, is_archived, is_fork,
  language_name, language_color, topics, default_branch, stars, forks, open_prs, open_issues, created_at, pushed_at,
  pinned, hidden, removed_at)
SELECT id, node_id, name, name_with_owner, owner, description, url, visibility, is_archived, is_fork,
  language_name, language_color, topics, default_branch, stars, forks, open_prs, open_issues, created_at, pushed_at,
  pinned, hidden, removed_at FROM repos;
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;
-- Two live rows can't share a key today, but a stale one mustn't make the index creation fail: keep the newest.
UPDATE repos SET removed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE removed_at IS NULL AND id NOT IN (SELECT max(id) FROM repos WHERE removed_at IS NULL GROUP BY lower(name_with_owner));
CREATE UNIQUE INDEX repos_key ON repos(name_with_owner COLLATE NOCASE) WHERE removed_at IS NULL;
`;

/**
 * Saved views named repos by short name (`repos=`, `pr=`, `diff=`, `/repos/<name>`): rewrite those to keys. Every
 * live repo is still the viewer's own here, so a name names at most one of them; names that don't (removed repos,
 * typos) are left as they are.
 */
function rewriteSavedViews(db: Db): void {
  const byName = new Map<string, string | null>();
  for (const r of db.all<{ name: string; name_with_owner: string }>('SELECT name, name_with_owner FROM repos WHERE removed_at IS NULL')) {
    const name = r.name.toLowerCase();
    // null: ambiguous (can't happen with owned repos only; left alone if it ever does)
    byName.set(name, byName.has(name) && byName.get(name) !== r.name_with_owner ? null : r.name_with_owner);
  }
  const resolve: RepoResolver = (repo) => (repo.includes('/') ? null : byName.get(repo.toLowerCase()) ?? null);
  for (const v of db.all<{ id: number; path: string; query: string }>('SELECT id, path, query FROM saved_views')) {
    const path = rewriteRepoPath(v.path, resolve);
    const query = rewriteRepoParams(v.query, resolve);
    if (path !== v.path || query !== v.query) db.run('UPDATE saved_views SET path = ?, query = ? WHERE id = ?', [path, query, v.id]);
  }
}

const MIGRATIONS: Migration[] = [
  { version: 1, destructive: false, sql: V1 },
  { version: 2, destructive: false, sql: V2 },
  { version: 3, destructive: false, sql: V3 },
  { version: 4, destructive: false, sql: V4 },
  { version: 5, destructive: true, rebuild: true, sql: REPOS_REBUILD, up: rewriteSavedViews },
];

/** The schema version this build creates and understands. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const userVersion = (db: Db) => Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
const foreignKeysOn = (db: Db) => Number(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys ?? 0) === 1;

function checkNotNewer(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `This database was upgraded by a newer gh-dash (v${version}); this build only knows schema v${SCHEMA_VERSION}. Run the newer gh-dash, or point this one at another database.`,
    );
  }
}

/** Throws (rolling the batch back) if the migrated schema leaves a row pointing at a missing parent. */
function checkForeignKeys(db: Db, from: number, to: number): void {
  const bad = db.all<{ table: string; parent: string }>('PRAGMA foreign_key_check');
  if (bad.length === 0) return;
  const refs = [...new Set(bad.map((r) => `${r.table} → ${r.parent}`))].join(', ');
  throw new Error(
    `Schema migration to v${to} stopped: ${bad.length} ${bad.length === 1 ? 'row' : 'rows'} would reference missing rows (${refs}). The database is unchanged (still schema v${from}).`,
  );
}

export function migrate(db: Db, allowDestructive: boolean): void {
  const current = userVersion(db);
  checkNotNewer(current);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  // A new database (v0) has nothing to lose, so any instance may create it.
  const blocked = current > 0 && pending.find((m) => m.destructive && !allowDestructive);
  if (blocked) {
    throw new Error(
      `Database schema v${current} needs destructive migration v${blocked.version}; start an instance without GH_DASH_SYNC=off once to upgrade it.`,
    );
  }
  // PRAGMA foreign_keys is a silent no-op inside a transaction, so it is switched off before BEGIN.
  const suspendFks = pending.some((m) => m.rebuild) && foreignKeysOn(db);
  if (suspendFks) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      // Re-check inside the write lock in case another process migrated concurrently.
      const now = userVersion(db);
      checkNotNewer(now);
      const batch = MIGRATIONS.filter((x) => x.version > now);
      const rebuild = batch.some((m) => m.rebuild);
      if (rebuild && foreignKeysOn(db)) {
        throw new Error('Cannot suspend foreign keys for a table rebuild: migrate() must not run inside a transaction.');
      }
      for (const m of batch) {
        db.exec(m.sql);
        m.up?.(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      if (rebuild) checkForeignKeys(db, now, SCHEMA_VERSION);
    });
  } finally {
    if (suspendFks) db.exec('PRAGMA foreign_keys = ON');
  }
}
