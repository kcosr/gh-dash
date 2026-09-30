import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Db, openDb } from './db';
import { getThread } from './comments';
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

/** Whether repos has its source and key columns (the `sources` migration ran). */
const keyed = (db: Db) => db.all<{ name: string }>('PRAGMA table_info(repos)').some((c) => c.name === 'key');

function repo(db: Db, id: number, name: string, over: { owner?: string; visibility?: string; removedAt?: string | null; pinned?: number; hidden?: number } = {}) {
  const owner = over.owner ?? 'alice';
  const nwo = `${owner}/${name.replace(/~\d+$/, '')}`;
  const [cols, vals] = keyed(db) ? [`source_id, key, ${REPO_COLS}`, [1, nwo]] : [REPO_COLS, []];
  db.run(`INSERT INTO repos (${cols}) VALUES (${vals.map(() => '?, ').join('')}?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'TypeScript', '#3178c6', '["dash"]', 'main', 3, 1, 2, 1,
    '2025-01-01T00:00:00Z', '2026-09-25T00:00:00Z', ?, ?, ?)`, [
    ...vals, id, `R_${id}`, name, nwo, owner, `${name} repo`, `https://github.com/${nwo}`, over.visibility ?? 'public',
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
      const [cols, vals] = keyed(db) ? ['source_id, key, ', `1, 'x/new', `] : ['', ''];
      const { lastInsertRowid } = db.run(`INSERT INTO repos (${cols}node_id, name, name_with_owner, owner, url, visibility, created_at) VALUES (${vals}'R_new', 'new', 'x/new', 'x', 'u', 'public', 'x')`);
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

describe('migration to sources', () => {
  const SOURCES = versionOf('sources');
  const VIEWER = { id: 'U_alice', login: 'alice', name: 'Alice A', avatarUrl: 'https://avatars.example/alice' };
  const RATE = { limit: 5000, remaining: 4321, resetAt: '2026-09-29T12:00:00Z' };

  /**
   * A database as it was just before `sources`, with foreign keys on: seedV4's rows (two live repos, a removed one,
   * data in every table), a repo added by hand that became unavailable, and a repo with the highest id deleted, so the
   * id sequence is ahead of max(id). meta holds the GitHub account and rate limit, and the run-level keys.
   */
  function beforeSources(seed: (db: Db) => void = seedBeforeSources): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    migrate(db, true, { upTo: SOURCES - 1 });
    seed(db);
    return db;
  }

  function seedBeforeSources(db: Db): void {
    seedV4(db);
    db.run(`UPDATE meta SET value = ? WHERE key = 'viewer'`, [JSON.stringify(VIEWER)]);
    for (const [key, value] of [['rateLimit', RATE], ['lastSync', { at: 'x', errors: [] }], ['lastFullSyncAt', 'x'], ['sessionSecret', 's']] as const) {
      db.run('INSERT INTO meta (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }
    repo(db, 4, 'tool', { owner: 'bob' });
    db.run(`UPDATE repos SET tracked_by = 'manual', added_at = '2026-09-28T00:00:00Z', unavailable_at = '2026-09-29T00:00:00Z', unavailable_reason = 'gone' WHERE id = 4`);
    db.run(`INSERT INTO sync_state (repo_id, synced_at) VALUES (4, '2026-09-28T00:00:00Z')`);
    repo(db, 10, 'deleted');
    db.run('DELETE FROM repos WHERE id = 10');
  }

  const V5_REPO_COLS = `${REPO_COLS}, tracked_by, added_at, unavailable_at, unavailable_reason`;
  const meta = (db: Db) => db.all<{ key: string; value: string }>('SELECT key, value FROM meta ORDER BY key');
  const source1 = (db: Db) => db.get<Record<string, unknown>>('SELECT * FROM sources WHERE id = 1');
  const seq = (db: Db) => db.get<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'repos'`)?.seq ?? null;
  const insert = (db: Db, id: number | null, sourceId: number, key: string, nodeId: string, removedAt: string | null = null) =>
    db.run(`INSERT INTO repos (id, source_id, key, node_id, name, name_with_owner, owner, url, visibility, created_at, removed_at)
      VALUES (?, ?, ?, ?, 'app', 'alice/app', 'alice', 'u', 'public', 'x', ?)`, [id, sourceId, key, nodeId, removedAt]).lastInsertRowid;

  it('keeps every row of every table, and foreign keys and full-text search working', () => {
    const db = beforeSources();
    const before = counts(db);
    const oldRepos = db.all(`SELECT ${V5_REPO_COLS} FROM repos ORDER BY id`);
    const children = Object.fromEntries(TABLES.filter((t) => t !== 'meta' && t !== 'repos').map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));
    migrate(db, true);

    expect(version(db)).toBe(SCHEMA_VERSION);
    // Two meta keys moved into the github.com source's row.
    expect(counts(db)).toEqual({ ...before, meta: before.meta! - 2 });
    expect(db.all(`SELECT ${V5_REPO_COLS} FROM repos ORDER BY id`)).toEqual(oldRepos);
    for (const [t, rows] of Object.entries(children)) {
      // New columns (NULL) aside, the child rows are the same. The columns are the ones the rows had before: later
      // migrations add more (and a statement prepared before a migration may or may not report them, by Node version).
      const now = db.all<Record<string, unknown>>(`SELECT * FROM ${t} ORDER BY 1, 2`);
      const cols = Object.keys(rows[0] ?? {});
      expect(now.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), t).toEqual(rows);
      for (const r of now) for (const [c, v] of Object.entries(r)) if (!cols.includes(c)) expect(v, `${t}.${c}`).toBeNull();
    }
    expectFtsIntact(db);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(foreignKeys(db)).toBe(1);
    expect(db.all<{ table: string }>('PRAGMA foreign_key_list(repos)').map((f) => f.table)).toEqual(['sources']);
    for (const t of ['sync_state', 'pull_requests', 'commits', 'issues', 'releases', 'stars', 'repo_set_members']) {
      expect(db.all<{ table: string }>(`PRAGMA foreign_key_list(${t})`).map((f) => f.table), t).toContain('repos');
    }
    // Deleting a repo still cascades.
    db.run('DELETE FROM repos WHERE id = 1');
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM commits WHERE repo_id = 1')!.n).toBe(0);
    expectFtsIntact(db);
  });

  it('puts every repo on github.com, keyed by its owner/name', () => {
    const db = beforeSources();
    migrate(db, true);
    expect(db.all('SELECT id, source_id, key, name_with_owner FROM repos ORDER BY id')).toEqual([
      { id: 1, source_id: 1, key: 'alice/a', name_with_owner: 'alice/a' },
      { id: 2, source_id: 1, key: 'alice/b', name_with_owner: 'alice/b' },
      { id: 3, source_id: 1, key: 'alice/a', name_with_owner: 'alice/a' },
      { id: 4, source_id: 1, key: 'bob/tool', name_with_owner: 'bob/tool' },
    ]);
    expect(db.all('SELECT id, kind, host, base_url, name FROM sources')).toEqual([
      { id: 1, kind: 'github', host: 'github.com', base_url: 'https://github.com', name: 'GitHub' },
    ]);
  });

  it("moves meta.viewer and meta.rateLimit into github.com's row; run-level keys stay", () => {
    const db = beforeSources();
    migrate(db, true);
    expect(source1(db)).toMatchObject({
      viewer_id: 'U_alice', viewer_login: 'alice', viewer_name: 'Alice A', viewer_avatar: 'https://avatars.example/alice', viewer_emails: '[]',
      last_sync: null, rate_limit: JSON.stringify(RATE), created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    });
    expect(meta(db).map((m) => m.key)).toEqual(['lastFullSyncAt', 'lastSync', 'sessionSecret']);
  });

  it('keeps an account stored by login only (no id), and leaves an unclaimed database unclaimed', () => {
    const byLogin = beforeSources((d) => {
      seedV4(d); // meta.viewer is {"login":"alice"}
    });
    migrate(byLogin, true);
    expect(source1(byLogin)).toMatchObject({ viewer_id: null, viewer_login: 'alice', viewer_name: null, viewer_avatar: null, rate_limit: null });

    const fresh = beforeSources(() => {});
    migrate(fresh, true);
    expect(source1(fresh)).toMatchObject({ viewer_id: null, viewer_login: null, rate_limit: null });
    expect(meta(fresh)).toEqual([]);
  });

  it('never hands out the id of a deleted repo again: the sequence is carried over', () => {
    const db = beforeSources();
    expect(seq(db)).toBe(10);
    migrate(db, true);
    expect(seq(db)).toBe(10);
    expect(insert(db, null, 1, 'x/new', 'R_new')).toBe(11);
  });

  it('carries the sequence over when every repo was deleted', () => {
    const db = beforeSources((d) => {
      repo(d, 7, 'gone');
      d.run('DELETE FROM repos');
    });
    expect(seq(db)).toBe(7);
    migrate(db, true);
    expect(seq(db)).toBe(7);
    expect(insert(db, null, 1, 'x/new', 'R_new')).toBe(8);
  });

  it('makes node ids unique per source and keys unique among live repos', () => {
    const db = beforeSources();
    migrate(db, true);
    db.run(`INSERT INTO sources (id, kind, host, base_url, name, created_at) VALUES (2, 'gitlab', 'gitlab.example.com', 'https://gitlab.example.com', 'GitLab', 'x'),
      (3, 'gitlab', 'gitlab2.example.com', 'https://gitlab2.example.com', 'gitlab2.example.com', 'x')`);
    // The same GitLab project id on two instances: two repos.
    insert(db, null, 2, 'gitlab.example.com/alice/app', 'gid://gitlab/Project/5');
    insert(db, null, 3, 'gitlab2.example.com/alice/app', 'gid://gitlab/Project/5');
    expect(() => insert(db, null, 2, 'gitlab.example.com/alice/other', 'gid://gitlab/Project/5')).toThrow(/UNIQUE constraint failed: repos\.source_id, repos\.node_id/);
    // One live row per key, in any case; removed rows don't count.
    expect(() => insert(db, null, 2, 'GitLab.example.com/Alice/App', 'gid://gitlab/Project/6')).toThrow(/UNIQUE constraint failed: repos\.key/);
    insert(db, null, 2, 'gitlab.example.com/alice/app', 'gid://gitlab/Project/7', '2026-09-01T00:00:00Z');
    expect(db.all<{ name: string; coll: string; key: number }>('PRAGMA index_xinfo(repos_key)').filter((c) => c.key)).toMatchObject([{ name: 'key', coll: 'NOCASE' }]);
    // A repo must belong to a source that exists.
    expect(() => insert(db, null, 9, 'nowhere.example.com/x/y', 'gid://gitlab/Project/8')).toThrow(/FOREIGN KEY/);
    // Hosts are unique.
    expect(() => db.run(`INSERT INTO sources (kind, host, base_url, name, created_at) VALUES ('gitlab', 'gitlab.example.com', 'https://gitlab.example.com/x', 'GitLab', 'x')`)).toThrow(/UNIQUE constraint failed: sources\.host/);
  });

  it('adds the star count, the landed commits of a pull request, and their indexes', () => {
    const db = beforeSources();
    migrate(db, true);
    const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols('sync_state')).toContain('stars_count');
    expect(cols('pull_requests')).toEqual(expect.arrayContaining(['merge_commit_oid', 'squash_commit_oid']));
    const idx = (name: string) => db.all<{ name: string }>(`PRAGMA index_info(${name})`).map((c) => c.name);
    expect(idx('pull_requests_landed')).toEqual(['merge_commit_oid', 'squash_commit_oid']);
    expect(idx('pr_commits_oid')).toEqual(['oid']);
  });

  it('rolls back to the version before when the rebuilt schema would leave a dangling reference', () => {
    const db = beforeSources();
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(`INSERT INTO stars (repo_id, login, starred_at) VALUES (99, 'x', 'x')`);
    db.exec('PRAGMA foreign_keys = ON');
    const before = counts(db);
    const metaBefore = meta(db);
    const oldSql = reposSql(db);

    expect(() => migrate(db, true)).toThrow(new RegExp(`1 row .*stars → repos.*still schema v${SOURCES - 1}`));
    expect(version(db)).toBe(SOURCES - 1);
    expect(reposSql(db)).toBe(oldSql);
    expect(db.get(`SELECT name FROM sqlite_master WHERE name IN ('sources', 'repos_new', 'sources_host')`)).toBeUndefined();
    expect(counts(db)).toEqual(before);
    expect(meta(db)).toEqual(metaBefore);
    expect(seq(db)).toBe(10);
    expect(foreignKeys(db)).toBe(1);
  });

  it('is left to an instance that syncs', () => {
    const db = beforeSources();
    expect(() => migrate(db, false)).toThrow(`Database schema v${SOURCES - 1} needs destructive migration v${SOURCES}`);
    expect(version(db)).toBe(SOURCES - 1);
  });

  it('creates github.com as source 1 in new databases too, with room for more sources', () => {
    const db = openDb(':memory:');
    expect(db.all('SELECT id, kind, host, base_url, name, viewer_login FROM sources')).toEqual([
      { id: 1, kind: 'github', host: 'github.com', base_url: 'https://github.com', name: 'GitHub', viewer_login: null },
    ]);
    const { lastInsertRowid } = db.run(`INSERT INTO sources (kind, host, base_url, name, created_at) VALUES ('gitlab', 'gitlab.example.com', 'https://gitlab.example.com', 'GitLab', 'x')`);
    expect(lastInsertRowid).toBe(2);
  });
});

describe('comment threads across the sources rebuild', () => {
  const SOURCES = versionOf('sources');
  const HEAD = 'a'.repeat(40);

  /** Threads on two repos (one PR, one commit), replies, an agent's comment, and the highest thread deleted. */
  function withThreads(from: 'v3' | 'v4'): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    if (from === 'v3') {
      migrate(db, true, { upTo: 3 });
      seedV4Rows(db);
    } else {
      sqlite.exec(V4_SQL);
      sqlite.exec('PRAGMA user_version = 4');
      seedV4(db);
    }
    migrate(db, true, { upTo: SOURCES - 1 });
    db.run(`INSERT INTO principals (id, kind, name, created_at) VALUES (2, 'agent', 'Reviewer', 'x')`);
    const thread = (repoId: number, pr: number | null, path: string | null) =>
      Number(db.run(`INSERT INTO comment_threads (repo_id, pr_number, commit_oid, path, side, start_line, end_line, snippet, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x', 'x')`, [repoId, pr, HEAD, path, path ? 'new' : null, path ? 3 : null, path ? 4 : null, path ? 'a\nb' : null]).lastInsertRowid);
    const t1 = thread(1, 1, 'src/a.ts');
    const t2 = thread(1, null, null);
    const t3 = thread(2, 1, 'README.md');
    const gone = thread(2, 1, null);
    for (const [t, author, body] of [[t1, 1, 'Why?'], [t1, 2, 'Because.'], [t2, 1, 'Commit note'], [t3, 1, 'Typo']] as const) {
      db.run(`INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, 'x')`, [t, author, body]);
    }
    db.run('DELETE FROM comment_threads WHERE id = ?', [gone]);
    return db;
  }

  /** seedV4's rows on a v3 database (v4 only added pull_requests.head_oid, which the rows leave NULL there). */
  function seedV4Rows(db: Db): void {
    db.run(`INSERT INTO meta (key, value) VALUES ('viewer', '{"login":"alice"}')`);
    repo(db, 1, 'a');
    repo(db, 2, 'b');
    for (const id of [1, 2]) {
      db.run(`INSERT INTO pull_requests (id, repo_id, number, title, state, created_at, updated_at, activity_at, url)
        VALUES (?, ?, 1, 'PR', 'open', 'x', 'x', 'x', 'u')`, [id * 10, id]);
    }
  }

  const rows = (db: Db) => ({
    threads: db.all('SELECT * FROM comment_threads ORDER BY id'),
    comments: db.all('SELECT * FROM comments ORDER BY id'),
    principals: db.all('SELECT id, kind, name FROM principals ORDER BY id'),
  });
  const threadSeq = (db: Db) => db.get<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'comment_threads'`)?.seq;

  for (const from of ['v3', 'v4'] as const) {
    it(`keeps every thread and comment, their links to repos and the id sequences (from ${from})`, () => {
      const db = withThreads(from);
      const before = rows(db);
      const seqBefore = threadSeq(db);
      expect(before.threads).toHaveLength(3);
      expect(before.comments).toHaveLength(4);
      migrate(db, true);

      expect(version(db)).toBe(SCHEMA_VERSION);
      // Every column the threads had, as they were. Named, not `SELECT *`: a statement cached before the migration may
      // or may not see the column v8 adds, depending on the SQLite version.
      const columns = Object.keys(before.threads[0] as object).join(', ');
      expect({ ...rows(db), threads: db.all(`SELECT ${columns} FROM comment_threads ORDER BY id`) }).toEqual(before);
      // ... and v8's resolved_by, empty: none of them was resolved.
      expect(db.all<{ resolved_by: number | null }>('SELECT resolved_by FROM comment_threads ORDER BY id').map((t) => t.resolved_by)).toEqual([null, null, null]);
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
      expect(foreignKeys(db)).toBe(1);
      expect(db.all<{ table: string; from: string; on_delete: string }>('PRAGMA foreign_key_list(comment_threads)').map((f) => [f.table, f.from, f.on_delete]))
        .toEqual([['principals', 'resolved_by', 'NO ACTION'], ['repos', 'repo_id', 'CASCADE']]);
      // A deleted thread's id never comes back.
      expect(threadSeq(db)).toBe(seqBefore);
      const next = db.run(`INSERT INTO comment_threads (repo_id, pr_number, commit_oid, created_at, updated_at) VALUES (1, 1, ?, 'x', 'x')`, [HEAD]).lastInsertRowid;
      expect(next).toBe(seqBefore! + 1);
      // Removing a repo (tracking, or a source) still takes its threads and their comments along.
      db.run('DELETE FROM repos WHERE id = 1');
      expect(db.all('SELECT repo_id, count(*) AS n FROM comment_threads GROUP BY repo_id')).toEqual([{ repo_id: 2, n: 1 }]);
      expect(db.all<{ body: string }>('SELECT body FROM comments').map((c) => c.body)).toEqual(['Typo']);
    });
  }
});

describe('migration to agents (v8)', () => {
  const AGENTS = versionOf('agents');
  /** The tests that look at the version stop there. */
  const V8 = { upTo: AGENTS };
  const HEAD = 'a'.repeat(40);

  /** A v7 database: two repos, threads with replies by the dashboard user and an agent, one resolved, one deleted. */
  function v7(): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    migrate(db, true, { upTo: AGENTS - 1 });
    repo(db, 1, 'a');
    repo(db, 2, 'b');
    db.run(`INSERT INTO principals (id, kind, name, created_at) VALUES (2, 'agent', 'Reviewer', 'x')`);
    const thread = (repoId: number, pr: number | null, path: string | null, at: string, status = 'open') =>
      Number(db.run(`INSERT INTO comment_threads (repo_id, pr_number, commit_oid, path, side, start_line, end_line, snippet, status, resolved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        repoId, pr, HEAD, path, path ? 'new' : null, path ? 3 : null, path ? 4 : null, path ? 'a\nb' : null, status, status === 'resolved' ? at : null, at, at,
      ]).lastInsertRowid);
    const comment = (t: number, author: number, body: string, at: string) =>
      db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [t, author, body, at]);
    const t1 = thread(1, 7, 'src/a.ts', '2026-09-01T10:00:00.000Z', 'resolved');
    const t2 = thread(2, null, null, '2026-09-01T09:00:00.000Z');
    comment(t1, 1, 'Why **this**?', '2026-09-01T10:00:00.000Z');
    comment(t2, 2, 'Commit note', '2026-09-01T09:00:00.000Z');
    comment(t1, 2, 'Because.', '2026-09-02T10:00:00.000Z');
    comment(t2, 1, 'Thanks', '2026-09-01T11:00:00.000Z');
    const gone = thread(1, 8, null, '2026-09-01T08:00:00.000Z');
    comment(gone, 1, 'Gone', '2026-09-01T08:00:00.000Z');
    db.run('DELETE FROM comment_threads WHERE id = ?', [gone]);
    return db;
  }

  it('adds who resolved a thread (the dashboard user, the only writer so far, for resolved ones), agent tokens and the comment event log', () => {
    const db = v7();
    migrate(db, true, V8);
    expect(version(db)).toBe(AGENTS);
    expect(db.all('SELECT id, status, resolved_by FROM comment_threads ORDER BY id')).toEqual([
      { id: 1, status: 'resolved', resolved_by: 1 },
      { id: 2, status: 'open', resolved_by: null },
    ]);
    // Read back as the principal.
    expect(getThread(db, 1)!.resolvedBy).toEqual({ id: 1, kind: 'self', name: 'You' });
    expect(getThread(db, 2)!.resolvedBy).toBeNull();
    for (const table of ['agent_tokens', 'comment_events']) expect(db.get(`SELECT count(*) AS n FROM ${table}`), table).toBeDefined();
    expect(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'comment_events' AND sql IS NOT NULL ORDER BY name`).map((i) => i.name))
      .toEqual(['comment_events_at', 'comment_events_repo', 'comment_events_thread']);
    expect(() => db.run(`INSERT INTO comment_events (at, actor_id, kind, repo_id, commit_oid, thread_id) VALUES ('x', 1, 'starred', 1, ?, 1)`, [HEAD]))
      .toThrow(/CHECK constraint/);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('backfills the openings and replies of existing threads, in time order, and nothing else', () => {
    const db = v7();
    migrate(db, true);
    expect(db.all('SELECT id, at, actor_id, kind, repo_id, pr_number, commit_oid, thread_id, comment_id, path, side, start_line, end_line, excerpt FROM comment_events ORDER BY id')).toEqual([
      { id: 1, at: '2026-09-01T09:00:00.000Z', actor_id: 2, kind: 'thread_opened', repo_id: 2, pr_number: null, commit_oid: HEAD, thread_id: 2, comment_id: 2, path: null, side: null, start_line: null, end_line: null, excerpt: 'Commit note' },
      { id: 2, at: '2026-09-01T10:00:00.000Z', actor_id: 1, kind: 'thread_opened', repo_id: 1, pr_number: 7, commit_oid: HEAD, thread_id: 1, comment_id: 1, path: 'src/a.ts', side: 'new', start_line: 3, end_line: 4, excerpt: 'Why this?' },
      { id: 3, at: '2026-09-01T11:00:00.000Z', actor_id: 1, kind: 'replied', repo_id: 2, pr_number: null, commit_oid: HEAD, thread_id: 2, comment_id: 4, path: null, side: null, start_line: null, end_line: null, excerpt: 'Thanks' },
      { id: 4, at: '2026-09-02T10:00:00.000Z', actor_id: 2, kind: 'replied', repo_id: 1, pr_number: 7, commit_oid: HEAD, thread_id: 1, comment_id: 3, path: 'src/a.ts', side: 'new', start_line: 3, end_line: 4, excerpt: 'Because.' },
    ]);
  });

  it('is additive: a GH_DASH_SYNC=off instance may run it', () => {
    const db = v7();
    migrate(db, false, V8);
    expect(version(db)).toBe(AGENTS);
  });

  it('keeps agent names unique in any case, and tokens one per agent', () => {
    const db = openDb(':memory:');
    db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'Claude', 'x')`);
    expect(() => db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'claude', 'x')`)).toThrow(/UNIQUE/);
    const token = (principal: number, hash: string) =>
      db.run(`INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (?, ?, 'ghd_abcd', 'x')`, [principal, hash]);
    token(2, 'h1');
    expect(() => token(2, 'h2')).toThrow(/UNIQUE/);
    expect(() => token(99, 'h3')).toThrow(/FOREIGN KEY/);
  });
});

describe('migration to branches (v9)', () => {
  const BRANCHES = versionOf('branches');
  const HEAD = 'a'.repeat(40);

  /** A v8 database: a merged PR, a PR thread and a commit thread with their events. */
  function v8(): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    migrate(db, true, { upTo: BRANCHES - 1 });
    repo(db, 1, 'a');
    db.run(`INSERT INTO pull_requests (repo_id, number, title, state, created_at, updated_at, merged_at, activity_at, url, head_ref)
      VALUES (1, 7, 'Fix', 'merged', 'x', 'x', '2026-09-02T00:00:00Z', 'x', 'u', 'fix/login')`);
    for (const pr of [7, null]) {
      const t = db.run(`INSERT INTO comment_threads (repo_id, pr_number, commit_oid, created_at, updated_at) VALUES (1, ?, ?, 'x', 'x')`, [pr, HEAD]).lastInsertRowid;
      db.run(`INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, 1, 'Why?', 'x')`, [t]);
      db.run(`INSERT INTO comment_events (at, actor_id, kind, repo_id, pr_number, commit_oid, thread_id, comment_id) VALUES ('x', 1, 'thread_opened', 1, ?, ?, ?, ?)`, [pr, HEAD, t, t]);
    }
    return db;
  }

  it("adds the threads' and events' branch, empty, and pull_requests.cross_repo, unknown until the sync says", () => {
    const db = v8();
    migrate(db, true, { upTo: BRANCHES });
    expect(version(db)).toBe(BRANCHES);
    // Every existing thread stays its PR's or commit's alone: none has a branch yet.
    expect(db.all('SELECT pr_number, branch FROM comment_threads ORDER BY id')).toEqual([{ pr_number: 7, branch: null }, { pr_number: null, branch: null }]);
    expect(db.all('SELECT pr_number, branch FROM comment_events ORDER BY id')).toEqual([{ pr_number: 7, branch: null }, { pr_number: null, branch: null }]);
    expect([getThread(db, 1)!.kind, getThread(db, 2)!.kind]).toEqual(['pr', 'commit']);
    expect(db.all('SELECT number, cross_repo FROM pull_requests')).toEqual([{ number: 7, cross_repo: null }]);
    for (const value of [0, 1]) db.run('UPDATE pull_requests SET cross_repo = ?', [value]);
    expect(() => db.run('UPDATE pull_requests SET cross_repo = 2')).toThrow(/CHECK constraint/);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it("finds a branch's threads and a head branch's PRs by index", () => {
    const db = v8();
    migrate(db, true);
    const plan = (sql: string) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join('\n');
    expect(plan(`SELECT * FROM comment_threads WHERE repo_id = 1 AND branch = 'fix/login'`)).toContain('USING INDEX comment_threads_branch (repo_id=? AND branch=?)');
    expect(plan(`SELECT * FROM pull_requests WHERE repo_id = 1 AND head_ref = 'fix/login'`)).toContain('USING INDEX pull_requests_head_ref (repo_id=? AND head_ref=?)');
  });

  it('is additive: a GH_DASH_SYNC=off instance may run it', () => {
    const db = v8();
    migrate(db, false, { upTo: BRANCHES });
    expect(version(db)).toBe(BRANCHES);
  });
});

describe('migration to agent sources (v10)', () => {
  const AGENT_SOURCES = versionOf('agent-sources');

  /** A v9 database: the dashboard user, an agent with a token, and a GitLab source beside github.com. */
  function v9(): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    migrate(db, true, { upTo: AGENT_SOURCES - 1 });
    db.run(`INSERT INTO principals (id, kind, name, created_at) VALUES (2, 'agent', 'Claude', 'x')`);
    db.run(`INSERT INTO agent_tokens (principal_id, token_hash, prefix, created_at) VALUES (2, 'h', 'ghd_abcd', 'x')`);
    db.run(`INSERT INTO sources (id, kind, host, base_url, name, created_at) VALUES (2, 'gitlab', 'gitlab.example.com', 'https://gitlab.example.com', 'GitLab', 'x')`);
    return db;
  }

  it('leaves every principal reaching every source, and lists no source of any agent', () => {
    const db = v9();
    migrate(db, true, { upTo: AGENT_SOURCES });
    expect(version(db)).toBe(AGENT_SOURCES);
    expect(db.all('SELECT id, all_sources FROM principals ORDER BY id')).toEqual([{ id: 1, all_sources: 1 }, { id: 2, all_sources: 1 }]);
    expect(db.all('SELECT * FROM agent_sources')).toEqual([]);
    // New principals too, unless told otherwise; the flag is 0 or 1.
    db.run(`INSERT INTO principals (kind, name, created_at) VALUES ('agent', 'Codex', 'x')`);
    expect(db.get('SELECT all_sources FROM principals WHERE id = 3')).toEqual({ all_sources: 1 });
    expect(() => db.run('UPDATE principals SET all_sources = 2 WHERE id = 2')).toThrow(/CHECK constraint/);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps one row per agent and source, of agents and sources that exist, gone with the source', () => {
    const db = v9();
    migrate(db, true);
    db.run('UPDATE principals SET all_sources = 0 WHERE id = 2');
    const add = (principal: number, source: number) => db.run('INSERT INTO agent_sources (principal_id, source_id) VALUES (?, ?)', [principal, source]);
    add(2, 1);
    add(2, 2);
    expect(() => add(2, 2)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => add(2, 9)).toThrow(/FOREIGN KEY/);
    expect(() => add(9, 1)).toThrow(/FOREIGN KEY/);
    db.run('DELETE FROM sources WHERE id = 2');
    // The agent keeps its limit, with github.com alone: never every source.
    expect(db.all('SELECT principal_id, source_id FROM agent_sources')).toEqual([{ principal_id: 2, source_id: 1 }]);
    expect(db.get('SELECT all_sources FROM principals WHERE id = 2')).toEqual({ all_sources: 0 });
  });

  it('is additive: a GH_DASH_SYNC=off instance may run it', () => {
    const db = v9();
    migrate(db, false, { upTo: AGENT_SOURCES });
    expect(version(db)).toBe(AGENT_SOURCES);
  });
});

describe('migration to synced branches (v11)', () => {
  const SYNCED_BRANCHES = versionOf('synced-branches');

  /** A v10 database: a repo whose sync state is known. */
  function v10(): Db {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = new Db(sqlite);
    migrate(db, true, { upTo: SYNCED_BRANCHES - 1 });
    repo(db, 1, 'a');
    db.run(`INSERT INTO sync_state (repo_id, synced_at) VALUES (1, '2026-09-30T00:00:00Z')`);
    return db;
  }

  it('adds an empty branch list per repo, and sync state saying none was read yet', () => {
    const db = v10();
    migrate(db, true, { upTo: SYNCED_BRANCHES });
    expect(version(db)).toBe(SYNCED_BRANCHES);
    expect(db.all('SELECT * FROM branches')).toEqual([]);
    expect(db.get('SELECT branches_pushed_at, branches_synced_at, branches_complete FROM sync_state WHERE repo_id = 1')).toEqual({
      branches_pushed_at: null, branches_synced_at: null, branches_complete: null,
    });
    // One row per repo and name, gone with the repo.
    const add = (name: string) => db.run(`INSERT INTO branches (repo_id, name, head_oid, first_seen_at) VALUES (1, ?, ?, 'x')`, [name, 'a'.repeat(40)]);
    add('fix/login');
    expect(() => add('fix/login')).toThrow(/UNIQUE/);
    db.run('DELETE FROM repos WHERE id = 1');
    expect(db.all('SELECT * FROM branches')).toEqual([]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('is additive: a GH_DASH_SYNC=off instance may run it', () => {
    const db = v10();
    migrate(db, false, { upTo: SYNCED_BRANCHES });
    expect(version(db)).toBe(SYNCED_BRANCHES);
  });
});

describe('migration names', () => {
  it('number migrations by name, and stop where asked', () => {
    // The final order: T2's repos rebuild, then local comments (diff-comments), then sources (the GitLab wave), then
    // agents and the comment event log (the MCP wave), then branch reviews, then the sources agents may reach, then the
    // branches the sync holds.
    expect(['repos-v5', 'comments', 'sources', 'agents', 'branches', 'agent-sources', 'synced-branches'].map(versionOf)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(SCHEMA_VERSION).toBe(versionOf('synced-branches'));
    expect(() => versionOf('nope')).toThrow('No migration is called nope');
    const db = new Db(new DatabaseSync(':memory:'));
    migrate(db, true, { upTo: versionOf('repos-v5') });
    expect(version(db)).toBe(versionOf('repos-v5'));
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'sources'`)).toBeUndefined();
    migrate(db, true);
    expect(version(db)).toBe(SCHEMA_VERSION);
  });
});
