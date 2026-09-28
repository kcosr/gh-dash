import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { migrate } from './schema';

export type Param = SQLInputValue;

export class Db {
  readonly sqlite: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, params: Param[] = []): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: Param[] = []): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: Param[] = []): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  /** Runs `fn` in a write transaction (BEGIN IMMEDIATE); nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.sqlite.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.sqlite.isTransaction) this.sqlite.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.statements.clear();
    this.sqlite.close();
  }
}

export interface OpenOptions {
  /** When false, migrations flagged destructive are refused (read-only companion instances). */
  allowDestructiveMigrations: boolean;
}

export function openDb(path: string, opts: OpenOptions = { allowDestructiveMigrations: true }): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(path, { timeout: 5000 });
  if (path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const db = new Db(sqlite);
  migrate(db, opts.allowDestructiveMigrations);
  return db;
}
