import * as fsp from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { SourceAccount, TokenChoice, TokenKind } from '../../shared/api';
import { redact } from '../provider/transport';
import { defaultExec, findCli } from './cli';
import type { CliInfo, CliIo, CredentialSpec, Exec, ResolvedToken, TokenCheck, TokenFs, TokenSupply, Validation } from './types';

export type { CliInfo, CliSpec, CredentialSpec, Exec, ExecResult, ResolvedToken, TokenCheck, TokenFs, TokenSupply, Validation } from './types';

export interface CredentialOptions {
  /** The token variable (merged with the headless env file), and PATH, HOME, XDG and Windows folders for the CLI. */
  env: NodeJS.ProcessEnv;
  /** The configured choice; null = not chosen yet (the desktop default). */
  choice?: TokenChoice | null;
  tokenFile?: string | null;
  /** The account this database was synced for on this source, for dbLogin and mismatch. */
  viewer?: () => { login: string; id?: string | null } | null;
  platform?: NodeJS.Platform;
  exec?: Exec;
  fs?: TokenFs;
  now?: () => number;
  log?: (line: string) => void;
}

/** How long a resolved token is trusted before the CLI / the token file are asked again. */
export const TOKEN_CACHE_MS = 30_000;
/** Validation's deadline, for all of its requests. */
const CHECK_TIMEOUT_MS = 15_000;

/** Printable ASCII only: anything else can't go in an Authorization header (and fetch's error would quote it). */
export const HEADER_SAFE = /^[\x21-\x7e]+$/;

interface Resolution extends ResolvedToken {
  cli: CliInfo;
  at: number;
}

/** The credential as last resolved and validated: what account() and GitHub's AccountStatus are built from. */
export interface CredentialSnapshot {
  resolved: ResolvedToken & { cli: CliInfo };
  /** The last validation of `resolved.token`; null when there is no token or it hasn't been checked yet. */
  validation: Validation | null;
  choice: TokenChoice | null;
  locked: boolean;
  kind: TokenKind | null;
  tokenFile: string | null;
  dbLogin: string | null;
  mismatch: boolean;
}

const NONE: ResolvedToken = { token: null, source: 'none', error: null };
const NO_CLI: CliInfo = { available: false, path: null, login: null };

/** A token check that found nothing (yet). */
export const EMPTY_CHECK: TokenCheck = {
  ok: false, error: null, id: null, login: null, name: null, avatarUrl: null, kind: null, expiresAt: null, scopes: null,
  canWrite: null, repos: null, instance: null, emails: [],
};

export function none(error: string | null): ResolvedToken {
  return { token: null, source: 'none', error };
}

const GITHUB_NAMES = { name: 'GitHub', host: 'github.com', noTokenHint: 'connect a GitHub account in Settings' } as const;

/**
 * "No GitHub token: <why>" (the one-argument form, whose text the GitHub routes and tests pin), or "No GitLab token for
 * gitlab.example.com: <why>" for any source but github.com. For 503s.
 */
export function noTokenMessage(resolved: ResolvedToken): string;
export function noTokenMessage(source: Pick<CredentialSpec, 'name' | 'host' | 'noTokenHint'>, resolved: ResolvedToken): string;
export function noTokenMessage(a: ResolvedToken | Pick<CredentialSpec, 'name' | 'host' | 'noTokenHint'>, b?: ResolvedToken): string {
  const source = b ? (a as Pick<CredentialSpec, 'name' | 'host' | 'noTokenHint'>) : GITHUB_NAMES;
  const resolved = b ?? (a as ResolvedToken);
  const where = source.host === 'github.com' ? '' : ` for ${source.host}`;
  return `No ${source.name} token${where}: ${resolved.error ?? source.noTokenHint}`;
}

/**
 * Where one source's token comes from, shared by its sync, diffs and account routes. The provider-specific parts
 * (env variable, CLI, validation, wording) come from the CredentialSpec.
 *
 * The spec's env variable always wins (and locks the choice). Otherwise the choice decides: `auto` (the headless
 * default) is the token file if one is configured, else the CLI when the spec allows it in `auto` (gh does, glab
 * doesn't); the CLI's choice (`gh`, `glab`) and `file` are just that source; `app` is the token the desktop app pushed
 * (setAppToken); null (the desktop default) is no token. There is no silent fallback from a configured source to
 * another. Results are cached for about 30 s; `check()` validates against the provider.
 */
