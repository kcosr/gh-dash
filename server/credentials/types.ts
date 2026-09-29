import type { posix } from 'node:path';
import type { TokenChoice, TokenKind, TokenSource } from '../../shared/api';
import type { ProviderKind } from '../provider/types';

/** A token and where it came from; `error` says why there is none. The token is only ever held in memory. */
export interface ResolvedToken {
  token: string | null;
  source: TokenSource;
  error: string | null;
}

/** What the sync and the diff service need from a source's token provider. */
export interface TokenSupply {
  /** The current token: cached for about 30 s, re-resolved when older (or with `fresh`). Never rejects. */
  get(opts?: { fresh?: boolean }): Promise<ResolvedToken>;
  /** The last resolved token without waiting; starts a background re-resolve when it's stale. */
  peek(): ResolvedToken;
  /**
   * The provider rejected `token` (401): resolve again before the next use. The current token, if it is that one (or
   * no token is named), is reported as rejected until it changes or is checked again.
   */
  invalidate(token?: string): void;
  /** Called when the token or its source changes. Returns an unsubscribe function. */
  onChange(listener: (token: ResolvedToken) => void): () => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}
/** execFile, promisified: rejects with the child_process error (code, killed, signal, stdout, stderr) on failure. */
export type Exec = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<ExecResult>;

export interface TokenFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  access(path: string, mode?: number): Promise<void>;
}

/** Where the provider's CLI is, and who it is logged in as (read from its config, never by running it). */
export interface CliInfo {
  available: boolean;
  path: string | null;
  login: string | null;
}

/** What a CLI resolver may use: the provider's environment, and its exec / fs stand-ins. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  fs: TokenFs;
  platform: NodeJS.Platform;
  win: boolean;
  path: typeof posix;
  /** An environment variable, looked up case-insensitively on Windows (a copied env loses that). */
  envVar(name: string): string | undefined;
}

/** A provider's command-line tool that can hand out its token: gh, or glab. */
export interface CliSpec {
  /** The executable's name ("gh.exe" on Windows) and what messages call it. */
  name: 'gh' | 'glab';
  /** The choice that selects it, and the source a token from it reports. */
  choice: TokenChoice;
  source: TokenSource;
  /** The configured executable (ghPath / glabPath); null = PATH, then the standard install locations. */
  path: string | null;
  /** The setting that holds `path`, for messages ("ghPath"). */
  pathSetting: string;
  /** Its folder under Program Files on Windows. */
  windowsFolder: string;
  /** Why there is no token when the CLI can't be found anywhere. */
  notFound: string;
  /** Whether `auto` uses it when no token file is configured (gh, as always; glab only when chosen). */
  inAuto: boolean;
  /** The active login from the CLI's config, without running it; null = not read (glab). */
  login: ((io: CliIo) => Promise<string | null>) | null;
  /** Asks the CLI at `path` for the token. Never rejects: a failure is a ResolvedToken with an error. */
  token(path: string, io: CliIo): Promise<ResolvedToken>;
}

/** What validating a token against its provider found out. Never holds the token. */
export interface TokenCheck {
  ok: boolean;
  /** Why the token can't be used; null when it can. Tokens are masked before it's stored. */
  error: string | null;
  id: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  /** The kind when validation tells more than the prefix (a GitLab OAuth token); null = the spec's `kind(token)`. */
  kind: TokenKind | null;
  expiresAt: string | null;
  scopes: string[] | null;
  /** GitLab: the scopes allow changes (api, write_repository). null for GitHub, or when unknown. */
  canWrite: boolean | null;
  /** GitHub: owned repositories. GitLab: projects in the personal namespace (private unknown). */
  repos: { total: number; private: number | null } | null;
  /** GitLab's version; null for GitHub. */
  instance: { version: string; enterprise: boolean } | null;
  /** The account's emails, which count as "me" (GitLab); empty when unknown. */
  emails: string[];
}

/** A TokenCheck for a given token, and when it was made. */
export interface Validation extends TokenCheck {
  token: string;
  checkedAt: string;
}

/**
 * Everything that differs between providers' credentials. The resolution machinery (cache, env lock, token file, app
 * token, CLI discovery, background validation) is CredentialProvider's and the same for every source.
 */
export interface CredentialSpec {
  provider: ProviderKind;
  /** "GitHub" / "GitLab", and the source's host: messages name both ("No GitLab token for gitlab.example.com"). */
  name: 'GitHub' | 'GitLab';
  host: string;
  /** "GitHub" for github.com, else "GitLab (gitlab.example.com)": what logs and errors call the source. */
  label: string;
  /** The variable that, when set, is the token and locks the choice (GITHUB_TOKEN, a GitLab source's tokenEnv). */
  envVar: string | null;
  /** Where the token file is configured, for "No token file is configured (…)". */
  fileSetting: string;
  /** Why there is no token when nothing is chosen ("connect a GitHub account in Settings"). */
  noTokenHint: string;
  /** Why there is no token under `auto` with no token file, when the CLI isn't used in `auto`. */
  notConfigured: string;
  /** Shown as the token's error after the provider rejected it (401). */
  rejected: string;
  /** What to do when the provider rejects the token, after the provider's message ("check GITHUB_TOKEN or …"). */
  authHint: string;
  /** Prefix of every log line ("[token]"). */
  logPrefix: string;
  cli: CliSpec | null;
  /** The kind from the token's prefix alone. */
  kind(token: string): TokenKind;
  /** Asks the provider who the token is for. May reject; the provider turns that into an error. */
  validate(token: string, signal: AbortSignal): Promise<TokenCheck>;
  /** Extra log lines after a successful validation (an expiry close by, write scopes); none by default. */
  notes?(check: Validation, now: number): string[];
}
