import { commentExcerpt } from '../../shared/comment-markdown';
import { type RepoResolver, rewriteRepoParams, rewriteRepoPath } from '../../shared/query';
import type { Db } from './db';

interface Migration {
  /** Stable name: tests and code refer to a migration by it (`versionOf`), so renumbering one is a one-line change. */
  name: string;
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
// tracked_by has no CHECK so that later tracking kinds need no rebuild. AUTOINCREMENT: repos added by hand can be
// deleted, and a new one must never get the id of a deleted one (a sync still running for that would write into it).
const REPOS_REBUILD = `
CREATE TABLE repos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// Local review comments (never sent to GitHub). Authors are principals: row 1 is the dashboard's own user; agents
// writing through the API get rows of their own. Threads are keyed by repo and PR number or commit oid, not by
// pull_requests.id: sync may delete and re-create a PR row (a transfer), and the user's comments must outlive that.
// A thread's revision (commit_oid, base_oid) and snippet let a later revision of the PR's diff relocate it.
// AUTOINCREMENT: ids end up in URLs, client caches and agents' hands, so a deleted one must never name something new.
const COMMENTS = `
CREATE TABLE principals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('self', 'agent')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO principals (id, kind, name, created_at) VALUES (1, 'self', 'You', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

CREATE TABLE comment_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  commit_oid TEXT NOT NULL,
  base_oid TEXT,
  path TEXT,
  side TEXT CHECK (side IN ('old', 'new')),
  start_line INTEGER,
  end_line INTEGER,
  snippet TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (side IS NULL OR path IS NOT NULL),
  CHECK ((side IS NULL) = (start_line IS NULL) AND (side IS NULL) = (end_line IS NULL) AND (side IS NULL) = (snippet IS NULL)),
  CHECK (start_line IS NULL OR (start_line >= 1 AND end_line >= start_line))
);
CREATE INDEX comment_threads_target ON comment_threads(repo_id, pr_number, commit_oid);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES principals(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX comments_thread ON comments(thread_id);
`;

// Repositories from several code hosts ("sources"): github.com is source 1, created here (for new databases too) and
// never removed. Every repo belongs to a source and gets its public key as a column (`owner/name` on github.com,
// `<host>/<full path>` elsewhere; see repo-key.ts). node_id stops being globally unique: GitLab ids like
// gid://gitlab/Project/5 exist on every instance, so it is unique per source. The rebuild copies ids, and the
// AUTOINCREMENT high-water mark is carried over explicitly: DROP TABLE deletes the old table's sqlite_sequence row,
// and a deleted repo's id must never come back (see v5). The copy leaves repos_new a sequence row even when it copies
// nothing (seq 0; schema.test.ts pins that, for a table emptied by deletes). Also new: the provider's star count at the
// last stars pass, and the commits an MR landed as (GitLab links commits to MRs by these), with their indexes.
const SOURCES = `
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  base_url TEXT NOT NULL,
  name TEXT NOT NULL,
  viewer_id TEXT,
  viewer_login TEXT,
  viewer_name TEXT,
  viewer_avatar TEXT,
  viewer_emails TEXT NOT NULL DEFAULT '[]',
  last_sync TEXT,
  rate_limit TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sources_host ON sources(host);
INSERT INTO sources (id, kind, host, base_url, name, created_at)
  VALUES (1, 'github', 'github.com', 'https://github.com', 'GitHub', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
CREATE TABLE repos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  key TEXT NOT NULL,
  node_id TEXT NOT NULL,
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
  unavailable_reason TEXT,
  UNIQUE (source_id, node_id)
);
INSERT INTO repos_new (id, source_id, key, node_id, name, name_with_owner, owner, description, url, visibility, is_archived,
  is_fork, language_name, language_color, topics, default_branch, stars, forks, open_prs, open_issues, created_at, pushed_at,
  pinned, hidden, removed_at, tracked_by, added_at, unavailable_at, unavailable_reason)
SELECT id, 1, name_with_owner, node_id, name, name_with_owner, owner, description, url, visibility, is_archived,
  is_fork, language_name, language_color, topics, default_branch, stars, forks, open_prs, open_issues, created_at, pushed_at,
  pinned, hidden, removed_at, tracked_by, added_at, unavailable_at, unavailable_reason FROM repos;
UPDATE sqlite_sequence SET seq = max(seq, ifnull((SELECT seq FROM sqlite_sequence WHERE name = 'repos'), 0)) WHERE name = 'repos_new';
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;
CREATE UNIQUE INDEX repos_key ON repos(key COLLATE NOCASE) WHERE removed_at IS NULL;
ALTER TABLE sync_state ADD COLUMN stars_count INTEGER;
ALTER TABLE pull_requests ADD COLUMN merge_commit_oid TEXT;
ALTER TABLE pull_requests ADD COLUMN squash_commit_oid TEXT;
CREATE INDEX pull_requests_landed ON pull_requests(merge_commit_oid, squash_commit_oid);
CREATE INDEX pr_commits_oid ON pr_commits(oid);
`;

/**
 * The GitHub account (`meta.viewer`) and rate limit (`meta.rateLimit`) the database recorded become source 1's. The
 * run-level keys (lastSync, lastFullSyncAt, syncLock, nextSyncAt, sessionSecret) stay in meta.
 */
function moveViewerMeta(db: Db): void {
  const read = (key: string): unknown => {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? JSON.parse(row.value) : null;
  };
  const viewer = read('viewer') as { id?: unknown; login?: unknown; name?: unknown; avatarUrl?: unknown } | null;
  if (viewer && typeof viewer.login === 'string') {
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    db.run('UPDATE sources SET viewer_id = ?, viewer_login = ?, viewer_name = ?, viewer_avatar = ? WHERE id = 1', [
      text(viewer.id), viewer.login, text(viewer.name), text(viewer.avatarUrl),
    ]);
  }
  const rl = read('rateLimit') as { limit?: unknown; remaining?: unknown; resetAt?: unknown } | null;
  if (rl && typeof rl.limit === 'number' && typeof rl.remaining === 'number' && typeof rl.resetAt === 'string') {
    db.run('UPDATE sources SET rate_limit = ? WHERE id = 1', [JSON.stringify({ limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt })]);
  }
  db.run(`DELETE FROM meta WHERE key IN ('viewer', 'rateLimit')`);
}

// Agents (MCP) and the comment event log. An agent is a principal of kind 'agent' with one token, kept as its sha256
// (the token is shown once); revoking keeps the principal, so its comments stay attributed to it. comment_events records
// every comment write with the thread's place copied in, so an event still reads right once its thread is gone (no
// foreign key to the thread or comment); a removed repo takes its events along. Agent names are unique (any case): the
// `agents` command and tools name an agent by it. Until now only the dashboard's user (principal 1) could write, so it
// resolved every thread that is resolved.
const AGENTS = `
ALTER TABLE comment_threads ADD COLUMN resolved_by INTEGER REFERENCES principals(id);
UPDATE comment_threads SET resolved_by = 1 WHERE status = 'resolved' AND resolved_by IS NULL;
CREATE UNIQUE INDEX principals_agent_name ON principals(name COLLATE NOCASE) WHERE kind = 'agent';
CREATE TABLE agent_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id INTEGER NOT NULL UNIQUE REFERENCES principals(id),
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE comment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK (kind IN ('thread_opened', 'replied', 'edited', 'comment_deleted', 'resolved', 'reopened', 'thread_deleted')),
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  commit_oid TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  comment_id INTEGER,
  path TEXT,
  side TEXT,
  start_line INTEGER,
  end_line INTEGER,
  excerpt TEXT
);
CREATE INDEX comment_events_at ON comment_events(at, id);
CREATE INDEX comment_events_thread ON comment_events(thread_id, id);
CREATE INDEX comment_events_repo ON comment_events(repo_id, at);
`;

/**
 * The comments made before the log existed: each thread's opening and every reply, at their times, by their authors
 * (event ids in time order). Resolving, reopening, edits and deletes left no trace, so they have no events; the excerpt
 * is the comment's words as they are now.
 */
function backfillCommentEvents(db: Db): void {
  const rows = db.all<{ id: number; thread_id: number; author_id: number; body: string; created_at: string; first: number }>(
    `SELECT c.id, c.thread_id, c.author_id, c.body, c.created_at, c.id = (SELECT min(id) FROM comments WHERE thread_id = c.thread_id) AS first
     FROM comments c ORDER BY c.created_at, c.id`,
  );
  for (const c of rows) {
    db.run(
      `INSERT INTO comment_events (at, actor_id, kind, repo_id, pr_number, commit_oid, thread_id, comment_id, path, side, start_line, end_line, excerpt)
       SELECT ?, ?, ?, repo_id, pr_number, commit_oid, id, ?, path, side, start_line, end_line, ? FROM comment_threads WHERE id = ?`,
      [c.created_at, c.author_id, c.first ? 'thread_opened' : 'replied', c.id, commentExcerpt(c.body), c.thread_id],
    );
  }
}

// Branch reviews (shared/api.ts, "Branch groups"). A thread's `branch` is the branch whose line of work it belongs to: a
// branch thread's own (pr_number NULL, branch set: the third kind, beside PR and commit threads), or a PR thread's PR's
// head branch when the PR is from the same repo. pull_requests.cross_repo says which PRs are: 1 from a fork (another
// repo), 0 from the same repo, NULL until the next sync of the PR says. Existing PR threads get their branch when the
// sync first reports their PR's cross_repo as 0; until then they stay their PR's alone. comment_events copies the
// branch, as it copies the rest of the thread's place.
const BRANCHES = `
ALTER TABLE comment_threads ADD COLUMN branch TEXT;
CREATE INDEX comment_threads_branch ON comment_threads(repo_id, branch) WHERE branch IS NOT NULL;
ALTER TABLE comment_events ADD COLUMN branch TEXT;
ALTER TABLE pull_requests ADD COLUMN cross_repo INTEGER CHECK (cross_repo IN (0, 1));
CREATE INDEX pull_requests_head_ref ON pull_requests(repo_id, head_ref);
`;

// Which sources an agent may reach through MCP (Settings → Agents, `agents scope`). `all_sources` 1, the default (every
// principal before this had it), is every source, sources added later included; 0 is only those agent_sources lists.
// Deleting a source takes its rows along but never widens an agent: one left with none reaches nothing. Only agents are
// ever limited (db/agents.ts): the dashboard's own user keeps 1. The REST API isn't scoped: it is the user's own.
const AGENT_SOURCES = `
ALTER TABLE principals ADD COLUMN all_sources INTEGER NOT NULL DEFAULT 1 CHECK (all_sources IN (0, 1));
CREATE TABLE agent_sources (
  principal_id INTEGER NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, source_id)
);
`;

const MIGRATIONS: Migration[] = [
  { name: 'initial', version: 1, destructive: false, sql: V1 },
  { name: 'commits-repo-index', version: 2, destructive: false, sql: V2 },
  { name: 'commits-head', version: 3, destructive: false, sql: V3 },
  { name: 'pr-head-oid', version: 4, destructive: false, sql: V4 },
  { name: 'repos-v5', version: 5, destructive: true, rebuild: true, sql: REPOS_REBUILD, up: rewriteSavedViews },
  { name: 'comments', version: 6, destructive: false, sql: COMMENTS },
  { name: 'sources', version: 7, destructive: true, rebuild: true, sql: SOURCES, up: moveViewerMeta },
  { name: 'agents', version: 8, destructive: false, sql: AGENTS, up: backfillCommentEvents },
  { name: 'branches', version: 9, destructive: false, sql: BRANCHES },
  { name: 'agent-sources', version: 10, destructive: false, sql: AGENT_SOURCES },
];

/** The schema version this build creates and understands. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** The version of the migration called `name` (throws for an unknown name). */
export function versionOf(name: string): number {
  const m = MIGRATIONS.find((x) => x.name === name);
  if (!m) throw new Error(`No migration is called ${name}`);
  return m.version;
}

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

/** A new database (v0) has nothing to lose, so any instance may create it; an existing one needs a syncing instance. */
function checkDestructive(version: number, pending: Migration[], allowDestructive: boolean): void {
  const blocked = version > 0 && pending.find((m) => m.destructive && !allowDestructive);
  if (blocked) {
    throw new Error(
      `Database schema v${version} needs destructive migration v${blocked.version}; start an instance without GH_DASH_SYNC=off once to upgrade it.`,
    );
  }
}

export interface MigrateOptions {
  /** Stop after this version (tests build a database as it was before a migration: `versionOf(name) - 1`). */
  upTo?: number;
}

export function migrate(db: Db, allowDestructive: boolean, opts: MigrateOptions = {}): void {
  const upTo = opts.upTo ?? SCHEMA_VERSION;
  const known = MIGRATIONS.filter((m) => m.version <= upTo);
  const current = userVersion(db);
  checkNotNewer(current);
  const pending = known.filter((m) => m.version > current);
  if (pending.length === 0) return;
  checkDestructive(current, pending, allowDestructive);
  // PRAGMA foreign_keys is a silent no-op inside a transaction, so it is switched off before BEGIN.
  const suspendFks = pending.some((m) => m.rebuild) && foreignKeysOn(db);
  if (suspendFks) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      // Re-check inside the write lock in case another process migrated concurrently.
      const now = userVersion(db);
      checkNotNewer(now);
      const batch = known.filter((x) => x.version > now);
      // Another process may have created the database meanwhile: the fresh-database exception holds only while it is still v0.
      checkDestructive(now, batch, allowDestructive);
      const rebuild = batch.some((m) => m.rebuild);
      if (rebuild && foreignKeysOn(db)) {
        throw new Error('Cannot suspend foreign keys for a table rebuild: migrate() must not run inside a transaction.');
      }
      for (const m of batch) {
        db.exec(m.sql);
        m.up?.(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      if (rebuild) checkForeignKeys(db, now, batch.at(-1)!.version);
    });
  } finally {
    if (suspendFks) db.exec('PRAGMA foreign_keys = ON');
  }
}
