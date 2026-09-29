import type { Db } from './db';

export interface LastSyncMeta {
  at: string;
  durationMs: number;
  trigger: 'manual' | 'scheduled' | 'startup';
  newItems: number;
  errors: string[];
  pointsUsed: number;
  /** Key of the one repository a single-repo run synced; absent for a full sync (and in databases from before). */
  repo?: string;
}

/** A provider's rate limit as a client last saw it (stored per source: sources.rate_limit). */
export interface RateLimitMeta {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface SyncLockMeta {
  instance: string;
  pid: number;
  trigger: 'manual' | 'scheduled' | 'startup';
  startedAt: string;
  heartbeatAt: string;
  progress: { done: number; total: number; current: string | null };
  /** Key of the one repository a single-repo run syncs. */
  repo?: string;
}

// The account and rate limit are per source (db/sources.ts); these are run-level.
interface MetaTypes {
  lastSync: LastSyncMeta;
  syncLock: SyncLockMeta;
  nextSyncAt: string;
  /** When the last full (all repositories) sync finished: the schedule counts from it, not from single-repo runs. */
  lastFullSyncAt: string;
  sessionSecret: string;
}

export function getMeta<K extends keyof MetaTypes>(db: Db, key: K): MetaTypes[K] | null {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as MetaTypes[K]) : null;
}

export function setMeta<K extends keyof MetaTypes>(db: Db, key: K, value: MetaTypes[K]): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    JSON.stringify(value),
  ]);
}

export function deleteMeta(db: Db, key: keyof MetaTypes): void {
  db.run('DELETE FROM meta WHERE key = ?', [key]);
}
