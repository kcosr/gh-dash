import type { Db } from './db';

interface Migration {
  version: number;
  /** Destructive migrations (drops/rebuilds) never run from a GH_DASH_SYNC=off instance. */
  destructive: boolean;
  sql: string;
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

const MIGRATIONS: Migration[] = [
  { version: 1, destructive: false, sql: V1 },
  { version: 2, destructive: false, sql: V2 },
  { version: 3, destructive: false, sql: V3 },
  { version: 4, destructive: false, sql: V4 },
];

export function migrate(db: Db, allowDestructive: boolean): void {
  const current = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  const blocked = pending.find((m) => m.destructive && !allowDestructive);
  if (blocked) {
    throw new Error(
      `Database schema v${current} needs destructive migration v${blocked.version}; start an instance without GH_DASH_SYNC=off once to upgrade it.`,
    );
  }
  db.tx(() => {
    // Re-check inside the write lock in case another process migrated concurrently.
    const now = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
    for (const m of MIGRATIONS.filter((x) => x.version > now)) {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
  });
}
