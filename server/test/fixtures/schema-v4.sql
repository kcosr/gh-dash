-- Schema v4 exactly as gh-dash created it before the tracked-repos rebuild (V1..V4 of server/db/schema.ts at 4edf6a1).
-- Frozen: migration tests build old databases from this instead of from the current migration list.

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

CREATE VIRTUAL TABLE pull_requests_fts USING fts5(title, body, content='pull_requests', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER pull_requests_fts_ai AFTER INSERT ON pull_requests BEGIN
  INSERT INTO pull_requests_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER pull_requests_fts_ad AFTER DELETE ON pull_requests BEGIN
  INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER pull_requests_fts_au AFTER UPDATE OF title, body ON pull_requests BEGIN
  INSERT INTO pull_requests_fts(pull_requests_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO pull_requests_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE VIRTUAL TABLE issues_fts USING fts5(title, body, content='issues', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER issues_fts_au AFTER UPDATE OF title, body ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO issues_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE VIRTUAL TABLE commits_fts USING fts5(headline, body, content='commits', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER commits_fts_ai AFTER INSERT ON commits BEGIN
  INSERT INTO commits_fts(rowid, headline, body) VALUES (new.id, new.headline, new.body);
END;
CREATE TRIGGER commits_fts_ad AFTER DELETE ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, headline, body) VALUES ('delete', old.id, old.headline, old.body);
END;
CREATE TRIGGER commits_fts_au AFTER UPDATE OF headline, body ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, headline, body) VALUES ('delete', old.id, old.headline, old.body);
  INSERT INTO commits_fts(rowid, headline, body) VALUES (new.id, new.headline, new.body);
END;

CREATE VIRTUAL TABLE releases_fts USING fts5(tag, name, body, content='releases', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER releases_fts_ai AFTER INSERT ON releases BEGIN
  INSERT INTO releases_fts(rowid, tag, name, body) VALUES (new.id, new.tag, new.name, new.body);
END;
CREATE TRIGGER releases_fts_ad AFTER DELETE ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, tag, name, body) VALUES ('delete', old.id, old.tag, old.name, old.body);
END;
CREATE TRIGGER releases_fts_au AFTER UPDATE OF tag, name, body ON releases BEGIN
  INSERT INTO releases_fts(releases_fts, rowid, tag, name, body) VALUES ('delete', old.id, old.tag, old.name, old.body);
  INSERT INTO releases_fts(rowid, tag, name, body) VALUES (new.id, new.tag, new.name, new.body);
END;

CREATE INDEX IF NOT EXISTS commits_repo_committed_at ON commits(repo_id, committed_at);
ALTER TABLE sync_state ADD COLUMN commits_head TEXT;
ALTER TABLE pull_requests ADD COLUMN head_oid TEXT;
