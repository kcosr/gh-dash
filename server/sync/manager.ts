import { randomUUID } from 'node:crypto';
import type { SyncStatus, TokenSource } from '../../shared/api';
import type { Db } from '../db/db';
import { deleteMeta, getMeta, type SyncLockMeta, setMeta } from '../db/meta';
import { repoKeySql, resolveRepo } from '../db/repo-key';
import { getSettings } from '../db/settings';
import { GitHubClient } from '../github/client';
import { VIEWER } from '../github/queries';
import type { ViewerData } from '../github/types';
import { tokenKind, type TokenSupply } from '../token';
import { runSync, saveViewer, type SyncProgress, type SyncRequest, viewerMismatch } from './sync';

/** A lock whose heartbeat is older than this belongs to a dead process. */
const LOCK_STALE_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 30_000;
/** After a scheduled attempt finds no token, try again this much later (not a whole interval: `gh auth login` is quick). */
const NO_TOKEN_RETRY_MS = 60_000;
/** A repo added by hand whose first sync didn't complete is tried again after this long. */
const FIRST_SYNC_RETRY_MS = 5 * 60_000;

type Trigger = SyncLockMeta['trigger'];

export interface SyncManagerOptions {
  db: Db;
  /** Whether this process runs the scheduler (GH_DASH_SYNC). */
  schedule: boolean;
  /** Where the GitHub token comes from (shared with the diff service and the account routes). */
  tokens: TokenSupply;
  log?: (line: string) => void;
  /** GitHub's fetch (tests). */
  fetchImpl?: typeof fetch;
}

export type StartResult = { ok: true } | { ok: false; reason: 'running' | 'no-token' };

/**
 * Runs one sync at a time. The lock, progress and results live in the DB `meta` table so that
 * read-only companion instances (GH_DASH_SYNC=off) sharing the DB report the same status.
 */
