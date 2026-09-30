import { randomUUID } from 'node:crypto';
import { GITHUB_HOST, type SourceSyncStatus, type SyncStatus, type TokenSource } from '../../shared/api';
import type { Db } from '../db/db';
import { deleteMeta, getMeta, type LastSyncMeta, type SyncLockMeta, type SyncLockSource, setMeta } from '../db/meta';
import { repoKeySql, type RepoRef, resolveRepo, resolveRepoOn } from '../db/repo-key';
import { getSettings } from '../db/settings';
import { GITHUB_SOURCE_ID, getSource, type SourceRow, setSourceLastSync, setSourceRateLimit, sourceLabel, tryClaimViewer } from '../db/sources';
import { HttpError } from '../lib/errors';
import type { SyncSource } from '../provider/types';
import { githubSyncSource } from '../sources/registry';
import { noTokenMessage, type ResolvedToken, type TokenSupply } from '../token';
import { AccountMismatch, runSync, type SyncProgress, type SyncRequest, type SyncResult } from './sync';
import { notASource } from './tracking';

/** A lock whose heartbeat is older than this belongs to a dead process. */
const LOCK_STALE_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 30_000;
/** After a scheduled attempt finds no token, try again this much later (not a whole interval: `gh auth login` is quick). */
const NO_TOKEN_RETRY_MS = 60_000;
/** A repo added by hand whose first sync didn't complete is tried again after this long. */
const FIRST_SYNC_RETRY_MS = 5 * 60_000;

type Trigger = SyncLockMeta['trigger'];

/** One source as the manager syncs it. A SourceRegistry runtime is one. */
export interface SyncTarget {
  readonly id: number;
  /** Its identity: 'github.com', 'gitlab.example.com'. */
  readonly host: string;
  /** What logs and errors call it: 'GitHub', 'GitLab (gitlab.example.com)'. */
  readonly label: string;
  /** Its row, read fresh: the account its data belongs to, its last sync and rate limit. */
  readonly row: SourceRow;
  /** Whether this instance syncs it (its config names it). */
  readonly configured: boolean;
  /** Its token. `noTokenMessage` says why there is none in the source's words (else GitHub's wording). */
  readonly tokens: TokenSupply & { noTokenMessage?(resolved?: ResolvedToken): string };
  /** A sync client for one token: its request and point counters are that source's part of a run. */
  readonly syncSource: (token: string) => SyncSource;
}

/** The sources the manager syncs: startServer's SourceRegistry, or github.com alone (tests). */
export interface SyncSources {
  /** Every source this database knows, github.com first; `configured` tells the ones this instance syncs. */
  list(): SyncTarget[];
  byHost(host: string): SyncTarget | null;
  byId(id: number): SyncTarget | null;
  /** Called when a source's token, or where it comes from, changes. */
  onChange(listener: (target: SyncTarget) => void): () => void;
}

export interface SyncManagerOptions {
  db: Db;
  /** Whether this process runs the scheduler (GH_DASH_SYNC). */
  schedule: boolean;
  /** Where the GitHub token comes from (shared with the diff service and the account routes). */
  tokens: TokenSupply;
  /**
   * Every source, with its token and sync client (startServer's SourceRegistry, whose github.com runtime is over
   * `tokens` too). Without it, github.com is the only source, over `tokens` and `fetchImpl`.
   */
  sources?: SyncSources;
  log?: (line: string) => void;
  /** GitHub's fetch when there is no `sources` (tests). */
  fetchImpl?: typeof fetch;
}

/** 'no-source': the request names no source this instance syncs (the route checks that first). */
export type StartResult = { ok: true } | { ok: false; reason: 'running' | 'no-token' | 'no-source' };

const RUNNING: StartResult = { ok: false, reason: 'running' };

/** A source's part of a run: its token for the run. */
interface Run {
  target: SyncTarget;
  token: string;
}

