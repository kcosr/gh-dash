// The one runtime object for sources (design §3.1): for github.com and every GitLab source, its token supply and the
// factories for its provider clients. Built at startup from the config, and rebuilt on the desktop app's
// `reload-sources`, without a restart.
//
// Who uses what (the steps are the design's §11):
// - tokens (CredentialProvider: TokenSupply + account() + check()): startup's check() here; the manager's per-source
//   runs (5); tracking (6); diffs' 503 text (7); /sources and Settings → Sources (8, 11).
// - syncSource(token, limits?): runSync's `source` per source run of the multi-source manager (5), and its viewer
//   checks; tracking's candidates() and lookup() (6), with few retries and short waits. github.com's is
//   githubSyncSource (tracking still builds its own GitHub client, over the fetch and sleep it is given).
// - diffs (SourceDiffSupply): the diff service, through DiffRouter (sources/diffs.ts), which asks the repo's source's.
//   github.com's is the GitHubDiffSources startServer builds.
// - byHost / byId / list / configured: the manager (5), tracking (6), diffs (7), the API (8), the desktop child (11).
//   Each first catches up with sources another instance sharing the database added or removed.
// - setAppToken(host): the desktop app's set-token for a source (11). apply(): startup, reload-sources, and after
//   removeSource (8).

import type { ProviderKind, SourceAccount } from '../../shared/api';
import { CredentialProvider, type CredentialOptions } from '../credentials/provider';
import type { ResolvedToken, TokenSupply } from '../credentials/types';
import type { Db } from '../db/db';
import { ensureSource, GITHUB_SOURCE_ID, getSource, listSources, setSourceRateLimit, sourceByHost, type SourceRow } from '../db/sources';
import type { SourceDiffSupply } from '../diff/service';
import { tokenKind } from '../github/credentials';
import { GitHubSyncSource } from '../github/sync-source';
import { gitlabSpec } from '../gitlab/credentials';
import { GitLabDiffSources } from '../gitlab/diff-source';
import { GitLabSyncSource } from '../gitlab/sync-source';
import { defaultSleep, type RetryLimits } from '../provider/transport';
import type { SyncSource } from '../provider/types';
import type { SourceConfig, SourcesConfig } from './config';

/** One source as this instance runs it. */
export interface SourceRuntime {
  readonly id: number;
  readonly kind: ProviderKind;
  /** The source's identity: 'github.com', 'gitlab.example.com'. */
  readonly host: string;
  /** What logs and errors call it: 'GitHub', 'GitLab (gitlab.example.com)'. */
  readonly label: string;
  /** Its row, read fresh (viewer, last sync and rate limit change while running). */
  readonly row: SourceRow;
  /** Whether this instance can sync it: github.com always; a GitLab source when this instance's config names it. */
  readonly configured: boolean;
  /**
   * How this instance reaches it; null for github.com (its settings are Config's tokenChoice, tokenFile and ghPath)
   * and for a source that is in the database but not configured here ("not configured on this server").
   */
  readonly config: SourceConfig | null;
  /** Where its token comes from. An unconfigured source's never has one, and says so. */
  readonly tokens: CredentialProvider;
  /**
   * A sync client for one token. A 401 invalidates that token, so the next get() resolves again. `limits` replaces the
   * client's retry defaults (the sync's: several attempts, long waits), for a person waiting on the answer.
   */
  readonly syncSource: (token: string, limits?: RetryLimits) => SyncSource;
  /** Its diff and file-content client for the current token. */
  readonly diffs: SourceDiffSupply;
}

