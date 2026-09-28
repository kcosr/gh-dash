import type { Db } from './db';

/** The GitHub account this database belongs to (set by the first sync; see viewerMismatch). */
export interface ViewerMeta {
  /** GraphQL node id; missing in databases synced before it was stored. */
  id?: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface LastSyncMeta {
  at: string;
  durationMs: number;
  trigger: 'manual' | 'scheduled' | 'startup';
  newItems: number;
  errors: string[];
  pointsUsed: number;
}

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
}

interface MetaTypes {
  viewer: ViewerMeta;
  lastSync: LastSyncMeta;
  rateLimit: RateLimitMeta;
  syncLock: SyncLockMeta;
  nextSyncAt: string;
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
