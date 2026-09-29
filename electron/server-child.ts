/**
 * The server child (dist/server/desktop.mjs in a utilityProcess): start, ready/fatal, restart with backoff after
 * crashes, graceful shutdown, and the request/answer round trips (set-token, the GitLab sources' messages). Protocol:
 * shared/desktop.ts (MainToServer/ServerToMain).
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { AccountStatus, SourceAccount, SourceCheck, TokenChoice } from '../shared/api';
import type { MainToServer, ServerToMain, SourceTestDraft } from '../shared/desktop';

export type ChildStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'failed';
export type StartResult = { ok: true; apiUrl: string | null } | { ok: false; message: string };
export interface TokenResult {
  ok: boolean;
  account: AccountStatus;
}
export interface SourceTokenResult {
  ok: boolean;
  account: SourceAccount;
}
export interface ReloadResult {
  ok: boolean;
  error: string | null;
  sources: string[];
}

/** A request main sends (every message but shutdown), without the id the round trip adds. */
type Request = MainToServer extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never;
/** An answer to a request. */
type Answer = Extract<ServerToMain, { id: number }>;

export interface ServerChildOptions {
  script: string;
  /** Environment for each start (read fresh, so a restart picks up changes). */
  env: () => Record<string, string>;
  log: (line: string) => void;
  /** Called on every successful start (first start, config restart, crash recovery), before requests flow. */
  onReady?: (apiUrl: string | null) => void;
  /** A database migration or a slow disk can take a while; a hung child is killed after this. */
  startTimeoutMs?: number;
}

/** Crash-restart budget: this many unexpected exits within the window, then give up (error page). */
const MAX_CRASHES = 4;
const CRASH_WINDOW_MS = 5 * 60_000;
const BACKOFF_MS = [500, 1_000, 3_000, 8_000];
/**
 * gh may wait on a keyring prompt (60 s in the server) and glab 15 s; leave room for the provider's check after it.
 * Every request gets as long.
 */
const TOKEN_TIMEOUT_MS = 90_000;

type Outcome = { kind: 'ready'; apiUrl: string | null } | { kind: 'fatal'; message: string } | { kind: 'exit'; message: string };

const STOPPED: StartResult = { ok: false, message: 'stopped' };

export class ServerChild {
  status: ChildStatus = 'idle';
  apiUrl: string | null = null;
  /** Why the last start failed (fatal message, crash); cleared by a successful start. */
  lastError: string | null = null;
  private proc: UtilityProcess | null = null;
  private exited: Promise<number> | null = null;
  /** The start in progress, crash recovery included (its backoff too), so stop() can wait it out. */
  private starting: Promise<StartResult> | null = null;
  /**
   * Bumped by every launch and by stop(). A callback from an earlier launch (its exit, a late ready/fatal, a backoff
   * ending) sees a newer generation and leaves the replacement alone.
   */
  private generation = 0;
  /** Ends the current backoff early (stop()). */
  private cancelBackoff: (() => void) | null = null;
  private crashes: number[] = [];
  private waiters: (() => void)[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Answer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; proc: UtilityProcess | null }>();