export interface SourceRegistryOptions {
  db: Db;
  /** The merged environment (token variables, PATH and HOME for glab). */
  env: NodeJS.ProcessEnv;
  /**
   * github.com's parts, which startServer builds: TokenProvider.credentials and the diff service's GitHubDiffSources;
   * `fetchImpl` is its sync clients' transport (tests; default: the global fetch, looked up on each call).
   */
  github: { tokens: CredentialProvider; diffs: SourceDiffSupply; fetchImpl?: typeof fetch };
  log?: (line: string) => void;
  /** Test seams for GitLab sources' credential providers and clients. */
  seams?: Pick<CredentialOptions, 'platform' | 'exec' | 'fs' | 'now'> & { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
}

/**
 * Where this instance sends a source's requests: the configured URL for a source its config names, which is what the
 * credentials are for. The row's URL is what another instance last configured (it may have recreated the row), and
 * only stands in for a source not configured here, which never has a token.
 */
function reachedAt(row: SourceRow, config: SourceConfig | null): string {
  return config ? config.baseUrl : row.baseUrl;
}

/** What a GitLab runtime was built from: a change rebuilds it (a provider can't be reconfigured in place). */
function recipe(row: SourceRow, config: SourceConfig | null, glabPath: string | null): string {
  return JSON.stringify({ baseUrl: reachedAt(row, config), config, glabPath: config ? glabPath : null });
}

/** "glab", "file", "GITLAB_TOKEN (locked)", "not chosen": how the source's token is found, without the token. */
function describe(config: SourceConfig, env: NodeJS.ProcessEnv): string {
  const locked = config.tokenEnv !== null && !!env[config.tokenEnv]?.trim();
  const method = locked ? `${config.tokenEnv} (locked)` : config.tokenChoice === null ? 'not chosen' : config.tokenChoice === 'auto' ? (config.tokenFile ? 'file' : 'not configured') : config.tokenChoice;
  return `token: ${method}${config.from === 'env' ? ' · from env' : ''}`;
}

interface Built {
  runtime: SourceRuntime;
  recipe: string;
  unsubscribe: () => void;
}

/**
 * github.com's sync clients, one per token (what the sync manager built before sources): a 401 invalidates the token,
 * so the next get() resolves again; the rate limit GitHub reports is written to source 1 as it comes; and the access
 * hints follow the token's kind. `fetchImpl` defaults to the global fetch, looked up on each call.
 */
export function githubSyncSource(
  db: Db,
  tokens: Pick<TokenSupply, 'invalidate'>,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): (token: string, limits?: RetryLimits) => GitHubSyncSource {
  return (token, limits = {}) =>
    new GitHubSyncSource({
      ...limits,
      token,
      fetchImpl: async (input, init) => {
        const res = await fetchImpl(input, init);
        if (res.status === 401) tokens.invalidate(token);
        return res;
      },
      onRateLimit: (rl) => setSourceRateLimit(db, GITHUB_SOURCE_ID, rl),
      tokenKind: tokenKind(token),
    });
}

/** A CredentialProvider for a GitLab source as configured: what the registry builds, and what a draft test can use. */
export function gitlabCredentials(
  config: Pick<SourceConfig, 'host' | 'baseUrl' | 'tokenChoice' | 'tokenFile' | 'tokenEnv'>,
  glabPath: string | null,
  opts: Omit<CredentialOptions, 'choice' | 'tokenFile'> & { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): CredentialProvider {
  const { fetchImpl, sleep, ...rest } = opts;
  const spec = gitlabSpec({ host: config.host, baseUrl: config.baseUrl }, { tokenEnv: config.tokenEnv, glabPath, fetchImpl, sleep });
  return new CredentialProvider(spec, { ...rest, choice: config.tokenChoice, tokenFile: config.tokenFile });
}

/**
 * Every source this database knows, as this instance runs them. apply() reconciles the config with the sources table
 * (ensureSource: an insert, or a refresh of base_url; rows are never deleted here, since another instance sharing the
 * database may still configure one) and builds or rebuilds one runtime per source. Lookups (list, configured, byId,
 * byHost) first catch up with the rows another instance added or removed since, without writing.
 */
export class SourceRegistry {
  private readonly db: Db;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly seams: NonNullable<SourceRegistryOptions['seams']>;
  private readonly githubRuntime: SourceRuntime;
  private readonly runtimes = new Map<number, Built>();
  private readonly listeners = new Set<(runtime: SourceRuntime, token: ResolvedToken) => void>();
  /**
   * Tokens the desktop app pushed, by source id: kept across rebuilds of that source's provider, and forgotten with its
   * runtime. A host removed and added again is a new source, which may be for another account: it waits for its own.
   */
  private readonly appTokens = new Map<number, string>();
  private current: SourcesConfig = { glabPath: null, sources: [] };

  constructor(opts: SourceRegistryOptions) {
    this.db = opts.db;
    this.env = opts.env;
    this.log = opts.log ?? ((line) => console.log(line));
    this.seams = opts.seams ?? {};
    const db = this.db;
    const last = { row: getSource(db, GITHUB_SOURCE_ID)! };
    const runtime: SourceRuntime = {
      id: GITHUB_SOURCE_ID,
      kind: 'github',
      host: last.row.host,
      label: opts.github.tokens.label,
      get row() {
        return (last.row = getSource(db, GITHUB_SOURCE_ID) ?? last.row);
      },
      configured: true,
      config: null,
      tokens: opts.github.tokens,
      syncSource: githubSyncSource(db, opts.github.tokens, opts.github.fetchImpl),
      diffs: opts.github.diffs,
    };
    this.githubRuntime = runtime;
    opts.github.tokens.onChange((token) => this.emit(runtime, token));
  }

  /** The config last applied. */
  get config(): SourcesConfig {
    return this.current;
  }

  /**
   * Reconciles `next` (default: the config last applied, say after removeSource) with the sources table, then builds
   * a runtime for each new source and rebuilds those whose URL or credential settings changed; the others are kept,
   * token cache and all. Returns the runtimes built, which the caller may check(). All or nothing: a host already
   * stored for another kind throws, and nothing changes.
   */
  apply(next: SourcesConfig = this.current): SourceRuntime[] {
    // Writes only what changed: an unchanged config (every GitHub-only startup) takes no write lock.
    const stale = next.sources.filter((c) => {
      const row = sourceByHost(this.db, c.host);
      return !row || row.kind !== c.kind || row.baseUrl !== c.baseUrl;
    });
    if (stale.length) this.db.tx(() => stale.forEach((c) => ensureSource(this.db, { kind: c.kind, host: c.host, baseUrl: c.baseUrl })));
    const rows = listSources(this.db).filter((r) => r.id !== GITHUB_SOURCE_ID);
    this.current = next;
    const built: SourceRuntime[] = [];
    const live = new Set(rows.map((r) => r.id));
    for (const id of [...this.runtimes.keys()]) if (!live.has(id)) this.drop(id);
    for (const row of rows) {
      const config = this.configFor(row.host);
      const had = this.runtimes.get(row.id);
      if (had?.recipe === recipe(row, config, next.glabPath)) continue;
      built.push(this.install(row, config));
    }
    return built;
  }

  /** github.com first, then the others by id. */
  list(): SourceRuntime[] {
    this.reconcile();
    return [this.githubRuntime, ...[...this.runtimes.values()].map((b) => b.runtime).sort((a, b) => a.id - b.id)];
  }

  /** The sources this instance can sync: github.com, and the GitLab sources its config names. */
  configured(): SourceRuntime[] {
    return this.list().filter((r) => r.configured);
  }

  github(): SourceRuntime {
    return this.githubRuntime;
  }

  byId(id: number): SourceRuntime | null {
    if (id === GITHUB_SOURCE_ID) return this.githubRuntime;
    this.reconcile();
    return this.runtimes.get(id)?.runtime ?? null;
  }

  byHost(host: string): SourceRuntime | null {
    const h = host.toLowerCase();
    return this.list().find((r) => r.host === h) ?? null;
  }

  /**
   * Re-resolves and validates the tokens of `runtimes` (default: every configured source but github.com, whose
   * TokenProvider startServer checks itself). Each provider logs who the token is for, and then its notes: an expiry
   * within EXPIRY_WARN_DAYS, and scopes that can change things. Never rejects.
   */
  check(runtimes: SourceRuntime[] = this.configured().filter((r) => r.id !== GITHUB_SOURCE_ID)): Promise<SourceAccount[]> {
    return Promise.all(runtimes.filter((r) => r.configured).map((r) => r.tokens.check()));
  }

  /**
   * The token the desktop app holds for a GitLab source (pasted, or remembered in the OS keychain); null forgets it.
   * Kept across rebuilds of the source's provider, for that source only: a host without a runtime (not in the
   * database) has no token to keep or forget, and returns null. github.com's goes through TokenProvider.setAppToken,
   * as before.
   */
  setAppToken(host: string, token: string | null): SourceRuntime | null {
    const runtime = this.byHost(host);
    if (!runtime || runtime.id === GITHUB_SOURCE_ID) return null;
    const value = token?.trim() || null;
    if (value) this.appTokens.set(runtime.id, value);
    else this.appTokens.delete(runtime.id);
    runtime.tokens.setAppToken(value);
    return runtime;
  }

  /**
   * A throwaway credential provider for a source as `draft` would configure it: the desktop app tests a source with it
   * before adding it, and a new method before switching to it. Built as apply() would build it (this registry's
   * environment, glab path and seams), and compared with the account this database has on that host, if any. Not
   * applied and not kept: nothing else ever sees it.
   */
  draft(draft: Pick<SourceConfig, 'host' | 'baseUrl' | 'tokenChoice' | 'tokenFile' | 'tokenEnv'>): CredentialProvider {
    const { fetchImpl = fetch, sleep = defaultSleep, ...seams } = this.seams;
    const db = this.db;
    const viewer = () => {
      const row = sourceByHost(db, draft.host);
      return row && row.kind === 'gitlab' ? row.viewer : null;
    };
    return gitlabCredentials(draft, this.current.glabPath, { env: this.env, viewer, log: this.log, fetchImpl, sleep, ...seams });
  }

  /** Called when any source's token or its origin changes, including in providers built later. */
  onChange(listener: (runtime: SourceRuntime, token: ResolvedToken) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Brings the runtimes in line with the sources table before a lookup, as another instance sharing the database may
   * have added or removed a source since apply(): a new row gets a runtime (configured when this instance's config
   * names its host), and a runtime whose row is gone is dropped, so it is neither listed nor synced. One small SELECT
   * (ids are never reused: AUTOINCREMENT); a new row is read in full once. Never writes: a source this config names
   * whose row was removed waits for the next apply() to be added again.
   */
  private reconcile(): void {
    const ids = this.db.all<{ id: number }>('SELECT id FROM sources WHERE id <> ?', [GITHUB_SOURCE_ID]).map((r) => r.id);
    const live = new Set(ids);
    for (const id of [...this.runtimes.keys()]) {
      if (live.has(id)) continue;
      this.log(`[sources] ${this.runtimes.get(id)!.runtime.label} is no longer in the database`);
      this.drop(id);
    }
    for (const id of ids) {
      if (this.runtimes.has(id)) continue;
      const row = getSource(this.db, id);
      if (row) this.install(row, this.configFor(row.host));
    }
  }

  private configFor(host: string): SourceConfig | null {
    return this.current.sources.find((c) => c.host === host) ?? null;
  }

  /** Builds the runtime for `row` (replacing any it had) and says how it is reached. */
  private install(row: SourceRow, config: SourceConfig | null): SourceRuntime {
    this.runtimes.get(row.id)?.unsubscribe();
    const b = this.build(row, config, this.current.glabPath, recipe(row, config, this.current.glabPath));
    this.runtimes.set(row.id, b);
    this.log(`[sources] ${b.runtime.label} ${config ? `at ${config.baseUrl} · ${describe(config, this.env)}` : 'is in the database but not configured on this server'}`);
    return b.runtime;
  }

  /** Forgets a source that left the database, with the app token it held. */
  private drop(id: number): void {
    this.runtimes.get(id)?.unsubscribe();
    this.runtimes.delete(id);
    this.appTokens.delete(id);
  }

  private emit(runtime: SourceRuntime, token: ResolvedToken): void {
    for (const listener of this.listeners) {
      try {
        listener(runtime, token);
      } catch (err) {
        this.log(`[sources] change listener failed: ${(err as Error).message}`);
      }
    }
  }

  private build(row: SourceRow, config: SourceConfig | null, glabPath: string | null, want: string): Built {
    const { fetchImpl = fetch, sleep = defaultSleep, ...seams } = this.seams;
    const base = { env: this.env, viewer: () => getSource(this.db, row.id)?.viewer ?? null, log: this.log, fetchImpl, sleep, ...seams };
    // Not configured here: no method, no env lock and no glab, so it never has a token, and the message says why.
    const tokens = config
      ? gitlabCredentials(config, glabPath, base)
      : new CredentialProvider(
          { ...gitlabSpec(row, { tokenEnv: null, glabPath: null }), cli: null, noTokenHint: "it isn't configured on this server" },
          { ...base, choice: null },
        );
    const appToken = this.appTokens.get(row.id);
    if (config && appToken) tokens.setAppToken(appToken);
    const db = this.db;
    const last = { row };
    // The sync and diff clients carry the token: never to another URL than the one its credentials are configured for.
    const baseUrl = reachedAt(row, config);
    const runtime: SourceRuntime = {
      id: row.id,
      kind: row.kind,
      host: row.host,
      label: tokens.label,
      get row() {
        return (last.row = getSource(db, row.id) ?? last.row);
      },
      configured: config !== null,
      config,
      tokens,
      syncSource: (token, limits = {}) =>
        new GitLabSyncSource({
          ...limits,
          baseUrl,
          token,
          // A 401 means the token was revoked or replaced: resolve it again before the next use.
          fetchImpl: async (input, init) => {
            const res = await fetchImpl(input, init);
            if (res.status === 401) tokens.invalidate(token);
            return res;
          },
          sleep,
        }),
      diffs: new GitLabDiffSources({ baseUrl, tokens, authHint: tokens.spec.authHint, fetchImpl, sleep }),
    };
    const unsubscribe = tokens.onChange((token) => this.emit(runtime, token));
    return { runtime, recipe: want, unsubscribe };
  }
}
