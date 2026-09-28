import { randomUUID } from 'node:crypto';
import type { SyncStatus } from '../../shared/api';
import { resolveToken, type ResolvedToken, type TokenSource } from '../config';
import type { Db } from '../db/db';
import { deleteMeta, getMeta, type SyncLockMeta, setMeta } from '../db/meta';
import { getSettings } from '../db/settings';
import { GitHubClient } from '../github/client';
import { VIEWER } from '../github/queries';
import type { ViewerData } from '../github/types';
import { runSync, saveViewer, type SyncProgress, type SyncRequest, viewerMismatch } from './sync';

/** A lock whose heartbeat is older than this belongs to a dead process. */
const LOCK_STALE_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 30_000;

type Trigger = SyncLockMeta['trigger'];

export interface SyncManagerOptions {
  db: Db;
  /** Whether this process runs the scheduler (GH_DASH_SYNC). */
  schedule: boolean;
  resolveToken?: () => ResolvedToken;
  log?: (line: string) => void;
}

export type StartResult = { ok: true } | { ok: false; reason: 'running' | 'no-token' };

/**
 * Runs one sync at a time. The lock, progress and results live in the DB `meta` table so that
 * read-only companion instances (GH_DASH_SYNC=off) sharing the DB report the same status.
 */
export class SyncManager {
  private readonly db: Db;
  private readonly scheduleEnabled: boolean;
  private readonly resolve: () => ResolvedToken;
  private readonly log: (line: string) => void;
  private readonly instance = randomUUID();
  private tokenSource: TokenSource;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  /** After a scheduled attempt finds no token, don't retry before this time. */
  private noTokenUntil = 0;

  constructor(opts: SyncManagerOptions) {
    this.db = opts.db;
    this.scheduleEnabled = opts.schedule;
    this.resolve = opts.resolveToken ?? (() => resolveToken());
    this.log = opts.log ?? ((line) => console.log(line));
    this.tokenSource = this.resolve().source;
  }

  getTokenSource(): TokenSource {
    return this.tokenSource;
  }

  private liveLock(): SyncLockMeta | null {
    const lock = getMeta(this.db, 'syncLock');
    return lock && Date.now() - Date.parse(lock.heartbeatAt) < LOCK_STALE_MS ? lock : null;
  }

  status(): SyncStatus {
    const lock = this.liveLock();
    const last = getMeta(this.db, 'lastSync');
    const rl = getMeta(this.db, 'rateLimit');
    return {
      running: !!lock,
      trigger: lock?.trigger ?? null,
      progress: lock?.progress ?? null,
      lastSyncAt: last?.at ?? null,
      lastSyncDurationMs: last?.durationMs ?? null,
      lastResult: last ? { newItems: last.newItems, errors: last.errors } : null,
      nextSyncAt: getMeta(this.db, 'nextSyncAt'),
      rateLimit: rl ? { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt } : null,
      tokenSource: this.tokenSource,
      viewer: getMeta(this.db, 'viewer')?.login ?? null,
    };
  }

  /**
   * Fetches the viewer once (1 API point) if the DB doesn't know it yet, or only by login (databases from before ids
   * were stored). A token for another account is only reported here: the sync refuses it (see viewerMismatch).
   */
  async ensureViewer(): Promise<void> {
    if (getMeta(this.db, 'viewer')?.id) return;
    const { token } = this.resolve();
    if (!token) return;
    const client = this.client(token);
    const { viewer } = await client.query<ViewerData>(VIEWER);
    const mismatch = viewerMismatch(getMeta(this.db, 'viewer'), viewer);
    if (mismatch) this.log(`[sync] warning: ${mismatch}`);
    else saveViewer(this.db, viewer);
  }

  private client(token: string): GitHubClient {
    return new GitHubClient({
      token,
      onRateLimit: (rl) => setMeta(this.db, 'rateLimit', { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt }),
    });
  }

  private acquire(trigger: Trigger, req: SyncRequest): boolean {
    return this.db.tx(() => {
      if (this.liveLock()) return false;
      const now = new Date().toISOString();
      // Until the repo list arrives, assume the repos we already know about.
      const total = req.repo ? 1 : this.db.get<{ n: number }>('SELECT count(*) AS n FROM repos WHERE removed_at IS NULL')!.n;
      setMeta(this.db, 'syncLock', {
        instance: this.instance,
        pid: process.pid,
        trigger,
        startedAt: now,
        heartbeatAt: now,
        progress: { done: 0, total, current: null },
      });
      return true;
    });
  }