/** How a source's part of a run ended. */
interface Outcome extends SyncResult {
  target: SyncTarget;
  points: number | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** github.com alone, over its token supply: what a manager without a SourceRegistry syncs. */
function githubOnly(db: Db, tokens: TokenSupply, fetchImpl?: typeof fetch): SyncSources {
  const target: SyncTarget = {
    id: GITHUB_SOURCE_ID,
    host: GITHUB_HOST,
    label: 'GitHub',
    get row() {
      return getSource(db, GITHUB_SOURCE_ID)!;
    },
    configured: true,
    tokens,
    syncSource: githubSyncSource(db, tokens, fetchImpl),
  };
  return {
    list: () => [target],
    byHost: (host) => (host.trim().toLowerCase() === GITHUB_HOST ? target : null),
    byId: (id) => (id === GITHUB_SOURCE_ID ? target : null),
    onChange: (listener) => tokens.onChange(() => listener(target)),
  };
}

/**
 * Runs one sync at a time, of every source this instance syncs (design §4.6): one lock, and inside a run each source
 * syncs on its own, concurrently, with its own token, client, account claim, errors, rate limit and last sync. A
 * source whose token is missing, rejected or rate limited, or for another account, stops only its own part. The lock,
 * progress and results live in the database (meta, and each source's row) so that read-only companion instances
 * (GH_DASH_SYNC=off) sharing it report the same status.
 */
export class SyncManager {
  private readonly db: Db;
  private readonly scheduleEnabled: boolean;
  /** Every source this manager knows, and how to sync each. */
  readonly sources: SyncSources;
  private readonly log: (line: string) => void;
  private readonly instance = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  /** A scheduled start is waiting for the tokens. */
  private starting = false;
  private stopped = false;
  /** By source id: after a scheduled attempt found no token for it, don't try it again before this time. */
  private readonly noTokenUntil = new Map<number, number>();
  /** By source id: the account mismatch its last claim found, until a claim succeeds or its token changes. */
  private readonly refused = new Map<number, string>();
  /** Sources other than github.com whose account, with its emails, was read in this process. */
  private readonly accountRead = new Set<number>();
  /** The current run's sources by host (this process's copy of the lock's), and the one that reported last. */
  private parts = new Map<string, SyncLockSource>();
  private lastReporter: string | null = null;
  /** Single-repo syncs of just-added repos, waiting for this process's current sync. */
  private readonly queue: SyncRequest[] = [];
  /** Repos added by hand whose first sync the scheduler started, and when it may try again. */
  private readonly firstSyncRetry = new Map<string, number>();

  constructor(opts: SyncManagerOptions) {
    this.db = opts.db;
    this.scheduleEnabled = opts.schedule;
    this.sources = opts.sources ?? githubOnly(opts.db, opts.tokens, opts.fetchImpl);
    this.log = opts.log ?? ((line) => console.log(line));
    // A new token (`gh auth login`, a pasted one) is worth trying at the next tick rather than after the backoff, and
    // may be for the right account.
    this.sources.onChange((target) => {
      this.noTokenUntil.delete(target.id);
      this.refused.delete(target.id);
    });
    // The schedule counts from the last full sync. A database from before full syncs were recorded apart has only
    // lastSync, and every such run was a full one: adopt it now, before a single-repo run can overwrite it.
    const last = getMeta(this.db, 'lastSync');
    if (last && !last.repo && !getMeta(this.db, 'lastFullSyncAt')) setMeta(this.db, 'lastFullSyncAt', last.at);
  }

  private github(): SyncTarget {
    return this.sources.byId(GITHUB_SOURCE_ID)!;
  }

  /** github.com's token source as last resolved; polling this picks up a login or logout within about 30 s. */
  getTokenSource(): TokenSource {
    return this.github().tokens.peek().source;
  }

  private liveLock(): SyncLockMeta | null {
    const lock = getMeta(this.db, 'syncLock');
    return lock && Date.now() - Date.parse(lock.heartbeatAt) < LOCK_STALE_MS ? lock : null;
  }

