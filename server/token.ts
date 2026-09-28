import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { AccountStatus, TokenChoice, TokenKind, TokenSource } from '../shared/api';
import { redact } from './github/transport';

/** A token and where it came from; `error` says why there is none. The token is only ever held in memory. */
export interface ResolvedToken {
  token: string | null;
  source: TokenSource;
  error: string | null;
}

/** What the sync and the diff service need from the token provider. */
export interface TokenSupply {
  /** The current token: cached for about 30 s, re-resolved when older (or with `fresh`). Never rejects. */
  get(opts?: { fresh?: boolean }): Promise<ResolvedToken>;
  /** The last resolved token without waiting; starts a background re-resolve when it's stale. */
  peek(): ResolvedToken;
  /** Forgets the cached token and its validation (e.g. after GitHub answered 401). */
  invalidate(): void;
  /** Called when the token or its source changes. Returns an unsubscribe function. */
  onChange(listener: (token: ResolvedToken) => void): () => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}
/** execFile, promisified: rejects with the child_process error (code, killed, signal, stderr) on failure. */
export type Exec = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<ExecResult>;

export interface TokenFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  access(path: string, mode?: number): Promise<void>;
}

export interface TokenProviderOptions {
  /** GITHUB_TOKEN (merged with the headless env file), and PATH, HOME, XDG and Windows folders for finding gh. */
  env: NodeJS.ProcessEnv;
  /** The configured choice; null = not chosen yet (the desktop default). */
  choice?: TokenChoice | null;
  tokenFile?: string | null;
  ghPath?: string | null;
  /** The account this database was synced for (meta.viewer), for AccountStatus.dbLogin and mismatch. */
  viewer?: () => { login: string; id?: string | null } | null;
  platform?: NodeJS.Platform;
  exec?: Exec;
  fetchImpl?: typeof fetch;
  fs?: TokenFs;
  now?: () => number;
  log?: (line: string) => void;
}

/** How long a resolved token is trusted before gh / the token file are asked again. */
export const TOKEN_CACHE_MS = 30_000;
/** gh can wait on a keyring prompt (it gives up after 60 s itself). */
const GH_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 15_000;
/** An expiry closer than this on a token that works is a GitHub glitch (it once reported "now + 1 minute"). */
const EXPIRY_SANITY_MS = 5 * 60_000;
const GRAPHQL = 'https://api.github.com/graphql';

/** Printable ASCII only: anything else can't go in an Authorization header (and fetch's error would quote it). */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

const VIEWER_CHECK = `query {
  viewer {
    id login name avatarUrl
    repos: repositories(ownerAffiliations: OWNER, first: 1) { totalCount }
    privateRepos: repositories(ownerAffiliations: OWNER, privacy: PRIVATE, first: 1) { totalCount }
  }
}`;
interface ViewerCheckData {
  viewer?: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    repos: { totalCount: number } | null;
    privateRepos: { totalCount: number } | null;
  } | null;
}

export interface GhInfo {
  available: boolean;
  path: string | null;
  login: string | null;
}

interface Resolution extends ResolvedToken {
  gh: GhInfo;
  at: number;
}

interface Validation {
  token: string;
  ok: boolean;
  id: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  expiresAt: string | null;
  scopes: string[] | null;
  repos: { total: number; private: number } | null;
  error: string | null;
  checkedAt: string;
}

const execFileAsync = promisify(execFile);
const defaultExec: Exec = async (file, args, { env, timeout }) => {
  const { stdout, stderr } = await execFileAsync(file, args, { env, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  return { stdout, stderr };
};

const NONE: ResolvedToken = { token: null, source: 'none', error: null };

/** Token kind from its prefix (GitHub's own table); the length isn't checked. */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('gho_')) return 'oauth';
  if (token.startsWith('ghu_') || token.startsWith('ghs_')) return 'app';
  return 'unknown';
}

/**
 * GitHub-Authentication-Token-Expiration: "2027-09-06 12:00:00 UTC", or with an offset ("2025-09-10 02:30:13 +0200").
 * null when absent, unparseable, or implausibly close for a token that just worked.
 */
export function parseTokenExpiration(value: string | null, now: number): string | null {
  const m = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2}))?$/i);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone && /^[+-]/.test(zone)) {
    const digits = zone.replace(':', '');
    ms -= (zone.startsWith('-') ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))) * 60_000;
  }
  if (!Number.isFinite(ms) || ms - now < EXPIRY_SANITY_MS) return null;
  return new Date(ms).toISOString();
}

