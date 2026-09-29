// Adding repositories of other owners, on any source: the candidates the token can read, a lookup that checks access
// and sizes the first sync, and the add itself. The requests are the source's (SyncSource.candidates and lookup), made
// for the person waiting on them: few retries, no long waits. Nothing here syncs; an add hands the repo to the sync
// manager.
//
// Which source: the `source` parameter (a host; github.com when absent), unless the input is an address or key on
// another source's host, which wins (a GitLab URL pasted while GitHub is selected). A host that isn't a source here, or
// isn't configured on this server, is a 400 that names it.

import { GITHUB_HOST, type AddRepoResponse, type RepoCandidate, type RepoCandidatesResponse, type RepoLookup, type RepoPreview, type TrackedBy } from '../../shared/api';
import { inputHost, parseGitHubInput, parseGitLabInput } from '../../shared/repos';
import { HttpError } from '../lib/errors';
import type { Db } from '../db/db';
import { resolveRepo, resolveRepoOn } from '../db/repo-key';
import { getRepo, removeRepo } from '../db/repos';
import { getSettings } from '../db/settings';
import { GITHUB_SOURCE_ID, getSource, setSourceRateLimit, sourceByHost, sourceKey, tryClaimViewer, viewerMismatch, type SourceRef } from '../db/sources';
import { addManual, applyProbe } from '../db/write';
import { GitHubSyncSource } from '../github/sync-source';
import { DAY_MS, isoSec } from '../lib/time';
import { SourceError } from '../provider/errors';
import { defaultSleep, type RetryLimits } from '../provider/transport';
import type { LookupRecord, RepoCandidateRecord, SyncSource, ViewerInfo } from '../provider/types';
import { reachedAt, type SourceRegistry } from '../sources/registry';
import { noTokenMessage, tokenKind, type ResolvedToken, type TokenSupply } from '../token';

/** How long the candidate lists are reused (the Add dialog filters them locally as you type). */
const CANDIDATES_TTL_MS = 5 * 60_000;
/** A person is waiting on every request here: few retries, no long waits. */
const INTERACTIVE: RetryLimits = { maxAttempts: 2, maxRetryWaitMs: 10_000 };

/** The 400 for a host that names no source in this database. */
export const notASource = (host: string) => `${host} isn't a source here.`;

/**
 * Stops tracking a repository added by hand: deletes its pull requests, issues, commits, releases and stars, its set
 * memberships and its cached diffs. Nothing changes on the code host. `input` is the repo's key (or an owned github.com
 * repo's short name); with `source` (a host) it may also be the repo's path there, and the repo must be on that source.
 * 400 for a host that isn't a source here, 404 for an unknown repo, 409 for one the viewer owns (hide it instead). A
 * source that isn't configured on this server still has its repos removed: that needs no token.
 */
export function removeTrackedRepo(deps: { db: Db; diffs: { evict(): void } }, input: string, source?: string): void {
  const { db } = deps;
  const src = source === undefined ? null : sourceByHost(db, source);
  if (source !== undefined && !src) throw new HttpError(400, notASource(source.toLowerCase()));
  const ref = src ? resolveRepoOn(db, input, src) : resolveRepo(db, input);
  if (!ref) throw new HttpError(404, 'Repository not found');
  if (ref.trackedBy === 'owned') {
    throw new HttpError(409, 'Repositories you own are tracked automatically; hide it instead.', { key: ref.key, trackedBy: 'owned' });
  }
  // TODO(diff-comments): once comments exist, the Remove confirmation shows how many of the user's comments go with
  // the repo (the user decided: show the count, then delete). Add Repo.commentCount; the cascade already deletes them.
  removeRepo(db, ref.id);
  deps.diffs.evict();
}

/** The Sync manager's part: start a just-added repo's first sync, or queue it. */
export interface FirstSync {
  /**
   * `source` is the repo's source (a host). A source this instance doesn't sync answers 'queued' (the instance that
   * syncs it picks the repo up).
   */
  startOrQueue(req: { repo: string; source: string }): Promise<'started' | 'queued'>;
}