export class SyncManager {
  private readonly db: Db;
  private readonly scheduleEnabled: boolean;
  private readonly tokens: TokenSupply;
  private readonly log: (line: string) => void;
  private readonly instance = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  /** A scheduled start is waiting for the token. */
  private starting = false;
  private stopped = false;
  /** After a scheduled attempt finds no token, don't retry before this time. */
  private noTokenUntil = 0;
  /** Single-repo syncs of just-added repos, waiting for this process's current sync. */
  private readonly queue: SyncRequest[] = [];
  /** Repos added by hand whose first sync the scheduler started, and when it may try again. */
  private readonly firstSyncRetry = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SyncManagerOptions) {
    this.db = opts.db;
    this.scheduleEnabled = opts.schedule;
    this.tokens = opts.tokens;
    this.log = opts.log ?? ((line) => console.log(line));
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    // A new token (`gh auth login`, a pasted one) is worth trying at the next tick rather than after the backoff.
    this.tokens.onChange(() => {
      this.noTokenUntil = 0;
    });
  }

  /** The token's source as last resolved; polling this picks up a login or logout within about 30 s. */
  getTokenSource(): TokenSource {
    return this.tokens.peek().source;
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
      tokenSource: this.getTokenSource(),
      viewer: getMeta(this.db, 'viewer')?.login ?? null,
      repo: lock?.repo ?? null,
    };
  }

  /**
   * Fetches the viewer once (1 API point) if the DB doesn't know it yet, or only by login (databases from before ids
   * were stored). A token for another account is only reported here: the sync refuses it (see viewerMismatch).
   */
  async ensureViewer(): Promise<void> {
    if (getMeta(this.db, 'viewer')?.id) return;
    const { token } = await this.tokens.get();
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
      // A 401 means the token was revoked or replaced: resolve it again before the next use.
      fetchImpl: async (input, init) => {
        const res = await this.fetchImpl(input, init);
        if (res.status === 401) this.tokens.invalidate(token);
        return res;
      },
      onRateLimit: (rl) => setMeta(this.db, 'rateLimit', { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt }),
    });
  }

  private acquire(trigger: Trigger, req: SyncRequest): boolean {
    return this.db.tx(() => {
      if (this.liveLock()) return false;
      const now = new Date().toISOString();
      // Until the repo list arrives, assume the repos we already know about (unavailable ones aren't synced).
      const total = req.repo
        ? 1
        : this.db.get<{ n: number }>('SELECT count(*) AS n FROM repos WHERE removed_at IS NULL AND unavailable_at IS NULL')!.n;
      setMeta(this.db, 'syncLock', {
        instance: this.instance,
        pid: process.pid,
        trigger,
        startedAt: now,
        heartbeatAt: now,
        progress: { done: 0, total, current: null },
        ...(req.repo ? { repo: resolveRepo(this.db, req.repo)?.key ?? req.repo } : {}),
      });
      return true;
    });
  }

  private writeLock(progress: SyncProgress): void {
    const lock = getMeta(this.db, 'syncLock');
    if (lock?.instance !== this.instance) return;
    setMeta(this.db, 'syncLock', { ...lock, heartbeatAt: new Date().toISOString(), progress });
  }

  /** A manual start asks for the token afresh (the user may just have logged in); others take the cached one. */
  async start(trigger: Trigger, req: SyncRequest = {}): Promise<StartResult> {
    // Before resolving the token: a 409 needn't run gh.
    if (this.current || this.liveLock()) return { ok: false, reason: 'running' };
    const { token } = await this.tokens.get({ fresh: trigger === 'manual' });
    if (!token) return { ok: false, reason: 'no-token' };
    if (this.stopped || this.current || !this.acquire(trigger, req)) return { ok: false, reason: 'running' };
    this.current = this.execute(trigger, req, token).finally(() => {
      this.current = null;
      if (!this.startQueued()) this.reschedule();
    });
    return { ok: true };
  }

  /**
   * The first sync of a repo just added (POST /repos): now if nothing runs, else after the sync this process is
   * running. When another instance holds the lock, the scheduler's rule for never-synced repos picks it up.
   */
  async startOrQueue(req: SyncRequest): Promise<'started' | 'queued'> {
    if (!this.current && !this.liveLock()) {
      const res = await this.start('manual', req);
      if (res.ok) return 'started';
    }
    if (this.current && !this.queue.some((q) => q.repo === req.repo)) this.queue.push(req);
    return 'queued';
  }

  /** Starts the next queued single-repo sync whose repo still needs one (a full sync may have covered it). */
  private startQueued(): boolean {
    while (!this.stopped && this.queue.length) {
      const req = this.queue.shift()!;
      const ref = req.repo ? resolveRepo(this.db, req.repo) : null;
      if (!ref || this.db.get('SELECT 1 FROM sync_state WHERE repo_id = ? AND synced_at IS NOT NULL', [ref.id])) continue;
      void this.start('manual', { ...req, repo: ref.key });
      return true;
    }
    return false;
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
          tokenKind: tokenKind(token),
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
      if (!req.repo) setMeta(this.db, 'lastFullSyncAt', new Date().toISOString());
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
    // Single-repo runs (a repo just added) don't move the schedule of full syncs.
    const last = getMeta(this.db, 'lastFullSyncAt') ?? getMeta(this.db, 'lastSync')?.at;
    const due = Math.max(last ? Date.parse(last) + interval : 0, this.noTokenUntil);
    const next = new Date(Math.max(due, Date.now())).toISOString();
    if (getMeta(this.db, 'nextSyncAt') !== next && !this.current) setMeta(this.db, 'nextSyncAt', next);
    if (this.current || this.starting || this.liveLock() || Date.now() < this.noTokenUntil) return;
    let req: SyncRequest = {};
    if (Date.now() < due) {
      // Not due, but a repo added by hand has never synced (added on another instance, or its first sync failed).
      const key = this.neverSyncedManualRepo();
      if (!key) return;
      this.firstSyncRetry.set(key, Date.now() + FIRST_SYNC_RETRY_MS);
      req = { repo: key };
    }
    this.starting = true;
    void this.start(trigger, req)
      .then((res) => {
        if (!res.ok && res.reason === 'no-token') this.noTokenUntil = Date.now() + NO_TOKEN_RETRY_MS;
      })
      .finally(() => {
        this.starting = false;
      });
  }

  /** A live, readable repo added by hand that has never synced, and isn't waiting out a failed first attempt. */
  private neverSyncedManualRepo(): string | null {
    const keys = this.db.all<{ key: string }>(
      `SELECT ${repoKeySql('r')} AS key FROM repos r LEFT JOIN sync_state s ON s.repo_id = r.id
       WHERE r.tracked_by = 'manual' AND r.removed_at IS NULL AND r.unavailable_at IS NULL AND s.synced_at IS NULL ORDER BY r.id`,
    );
    const now = Date.now();
    return keys.find((k) => (this.firstSyncRetry.get(k.key) ?? 0) <= now)?.key ?? null;
  }

  /** Stops the scheduler and waits briefly for a running sync to release its lock. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scheduleEnabled) deleteMeta(this.db, 'nextSyncAt');
    if (this.current) {
      await Promise.race([this.current, new Promise((r) => setTimeout(r, 2000))]);
      if (getMeta(this.db, 'syncLock')?.instance === this.instance) deleteMeta(this.db, 'syncLock');
    }
  }
}