/** X-OAuth-Scopes: "repo, read:org" → ['repo', 'read:org']; null when the header is absent. */
function parseScopes(value: string | null): string[] | null {
  if (value === null) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The active login for `host` in gh's hosts.yml (`<host>: { user: <login> }`), without a YAML parser or an API call.
 * The file may hold a plain-text oauth_token: nothing but `user` is ever read out of it.
 */
export function ghLoginFromHosts(yaml: string, host = 'github.com'): string | null {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1/, '$2').trimEnd() === `${host}:`);
  if (start < 0) return null;
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const n = line.length - line.trimStart().length;
    if (n === 0) break;
    indent ??= n;
    if (n !== indent) continue;
    const m = line.trim().match(/^user:\s*(.*)$/);
    if (m) return m[1]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2') || null;
  }
  return null;
}

/** "No GitHub token: <why>", for 503s. */
export function noTokenMessage(resolved: ResolvedToken): string {
  return `No GitHub token: ${resolved.error ?? 'connect a GitHub account in Settings'}`;
}

/**
 * Where the GitHub token comes from, shared by the sync, the diff service and the account routes.
 *
 * GITHUB_TOKEN in the environment always wins (and locks the choice). Otherwise the choice decides: `auto` (the
 * headless default) is the token file if one is configured, else gh; `gh` and `file` are just that source; `app` is the
 * token the desktop app pushed (setAppToken); null (the desktop default) is no token. There is no silent fallback
 * from a configured source to another. Results are cached for about 30 s; `check()` validates against GitHub.
 */
export class TokenProvider implements TokenSupply {
  private readonly env: NodeJS.ProcessEnv;
  private choice: TokenChoice | null;
  private readonly tokenFile: string | null;
  private readonly ghPath: string | null;
  private readonly viewer: () => { login: string; id?: string | null } | null;
  private readonly platform: NodeJS.Platform;
  private readonly win: boolean;
  private readonly path: typeof posix;
  private readonly exec: Exec;
  private readonly fetchImpl: typeof fetch;
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
  private readonly listeners = new Set<(token: ResolvedToken) => void>();
  /** Token file permission warnings already logged ("path:mode"), so they aren't repeated every 30 s. */
  private readonly warned = new Set<string>();