  constructor(private readonly opts: ServerChildOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Resolves once the child is running, failed or stopped (i.e. not in the middle of starting or stopping). */
  async whenSettled(): Promise<ChildStatus> {
    while (this.status === 'starting' || this.status === 'stopping') await new Promise<void>((r) => this.waiters.push(r));
    return this.status;
  }

  start(): Promise<StartResult> {
    if (this.status === 'running') return Promise.resolve({ ok: true, apiUrl: this.apiUrl });
    return this.launch(0);
  }

  async restart(): Promise<StartResult> {
    await this.stop();
    return this.start();
  }

  /** `shutdown` message, then wait for the exit; kill after the timeout. */
  async stop(timeoutMs = 5_000): Promise<void> {
    // Nothing from the current launch may start another child after this: not its exit, not a pending crash recovery.
    this.generation++;
    this.cancelBackoff?.();
    const proc = this.proc;
    const exited = this.exited;
    if (proc && exited) {
      const failed = this.status === 'failed';
      this.setStatus('stopping');
      const timer = setTimeout(() => {
        this.opts.log(`[server] did not exit within ${timeoutMs} ms; killing it`);
        proc.kill();
      }, timeoutMs);
      // A child that reported fatal is already on its way out.
      if (!failed) {
        try {
          this.send({ type: 'shutdown' });
        } catch {
          proc.kill();
        }
      }
      const code = await exited;
      clearTimeout(timer);
      this.opts.log(`[server] stopped (exit code ${code})`);
    }
    await this.starting;
    this.apiUrl = null;
    this.setStatus('idle');
  }

  /** Sends set-token once the child is running, and waits for the matching token-result. */
  async setToken(choice: TokenChoice | null, token?: string | null): Promise<TokenResult> {
    await this.running();
    return this.sendSetToken(choice, token);
  }

  /** Sends set-token right away (from onReady, before any request is forwarded). */
  async sendSetToken(choice: TokenChoice | null, token?: string | null): Promise<TokenResult> {
    const answer = expect(await this.request(token === undefined ? { type: 'set-token', choice } : { type: 'set-token', choice, token }), 'token-result');
    return { ok: answer.ok === true, account: answer.account as AccountStatus };
  }

  /** A GitLab source's app token (null forgets it), once the child is running; answered with the source's account. */
  async setSourceToken(source: string, token: string | null): Promise<SourceTokenResult> {
    await this.running();
    return this.sendSetSourceToken(source, token);
  }

  /** setSourceToken right away (from onReady). */
  async sendSetSourceToken(source: string, token: string | null): Promise<SourceTokenResult> {
    const answer = expect(await this.request({ type: 'set-token', source, token }), 'token-result');
    return { ok: answer.ok === true, account: answer.account as SourceAccount };
  }

  /** config.json's sources changed: the child applies them without a restart. */
  async reloadSources(): Promise<ReloadResult> {
    await this.running();
    const { ok, error, sources } = expect(await this.request({ type: 'reload-sources' }), 'sources-result');
    return { ok, error, sources };
  }

  /** Resolves and validates a draft GitLab source in the child; nothing is kept there. */
  async testSource(draft: SourceTestDraft): Promise<SourceCheck> {
    await this.running();
    return expect(await this.request({ type: 'test-source', draft }), 'source-test-result').check;
  }

  /** Deletes an unconfigured source with its data (main has taken it out of config.json and reloaded). */
  async deleteSource(source: string): Promise<{ repos: number }> {
    await this.running();
    return { repos: expect(await this.request({ type: 'delete-source', source }), 'source-deleted').repos };
  }

  /** Starts a source's sync, or queues it behind the one running. */
  async syncSource(source: string): Promise<'started' | 'queued'> {
    await this.running();
    return expect(await this.request({ type: 'sync-source', source }), 'sync-started').result;
  }

  private async running(): Promise<void> {
    if ((await this.whenSettled()) !== 'running') throw new Error(this.lastError ?? 'The gh-dash server is not running.');
  }

  /** Sends a request and waits for its answer: rejects on `request-failed`, a timeout, or the child going away. */
  private request(message: Request): Promise<Answer> {
    const id = this.nextId++;
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The gh-dash server did not answer in time.'));
      }, TOKEN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, proc: this.proc });
      try {
        this.send({ ...message, id } as MainToServer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private send(message: MainToServer) {
    if (!this.proc) throw new Error('The gh-dash server is not running.');
    this.proc.postMessage(message);
  }

  private setStatus(status: ChildStatus) {
    this.status = status;
    if (status === 'starting' || status === 'stopping') return;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** One start at a time; `delayMs` is the crash-recovery backoff before the first attempt. */
  private launch(delayMs: number): Promise<StartResult> {
    this.starting ??= this.startLoop(delayMs).finally(() => (this.starting = null));
    return this.starting;
  }

  private async startLoop(delayMs: number): Promise<StartResult> {
    let gen = this.generation;
    this.setStatus('starting');
    for (;;) {
      if (delayMs > 0) {
        await this.backoff(delayMs);
        if (gen !== this.generation) return STOPPED;
      }
      gen = ++this.generation;
      const outcome = await this.spawnOnce(gen);
      if (gen !== this.generation) return STOPPED;
      if (outcome.kind === 'ready') {
        this.apiUrl = outcome.apiUrl;
        this.lastError = null;
        this.opts.onReady?.(outcome.apiUrl);
        this.setStatus('running');
        return { ok: true, apiUrl: outcome.apiUrl };
      }
      this.lastError = outcome.message;
      // A fatal message is a verdict (bad config, locked database): retrying won't help until something changes.
      if (outcome.kind === 'fatal' || !this.crashBudget()) {
        this.opts.log(`[server] failed to start: ${outcome.message}`);
        this.setStatus('failed');
        return { ok: false, message: outcome.message };
      }
      delayMs = this.backoffMs();
      this.opts.log(`[server] ${outcome.message}; retrying in ${delayMs} ms`);
    }
  }

  /** Records an unexpected exit; false once the budget is spent. */
  private crashBudget(): boolean {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    return this.crashes.length <= MAX_CRASHES;
  }

  private backoffMs(): number {
    return BACKOFF_MS[Math.min(this.crashes.length, BACKOFF_MS.length) - 1]!;
  }

  /** Waits before a restart; stop() ends it early (and the caller then sees a newer generation). */
  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const end = () => {
        clearTimeout(timer);
        this.cancelBackoff = null;
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.cancelBackoff = end;
    });
  }

  private spawnOnce(gen: number): Promise<Outcome> {
    const t0 = Date.now();
    const proc = utilityProcess.fork(this.opts.script, [], { serviceName: 'gh-dash-server', stdio: 'pipe', env: this.opts.env() });
    this.proc = proc;
    this.exited = new Promise<number>((resolve) => proc.once('exit', resolve));
    for (const stream of [proc.stdout, proc.stderr]) {
      let buffered = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        const lines = (buffered + chunk).split('\n');
        buffered = lines.pop()!;
        for (const line of lines) if (line) this.opts.log(`[server] ${line}`);
      });
    }
    let settled = false;
    let fatal: string | null = null;
    return new Promise<Outcome>((resolve) => {
      const done = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timeoutMs = this.opts.startTimeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        done({ kind: 'fatal', message: `The server did not start within ${Math.round(timeoutMs / 1000)} s.` });
        proc.kill();
      }, timeoutMs);
      proc.once('spawn', () => this.opts.log(`[server] pid ${proc.pid}: ${this.opts.script}`));
      proc.on('message', (message: ServerToMain) => {
        if (message?.type === 'ready') {
          this.opts.log(`[server] ready in ${Date.now() - t0} ms${message.apiUrl ? ` · Local API ${message.apiUrl}` : ''}`);
          done({ kind: 'ready', apiUrl: typeof message.apiUrl === 'string' ? message.apiUrl : null });
        } else if (message?.type === 'fatal') {
          fatal = String(message.message);
          done({ kind: 'fatal', message: fatal });
        } else if (message && typeof (message as { id?: unknown }).id === 'number') {
          const answer = message as Answer;
          const entry = this.pending.get(answer.id);
          if (!entry) return;
          this.pending.delete(answer.id);
          clearTimeout(entry.timer);
          if (answer.type === 'request-failed') entry.reject(new Error(String(answer.message)));
          else entry.resolve(answer);
        }
      });
      proc.once('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        for (const [id, entry] of this.pending) {
          if (entry.proc !== proc) continue;
          clearTimeout(entry.timer);
          entry.reject(new Error('The gh-dash server stopped before answering.'));
          this.pending.delete(id);
        }
        if (!settled) {
          done(fatal ? { kind: 'fatal', message: fatal } : { kind: 'exit', message: `The server exited during startup (code ${code})` });
        } else if (gen === this.generation && this.status === 'running') {
          this.opts.log(`[server] exited unexpectedly (code ${code})`);
          this.apiUrl = null;
          if (this.crashBudget()) {
            // Requests wait (whenSettled) while the replacement starts; a stop() or restart() meanwhile cancels it.
            void this.launch(this.backoffMs());
          } else {
            this.lastError = `The server stopped unexpectedly (exit code ${code}) and kept failing.`;
            this.setStatus('failed');
          }
        }
      });
    });
  }
}

/** The answer of the expected type; another one means the two sides disagree on the protocol. */
function expect<T extends Answer['type']>(answer: Answer, type: T): Extract<Answer, { type: T }> {
  if (answer.type !== type) throw new Error(`The gh-dash server answered ${answer.type} instead of ${type}.`);
  return answer as Extract<Answer, { type: T }>;
}
