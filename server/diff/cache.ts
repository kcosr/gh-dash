import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../db/db';

export type CacheKind = 'pr' | 'commit' | 'blob';

export interface CacheEntry {
  key: string;
  kind: CacheKind;
  /** The repo's key (db/repo-key.ts): entries of repos that disappear are dropped. */
  repo: string;
  /** PR number for kind 'pr', so a new head can supersede the old one. */
  number?: number | null;
  /** PR head, commit, or the commit a blob was read at. */
  oid: string;
  /** For PRs: the base branch and merge base the diff was computed against (either can move under a fixed head). */
  baseRef?: string | null;
  baseOid?: string | null;
  /** When the data was fetched from GitHub, or last confirmed unchanged there (ms). */
  fetchedAt: number;
  /** gzip-compressed diff JSON or file text. */
  data: Uint8Array;
}

/** A cached PR diff's identity, for deciding whether it still matches the PR. */
export interface PrEntry {
  key: string;
  oid: string;
  baseRef: string | null;
  baseOid: string | null;
  fetchedAt: number;
}

// Evicting stops at this fraction of the cap, so a full cache doesn't evict on every insert.
const LOW_WATER = 0.9;

// Bump to change the schema: the cache is disposable, so an old one is simply dropped and recreated.
// `data` comes last so size and LRU scans never touch the blob pages.
const VERSION = 2;
const SCHEMA = `
CREATE TABLE entries (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  oid TEXT NOT NULL,
  base_ref TEXT,
  base_oid TEXT,
  bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX entries_lru ON entries(accessed_at, bytes);
CREATE INDEX entries_repo ON entries(repo, kind, number);
`;

/**
 * Diffs and file contents fetched from GitHub, in their own SQLite file next to the main database: clearing it
 * really frees disk (auto_vacuum), it can be deleted or left out of backups at any time, and it stays writable and
 * self-migrating for read-only (GH_DASH_SYNC=off) instances that share it.
 */
export class DiffCache {
  readonly path: string;
  private readonly db: Db;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // `timeout` is SQLite's busy timeout: wait up to 5 s for another instance's write lock.
    const sqlite = new DatabaseSync(path, { timeout: 5000 });
    this.db = new Db(sqlite);
    try {
      // auto_vacuum only takes effect before the first table exists; set it first.
      sqlite.exec('PRAGMA auto_vacuum = FULL');
      if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 8388608');
      sqlite.exec('PRAGMA synchronous = NORMAL');
      this.migrate();
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }

  private migrate(): void {
    const version = () => Number(this.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
    if (version() === VERSION) return;
    this.db.tx(() => {
      if (version() === VERSION) return;
      const foreign = this.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'entries'");
      if (foreign.length) throw new Error(`${this.path} is not a gh-dash diff cache (it has other tables); check GH_DASH_CACHE_DB`);
      this.db.exec('DROP TABLE IF EXISTS entries');
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${VERSION}`);
    });
  }

  /** The stored data, marking the entry as recently used. */
  get(key: string): Uint8Array | null {
    const row = this.db.get<{ data: Uint8Array }>('SELECT data FROM entries WHERE key = ?', [key]);
    if (!row) return null;
    try {
      this.db.run('UPDATE entries SET accessed_at = ? WHERE key = ?', [this.now(), key]);
    } catch {
      // Recency only guides eviction; a busy or full database mustn't fail a read.
    }
    return row.data;
  }

  put(e: CacheEntry): void {
    this.db.run(
      `INSERT INTO entries (key, kind, repo, number, oid, base_ref, base_oid, bytes, fetched_at, accessed_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET oid = excluded.oid, base_ref = excluded.base_ref, base_oid = excluded.base_oid, bytes = excluded.bytes,
         fetched_at = excluded.fetched_at, accessed_at = excluded.accessed_at, data = excluded.data`,
      [e.key, e.kind, e.repo, e.number ?? null, e.oid, e.baseRef ?? null, e.baseOid ?? null, e.data.byteLength, e.fetchedAt, this.now(), e.data],
    );
  }

  /** The most recently used cached diff of a PR (normally its only one). */
  prEntry(repo: string, number: number): PrEntry | null {
    return (
      this.db.get<PrEntry>(
        `SELECT key, oid, base_ref AS baseRef, base_oid AS baseOid, fetched_at AS fetchedAt FROM entries
         WHERE repo = ? AND kind = 'pr' AND number = ? ORDER BY accessed_at DESC LIMIT 1`,
        [repo, number],
      ) ?? null
    );
  }

  /** Drops a PR's other diffs once `key` supersedes them (a push, retarget or moved merge base). */
  dropOthers(repo: string, number: number, key: string): void {
    this.db.run("DELETE FROM entries WHERE repo = ? AND kind = 'pr' AND number = ? AND key <> ?", [repo, number, key]);
  }

  /** Full SHA of a cached commit diff starting with `prefix`, when exactly one matches. */
  findCommit(repo: string, prefix: string): string | null {
    const rows = this.db.all<{ oid: string }>("SELECT oid FROM entries WHERE repo = ? AND kind = 'commit' AND oid >= ? AND oid < ? LIMIT 2", [
      repo,
      prefix,
      `${prefix}g`,
    ]);
    return rows.length === 1 ? rows[0]!.oid : null;
  }

  /**
   * Drops entries of repos not in `repos`, then least recently used entries until the total is under the cap
   * (down to LOW_WATER of it once over). Returns the number of entries removed.
   */
  evict(maxBytes: number, repos: string[]): number {
    return this.db.tx(() => {
      let removed = this.db.run('DELETE FROM entries WHERE repo NOT IN (SELECT value FROM json_each(?))', [JSON.stringify(repos)]).changes;
      let total = this.stats().bytes;
      if (total <= maxBytes) return removed;
      const target = maxBytes * LOW_WATER;
      for (const row of this.db.all<{ key: string; bytes: number }>('SELECT key, bytes FROM entries ORDER BY accessed_at, key')) {
        if (total <= target) break;
        this.db.run('DELETE FROM entries WHERE key = ?', [row.key]);
        total -= row.bytes;
        removed++;
      }
      return removed;
    });
  }

  stats(): { entries: number; bytes: number } {
    const row = this.db.get<{ entries: number; bytes: number }>('SELECT count(*) AS entries, coalesce(sum(bytes), 0) AS bytes FROM entries')!;
    return { entries: row.entries, bytes: row.bytes };
  }

  /** Removes everything and gives the space back to the filesystem. */
  clear(): void {
    this.db.run('DELETE FROM entries');
    this.db.exec('VACUUM');
    if (this.path !== ':memory:') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}

/** Opens the cache; if the file can't be used, falls back to memory so diffs still work (just uncached across restarts). */
export function openDiffCache(path: string, log: (line: string) => void = console.warn): DiffCache {
  try {
    return new DiffCache(path);
  } catch (err) {
    log(`[diff] cannot use the diff cache at ${path} (${(err as Error).message}); caching in memory instead`);
    return new DiffCache(':memory:');
  }
}