  constructor(opts: TokenProviderOptions) {
    this.env = opts.env;
    this.choice = opts.choice === undefined ? 'auto' : opts.choice;
    this.tokenFile = opts.tokenFile ?? null;
    this.ghPath = opts.ghPath ?? null;
    this.viewer = opts.viewer ?? (() => null);
    this.platform = opts.platform ?? process.platform;
    this.win = this.platform === 'win32';
    this.path = this.win ? win32 : posix;
    this.exec = opts.exec ?? defaultExec;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.fs = opts.fs ?? fsp;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
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

  invalidate(): void {
    this.invalidated = true;
    this.validation = null;
  }

  onChange(listener: (token: ResolvedToken) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  /** The account behind the current token, validating it first if that hasn't happened for this token. */
  async account(): Promise<AccountStatus> {
    const r = await this.resolution();
    if (r.token && this.validation?.token !== r.token) await this.validate(r.token, false);
    return this.status(r);
  }

  /** Re-resolves the token now and validates it against GitHub (1 GraphQL point). */
  async check(): Promise<AccountStatus> {
    const r = await this.resolution(true);
    if (r.token) await this.validate(r.token, true);
    return this.status(r);
  }

  private validate(token: string, force: boolean): Promise<Validation> {
    if (this.validating?.token === token) return this.validating.promise;
    if (!force && this.validation?.token === token) return Promise.resolve(this.validation);
    const promise = this.fetchViewer(token).then((v) => {
      if (this.validating?.promise === promise) this.validating = null;
      if (this.current?.token === token) {
        this.validation = v;
        this.log(
          v.ok
            ? `[token] ${this.current.source} token is for @${v.login} (${tokenKind(token)}${v.expiresAt ? `, expires ${v.expiresAt.slice(0, 10)}` : ''})`
            : `[token] ${this.current.source} token check failed: ${v.error}`,
        );
      }
      return v;
    });
    this.validating = { token, promise };
    return promise;
  }

  private async fetchViewer(token: string): Promise<Validation> {
    const base: Validation = {
      token, ok: false, id: null, login: null, name: null, avatarUrl: null, expiresAt: null, scopes: null, repos: null, error: null,
      checkedAt: new Date(this.now()).toISOString(),
    };
    const fail = (error: string): Validation => ({ ...base, error: redact(token, error) });
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(GRAPHQL, {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'gh-dash' },
        body: JSON.stringify({ query: VIEWER_CHECK }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      return fail(`Couldn't reach GitHub: ${(err as Error).message}`);
    }
    if (res.status === 401) return fail('Bad credentials');
    let body: { data?: ViewerCheckData | null; errors?: { message: string }[]; message?: string };
    try {
      body = JSON.parse(text);
    } catch {
      return fail(res.ok ? 'Invalid response from GitHub' : `GitHub returned ${res.status}`);
    }
    if (!res.ok) return fail(`GitHub returned ${res.status}${body.message ? `: ${body.message}` : ''}`);
    const viewer = body.data?.viewer;
    if (!viewer) return fail(body.errors?.map((e) => e.message).join('; ') || 'GitHub returned no account for this token');
    const kind = tokenKind(token);
    return {
      ...base,
      ok: true,
      id: viewer.id,
      login: viewer.login,
      name: viewer.name ?? null,
      avatarUrl: viewer.avatarUrl ?? null,
      expiresAt: parseTokenExpiration(res.headers.get('github-authentication-token-expiration'), this.now()),
      scopes: kind === 'fine-grained' ? null : parseScopes(res.headers.get('x-oauth-scopes')),
      repos: viewer.repos && viewer.privateRepos ? { total: viewer.repos.totalCount, private: viewer.privateRepos.totalCount } : null,
    };
  }

  private status(r: Resolution): AccountStatus {
    const v = r.token && this.validation?.token === r.token ? this.validation : null;
    const db = this.viewer();
    // The same account: by node id when both are known (logins can be renamed), else by login.
    const mismatch = !!(v?.login && db && (v.id && db.id ? v.id !== db.id : v.login.toLowerCase() !== db.login.toLowerCase()));
    return {
      source: r.source,
      choice: this.choice,
      locked: this.envToken() !== null,
      login: v?.login ?? null,
      name: v?.name ?? null,
      avatarUrl: v?.avatarUrl ?? null,
      dbLogin: db?.login ?? null,
      mismatch,
      kind: r.token ? tokenKind(r.token) : null,
      expiresAt: v?.expiresAt ?? null,
      scopes: v?.scopes ?? null,
      repos: v?.repos ?? null,
      error: r.error ?? v?.error ?? null,
      gh: r.gh,
      tokenFile: this.tokenFile,
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
    this.log(r.token ? `[token] using ${r.source}` : `[token] no token${r.error ? `: ${r.error}` : ''}`);
    if (prev.token === r.token && prev.source === r.source) return;
    for (const listener of this.listeners) {
      try {
        listener(r);
      } catch (err) {
        this.log(`[token] change listener failed: ${(err as Error).message}`);
      }
    }
  }

  private async resolveNow(): Promise<Resolution> {
    const at = this.now();
    let gh: GhInfo = { available: false, path: null, login: null };
    try {
      gh = await this.detectGh();
      const done = (r: ResolvedToken): Resolution => ({ ...r, gh, at });
      const fromEnv = this.envToken();
      if (fromEnv) return done({ token: fromEnv, source: 'env', error: null });
      switch (this.choice) {
        case 'auto':
          return done(this.tokenFile ? await this.fromFile(this.tokenFile) : await this.fromGh(gh));
        case 'gh':
          return done(await this.fromGh(gh));
        case 'file':
          return done(this.tokenFile ? await this.fromFile(this.tokenFile) : none('No token file is configured (GITHUB_TOKEN_FILE)'));
        case 'app':
          return done(this.appToken ? { token: this.appToken, source: 'app', error: null } : none('No token has been entered in the app'));
        default:
          return done(NONE);
      }
    } catch (err) {
      return { ...none(`Couldn't resolve the GitHub token: ${(err as Error).message}`), gh, at };
    }
  }

  /** An environment variable, looked up case-insensitively on Windows (a copied env loses that). */
  private envVar(name: string): string | undefined {
    if (!this.win) return this.env[name];
    return Object.entries(this.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  }

  private envToken(): string | null {
    return this.envVar('GITHUB_TOKEN')?.trim() || null;
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
    this.log(`[token] warning: token file ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`);
  }

  private async fromGh(gh: GhInfo): Promise<ResolvedToken> {
    if (!gh.path) {
      return none(this.ghPath ? `gh not found at ${this.ghPath} (GH_DASH_GH_PATH)` : 'GitHub CLI (gh) not found: install it, or set GH_DASH_GH_PATH');
    }
    try {
      // --hostname: GH_HOST may point gh at an Enterprise server; gh-dash only talks to github.com.
      const { stdout } = await this.exec(gh.path, ['auth', 'token', '--hostname', 'github.com'], { env: this.ghEnv(), timeout: GH_TIMEOUT_MS });
      const token = stdout.trim();
      if (!token) return none('gh auth token printed no token');
      if (!HEADER_SAFE.test(token)) return none('gh auth token printed something other than a token');
      return { token, source: 'gh-cli', error: null };
    } catch (err) {
      return none(ghError(err, gh.path));
    }
  }

  /** gh's environment, minus GH_TOKEN / GITHUB_TOKEN: with those set, `gh auth token` just prints them back. */
  private ghEnv(): NodeJS.ProcessEnv {
    const drop = new Set(['GH_TOKEN', 'GITHUB_TOKEN']);
    const env = Object.fromEntries(Object.entries(this.env).filter(([key, value]) => value !== undefined && !drop.has(this.win ? key.toUpperCase() : key)));
    return { ...env, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };
  }

  /** gh's location (GH_DASH_GH_PATH, PATH, then where installers put it) and its active github.com login. */
  private async detectGh(): Promise<GhInfo> {
    const path = await this.findGh();
    return { available: path !== null, path, login: path ? await this.ghLogin() : null };
  }

  private async findGh(): Promise<string | null> {
    if (this.ghPath) return (await this.isExecutable(this.ghPath)) ? this.ghPath : null;
    const exe = this.win ? 'gh.exe' : 'gh';
    const pathDirs = (this.envVar('PATH') ?? '').split(this.path.delimiter).filter((dir) => dir && this.path.isAbsolute(dir));
    for (const dir of new Set([...pathDirs, ...this.standardDirs()])) {
      const candidate = this.path.join(dir, exe);
      if (await this.isExecutable(candidate)) return candidate;
    }
    return null;
  }

  /** Install locations to try when PATH is minimal (apps started from a desktop launcher, systemd units). */
  private standardDirs(): string[] {
    const home = (this.win ? this.envVar('USERPROFILE') : this.envVar('HOME')) || homedir();
    const j = this.path.join;
    if (this.win) {
      const dirs: string[] = [];
      for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const dir = this.envVar(name);
        if (dir) dirs.push(j(dir, 'GitHub CLI'));
      }
      const local = this.envVar('LOCALAPPDATA');
      if (local) dirs.push(j(local, 'Microsoft', 'WinGet', 'Links'));
      dirs.push(j(this.envVar('SCOOP') || j(home, 'scoop'), 'shims'));
      dirs.push(j(this.envVar('ChocolateyInstall') || 'C:\\ProgramData\\chocolatey', 'bin'));
      return dirs;
    }
    const nix = [j(home, '.nix-profile/bin'), '/run/current-system/sw/bin'];
    if (this.platform === 'darwin') {
      return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', ...nix, j(home, '.local/bin')];
    }
    return ['/usr/bin', '/usr/local/bin', j(home, '.local/bin'), '/home/linuxbrew/.linuxbrew/bin', j(home, '.linuxbrew/bin'), ...nix, '/snap/bin'];
  }

  private async isExecutable(path: string): Promise<boolean> {
    try {
      if (!(await this.fs.stat(path)).isFile()) return false;
      if (!this.win) await this.fs.access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** gh's active github.com login from hosts.yml; null when unknown. */
  private async ghLogin(): Promise<string | null> {
    const j = this.path.join;
    const dir =
      this.envVar('GH_CONFIG_DIR') ||
      (this.envVar('XDG_CONFIG_HOME') ? j(this.envVar('XDG_CONFIG_HOME')!, 'gh') : null) ||
      (this.win && this.envVar('AppData') ? j(this.envVar('AppData')!, 'GitHub CLI') : null) ||
      j((this.win ? this.envVar('USERPROFILE') : this.envVar('HOME')) || homedir(), '.config', 'gh');
    try {
      return ghLoginFromHosts(await this.fs.readFile(j(dir, 'hosts.yml'), 'utf8'));
    } catch {
      return null;
    }
  }
}

function none(error: string | null): ResolvedToken {
  return { token: null, source: 'none', error };
}

function ghError(err: unknown, path: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string | null };
  if (e.code === 'ENOENT' || e.code === 'EACCES') return `Couldn't run gh at ${path} (${e.code})`;
  if (e.killed || e.signal === 'SIGTERM') return `gh auth token timed out after ${GH_TIMEOUT_MS / 1000} s (is it waiting for a keyring prompt?)`;
  const stderr = (e.stderr ?? '').trim().split('\n')[0]!.trim();
  if (/no oauth token/i.test(stderr)) return 'gh is not logged in to github.com: run `gh auth login`';
  return `gh auth token failed: ${(stderr || e.message.split('\n')[0]!).slice(0, 200)}`;
}
