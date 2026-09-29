import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Db, openDb } from './db';
import { migrate, SCHEMA_VERSION, versionOf } from './schema';

/** The repos rebuild's tests look at the database it leaves: they stop there. */
const V5 = { upTo: versionOf('repos-v5') };

const V4_SQL = readFileSync(new URL('../test/fixtures/schema-v4.sql', import.meta.url), 'utf8');

/** A database at schema v4, built from the frozen v4 SQL, with foreign keys on (as openDb leaves them). */
function v4(seed: (db: Db) => void = seedV4): Db {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(V4_SQL);
  sqlite.exec('PRAGMA user_version = 4');
  const db = new Db(sqlite);
  seed(db);
  return db;
}

const REPO_COLS = `id, node_id, name, name_with_owner, owner, description, url, visibility, is_archived, is_fork, language_name,
  language_color, topics, default_branch, stars, forks, open_prs, open_issues, created_at, pushed_at, pinned, hidden, removed_at`;

function repo(db: Db, id: number, name: string, over: { owner?: string; visibility?: string; removedAt?: string | null; pinned?: number; hidden?: number } = {}) {
  const owner = over.owner ?? 'alice';
  const nwo = `${owner}/${name.replace(/~\d+$/, '')}`;
  db.run(`INSERT INTO repos (${REPO_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'TypeScript', '#3178c6', '["dash"]', 'main', 3, 1, 2, 1,
    '2025-01-01T00:00:00Z', '2026-09-25T00:00:00Z', ?, ?, ?)`, [
    id, `R_${id}`, name, nwo, owner, `${name} repo`, `https://github.com/${nwo}`, over.visibility ?? 'public',
    over.pinned ?? 0, over.hidden ?? 0, over.removedAt ?? null,
  ]);
}

/** Two live repos (a, b), a removed one renamed to a~3 by the old collision rule, and data in every table. */
function seedV4(db: Db): void {
  db.run(`INSERT INTO meta (key, value) VALUES ('viewer', '{"login":"alice"}')`);
  db.run(`INSERT INTO settings (key, value) VALUES ('includeForks', 'true')`);
  repo(db, 1, 'a', { pinned: 1 });
  repo(db, 2, 'b', { visibility: 'private', hidden: 1 });
  repo(db, 3, 'a~3', { removedAt: '2026-01-01T00:00:00Z' });
  for (const id of [1, 2, 3]) {
    db.run(`INSERT INTO sync_state (repo_id, synced_at, commits_head) VALUES (?, '2026-09-27T00:00:00Z', 'abc')`, [id]);
    db.run(`INSERT INTO pull_requests (id, repo_id, number, title, body, state, created_at, updated_at, activity_at, url, head_oid)
      VALUES (?, ?, 1, 'Add parser ${id}', 'body ${id}', 'open', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 'u', 'abc')`, [id * 10, id]);
    db.run(`INSERT INTO pr_commits (pr_id, position, oid, headline, committed_at, url) VALUES (?, 0, 'abc', 'fix', '2026-09-01T00:00:00Z', 'u')`, [id * 10]);
    for (const n of [1, 2]) {
      db.run(`INSERT INTO commits (repo_id, oid, headline, body, committed_at, url) VALUES (?, ?, 'Refactor parser', 'details', '2026-09-0${n}T00:00:00Z', 'u')`, [id, `${id}${n}`]);
    }
    db.run(`INSERT INTO issues (repo_id, number, title, state, created_at, updated_at, activity_at, url)
      VALUES (?, 5, 'Parser crash', 'open', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'u')`, [id]);
    db.run(`INSERT INTO releases (repo_id, tag, name, published_at, url) VALUES (?, 'v1.0.0', 'Parser', '2026-09-01T00:00:00Z', 'u')`, [id]);
    db.run(`INSERT INTO stars (repo_id, login, starred_at) VALUES (?, 'carol', '2026-09-01T00:00:00Z')`, [id]);
  }
  db.run(`INSERT INTO repo_sets (id, name, created_at) VALUES (1, 'Work', '2026-09-01T00:00:00Z')`);
  db.run(`INSERT INTO repo_set_members (set_id, repo_id, position) VALUES (1, 2, 0), (1, 1, 1)`);
  db.run(`INSERT INTO saved_views (name, path, query, created_at) VALUES ('Mine', '/prs', 'who=me', '2026-09-01T00:00:00Z')`);
}

const TABLES = ['meta', 'settings', 'repos', 'sync_state', 'pull_requests', 'pr_commits', 'commits', 'issues', 'releases', 'stars', 'repo_sets', 'repo_set_members', 'saved_views'];
const FTS = ['pull_requests_fts', 'issues_fts', 'commits_fts', 'releases_fts'];