  status(): SyncStatus {
    const lock = this.liveLock();
    const last = getMeta(this.db, 'lastSync');
    const targets = this.sources.list().map((target) => ({ target, row: target.row }));
    const github = targets.find((t) => t.target.id === GITHUB_SOURCE_ID)?.row ?? getSource(this.db, GITHUB_SOURCE_ID);
    const rl = github?.rateLimit;
    // No source has a last sync of its own yet: the database was last synced by a build from before sources, whose
    // runs were github.com's.
    const legacy = targets.every((t) => !t.row.lastSync) ? last : null;
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
      viewer: github?.viewer?.login ?? null,
      repo: lock?.repo ?? null,
      sources: targets.map(({ target, row }) => this.sourceStatus(target, row, lock, legacy)),
    };
  }

  private sourceStatus(target: SyncTarget, row: SourceRow, lock: SyncLockMeta | null, legacy: LastSyncMeta | null): SourceSyncStatus {
    const github = target.id === GITHUB_SOURCE_ID;
    // A lock from a build from before sources is github.com's.
    const part = !lock ? null : lock.sources ? (lock.sources[target.host] ?? null) : github ? { ...lock.progress, running: true } : null;
    const last = row.lastSync ?? (github ? legacy : null);
    const resolved = target.configured ? target.tokens.peek() : null;
    const rl = row.rateLimit;
    return {
      source: target.host,
      running: !!part?.running,
      progress: part ? { done: part.done, total: part.total, current: part.current } : null,
      lastSyncAt: last?.at ?? null,
      lastResult: last ? { newItems: last.newItems, errors: last.errors } : null,
      rateLimit: rl ? { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt } : null,
      tokenSource: resolved?.source ?? 'none',
      viewer: row.viewer?.login ?? null,
      problem: !resolved
        ? `${target.label} isn't configured on this server`
        : !resolved.token
          ? this.noTokenText(target, resolved)
          : (this.refused.get(target.id) ?? null),
    };
  }

  private noTokenText(target: SyncTarget, resolved: ResolvedToken): string {
    return target.tokens.noTokenMessage?.(resolved) ?? noTokenMessage(resolved);
  }

  /**
   * Why a request found no token (POST /sync's 503): the reason of each source it would sync that has none, e.g.
   * "No GitHub token: …; No GitLab token for gitlab.example.com: …".
   */
  noTokenMessage(req: SyncRequest = {}): string {
    const targets = this.plan(req).targets.map((target) => ({ target, resolved: target.tokens.peek() }));
    const without = targets.filter((t) => !t.resolved.token);
    return (without.length ? without : targets).map((t) => this.noTokenText(t.target, t.resolved)).join('; ');
  }