export class CredentialProvider implements TokenSupply {
  readonly spec: CredentialSpec;
  private readonly env: NodeJS.ProcessEnv;
  private choice: TokenChoice | null;
  private readonly tokenFile: string | null;
  private readonly viewer: () => { login: string; id?: string | null } | null;
  private readonly win: boolean;
  private readonly io: CliIo;
  private readonly fs: TokenFs;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private appToken: string | null = null;
  private current: Resolution | null = null;
  private invalidated = false;
  private pending: Promise<Resolution> | null = null;
  /** Bumped by setChoice/setAppToken: a resolution started before is stale when it lands. */
  private generation = 0;
  private validation: Validation | null = null;
  private validating: { token: string; promise: Promise<Validation> } | null = null;
  /** Validations started so far: recheck() doesn't repeat one its own resolution started. */
  private checksStarted = 0;
  private readonly listeners = new Set<(token: ResolvedToken) => void>();
  /** Token file permission warnings already logged ("path:mode"), so they aren't repeated every 30 s. */
  private readonly warned = new Set<string>();

  constructor(spec: CredentialSpec, opts: CredentialOptions) {
    this.spec = spec;
    this.env = opts.env;
    this.choice = opts.choice === undefined ? 'auto' : opts.choice;
    this.tokenFile = opts.tokenFile ?? null;
    this.viewer = opts.viewer ?? (() => null);
    const platform = opts.platform ?? process.platform;
    this.win = platform === 'win32';
    this.fs = opts.fs ?? fsp;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
    this.io = {
      env: this.env,
      exec: opts.exec ?? defaultExec,
      fs: this.fs,
      platform,
      win: this.win,
      path: this.win ? win32 : posix,
      envVar: (name) => this.envVar(name),
    };
  }

  /** What logs and errors call this source: "GitHub", "GitLab (gitlab.example.com)". */
  get label(): string {
    return this.spec.label;
  }

  // ---------------------------------------------------------------------------
  // TokenSupply
  // ---------------------------------------------------------------------------

  async get(opts: { fresh?: boolean } = {}): Promise<ResolvedToken> {
    return this.resolution(opts.fresh);
  }

  peek(): ResolvedToken {
    if (this.isStale() && !this.pending) void this.refresh();
    return this.current ?? NONE;
  }

  invalidate(token?: string): void {
    this.invalidated = true;
    const current = this.current?.token;
    if (current && (token === undefined || token === current)) {
      this.validation = { ...this.unchecked(current), error: this.spec.rejected };
    }
  }