export interface TrackingOptions {
  db: Db;
  /** github.com's token, shared with the sync and the diffs. */
  tokens: TokenSupply;
  /** The other sources (GitLab), by host, with their tokens and clients; without it, github.com is the only one. */
  sources?: SourceRegistry;
  sync: FirstSync;
  /** Timezone of the returned Repo's weekly stats (the server's default). */
  tz: string;
  /** github.com's transport (tests). */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** One source as the tracking API reaches it. */
interface Reach extends SourceRef {
  /** What errors call it: 'GitHub', 'GitLab (gitlab.example.com)'. */
  label: string;
  tokens: TokenSupply;
  /** The 503 without a token. */
  noToken(resolved: ResolvedToken): string;
  /** How to fix a token the provider rejects, appended to the 503. */
  authHint: string;
  /** The provider path `input` names on this source, or null when it names none. */
  parse(input: string): string | null;
  /** The 400 for input `parse` refuses. */
  refuse(input: string): string;
  /** A client for `token`, for a person waiting on it. */
  open(token: string): SyncSource;
}

/** A source's candidate lists, for the token they were fetched with and the account the source said it belongs to. */
interface Cached {
  token: string;
  viewer: ViewerInfo;
  at: number;
  fetchedAt: string;
  items: RepoCandidateRecord[];
  suggested: RepoCandidateRecord[];
  truncated: boolean;
}

/** A lookup of a repository the token can read. */
type Readable = Extract<LookupRecord, { ok: true }>;

interface Looked {
  reach: Reach;
  /** The backfill start the counts are from. */
  since: string;
  result: LookupRecord;
  /** About how many requests its first sync costs (the source's estimate), when it can be read. */
  requests: number | null;
}

export class Tracking {
  private readonly opts: TrackingOptions;
  private readonly cached = new Map<number, Cached>();