  /**
   * Reads the account of each source this instance syncs, if its row doesn't know it yet (github.com: 1 API point), or
   * only by login (databases from before ids were stored). Other sources' accounts also list the emails their commits
   * carry ("me" on commits, which name no account there): read once per process while none are known. A token for
   * another account is only reported here: the sync refuses it (see viewerMismatch). Rejects with github.com's
   * failure; the others' are logged.
   */
  async ensureViewer(): Promise<void> {
    const targets = this.sources.list().filter((t) => t.configured && this.needsAccount(t));
    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        const { token } = await target.tokens.get();
        if (!token) return;
        const mismatch = await this.readAccount(target, target.syncSource(token));
        if (mismatch) this.log(`[sync] warning: ${mismatch}`);
      }),
    );
    let github: PromiseRejectedResult | null = null;
    for (const [i, s] of settled.entries()) {
      if (s.status === 'fulfilled') continue;
      const target = targets[i]!;
      if (target.id === GITHUB_SOURCE_ID) github = s;
      else this.log(`[sync] could not read the ${target.label} account: ${message(s.reason)}`);
    }
    if (github) throw github.reason;
  }

  private needsAccount(target: SyncTarget): boolean {
    const viewer = target.row.viewer;
    if (!viewer?.id) return true;
    return target.id !== GITHUB_SOURCE_ID && !viewer.emails.length && !this.accountRead.has(target.id);
  }

  /** Claims the source for the account behind `source`'s token; returns the mismatch when it belongs to another one. */
  private async readAccount(target: SyncTarget, source: SyncSource): Promise<string | null> {
    const { emails, ...viewer } = await source.viewer();
    const github = target.id === GITHUB_SOURCE_ID;
    if (!github) this.accountRead.add(target.id);
    // GitHub shows no emails (its commits carry their author's account): its claim keeps what's stored, as before.
    // Other sources' replace the stored ones when they list any (none may mean the query couldn't read them).
    const mismatch = tryClaimViewer(this.db, target.id, github || !emails.length ? viewer : { ...viewer, emails });
    if (mismatch) this.refused.set(target.id, mismatch);
    else this.refused.delete(target.id);
    return mismatch;
  }

  /**
   * What `req` syncs: its `source`, else its repo's source, else every source this instance syncs; `all` when that is
   * every one of them (a full sync the schedule counts from). A name nothing tracks is github.com's (an owned repo
   * just created).
   */
  private plan(req: SyncRequest): { targets: SyncTarget[]; ref: RepoRef | null; all: boolean } {
    const named = req.source === undefined ? null : this.sources.byHost(req.source);
    if (req.source !== undefined && !named?.configured) return { targets: [], ref: null, all: false };
    if (req.repo !== undefined) {
      const ref = this.resolve(req);
      const target = ref ? this.sources.byId(ref.sourceId) : (named ?? this.github());
      return { targets: target?.configured ? [target] : [], ref, all: false };
    }
    const configured = this.sources.list().filter((t) => t.configured);
    return { targets: named ? [named] : configured, ref: null, all: !named || configured.length === 1 };
  }

  /** The repo `req` names: a key, a github.com short name, or with `source` its path there. */
  private resolve(req: SyncRequest): RepoRef | null {
    if (req.repo === undefined) return null;
    const named = req.source === undefined ? null : this.sources.byHost(req.source);
    return named ? resolveRepoOn(this.db, req.repo, named) : resolveRepo(this.db, req.repo);
  }

  private acquire(trigger: Trigger, req: SyncRequest, ref: RepoRef | null, runs: Run[]): boolean {
    return this.db.tx(() => {
      if (this.liveLock()) return false;
      const now = new Date().toISOString();
      // Until the repo lists arrive, assume the repos we already know about (unavailable ones aren't synced).
      const known = (sourceId: number) =>
        this.db.get<{ n: number }>('SELECT count(*) AS n FROM repos WHERE source_id = ? AND removed_at IS NULL AND unavailable_at IS NULL', [sourceId])!.n;
      this.parts = new Map(runs.map(({ target }) => [target.host, { done: 0, total: req.repo ? 1 : known(target.id), current: null, running: true }]));
      this.lastReporter = null;
      setMeta(this.db, 'syncLock', {
        instance: this.instance,
        pid: process.pid,
        trigger,
        startedAt: now,
        heartbeatAt: now,
        progress: this.progress(),
        sources: Object.fromEntries(this.parts),
        ...(req.repo ? { repo: ref?.key ?? req.repo } : {}),
      });
      return true;
    });
  }

  /** The run's progress: its sources' added up; the repo being synced is the one the last source to report is on. */
  private progress(): SyncProgress {
    let done = 0;
    let total = 0;
    for (const p of this.parts.values()) {
      done += p.done;
      total += p.total;
    }
    const last = this.lastReporter === null ? undefined : this.parts.get(this.lastReporter);
    const current = last?.current ?? [...this.parts.values()].find((p) => p.current !== null)?.current ?? null;
    return { done, total, current };
  }

  private report(host: string, p: SyncProgress): void {
    const part = this.parts.get(host);
    if (!part) return;
    Object.assign(part, p);
    this.lastReporter = host;
    this.writeLock();
  }

  private writeLock(): void {
    const lock = getMeta(this.db, 'syncLock');
    if (lock?.instance !== this.instance) return;
    setMeta(this.db, 'syncLock', { ...lock, heartbeatAt: new Date().toISOString(), progress: this.progress(), sources: Object.fromEntries(this.parts) });
  }

  /** A manual start asks for the tokens afresh (the user may just have logged in); others take the cached ones. */
  async start(trigger: Trigger, req: SyncRequest = {}): Promise<StartResult> {
    return (await this.begin(trigger, req)).result;
  }

  /** start(), and the sources it found without a token (the scheduler backs off from those). */
  private async begin(trigger: Trigger, req: SyncRequest): Promise<{ result: StartResult; missing: SyncTarget[] }> {
    // Before resolving the tokens: a 409 needn't run gh.
    if (this.current || this.liveLock()) return { result: RUNNING, missing: [] };
    const { targets, ref, all } = this.plan(req);
    if (!targets.length) return { result: { ok: false, reason: 'no-source' }, missing: [] };
    const fresh = trigger === 'manual';
    const found = await Promise.all(targets.map(async (target) => ({ target, token: (await target.tokens.get({ fresh })).token })));
    const runs = found.filter((f): f is Run => f.token !== null);
    const missing = found.filter((f) => f.token === null).map((f) => f.target);
    if (!runs.length) return { result: { ok: false, reason: 'no-token' }, missing };
    if (this.stopped || this.current || !this.acquire(trigger, req, ref, runs)) return { result: RUNNING, missing };
    // A path on the named source reaches runSync as the key it resolved to.
    const run = req.source !== undefined && ref ? { ...req, repo: ref.key } : req;
    this.current = this.execute(trigger, run, runs, all).finally(() => {
      this.current = null;
      if (!this.startQueued()) this.reschedule();
    });
    return { result: { ok: true }, missing };
  }

  /**
   * POST /sync without HTTP: checks that `body` names something this instance can sync, then starts a manual run
   * (asking for the tokens afresh) and returns the status it started with. Throws HttpError: 404 for a `source` that
   * isn't a source here or a repo key nothing tracks, 400 for a source (or a repo's source) this instance doesn't sync
   * or when there is nothing to sync, 409 with the running status when a sync is running, 503 with the reasons when no
   * requested source has a token.
   */
  async request(body: SyncRequest): Promise<SyncStatus> {
    const { db } = this;
    const req: SyncRequest = { ...body };
    // `source` syncs that source alone; it must be one this instance syncs.
    const source = req.source === undefined ? null : this.sources.byHost(req.source);
    if (req.source !== undefined) {
      if (!source) throw new HttpError(404, notASource(req.source));
      if (!source.configured) throw new HttpError(400, `${source.label} isn't configured on this server.`);
    }
    if (req.repo !== undefined) {
      // A tracked repo is synced by its key (with `source`, by its path there too); a bare name nothing tracks may be a
      // repo the viewer just created on github.com.
      const ref = source ? resolveRepoOn(db, req.repo, source) : resolveRepo(db, req.repo);
      if (ref) {
        req.repo = ref.key;
        const on = this.sources.byId(ref.sourceId);
        if (!on?.configured) throw new HttpError(400, `${on?.label ?? sourceLabel(getSource(db, ref.sourceId)!)} isn't configured on this server.`);
      } else if (req.repo.includes('/') || (source && source.id !== GITHUB_SOURCE_ID)) {
        throw new HttpError(404, `${req.repo} isn't tracked${source ? ` on ${source.label}` : ''}. Add it first (POST /api/v1/repos).`);
      }
    }
    // Resolves the tokens afresh, so "Sync now" works right after `gh auth login` or a new token file.
    const res = await this.start('manual', req);
    if (!res.ok && res.reason === 'running') throw new HttpError(409, 'A sync is already running', this.status());
    if (!res.ok && res.reason === 'no-token') throw new HttpError(503, this.noTokenMessage(req));
    if (!res.ok) throw new HttpError(400, 'Nothing here to sync');
    return this.status();
  }

  /** Whether this manager syncs the source at `host`: every source this instance's config names (github.com always). */
  syncsSource(host: string): boolean {
    return !!this.sources.byHost(host)?.configured;
  }

  /**
   * The first sync of a repo just added (POST /repos) on `source` (a host; the key's source when absent): now if
   * nothing runs, else after the sync this process is running. When another instance holds the lock, the scheduler's
   * rule for repos waiting for a sync picks it up. A source this instance doesn't sync is left to the one that does.
   */
  async startOrQueue(req: SyncRequest): Promise<'started' | 'queued'> {
    if (req.source !== undefined && !this.syncsSource(req.source)) return 'queued';
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
      const ref = this.resolve(req);
      if (!ref || this.db.get('SELECT 1 FROM sync_state WHERE repo_id = ? AND synced_at IS NOT NULL', [ref.id])) continue;
      void this.start('manual', { ...req, repo: ref.key });
      return true;
    }
    return false;
  }

  private async execute(trigger: Trigger, req: SyncRequest, runs: Run[], all: boolean): Promise<void> {
    const started = Date.now();
    const heartbeat = setInterval(() => this.writeLock(), HEARTBEAT_MS);
    let outcomes: Outcome[];
    try {
      outcomes = await Promise.all(runs.map((run) => this.runSource(trigger, req, run)));
    } finally {
      clearInterval(heartbeat);
    }
    const durationMs = Date.now() - started;
    this.db.tx(() => {
      setMeta(this.db, 'lastSync', {
        at: new Date().toISOString(),
        durationMs,
        trigger,
        newItems: outcomes.reduce((n, o) => n + o.newItems, 0),
        // Named by source, but for github.com's.
        errors: outcomes.flatMap((o) => (o.target.id === GITHUB_SOURCE_ID ? o.errors : o.errors.map((e) => `${o.target.label}: ${e}`))),
        pointsUsed: outcomes.reduce((n, o) => n + (o.points ?? 0), 0),
        ...(req.repo ? { repo: getMeta(this.db, 'syncLock')?.repo ?? req.repo } : {}),
      });
      if (all) setMeta(this.db, 'lastFullSyncAt', new Date().toISOString());
      if (getMeta(this.db, 'syncLock')?.instance === this.instance) deleteMeta(this.db, 'syncLock');
    });
    this.parts = new Map();
    this.lastReporter = null;
  }

  /** One source's part of a run. Never rejects: whatever stops it is its errors. */
  private async runSource(trigger: Trigger, req: SyncRequest, { target, token }: Run): Promise<Outcome> {
    const started = Date.now();
    const source = target.syncSource(token);
    let result: SyncResult = { repos: 0, newItems: 0, errors: [], forksSkipped: 0 };
    try {
      // Other sources' accounts list their commit emails: read once per process while none are known.
      if (target.id !== GITHUB_SOURCE_ID && this.needsAccount(target)) {
        const mismatch = await this.readAccount(target, source);
        if (mismatch) throw new AccountMismatch(mismatch);
      }
      result = await runSync(
        { db: this.db, source, src: target.row, settings: getSettings(this.db), onProgress: (p) => this.report(target.host, p) },
        req,
      );
      this.refused.delete(target.id);
    } catch (err) {
      if (err instanceof AccountMismatch) this.refused.set(target.id, err.message);
      result = { ...result, errors: [message(err)] };
    }
    const durationMs = Date.now() - started;
    const rl = source.rateLimit;
    this.db.tx(() => {
      // github.com's client writes it as GitHub reports it (githubSyncSource); the others' as the run leaves it.
      if (rl?.resetAt) setSourceRateLimit(this.db, target.id, { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt });
      setSourceLastSync(this.db, target.id, {
        at: new Date().toISOString(), durationMs, newItems: result.newItems, errors: result.errors, requests: source.requests, points: source.points,
      });
    });
    const part = this.parts.get(target.host);
    if (part) {
      part.running = false;
      part.current = null;
      this.writeLock();
    }
    const scope = [req.repo ? `repo=${req.repo}` : null, req.full ? 'full' : null].filter(Boolean).join(' ');
    const named = target.id === GITHUB_SOURCE_ID ? '' : `${target.label} · `;
    const spent = source.points === null ? `${source.requests} requests` : `${source.points} points in ${source.requests} requests`;
    this.log(
      `[sync] ${named}${trigger}${scope ? ` (${scope})` : ''} done in ${(durationMs / 1000).toFixed(1)}s · ${result.repos} repos · ` +
        `${result.newItems} new items · ${result.errors.length} errors · ${spent}` +
        (rl ? ` (${rl.remaining}/${rl.limit} left)` : '') +
        (result.forksSkipped ? ` · commit history and branches skipped for ${result.forksSkipped} forks (includeForks off)` : ''),
    );
    for (const e of result.errors) this.log(`[sync]   error: ${named ? `${target.label}: ` : ''}${e}`);
    return { ...result, target, points: source.points };
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
    const now = Date.now();
    const configured = this.sources.list().filter((t) => t.configured);
    const backoff = (t: SyncTarget) => this.noTokenUntil.get(t.id) ?? 0;
    // Held back while every source waits out a missing token; a source with one syncs on schedule without the others.
    const held = configured.length ? Math.min(...configured.map(backoff)) : 0;
    // Single-repo runs (a repo just added) don't move the schedule of full syncs; with no full sync yet, one is due.
    const last = getMeta(this.db, 'lastFullSyncAt');
    const due = Math.max(last ? Date.parse(last) + interval : 0, held);
    const next = new Date(Math.max(due, now)).toISOString();
    if (getMeta(this.db, 'nextSyncAt') !== next && !this.current) setMeta(this.db, 'nextSyncAt', next);
    if (this.current || this.starting || this.liveLock() || now < held) return;
    let req: SyncRequest = {};
    if (now < due) {
      // Not due, but a repo added by hand waits for its sync (added on another instance, revived, or its sync failed),
      // on a source that isn't waiting out a missing token.
      const key = this.manualRepoAwaitingSync(configured.filter((t) => backoff(t) <= now).map((t) => t.id));
      if (!key) return;
      this.firstSyncRetry.set(key, now + FIRST_SYNC_RETRY_MS);
      req = { repo: key };
    }
    this.starting = true;
    void this.begin(trigger, req)
      .then(({ missing }) => {
        for (const t of missing) this.noTokenUntil.set(t.id, Date.now() + NO_TOKEN_RETRY_MS);
      })
      .finally(() => {
        this.starting = false;
      });
  }

  /**
   * A live, readable repo added by hand on one of `sourceIds` with no synced_at (never synced since it was added or
   * revived), that isn't waiting out a failed attempt.
   */
  private manualRepoAwaitingSync(sourceIds: number[]): string | null {
    if (!sourceIds.length) return null;
    const keys = this.db.all<{ key: string }>(
      `SELECT ${repoKeySql('r')} AS key FROM repos r LEFT JOIN sync_state s ON s.repo_id = r.id
       WHERE r.tracked_by = 'manual' AND r.removed_at IS NULL AND r.unavailable_at IS NULL AND s.synced_at IS NULL
         AND r.source_id IN (SELECT value FROM json_each(?)) ORDER BY r.id`,
      [JSON.stringify(sourceIds)],
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
