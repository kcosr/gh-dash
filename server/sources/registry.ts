// The one runtime object for sources (design §3.1): for github.com and every GitLab source, its token supply and the
// factories for its provider clients. Built at startup from the config, and rebuilt on the desktop app's
// `reload-sources`, without a restart.
//
// Who uses what (the steps are the design's §11):
// - tokens (CredentialProvider: TokenSupply + account() + check()): startup's check() here; the manager's per-source
//   runs (5); tracking (6); diffs' 503 text (7); /sources and Settings → Sources (8, 11).
// - syncSource(token): runSync's `source`, per source run of the multi-source manager (5); tracking's candidates() and
//   lookup() (6). github.com's is null for now: the manager builds its GitHubSyncSource itself until step 5 moves that
//   here.
// - diffs (DiffSources): the diff service, routed by the repo's source (7). github.com's is the GitHubDiffSources the
//   diff service already uses.
// - byHost / byId / list / configured: the manager (5), tracking (6), diffs (7), the API (8), the desktop child (11).
// - setAppToken(host): the desktop app's set-token for a source (11). apply(): startup, reload-sources, and after
//   removeSource (8).

import type { ProviderKind, SourceAccount } from '../../shared/api';
import { CredentialProvider, type CredentialOptions } from '../credentials/provider';
import type { ResolvedToken } from '../credentials/types';
import type { Db } from '../db/db';
import { ensureSource, GITHUB_SOURCE_ID, getSource, listSources, sourceByHost, type SourceRow } from '../db/sources';
import type { DiffSources } from '../diff/service';
import { gitlabSpec } from '../gitlab/credentials';
import { GitLabDiffSources } from '../gitlab/diff-source';
import { GitLabSyncSource } from '../gitlab/sync-source';
import { defaultSleep } from '../provider/transport';
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
   * A sync client for one token. A 401 invalidates that token, so the next get() resolves again. null for github.com,
   * whose GitHubSyncSource the manager builds itself until step 5.
   */
  readonly syncSource: ((token: string) => SyncSource) | null;
  /** Its diff and file-content client for the current token. */
  readonly diffs: DiffSources;
}

export interface SourceRegistryOptions {
  db: Db;
  /** The merged environment (token variables, PATH and HOME for glab). */
  env: NodeJS.ProcessEnv;
  /** github.com's parts, which startServer builds: TokenProvider.credentials and the diff service's GitHubDiffSources. */
  github: { tokens: CredentialProvider; diffs: DiffSources };
  log?: (line: string) => void;
  /** Test seams for GitLab sources' credential providers and clients. */
  seams?: Pick<CredentialOptions, 'platform' | 'exec' | 'fs' | 'now'> & { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
}

/** What a GitLab runtime was built from: a change rebuilds it (a provider can't be reconfigured in place). */
function recipe(row: SourceRow, config: SourceConfig | null, glabPath: string | null): string {
  return JSON.stringify({ baseUrl: row.baseUrl, config, glabPath: config ? glabPath : null });
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
 * database may still configure one) and builds or rebuilds one runtime per source.
 */
export class SourceRegistry {
  private readonly db: Db;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly seams: NonNullable<SourceRegistryOptions['seams']>;
  private readonly githubRuntime: SourceRuntime;
  private readonly runtimes = new Map<number, Built>();
  private readonly listeners = new Set<(runtime: SourceRuntime, token: ResolvedToken) => void>();
  /** Tokens the desktop app pushed, by host: kept across rebuilds of that source's provider. */
  private readonly appTokens = new Map<string, string>();
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
      syncSource: null,
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
    const byHost = new Map(next.sources.map((c) => [c.host, c]));
    const built: SourceRuntime[] = [];
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const config = byHost.get(row.host) ?? null;
      const want = recipe(row, config, next.glabPath);
      const had = this.runtimes.get(row.id);
      if (had?.recipe === want) continue;
      had?.unsubscribe();
      const b = this.build(row, config, next.glabPath, want);
      this.runtimes.set(row.id, b);
      built.push(b.runtime);
      this.log(`[sources] ${b.runtime.label} ${config ? `at ${row.baseUrl} · ${describe(config, this.env)}` : 'is in the database but not configured on this server'}`);
    }
    for (const [id, b] of this.runtimes) {
      if (seen.has(id)) continue;
      b.unsubscribe();
      this.runtimes.delete(id);
    }
    return built;
  }

  /** github.com first, then the others by id. */
  list(): SourceRuntime[] {
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
    return id === GITHUB_SOURCE_ID ? this.githubRuntime : (this.runtimes.get(id)?.runtime ?? null);
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
   * Kept across rebuilds of the source's provider. github.com's goes through TokenProvider.setAppToken, as before.
   */
  setAppToken(host: string, token: string | null): SourceRuntime | null {
    const runtime = this.byHost(host);
    if (!runtime || runtime.id === GITHUB_SOURCE_ID) return null;
    const value = token?.trim() || null;
    if (value) this.appTokens.set(runtime.host, value);
    else this.appTokens.delete(runtime.host);
    runtime.tokens.setAppToken(value);
    return runtime;
  }

  /** Called when any source's token or its origin changes, including in providers built later. */
  onChange(listener: (runtime: SourceRuntime, token: ResolvedToken) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    if (config && this.appTokens.has(row.host)) tokens.setAppToken(this.appTokens.get(row.host)!);
    const db = this.db;
    const last = { row };
    const baseUrl = row.baseUrl;
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
      syncSource: (token) =>
        new GitLabSyncSource({
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
      diffs: new GitLabDiffSources({ baseUrl, tokens, fetchImpl, sleep }),
    };
    const unsubscribe = tokens.onChange((token) => this.emit(runtime, token));
    return { runtime, recipe: want, unsubscribe };
  }
}