  constructor(opts: TrackingOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The source named by `host` (default github.com); 400 when there is none, or it isn't configured on this server. */
  private reach(host: string = GITHUB_HOST): Reach {
    const h = host.trim().toLowerCase();
    if (h === GITHUB_HOST) return this.github();
    const runtime = this.opts.sources?.byHost(h) ?? null;
    if (!runtime) throw new HttpError(400, notASource(h));
    const open = runtime.syncSource;
    if (!runtime.configured) throw new HttpError(400, `${runtime.label} isn't configured on this server.`);
    // Every source but github.com is a GitLab instance in this wave. Pasted URLs are read against the URL its client
    // uses (the configured one), not the one another instance may have stored.
    const baseUrl = reachedAt(runtime.row, runtime.config);
    return {
      id: runtime.id,
      host: runtime.host,
      label: runtime.label,
      tokens: runtime.tokens,
      noToken: (resolved) => runtime.tokens.noTokenMessage(resolved),
      authHint: runtime.tokens.spec.authHint,
      parse: (input) => parseGitLabInput(input, { host: runtime.host, baseUrl })?.path ?? null,
      refuse: (input) => `Not a GitLab project: "${input.slice(0, 200)}". Enter group/project or a ${runtime.host} URL.`,
      // The registry's client (its 401 invalidates the token), with few retries and no long waits.
      open: (token) => open(token, INTERACTIVE),
    };
  }

  /** Every source's host (configured here or not): a key's first segment that is one of them names that source. */
  private hosts(): string[] {
    return this.opts.sources?.list().map((r) => r.host) ?? [GITHUB_HOST];
  }

  private github(): Reach {
    const { tokens, fetchImpl = fetch, sleep = defaultSleep } = this.opts;
    return {
      id: GITHUB_SOURCE_ID,
      host: GITHUB_HOST,
      label: 'GitHub',
      tokens,
      noToken: (resolved) => noTokenMessage(resolved),
      authHint: 'check GITHUB_TOKEN or run `gh auth login`',
      parse: (input) => {
        const p = parseGitHubInput(input);
        return p ? `${p.owner}/${p.name}` : null;
      },
      refuse: (input) => `Not a GitHub repository: "${input.slice(0, 200)}". Enter owner/name or a github.com URL.`,
      open: (token) =>
        new GitHubSyncSource({
          token,
          sleep,
          ...INTERACTIVE,
          tokenKind: tokenKind(token),
          // A 401 means the token was revoked or replaced: resolve it again before the next use.
          fetchImpl: async (input, init) => {
            const res = await fetchImpl(input, init);
            if (res.status === 401) tokens.invalidate(token);
            return res;
          },
        }),
    };
  }

  /** The source's current token (503 without one). */
  private async token(reach: Reach): Promise<string> {
    const resolved = await reach.tokens.get();
    if (!resolved.token) throw new HttpError(503, reach.noToken(resolved));
    return resolved.token;
  }

  /**
   * Runs `fn` on a client for `token`: provider failures become API errors, and the rate limit the provider reported
   * (lookups spend GitHub's GraphQL points too) is kept current for the header.
   */
  private async call<T>(reach: Reach, token: string, fn: (source: SyncSource) => Promise<T>): Promise<T> {
    const source = reach.open(token);
    try {
      return await fn(source);
    } catch (err) {
      throw httpError(err, reach);
    } finally {
      const rl = source.rateLimit;
      if (rl?.resetAt) setSourceRateLimit(this.opts.db, reach.id, { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt });
    }
  }

  /** The viewer must be the source's claimed account: results for another one would be wrong here (409). */
  private checkViewer(reach: Reach, viewer: ViewerInfo): void {
    const mismatch = viewerMismatch(getSource(this.opts.db, reach.id)!, viewer);
    if (mismatch) throw new HttpError(409, mismatch);
  }

  /** How each live repo of the source with one of these node ids is tracked. */
  private trackedBy(reach: Reach, nodeIds: string[]): Map<string, { trackedBy: TrackedBy; hidden: boolean }> {
    const rows = this.opts.db.all<{ node_id: string; tracked_by: string; hidden: number }>(
      'SELECT node_id, tracked_by, hidden FROM repos WHERE source_id = ? AND removed_at IS NULL AND node_id IN (SELECT value FROM json_each(?))',
      [reach.id, JSON.stringify(nodeIds)],
    );
    return new Map(rows.map((r) => [r.node_id, { trackedBy: r.tracked_by === 'manual' ? 'manual' : 'owned', hidden: !!r.hidden }]));
  }

  /**
   * The token's repositories of others on a source (most recently active first, up to 1000) and a few suggested ones
   * that aren't tracked yet. Cached for 5 minutes per source and token; `refresh` asks again. Cost: GitHub, up to 10
   * REST requests and 1 GraphQL point; GitLab, up to 10 REST requests and 1 GraphQL request.
   */
  async candidates(opts: { refresh?: boolean; source?: string } = {}): Promise<RepoCandidatesResponse> {
    const reach = this.reach(opts.source);
    const token = await this.token(reach);
    let list = this.cached.get(reach.id);
    if (opts.refresh || !list || list.token !== token || this.now() - list.at > CANDIDATES_TTL_MS) {
      const found = await this.call(reach, token, (source) => source.candidates());
      list = { token, viewer: found.viewer, at: this.now(), fetchedAt: new Date(this.now()).toISOString(), items: found.items, suggested: found.suggested, truncated: found.truncated };
      this.cached.set(reach.id, list);
    }
    // On every answer, cached ones too: the database may have been claimed by another account since they were fetched.
    this.checkViewer(reach, list.viewer);
    const tracked = this.trackedBy(reach, [...list.items, ...list.suggested].map((r) => r.nodeId));
    const out = (r: RepoCandidateRecord): RepoCandidate => ({
      key: sourceKey(reach, r.nameWithOwner), owner: r.owner, name: r.name, description: r.description, visibility: r.visibility,
      isArchived: r.isArchived, isFork: r.isFork, stars: r.stars, pushedAt: r.pushedAt, tracked: tracked.get(r.nodeId)?.trackedBy ?? null,
    });
    return {
      items: list.items.map(out),
      suggested: list.suggested.filter((r) => !tracked.has(r.nodeId)).map(out),
      truncated: list.truncated,
      fetchedAt: list.fetchedAt,
    };
  }

  /**
   * The source and provider path `input` names: on `source`, unless the input is an address or key on another host,
   * which wins. 400 when that host isn't a source here (or isn't configured), or the input names no repository.
   */
  private target(input: string, source?: string): { reach: Reach; path: string } {
    const asked = this.reach(source);
    const named = inputHost(input, this.hosts());
    const reach = named !== null && named !== asked.host ? this.reach(named) : asked;
    const path = reach.parse(input);
    if (path !== null) return { reach, path };
    // Not a GitHub repository, but a key on some host ("gitlab.example.com/group/project"): say the host isn't a source.
    // (On GitLab such an input is a path: groups may have dots.)
    const guessed = reach.host === GITHUB_HOST && named === null ? inputHost(input, [], { guess: true }) : null;
    if (guessed !== null) throw new HttpError(400, notASource(guessed));
    throw new HttpError(400, reach.refuse(input));
  }

  private async look(input: string, source?: string): Promise<Looked> {
    const { reach, path } = this.target(input, source);
    const token = await this.token(reach);
    const since = isoSec(this.now() - getSettings(this.opts.db).backfillDays * DAY_MS);
    const { result, requests } = await this.call(reach, token, async (s) => {
      const result = await s.lookup(path, since);
      return { result, requests: result.ok ? s.requestsFor(result.counts) : null };
    });
    this.checkViewer(reach, result.viewer);
    return { reach, since, result, requests };
  }

  private preview({ reach, since, requests }: Looked, result: Readable): RepoPreview {
    const { record, probe, counts } = result;
    const tracked = this.trackedBy(reach, [record.nodeId]).get(record.nodeId) ?? null;
    return {
      key: sourceKey(reach, record.nameWithOwner), owner: record.owner, name: record.name, description: record.description, visibility: record.visibility,
      isArchived: record.isArchived, isFork: record.isFork, stars: record.stars, pushedAt: record.pushedAt,
      tracked: tracked?.trackedBy ?? null,
      url: record.url, openPrs: probe.openPrs, openIssues: probe.openIssues,
      owned: result.owned,
      hidden: tracked ? tracked.hidden : null,
      backfill: { since, commits: counts.commits, prs: counts.prs, issues: counts.issues, releases: counts.releases, requests },
      ...(result.unavailable?.length ? { unavailable: result.unavailable } : {}),
    };
  }

  /** Whether the token can read a repository (why not, if it can't), with a preview and the size of its first sync. */
  async lookup(input: string, source?: string): Promise<RepoLookup> {
    const l = await this.look(input, source);
    if (!l.result.ok) return { ok: false, key: sourceKey(l.reach, l.result.path), ...l.result.access };
    return { ok: true, repo: this.preview(l, l.result) };
  }

  /**
   * Tracks a repository by hand after checking again that the token can read it (a preview the client showed isn't
   * trusted), then starts or queues its first sync. Refused: repos the viewer owns (tracked automatically) and ones
   * already tracked (409), and ones the token can't read (404 not-found, else 403).
   */
  async add(input: string, includeInDefault: boolean, source?: string): Promise<AddRepoResponse> {
    const l = await this.look(input, source);
    const { reach, result } = l;
    if (!result.ok) {
      const { problem, message, hint } = result.access;
      throw new HttpError(problem === 'not-found' ? 404 : 403, message, { problem, hint });
    }
    const p = this.preview(l, result);
    if (p.owned) {
      throw new HttpError(409, `You own ${p.key}, so it's tracked automatically.`, { key: p.key, trackedBy: 'owned', hidden: p.hidden ?? false });
    }
    const { db } = this.opts;
    const now = isoSec(this.now());
    const res = db.tx(() => {
      // Again under the write lock: another add, or a sync, may have claimed the source since the lookup.
      const mismatch = tryClaimViewer(db, reach.id, result.viewer);
      if (mismatch) throw new HttpError(409, mismatch);
      const added = addManual(db, reach, result.record, { hidden: !includeInDefault }, now);
      if (added.added) applyProbe(db, added.id, result.probe);
      return added;
    });
    if (!res.added) {
      const why = res.trackedBy === 'owned' ? `You own ${p.key}, so it's tracked automatically.` : `${p.key} is already tracked.`;
      throw new HttpError(409, why, { key: p.key, trackedBy: res.trackedBy, hidden: res.hidden });
    }
    const sync = await this.opts.sync.startOrQueue({ repo: p.key, source: reach.host });
    return { repo: getRepo(db, p.key, this.opts.tz)!, sync };
  }
}

/** Provider failures as API errors: 429 rate limited (with the reset time), 503 token rejected, else 502. */
function httpError(err: unknown, reach: Reach): unknown {
  if (!(err instanceof SourceError)) return err;
  if (err.kind === 'rate-limit') return new HttpError(429, err.message, { resetAt: err.resetAt });
  if (err.kind === 'auth') return new HttpError(503, `${err.message}; ${reach.authHint}`);
  return new HttpError(502, `${reach.label} request failed: ${err.message}`);
}