const counts = (db: Db) => Object.fromEntries(TABLES.map((t) => [t, db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n]));
const version = (db: Db) => db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
const foreignKeys = (db: Db) => db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys;
const reposSql = (db: Db) => db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repos'`)!.sql;
const views = (db: Db) => db.all<{ name: string; path: string; query: string }>('SELECT name, path, query FROM saved_views ORDER BY id');

function expectFtsIntact(db: Db): void {
  for (const t of FTS) db.exec(`INSERT INTO ${t}(${t}) VALUES ('integrity-check')`);
  expect(db.all<{ rowid: number }>(`SELECT rowid FROM commits_fts WHERE commits_fts MATCH 'parser'`).length).toBe(counts(db).commits);
}

describe('migration to repo keys (repos rebuild)', () => {
  it('rebuilds repos without touching the rows that reference it', () => {
    const db = v4();
    const before = counts(db);
    const oldRows = db.all(`SELECT ${REPO_COLS} FROM repos ORDER BY id`);
    migrate(db, true, V5);

    expect(version(db)).toBe(versionOf('repos-v5'));
    expect(counts(db)).toEqual(before);
    expect(db.all(`SELECT ${REPO_COLS} FROM repos ORDER BY id`)).toEqual(oldRows);
    expect(db.all('SELECT repo_id, position FROM repo_set_members ORDER BY position')).toEqual([{ repo_id: 2, position: 0 }, { repo_id: 1, position: 1 }]);
    expectFtsIntact(db);
    expect(foreignKeys(db)).toBe(1);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    for (const t of ['sync_state', 'pull_requests', 'commits', 'issues', 'releases', 'stars', 'repo_set_members']) {
      expect(db.all<{ table: string }>(`PRAGMA foreign_key_list(${t})`).map((f) => f.table), t).toContain('repos');
    }
  });

  it('backfills every existing repo as owned', () => {
    const db = v4();
    migrate(db, true, V5);
    expect(db.all('SELECT DISTINCT tracked_by, added_at, unavailable_at, unavailable_reason FROM repos')).toEqual([
      { tracked_by: 'owned', added_at: null, unavailable_at: null, unavailable_reason: null },
    ]);
    // Old removed rows (renamed by the old collision rule) are left as they were.
    expect(db.get('SELECT name, removed_at FROM repos WHERE id = 3')).toEqual({ name: 'a~3', removed_at: '2026-01-01T00:00:00Z' });
  });

  it('keys repos by owner/name among live repos, case-insensitively', () => {
    const db = v4();
    migrate(db, true, V5);
    const idx = db.all<{ name: string; unique: number; partial: number }>('PRAGMA index_list(repos)');
    expect(idx.find((i) => i.name === 'repos_key')).toMatchObject({ unique: 1, partial: 1 });
    // Only node_id is unique inline: the short name no longer is.
    expect(idx.filter((i) => i.name.startsWith('sqlite_autoindex')).length).toBe(1);
    expect(reposSql(db)).not.toMatch(/name TEXT NOT NULL UNIQUE/);
    expect(db.all<{ name: string; coll: string; key: number }>('PRAGMA index_xinfo(repos_key)').filter((c) => c.key)).toMatchObject([
      { name: 'name_with_owner', coll: 'NOCASE' },
    ]);

    // Same short name, another owner: fine (the manual repo next to the owned one).
    repo(db, 4, 'a', { owner: 'bob' });
    // A second live row with the same key (any case) is refused; a removed one is not.
    expect(() => repo(db, 5, 'A', { owner: 'ALICE' })).toThrow(/UNIQUE constraint failed: repos\.name_with_owner/);
    repo(db, 6, 'a', { removedAt: '2026-09-01T00:00:00Z' });
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM repos WHERE name_with_owner = 'alice/a'`)!.n).toBe(3);
  });

  it("widens visibility to 'internal' and takes tracked_by without a CHECK", () => {
    const db = v4();
    migrate(db, true, V5);
    repo(db, 4, 'corp', { owner: 'acme', visibility: 'internal' });
    expect(() => repo(db, 5, 'x', { visibility: 'secret' })).toThrow(/CHECK constraint failed/);
    db.run(`UPDATE repos SET tracked_by = 'manual', added_at = '2026-09-29T00:00:00Z' WHERE id = 4`);
    expect(db.get('SELECT visibility, tracked_by FROM repos WHERE id = 4')).toEqual({ visibility: 'internal', tracked_by: 'manual' });
  });

  it('keeps foreign keys pointing at the new table: deleting a repo cascades, FTS included', () => {
    const db = v4();
    migrate(db, true, V5);
    db.run('DELETE FROM repos WHERE id = 1');
    for (const t of ['sync_state', 'pull_requests', 'commits', 'issues', 'releases', 'stars', 'repo_set_members']) {
      expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE repo_id = 1`)!.n, t).toBe(0);
    }
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM pr_commits WHERE pr_id = 10')!.n).toBe(0);
    expect(counts(db).commits).toBe(4);
    expectFtsIntact(db);
    expect(() => db.run(`INSERT INTO commits (repo_id, oid, headline, committed_at, url) VALUES (99, 'x', 'x', 'x', 'u')`)).toThrow(/FOREIGN KEY/);
  });

  it('marks all but the newest of live rows sharing a key (in any case) removed', () => {
    const db = v4((d) => {
      repo(d, 1, 'app');
      repo(d, 2, 'App');
      repo(d, 3, 'app~3', { removedAt: '2026-01-01T00:00:00Z' });
      repo(d, 4, 'other');
    });
    migrate(db, true, V5);
    const rows = db.all<{ id: number; removed_at: string | null }>('SELECT id, removed_at FROM repos ORDER BY id');
    expect(rows[0]!.removed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(rows.slice(1)).toEqual([{ id: 2, removed_at: null }, { id: 3, removed_at: '2026-01-01T00:00:00Z' }, { id: 4, removed_at: null }]);
  });

  it('rolls back to v4 when the rebuilt schema would leave a dangling reference', () => {
    const db = v4();
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(`INSERT INTO commits (repo_id, oid, headline, committed_at, url) VALUES (99, 'x', 'x', 'x', 'u')`);
    db.exec('PRAGMA foreign_keys = ON');
    db.run(`INSERT INTO saved_views (name, path, query, created_at) VALUES ('A', '/prs', 'repos=a', 'x')`);
    const before = counts(db);
    const oldSql = reposSql(db);

    expect(() => migrate(db, true)).toThrow(/1 row .*commits → repos.*still schema v4/);
    expect(version(db)).toBe(4);
    expect(reposSql(db)).toBe(oldSql);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name IN ('repos_new', 'repos_key')`)).toBeUndefined();
    expect(counts(db)).toEqual(before);
    expect(views(db).map((v) => v.query)).toEqual(['who=me', 'repos=a']);
    expect(foreignKeys(db)).toBe(1);
  });

  it('refuses to rebuild inside an open transaction, where foreign keys cannot be suspended', () => {
    const db = v4();
    const before = counts(db);
    expect(() => db.tx(() => migrate(db, true))).toThrow(/foreign keys/);
    expect(version(db)).toBe(4);
    expect(counts(db)).toEqual(before);
    expect(foreignKeys(db)).toBe(1);
  });

  it('is left to an instance that syncs (GH_DASH_SYNC=off refuses it)', () => {
    const db = v4();
    expect(() => migrate(db, false)).toThrow(/Database schema v4 needs destructive migration v\d+; start an instance without GH_DASH_SYNC=off/);
    expect(version(db)).toBe(4);
  });

  it('still lets any instance create a new database', () => {
    const db = new Db(new DatabaseSync(':memory:'));
    migrate(db, false);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(foreignKeys(db)).toBe(1);
  });

  it('rechecks under the write lock: a database another process created meanwhile is not rebuilt by a sync-off instance', () => {
    const db = new Db(new DatabaseSync(':memory:'));
    // This instance saw v0 (a new database); before it takes the write lock, another process creates the v4 schema.
    const tx = db.tx.bind(db);
    db.tx = <T>(fn: () => T): T => {
      db.exec(V4_SQL);
      db.exec('PRAGMA user_version = 4');
      return tx(fn);
    };
    expect(() => migrate(db, false)).toThrow(/Database schema v4 needs destructive migration v\d+/);
    expect(version(db)).toBe(4);
  });

  it('refuses a database from a newer gh-dash', () => {
    const db = new Db(new DatabaseSync(':memory:'));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    for (const allow of [true, false]) {
      expect(() => migrate(db, allow)).toThrow(`This database was upgraded by a newer gh-dash (v${SCHEMA_VERSION + 1})`);
    }
    expect(version(db)).toBe(SCHEMA_VERSION + 1);
  });

  it('never hands out the id of a deleted repo again (AUTOINCREMENT), also after migrating', () => {
    for (const db of [v4(), openDb(':memory:')]) {
      if (version(db) === 4) migrate(db, true, V5);
      else repo(db, 1, 'a');
      const max = db.get<{ id: number }>('SELECT max(id) AS id FROM repos')!.id;
      db.run('DELETE FROM repos WHERE id = ?', [max]);
      const { lastInsertRowid } = db.run(`INSERT INTO repos (node_id, name, name_with_owner, owner, url, visibility, created_at) VALUES ('R_new', 'new', 'x/new', 'x', 'u', 'public', 'x')`);
      expect(lastInsertRowid).toBe(max + 1);
    }
  });

  it('creates new databases at the latest version with foreign keys on', () => {
    const db = openDb(':memory:');
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(foreignKeys(db)).toBe(1);
    expect(db.all<{ name: string }>('PRAGMA index_list(repos)').map((i) => i.name)).toContain('repos_key');
  });
});

describe('saved views on migration', () => {
  function migrated(rows: [path: string, query: string][]) {
    const db = v4((d) => {
      seedV4(d);
      repo(d, 4, 'gone', { removedAt: '2026-01-01T00:00:00Z' });
      d.run('DELETE FROM saved_views');
      for (const [path, query] of rows) d.run(`INSERT INTO saved_views (name, path, query, created_at) VALUES ('v', ?, ?, 'x')`, [path, query]);
    });
    migrate(db, true);
    return views(db).map((v) => [v.path, v.query]);
  }

  it('names repos by key in `repos`, and leaves unknown entries', () => {
    expect(migrated([
      ['/prs', 'repos=a,b'],
      ['/prs', 'repos=a,nope'],
      ['/prs', 'repos=nope&who=me'],
      ['/prs', 'repos=B'],
      ['/prs', 'repos=gone'],
      ['/prs', 'repos=a~3'],
      ['/prs', 'repos='],
    ])).toEqual([
      ['/prs', 'repos=alice/a,alice/b'],
      ['/prs', 'repos=alice/a,nope'],
      ['/prs', 'repos=nope&who=me'],
      ['/prs', 'repos=alice/b'],
      ['/prs', 'repos=gone'],
      ['/prs', 'repos=a~3'],
      ['/prs', 'repos='],
    ]);
  });

  it('rewrites the repo part of `pr` and `diff`, and keeps every other param byte-identical', () => {
    expect(migrated([
      ['/prs', 'who=me&pr=a%231&range=custom&from=2026-09-01&to=2026-09-27'],
      ['/activity', 'diff=b@abc1234&file=src/x%20y.ts&q=a%20b+c&types=pr,commit'],
      ['/prs', 'diff=a%2312&x=%7E'],
    ])).toEqual([
      ['/prs', 'who=me&pr=alice/a%231&range=custom&from=2026-09-01&to=2026-09-27'],
      ['/activity', 'diff=alice/b@abc1234&file=src/x%20y.ts&q=a%20b+c&types=pr,commit'],
      ['/prs', 'diff=alice/a%2312&x=%7E'],
    ]);
  });

  it('understands percent-encoded input', () => {
    expect(migrated([
      ['/prs', 'repos=alice%2Fa,b'],
      ['/prs', 'repos=alice%2Fb'],
      ['/prs', 'repos=a%2Cb'],
    ])).toEqual([
      ['/prs', 'repos=alice/a,alice/b'],
      ['/prs', 'repos=alice%2Fb'],
      ['/prs', 'repos=alice/a,alice/b'],
    ]);
  });

  it('moves views of a repository page to its /repos/<owner>/<name> path', () => {
    expect(migrated([['/repos/a', ''], ['/repos/nope', 'who=me'], ['/repos', 'repos=a']])).toEqual([
      ['/repos/alice/a', ''],
      ['/repos/nope', 'who=me'],
      ['/repos', 'repos=alice/a'],
    ]);
  });
});

describe('migration names', () => {
  it('number migrations by name, and stop where asked', () => {
    expect(versionOf('repos-v5')).toBe(5);
    expect(versionOf('pr-head-oid')).toBe(4);
    expect(() => versionOf('nope')).toThrow('No migration is called nope');
    const db = new Db(new DatabaseSync(':memory:'));
    migrate(db, true, { upTo: versionOf('pr-head-oid') });
    expect(version(db)).toBe(versionOf('pr-head-oid'));
    expect(db.all<{ name: string }>('PRAGMA table_info(repos)').map((c) => c.name)).not.toContain('tracked_by');
    migrate(db, true);
    expect(version(db)).toBe(SCHEMA_VERSION);
  });
});
