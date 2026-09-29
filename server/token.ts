// github.com's token provider: CredentialProvider over githubSpec, with the AccountStatus the /account routes and the
// desktop app speak. The resolution machinery is server/credentials/provider.ts; GitHub's own parts are
// server/github/credentials.ts.

import type { AccountStatus, TokenChoice } from '../shared/api';
import { type CredentialOptions, CredentialProvider, type CredentialSnapshot } from './credentials/provider';
import type { Exec, ResolvedToken, TokenFs, TokenSupply } from './credentials/types';
import { githubSpec } from './github/credentials';

export { noTokenMessage, TOKEN_CACHE_MS } from './credentials/provider';
export type { Exec, ExecResult, ResolvedToken, TokenFs, TokenSupply } from './credentials/types';
export { ghLoginFromHosts, parseTokenExpiration, tokenKind } from './github/credentials';

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

export interface GhInfo {
  available: boolean;
  path: string | null;
  login: string | null;
}

/**
 * Where the GitHub token comes from, shared by the sync, the diff service and the account routes.
 *
 * GITHUB_TOKEN in the environment always wins (and locks the choice). Otherwise the choice decides: `auto` (the
 * headless default) is the token file if one is configured, else gh; `gh` and `file` are just that source; `app` is the
 * token the desktop app pushed (setAppToken); null (the desktop default) is no token. There is no silent fallback
 * from a configured source to another. Results are cached for about 30 s; `check()` validates against GitHub.
 *
 * `credentials` is the same provider as a generic CredentialProvider (SourceAccount), for the per-source code.
 */
export class TokenProvider implements TokenSupply {
  readonly credentials: CredentialProvider;

  constructor(opts: TokenProviderOptions) {
    const { ghPath, fetchImpl, ...rest } = opts;
    const options: CredentialOptions = rest;
    this.credentials = new CredentialProvider(githubSpec({ ghPath, fetchImpl, now: opts.now }), options);
  }

  get(opts: { fresh?: boolean } = {}): Promise<ResolvedToken> {
    return this.credentials.get(opts);
  }

  peek(): ResolvedToken {
    return this.credentials.peek();
  }

  invalidate(token?: string): void {
    this.credentials.invalidate(token);
  }

  onChange(listener: (token: ResolvedToken) => void): () => void {
    return this.credentials.onChange(listener);
  }

  getChoice(): TokenChoice | null {
    return this.credentials.getChoice();
  }

  setChoice(choice: TokenChoice | null): void {
    this.credentials.setChoice(choice);
  }

  /** The token the desktop app holds (pasted, or remembered in the OS keychain); null forgets it. */
  setAppToken(token: string | null): void {
    this.credentials.setAppToken(token);
  }

  /**
   * The account behind the current token as last resolved and validated. Never calls GitHub, so it can be polled:
   * only the first resolution is waited for; after that a stale token is re-resolved in the background (at most every
   * 30 s), and a new token is validated in the background when it turns up.
   */
  async account(): Promise<AccountStatus> {
    return accountStatus(await this.credentials.snapshot());
  }

  /** Re-resolves the token now and validates it against GitHub (1 GraphQL point): startup, Retry and set-token. */
  async check(): Promise<AccountStatus> {
    return accountStatus(await this.credentials.recheck());
  }
}

function accountStatus(s: CredentialSnapshot): AccountStatus {
  const v = s.validation;
  const repos = v?.repos;
  return {
    source: s.resolved.source,
    choice: s.choice,
    locked: s.locked,
    login: v?.login ?? null,
    name: v?.name ?? null,
    avatarUrl: v?.avatarUrl ?? null,
    dbLogin: s.dbLogin,
    mismatch: s.mismatch,
    kind: s.kind,
    expiresAt: v?.expiresAt ?? null,
    scopes: v?.scopes ?? null,
    repos: repos && repos.private !== null ? { total: repos.total, private: repos.private } : null,
    error: s.resolved.error ?? v?.error ?? null,
    gh: s.resolved.cli,
    tokenFile: s.tokenFile,
    checkedAt: v?.checkedAt ?? null,
  };
}
