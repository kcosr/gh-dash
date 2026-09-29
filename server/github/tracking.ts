// Adding repositories of other owners: the candidates the token can read, a lookup that checks access and sizes the
// first sync, and the add itself. Requests go straight to GitHub for the person waiting on them; nothing here syncs.
// When sources other than GitHub exist, `candidates` and `lookup` become SyncSource methods (their shapes are
// provider-neutral already).

import type { AddRepoResponse, RepoCandidate, RepoCandidatesResponse, RepoLookup, RepoPreview, TokenKind, TrackedBy } from '../../shared/api';
import { parseRepoInput } from '../../shared/repos';
import { HttpError } from '../api/http';
import type { Db } from '../db/db';
import { getMeta, setMeta } from '../db/meta';
import { getRepo } from '../db/repos';
import { getSettings } from '../db/settings';
import { addManual, applyProbe } from '../db/write';
import { DAY_MS, isoSec } from '../lib/time';
import { defaultSleep } from '../provider/transport';
import { tryClaimViewer, viewerMismatch } from '../sync/sync';
import { noTokenMessage, tokenKind, type TokenSupply } from '../token';
import { type AccessFailure, accessFailure, notFound } from './access';
import { GitHubClient } from './client';
import { mapProbe, mapRepo } from './map';
import { REPO_LOOKUP, REPO_SUGGESTIONS } from './queries';
import { GitHubRestClient } from './rest';
import { GitHubError } from './transport';
import type { GqlRepoSummary, GqlViewer, RepoLookupData, RepoSuggestionsData } from './types';

/** How long the candidate lists are reused (the Add dialog filters them locally as you type). */
const CANDIDATES_TTL_MS = 5 * 60_000;
/** At most this many of the token's repositories are listed (10 REST pages). */
const MAX_CANDIDATES = 1000;

/** A first sync pages commits by 100 and PRs / issues by 50, all in the same rounds; open items take their own. */
export function backfillRequests(commits: number, prs: number, issues: number, openPrs: number, openIssues: number): number {
  return Math.max(1, Math.ceil(commits / 100), Math.ceil(prs / 50), Math.ceil(issues / 50)) + Math.ceil(openPrs / 50) + Math.ceil(openIssues / 50);
}

/** The Sync manager's part: start a just-added repo's first sync, or queue it. */
export interface FirstSync {
  startOrQueue(req: { repo: string }): Promise<'started' | 'queued'>;
}

export interface TrackingOptions {
  db: Db;
  tokens: TokenSupply;
  sync: FirstSync;
  /** Timezone of the returned Repo's weekly stats (the server's default). */
  tz: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RestRepo {
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  visibility?: 'public' | 'private' | 'internal';
  private: boolean;
  archived: boolean;
  fork: boolean;
  stargazers_count: number;
  pushed_at: string | null;
}

/** A candidate before it's compared with what is tracked. */
type Found = Omit<RepoCandidate, 'tracked'> & { nodeId: string };

interface Looked {
  key: string;
  /** The backfill start the counts are from. */
  since: string;
  viewer: GqlViewer;
  failure: AccessFailure | null;
  data: RepoLookupData;
  kind: TokenKind;
}

const fromRest = (r: RestRepo): Found => ({
  nodeId: r.node_id, key: r.full_name, owner: r.owner.login, name: r.name, description: r.description,
  visibility: r.visibility ?? (r.private ? 'private' : 'public'), isArchived: r.archived, isFork: r.fork, stars: r.stargazers_count, pushedAt: r.pushed_at,
});

const fromGql = (r: GqlRepoSummary): Found => ({
  nodeId: r.id, key: r.nameWithOwner, owner: r.owner.login, name: r.name, description: r.description || null,
  visibility: r.visibility === 'PUBLIC' ? 'public' : r.visibility === 'INTERNAL' ? 'internal' : 'private',
  isArchived: r.isArchived, isFork: r.isFork, stars: r.stargazerCount, pushedAt: r.pushedAt,
});

export class Tracking {
  private readonly opts: TrackingOptions;
  /** The last candidate lists, for the token they were fetched with and the account GitHub said it belongs to. */
  private cached: { token: string; viewer: GqlViewer; at: number; items: Found[]; suggested: Found[]; truncated: boolean; fetchedAt: string } | null = null;