  onChange(listener: (token: ResolvedToken) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** "No GitLab token for gitlab.example.com: <why>", for the current (or given) resolution. */
  noTokenMessage(resolved: ResolvedToken = this.peek()): string {
    return noTokenMessage(this.spec, resolved);
  }

  // ---------------------------------------------------------------------------
  // Choice (the desktop app's set-token)
  // ---------------------------------------------------------------------------

  getChoice(): TokenChoice | null {
    return this.choice;
  }

  setChoice(choice: TokenChoice | null): void {
    this.choice = choice;
    this.restart();
  }

  /** The token the desktop app holds (pasted, or remembered in the OS keychain); null forgets it. */
  setAppToken(token: string | null): void {
    this.appToken = token?.trim() || null;
    this.restart();
  }

  private restart(): void {
    this.generation++;
    this.pending = null;
    this.invalidated = true;
  }

  // ---------------------------------------------------------------------------
  // Account status and validation
  // ---------------------------------------------------------------------------

  /** The account behind the current token (see snapshot()). Never calls the provider, so it can be polled. */
  async account(): Promise<SourceAccount> {
    return this.sourceAccount(await this.snapshot());
  }

  /** Re-resolves the token now and validates it against the provider (see recheck()). */
  async check(): Promise<SourceAccount> {
    return this.sourceAccount(await this.recheck());
  }

  /**
   * The credential as last resolved and validated. Never calls the provider: only the first resolution is waited
   * for; after that a stale token is re-resolved in the background (at most every 30 s), and a new token is validated
   * in the background when it turns up.
   */
  async snapshot(): Promise<CredentialSnapshot> {
    if (!this.current) await this.resolution();
    this.peek();
    return this.snapshotOf(this.current!);
  }

  /** Re-resolves the token now and validates it (GitHub: 1 GraphQL point; GitLab: 2 requests): startup, Retry, set-token. */
  async recheck(): Promise<CredentialSnapshot> {
    const started = this.checksStarted;
    const r = await this.resolution(true);
    // A new token is validated as it's committed; that check is as fresh as this one would be.
    if (r.token) await this.validate(r.token, this.checksStarted === started);
    return this.snapshotOf(r);
  }

  private validate(token: string, force: boolean): Promise<Validation> {
    if (this.validating?.token === token) return this.validating.promise;
    if (!force && this.validation?.token === token) return Promise.resolve(this.validation);
    this.checksStarted++;
    const promise = this.runCheck(token).then((v) => {
      if (this.validating?.promise === promise) this.validating = null;
      if (this.current?.token === token) {
        this.validation = v;
        const p = this.spec.logPrefix;
        this.log(
          v.ok
            ? `${p} ${this.current.source} token is for @${v.login} (${v.kind ?? this.spec.kind(token)}${v.expiresAt ? `, expires ${v.expiresAt.slice(0, 10)}` : ''})`
            : `${p} ${this.current.source} token check failed: ${v.error}`,
        );
        if (v.ok) for (const note of this.spec.notes?.(v, this.now()) ?? []) this.log(`${p} ${note}`);
      }
      return v;
    });
    this.validating = { token, promise };
    return promise;
  }

  private unchecked(token: string): Validation {
    return { ...EMPTY_CHECK, emails: [], token, checkedAt: new Date(this.now()).toISOString() };
  }

  /** The spec's validation, which never leaves this with the token in it. */
  private async runCheck(token: string): Promise<Validation> {
    const base = this.unchecked(token);
    try {
      const found = await this.spec.validate(token, AbortSignal.timeout(CHECK_TIMEOUT_MS));
      return { ...base, ...found, error: found.error === null ? null : redact(token, found.error) };
    } catch (err) {
      return { ...base, error: redact(token, `Couldn't check the ${this.spec.label} token: ${(err as Error).message}`) };
    }
  }

  private snapshotOf(r: Resolution): CredentialSnapshot {
    const v = r.token && this.validation?.token === r.token ? this.validation : null;
    const db = this.viewer();
    // The same account: by node id when both are known (logins can be renamed), else by login.
    const mismatch = !!(v?.login && db && (v.id && db.id ? v.id !== db.id : v.login.toLowerCase() !== db.login.toLowerCase()));
    return {
      resolved: { token: r.token, source: r.source, error: r.error, cli: r.cli },
      validation: v,
      choice: this.choice,
      locked: this.envToken() !== null,
      kind: r.token ? (v?.kind ?? this.spec.kind(r.token)) : null,
      tokenFile: this.tokenFile,
      dbLogin: db?.login ?? null,
      mismatch,
    };
  }

  private sourceAccount(s: CredentialSnapshot): SourceAccount {
    const v = s.validation;
    return {
      source: s.resolved.source,
      choice: s.choice,
      locked: s.locked,
      env: this.spec.envVar,
      login: v?.login ?? null,
      name: v?.name ?? null,
      avatarUrl: v?.avatarUrl ?? null,
      dbLogin: s.dbLogin,
      mismatch: s.mismatch,
      kind: s.kind,
      expiresAt: v?.expiresAt ?? null,
      scopes: v?.scopes ?? null,
      canWrite: v?.canWrite ?? null,
      repos: v?.repos ?? null,
      cli: this.spec.cli ? { name: this.spec.cli.name, ...s.resolved.cli } : null,
      tokenFile: s.tokenFile,
      instance: v?.instance ?? null,
      error: s.resolved.error ?? v?.error ?? null,
      checkedAt: v?.checkedAt ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private isStale(): boolean {
    return !this.current || this.invalidated || this.now() - this.current.at >= TOKEN_CACHE_MS;
  }

  private async resolution(fresh = false): Promise<Resolution> {
    if (!fresh && !this.isStale()) return this.current!;
    return this.refresh();
  }

  /** One resolution at a time; callers arriving meanwhile share it. */
  private refresh(): Promise<Resolution> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending: Promise<Resolution> = this.resolveNow().then((r) => {
      if (generation !== this.generation) {
        // The choice changed while this ran: resolve again for the new one.
        if (this.pending === pending) this.pending = null;
        return this.refresh();
      }
      if (this.pending === pending) this.pending = null;
      this.commit(r);
      return r;
    });
    this.pending = pending;
    return pending;
  }

  private commit(r: Resolution): void {
    const prev = this.current ?? NONE;
    this.current = r;
    this.invalidated = false;
    if (prev.token === r.token && prev.source === r.source && prev.error === r.error) return;
    const p = this.spec.logPrefix;
    this.log(r.token ? `${p} using ${r.source}` : `${p} no token${r.error ? `: ${r.error}` : ''}`);
    if (prev.token === r.token && prev.source === r.source) return;
    // A token not seen before is checked in the background, so account() never has to.
    if (r.token && r.token !== prev.token) void this.validate(r.token, false);
    for (const listener of this.listeners) {
      try {
        listener(r);
      } catch (err) {
        this.log(`${p} change listener failed: ${(err as Error).message}`);
      }
    }
  }

  private async resolveNow(): Promise<Resolution> {
    const at = this.now();
    let cli: CliInfo = NO_CLI;
    try {
      cli = await this.detectCli();
      const done = (r: ResolvedToken): Resolution => ({ ...r, cli, at });
      const fromEnv = this.envToken();
      if (fromEnv) return done({ token: fromEnv, source: 'env', error: null });
      const choice = this.choice;
      switch (choice) {
        case null:
          return done(NONE);
        case 'auto':
          if (this.tokenFile) return done(await this.fromFile(this.tokenFile));
          return done(this.spec.cli?.inAuto ? await this.fromCli(cli) : none(this.spec.notConfigured));
        case 'file':
          return done(this.tokenFile ? await this.fromFile(this.tokenFile) : none(`No token file is configured (${this.spec.fileSetting})`));
        case 'app':
          return done(this.appToken ? { token: this.appToken, source: 'app', error: null } : none('No token has been entered in the app'));
        default:
          if (choice === this.spec.cli?.choice) return done(await this.fromCli(cli));
          return done(none(`${choice} can't supply a ${this.spec.name} token`));
      }
    } catch (err) {
      return { ...none(`Couldn't resolve the ${this.spec.label} token: ${(err as Error).message}`), cli, at };
    }
  }

  /** An environment variable, looked up case-insensitively on Windows (a copied env loses that). */
  private envVar(name: string): string | undefined {
    if (!this.win) return this.env[name];
    return Object.entries(this.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  }

  private envToken(): string | null {
    return this.spec.envVar ? this.envVar(this.spec.envVar)?.trim() || null : null;
  }

  private async fromFile(path: string): Promise<ResolvedToken> {
    let text: string;
    try {
      const st = await this.fs.stat(path);
      if (!st.isFile()) return none(`Token file ${path} is not a file`);
      this.checkMode(path, st.mode);
      text = await this.fs.readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return none(code === 'ENOENT' ? `Token file ${path} does not exist` : `Can't read token file ${path} (${code ?? (err as Error).message})`);
    }
    // Never quote the contents: a wrong file could hold anything.
    const token = text.trim();
    if (!token) return none(`Token file ${path} is empty`);
    if (!HEADER_SAFE.test(token)) return none(`Token file ${path} must hold just the token (it has spaces, line breaks or other characters)`);
    return { token, source: 'file', error: null };
  }

  private checkMode(path: string, mode: number): void {
    if (this.win || !(mode & 0o077)) return;
    const key = `${path}:${mode & 0o777}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(`${this.spec.logPrefix} warning: token file ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`);
  }

  private async fromCli(info: CliInfo): Promise<ResolvedToken> {
    const cli = this.spec.cli!;
    if (!info.path) return none(cli.path ? `${cli.name} not found at ${cli.path} (${cli.pathSetting})` : cli.notFound);
    return cli.token(info.path, this.io);
  }

  /** The CLI's location and its active login. */
  private async detectCli(): Promise<CliInfo> {
    const cli = this.spec.cli;
    if (!cli) return NO_CLI;
    const path = await findCli(cli, this.io);
    return { available: path !== null, path, login: path && cli.login ? await cli.login(this.io) : null };
  }
}
