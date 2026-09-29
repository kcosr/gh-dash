// Adding repositories of other owners: the candidates the token can read, a lookup that checks access and sizes the
// first sync, and the add itself. The requests are the source's (SyncSource.candidates and lookup), made for the person
// waiting on them: few retries, no long waits. Nothing here syncs; an add hands the repo to the sync manager.

import { GITHUB_HOST, type AddRepoResponse, type RepoCandidate, type RepoCandidatesResponse, type RepoLookup, type RepoPreview, type TrackedBy } from '../../shared/api';
import { parseGitHubInput } from '../../shared/repos';
import { HttpError } from '../api/http';
import type { Db } from '../db/db';
import { getRepo } from '../db/repos';
import { getSettings } from '../db/settings';
import { GITHUB_SOURCE_ID, getSource, setSourceRateLimit, sourceKey, tryClaimViewer, viewerMismatch, type SourceRef } from '../db/sources';
import { addManual, applyProbe } from '../db/write';
import { GitHubSyncSource } from '../github/sync-source';
import { DAY_MS, isoSec } from '../lib/time';
import { SourceError } from '../provider/errors';
import { defaultSleep, type RetryLimits } from '../provider/transport';
import type { LookupRecord, RepoCandidateRecord, SyncSource, ViewerInfo } from '../provider/types';
import { noTokenMessage, tokenKind, type ResolvedToken, type TokenSupply } from '../token';

/** How long the candidate lists are reused (the Add dialog filters them locally as you type). */
const CANDIDATES_TTL_MS = 5 * 60_000;
/** A person is waiting on every request here: few retries, no long waits. */
const INTERACTIVE: RetryLimits = { maxAttempts: 2, maxRetryWaitMs: 10_000 };

/** The Sync manager's part: start a just-added repo's first sync, or queue it. */
export interface FirstSync {
  startOrQueue(req: { repo: string }): Promise<'started' | 'queued'>;
}

export interface TrackingOptions {
  db: Db;
  /** github.com's token, shared with the sync and the diffs. */
  tokens: TokenSupply;
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

  /** The source named by `host` (default github.com); 400 when there is none. */
  private reach(host: string = GITHUB_HOST): Reach {
    if (host.toLowerCase() === GITHUB_HOST) return this.github();
    throw new HttpError(400, `${host} isn't a source here.`);
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

  /** The source and provider path `input` names (400 when it names none). */
  private target(input: string, source?: string): { reach: Reach; path: string } {
    const reach = this.reach(source);
    const path = reach.parse(input);
    if (path === null) throw new HttpError(400, reach.refuse(input));
    return { reach, path };
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
    const sync = await this.opts.sync.startOrQueue({ repo: p.key });
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