  private writeLock(progress: SyncProgress): void {
    const lock = getMeta(this.db, 'syncLock');
    if (lock?.instance !== this.instance) return;
    setMeta(this.db, 'syncLock', { ...lock, heartbeatAt: new Date().toISOString(), progress });
  }

  start(trigger: Trigger, req: SyncRequest = {}): StartResult {
    const resolved = this.resolve();
    this.tokenSource = resolved.source;
    if (!resolved.token) return { ok: false, reason: 'no-token' };
    if (this.current || !this.acquire(trigger, req)) return { ok: false, reason: 'running' };
    this.current = this.execute(trigger, req, resolved.token).finally(() => {
      this.current = null;
      this.reschedule();
    });
    return { ok: true };
  }

  private async execute(trigger: Trigger, req: SyncRequest, token: string): Promise<void> {
    const started = Date.now();
    const client = this.client(token);
    let progress: SyncProgress = { done: 0, total: 0, current: null };
    const heartbeat = setInterval(() => this.writeLock(progress), HEARTBEAT_MS);
    let newItems = 0;
    let errors: string[] = [];
    let repos = 0;
    let forksSkipped = 0;
    try {
      const result = await runSync(
        {
          db: this.db,
          client,
          settings: getSettings(this.db),
          onProgress: (p) => {
            progress = p;
            this.writeLock(p);
          },
        },
        req,
      );
      ({ newItems, errors, repos, forksSkipped } = result);
    } catch (err) {
      errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      clearInterval(heartbeat);
    }
    const durationMs = Date.now() - started;
    this.db.tx(() => {
      setMeta(this.db, 'lastSync', {
        at: new Date().toISOString(),
        durationMs,
        trigger,
        newItems,
        errors,
        pointsUsed: client.pointsUsed,
      });
      if (getMeta(this.db, 'syncLock')?.instance === this.instance) deleteMeta(this.db, 'syncLock');
    });
    const scope = [req.repo ? `repo=${req.repo}` : null, req.full ? 'full' : null].filter(Boolean).join(' ');
    const rl = client.rateLimit;
    this.log(
      `[sync] ${trigger}${scope ? ` (${scope})` : ''} done in ${(durationMs / 1000).toFixed(1)}s · ${repos} repos · ` +
        `${newItems} new items · ${errors.length} errors · ${client.pointsUsed} points in ${client.requests} requests` +
        (rl ? ` (${rl.remaining}/${rl.limit} left)` : '') +
        (forksSkipped ? ` · commit history skipped for ${forksSkipped} forks (includeForks off)` : ''),
    );
    for (const e of errors) this.log(`[sync]   error: ${e}`);
  }

  /**
   * Starts the scheduler. Every tick recomputes "due" from the shared DB state (last sync and interval),
   * so syncs and setting changes made by other instances on the same DB are honoured.
   */
  startScheduler(): void {
    if (!this.scheduleEnabled || this.timer) return;
    this.tick('startup');
    this.timer = setInterval(() => this.tick('scheduled'), TICK_MS);
  }

  /** Re-evaluates the schedule now (e.g. after the interval setting changed). */
  reschedule(): void {
    if (this.scheduleEnabled) this.tick('scheduled');
  }

  private tick(trigger: Trigger): void {
    const interval = getSettings(this.db).syncIntervalMinutes * 60_000;
    const last = getMeta(this.db, 'lastSync');
    const due = Math.max(last ? Date.parse(last.at) + interval : 0, this.noTokenUntil);
    const next = new Date(Math.max(due, Date.now())).toISOString();
    if (getMeta(this.db, 'nextSyncAt') !== next && !this.current) setMeta(this.db, 'nextSyncAt', next);
    if (Date.now() < due || this.current || this.liveLock()) return;
    const res = this.start(trigger);
    if (!res.ok && res.reason === 'no-token') this.noTokenUntil = Date.now() + interval;
  }

  /** Stops the scheduler and waits briefly for a running sync to release its lock. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scheduleEnabled) deleteMeta(this.db, 'nextSyncAt');
    if (this.current) {
      await Promise.race([this.current, new Promise((r) => setTimeout(r, 2000))]);
      if (getMeta(this.db, 'syncLock')?.instance === this.instance) deleteMeta(this.db, 'syncLock');
    }
  }
}