  constructor(opts: TrackingOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** GitHub clients for the current token (503 without one). A person is waiting: few retries, no long waits. */
  private async connect(): Promise<{ token: string; kind: TokenKind; graphql: GitHubClient; rest: GitHubRestClient }> {
    const resolved = await this.opts.tokens.get();
    const { token } = resolved;
    if (!token) throw new HttpError(503, noTokenMessage(resolved));
    const { fetchImpl = fetch, sleep = defaultSleep } = this.opts;
    const watched: typeof fetch = async (input, init) => {
      const res = await fetchImpl(input, init);
      if (res.status === 401) this.opts.tokens.invalidate(token);
      return res;
    };
    return {
      token,
      kind: tokenKind(token),
      graphql: new GitHubClient({
        token, fetchImpl: watched, sleep, maxAttempts: 2, maxRetryWaitMs: 10_000,
        // Lookups spend GraphQL points too: keep the budget the header shows current.
        onRateLimit: (rl) => setMeta(this.opts.db, 'rateLimit', { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt }),
      }),
      rest: new GitHubRestClient({ token, fetchImpl: watched, sleep }),
    };
  }

  /** The viewer must be this database's account: results for another one would be wrong here. */
  private checkViewer(viewer: GqlViewer): void {
    const mismatch = viewerMismatch(getMeta(this.opts.db, 'viewer'), viewer);
    if (mismatch) throw new HttpError(409, mismatch);
  }

  /** How each live repo with one of these node ids is tracked. */
  private trackedBy(nodeIds: string[]): Map<string, { trackedBy: TrackedBy; hidden: boolean }> {
    const rows = this.opts.db.all<{ node_id: string; tracked_by: string; hidden: number }>(
      'SELECT node_id, tracked_by, hidden FROM repos WHERE removed_at IS NULL AND node_id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(nodeIds)],
    );
    return new Map(rows.map((r) => [r.node_id, { trackedBy: r.tracked_by === 'manual' ? 'manual' : 'owned', hidden: !!r.hidden }]));
  }

  /**
   * The token's repositories of other owners (collaborator or organization member, most recently pushed first, up to
   * 1000) and the untracked ones the viewer recently contributed to. Cached for 5 minutes per token; `refresh` asks
   * again. Cost: up to 10 REST requests and 1 GraphQL point.
   */
  async candidates(refresh = false): Promise<RepoCandidatesResponse> {
    const c = await this.connect();
    let list = this.cached;
    if (refresh || !list || list.token !== c.token || this.now() - list.at > CANDIDATES_TTL_MS) {
      const [repos, suggestions] = await Promise.all([
        c.rest.paginate<RestRepo[], RestRepo>('/user/repos', (page) => page, MAX_CANDIDATES, {
          query: { affiliation: 'collaborator,organization_member', sort: 'pushed', per_page: 100 },
        }),
        c.graphql.query<RepoSuggestionsData>(REPO_SUGGESTIONS),
      ]).catch(httpError);
      const items = repos.items.map(fromRest);
      list = {
        token: c.token, viewer: suggestions.viewer, at: this.now(), items, truncated: items.length >= MAX_CANDIDATES, fetchedAt: new Date(this.now()).toISOString(),
        suggested: suggestions.viewer.repositoriesContributedTo.nodes.flatMap((n) => (n ? [fromGql(n)] : [])),
      };
      this.cached = list;
    }
    // On every answer, cached ones too: the database may have been claimed by another account since they were fetched.
    this.checkViewer(list.viewer);
    const tracked = this.trackedBy([...list.items, ...list.suggested].map((r) => r.nodeId));
    const out = ({ nodeId, ...r }: Found): RepoCandidate => ({ ...r, tracked: tracked.get(nodeId)?.trackedBy ?? null });
    return {
      items: list.items.map(out),
      suggested: list.suggested.filter((r) => !tracked.has(r.nodeId)).map(out),
      truncated: list.truncated,
      fetchedAt: list.fetchedAt,
    };
  }

  private async look(input: string): Promise<Looked> {
    const parsed = parseRepoInput(input);
    if (!parsed) throw new HttpError(400, `Not a GitHub repository: "${input.slice(0, 200)}". Enter owner/name or a github.com URL.`);
    const key = `${parsed.owner}/${parsed.name}`;
    const c = await this.connect();
    const since = isoSec(this.now() - getSettings(this.opts.db).backfillDays * DAY_MS);
    const day = since.slice(0, 10);
    const { data, errors } = await c.graphql
      .queryPartial<RepoLookupData>(
        REPO_LOOKUP,
        { owner: parsed.owner, name: parsed.name, since, prQ: `repo:${key} is:pr updated:>=${day}`, issueQ: `repo:${key} is:issue updated:>=${day}` },
        { optional: ['prs', 'issues'] },
      )
      .catch(httpError);
    this.checkViewer(data.viewer);
    const failure = accessFailure(errors, ['repository'], key, c.kind) ?? (data.repository ? null : notFound(key, c.kind));
    return { key: data.repository?.nameWithOwner ?? key, since, viewer: data.viewer, failure, data, kind: c.kind };
  }

  private preview(l: Looked): RepoPreview {
    const r = l.data.repository!;
    const record = mapRepo(r);
    const tracked = this.trackedBy([r.id]).get(r.id) ?? null;
    const commits = r.defaultBranchRef ? (r.defaultBranchRef.target?.history?.totalCount ?? null) : 0;
    const prs = l.data.prs?.issueCount ?? null;
    const issues = l.data.issues?.issueCount ?? null;
    return {
      key: record.nameWithOwner, owner: record.owner, name: record.name, description: record.description, visibility: record.visibility,
      isArchived: record.isArchived, isFork: record.isFork, stars: record.stars, pushedAt: record.pushedAt,
      tracked: tracked?.trackedBy ?? null,
      url: record.url, openPrs: r.openPrs.totalCount, openIssues: r.openIssues.totalCount,
      owned: record.owner.toLowerCase() === l.viewer.login.toLowerCase(),
      hidden: tracked ? tracked.hidden : null,
      backfill: {
        since: l.since, commits, prs, issues, releases: r.releases.totalCount,
        requests: commits === null || prs === null || issues === null
          ? null
          : backfillRequests(commits, prs, issues, r.openPrs.totalCount, r.openIssues.totalCount),
      },
    };
  }

  /** Whether the token can read a repository (why not, if it can't), with a preview and the size of its first sync. */
  async lookup(input: string): Promise<RepoLookup> {
    const l = await this.look(input);
    if (l.failure) return { ok: false, key: l.key, ...l.failure };
    return { ok: true, repo: this.preview(l) };
  }

  /**
   * Tracks a repository by hand after checking again that the token can read it (a preview the client showed isn't
   * trusted), then starts or queues its first sync. Refused: repos the viewer owns (tracked automatically) and ones
   * already tracked (409), and ones the token can't read (404 not-found, else 403).
   */
  async add(input: string, includeInDefault: boolean): Promise<AddRepoResponse> {
    const l = await this.look(input);
    if (l.failure) {
      const { problem, message, hint } = l.failure;
      throw new HttpError(problem === 'not-found' ? 404 : 403, message, { problem, hint });
    }
    const p = this.preview(l);
    if (p.owned) {
      throw new HttpError(409, `You own ${p.key}, so it's tracked automatically.`, { key: p.key, trackedBy: 'owned', hidden: p.hidden ?? false });
    }
    const { db } = this.opts;
    const r = l.data.repository!;
    const now = isoSec(this.now());
    const res = db.tx(() => {
      // Again under the write lock: another add, or a sync, may have claimed the database since the lookup.
      const mismatch = tryClaimViewer(db, l.viewer);
      if (mismatch) throw new HttpError(409, mismatch);
      const added = addManual(db, mapRepo(r), { hidden: !includeInDefault }, now);
      if (added.added) applyProbe(db, added.id, mapProbe(r));
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

/** GitHub failures as API errors: 429 rate limited (with the reset time), 503 token rejected, else 502. */
function httpError(err: unknown): never {
  if (!(err instanceof GitHubError)) throw err;
  if (err.kind === 'rate-limit') throw new HttpError(429, err.message, { resetAt: err.resetAt });
  if (err.kind === 'auth') throw new HttpError(503, `${err.message}; check GITHUB_TOKEN or run \`gh auth login\``);
  throw new HttpError(502, `GitHub request failed: ${err.message}`);
}
