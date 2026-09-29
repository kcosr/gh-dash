import type { Settings } from '../../shared/api';
import type { Db } from '../db/db';
import { getMeta, setMeta, type ViewerMeta } from '../db/meta';
import type { RepoProbe, RepoRecord } from '../db/records';
import { repoKey } from '../db/repo-key';
import {
  applyProbe,
  deleteItem,
  deleteStarsExcept,
  getSyncState,
  markReposRemoved,
  pruneCommits,
  releaseExists,
  starExists,
  storedOpenNumbers,
  storedStarInfo,
  type SyncStateRow,
  updateSyncState,
  upsertCommit,
  upsertIssue,
  upsertPr,
  upsertRelease,
  upsertOwned,
  upsertStar,
} from '../db/write';
import { GitHubError, type GitHubClient } from '../github/client';
import { mapCommit, mapIssue, mapProbe, mapPullRequest, mapRelease, mapRepo, mapStar } from '../github/map';
import { recheckQuery, REPO_DETAIL, REPO_PROBES, VIEWER_REPO, VIEWER_REPOS } from '../github/queries';
import type {
  GqlIssue,
  GqlPullRequest,
  GqlViewer,
  RecheckData,
  RepoDetailData,
  RepoProbesData,
  ViewerRepoData,
  ViewerReposData,
} from '../github/types';
import { DAY_MS, isoSec } from '../lib/time';

/** Repos with more stars than this are never fully re-listed (unstar detection is skipped for them). */
const FULL_STAR_DIFF_MAX = 3000;
const PROBE_CHUNK = 25;
/** Max PRs and max issues re-read by number per request. */
const RECHECK_CHUNK = 50;

export interface SyncRequest {
  repo?: string;
  full?: boolean;
}

export interface SyncProgress {
  done: number;
  total: number;
  current: string | null;
}

export interface SyncResult {
  repos: number;
  newItems: number;
  errors: string[];
  /** Forks whose commit history was not synced because settings.includeForks is off. */
  forksSkipped: number;
}

export interface SyncDeps {
  db: Db;
  client: GitHubClient;
  settings: Settings;
  now?: () => number;
  concurrency?: number;
  onProgress?: (p: SyncProgress) => void;
}

export interface RepoPlan {
  /** stopAtKnown: stop after the first history page that contains an already-stored commit. */
  commits: { stopAtKnown: boolean } | null;
  /** Page (by updatedAt desc) until items are older than stopBefore. */
  prs: { stopBefore: string } | null;
  issues: { stopBefore: string } | null;
  releases: { stopAtKnown: boolean } | null;
  /** full: list every stargazer and delete the ones that disappeared (unstars). */
  stars: { mode: 'incremental' | 'full' } | null;
}

export interface PlanContext {
  full: boolean;
  /** Fork commit history (often a large upstream history) is only synced when forks are in scope. */
  includeForks: boolean;
  backfillStart: string;
  now: number;
  storedStars: { count: number; latest: string | null };
  isKnownRelease: (tag: string) => boolean;
}

/** Decides which sections of a repo need fetching, from the cheap probe and the stored high-water marks. */
export function planRepo(r: RepoRecord, probe: RepoProbe | null, s: SyncStateRow, ctx: PlanContext): RepoPlan {
  const { full, backfillStart } = ctx;

  let commits: RepoPlan['commits'] = null;
  if (r.defaultBranch && (!r.isFork || ctx.includeForks)) {
    if (full || !s.commits_pushed_at || s.commits_branch !== r.defaultBranch) commits = { stopAtKnown: false };
    else if (r.pushedAt !== s.commits_pushed_at) commits = { stopAtKnown: true };
  }

  const byUpdatedAt = (hwm: string | null, latest: string | null | undefined) => {
    if (full || !hwm) return { stopBefore: backfillStart };
    if (!probe || (latest && latest > hwm)) return { stopBefore: hwm };
    return null;
  };

  let releases: RepoPlan['releases'] = null;
  if (full || !s.releases_synced_at) releases = { stopAtKnown: false };
  else if (!probe || probe.releaseTags.some((t) => !ctx.isKnownRelease(t))) releases = { stopAtKnown: true };

  let stars: RepoPlan['stars'] = null;
  const canDiff = r.stars < FULL_STAR_DIFF_MAX;
  const diffDue = !s.stars_full_at || ctx.now - Date.parse(s.stars_full_at) >= DAY_MS;
  const { count, latest } = ctx.storedStars;
  if (full || !s.stars_synced_at) stars = { mode: 'full' };
  else if (canDiff && (r.stars > 0 || count > 0) && (diffDue || r.stars < count)) stars = { mode: 'full' };
  else if (!probe || (probe.latestStarredAt && (!latest || probe.latestStarredAt > latest))) stars = { mode: 'incremental' };

  return {
    commits,
    prs: byUpdatedAt(s.prs_hwm, probe?.latestPrUpdatedAt),
    issues: byUpdatedAt(s.issues_hwm, probe?.latestIssueUpdatedAt),
    releases,
    stars,
  };
}

interface RepoTarget {
  id: number;
  record: RepoRecord;
  probe: RepoProbe | null;
}

type Section = 'commits' | 'prs' | 'issues' | 'openPrs' | 'openIssues' | 'releases' | 'stars';

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const isFatal = (err: unknown) => err instanceof GitHubError && (err.kind === 'auth' || err.kind === 'rate-limit');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runSync(deps: SyncDeps, req: SyncRequest = {}): Promise<SyncResult> {
  const { db, client, settings } = deps;
  const nowMs = deps.now?.() ?? Date.now();
  const nowIso = isoSec(nowMs);
  const backfillStart = isoSec(nowMs - settings.backfillDays * DAY_MS);
  const full = !!req.full;
  const errors: string[] = [];

  const targets = req.repo ? await fetchOneRepo(deps, req.repo, nowIso) : await fetchAllRepos(deps, nowIso, errors);

  const progress: SyncProgress = { done: 0, total: targets.length, current: null };
  deps.onProgress?.({ ...progress });
  let newItems = 0;
  let fatal: string | null = null;

  await pool(targets, deps.concurrency ?? 3, async (t) => {
    if (fatal) return;
    const key = repoKey({ name: t.record.name, name_with_owner: t.record.nameWithOwner });
    progress.current = key;
    deps.onProgress?.({ ...progress });
    try {
      // Await first: `newItems += await …` would read newItems before the await and lose concurrent updates.
      const added = await syncRepo(deps, t, { full, includeForks: settings.includeForks, backfillStart, nowMs, nowIso });
      newItems += added;
      updateSyncState(db, t.id, { synced_at: nowIso, last_error: null });
    } catch (err) {
      if (isFatal(err)) fatal = message(err);
      else errors.push(`${key}: ${message(err)}`);
      updateSyncState(db, t.id, { last_error: message(err) });
    }
    progress.done++;
    deps.onProgress?.({ ...progress });
  });
  if (fatal) errors.push(`Sync stopped: ${fatal}`);
  const forksSkipped = settings.includeForks ? 0 : targets.filter((t) => t.record.isFork && t.record.defaultBranch).length;
  return { repos: targets.length, newItems, errors, forksSkipped };
}

/**
 * Why the token's account mustn't sync into this database, or null if it may. A database belongs to the account that
 * first synced it: adopting another one (say after `gh auth switch`) would mark every repo removed, rename same-named
 * ones and mix both accounts' data. Compares node ids, or logins for databases stored without an id.
 */
export function viewerMismatch(stored: ViewerMeta | null, viewer: { id?: string | null; login: string }): string | null {
  if (!stored) return null;
  const same = stored.id && viewer.id ? stored.id === viewer.id : stored.login.toLowerCase() === viewer.login.toLowerCase();
  if (same) return null;
  return `This database belongs to @${stored.login}, but the GitHub token is for @${viewer.login}. Switch back to @${stored.login}, or use a different database.`;
}

/** Records the viewer as the database's account (its login, name and avatar may have changed). */
export function saveViewer(db: Db, v: GqlViewer): void {
  setMeta(db, 'viewer', { id: v.id, login: v.login, name: v.name, avatarUrl: v.avatarUrl });
}

/** Runs before anything is written: a token for another account fails the sync and leaves the database as it was. */
function claimViewer(db: Db, v: GqlViewer): void {
  const mismatch = viewerMismatch(getMeta(db, 'viewer'), v);
  if (mismatch) throw new Error(mismatch);
  saveViewer(db, v);
}

async function fetchOneRepo(deps: SyncDeps, name: string, nowIso: string): Promise<RepoTarget[]> {
  const data = await deps.client.query<ViewerRepoData>(VIEWER_REPO, { name });
  claimViewer(deps.db, data.viewer);
  const node = data.viewer.repository;
  if (!node) throw new Error(`Repository not found on GitHub: ${name}`);
  const record = mapRepo(node);
  const probe = mapProbe(node);
  const id = deps.db.tx(() => {
    const repoId = upsertOwned(deps.db, record, nowIso);
    applyProbe(deps.db, repoId, probe);
    return repoId;
  });
  return [{ id, record, probe }];
}

async function fetchAllRepos(deps: SyncDeps, nowIso: string, errors: string[]): Promise<RepoTarget[]> {
  const { db, client } = deps;
  const records: RepoRecord[] = [];
  let after: string | null = null;
  do {
    const data: ViewerReposData = await client.query<ViewerReposData>(VIEWER_REPOS, { after });
    claimViewer(db, data.viewer);
    const conn = data.viewer.repositories;
    records.push(...conn.nodes.map(mapRepo));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  const ids = db.tx(() => {
    const out = records.map((r) => upsertOwned(db, r, nowIso));
    markReposRemoved(db, records.map((r) => r.nodeId), nowIso);
    return out;
  });

  const probes = new Map<string, RepoProbe>();
  const chunks: string[][] = [];
  for (let i = 0; i < records.length; i += PROBE_CHUNK) chunks.push(records.slice(i, i + PROBE_CHUNK).map((r) => r.nodeId));
  await pool(chunks, 4, async (chunk) => {
    try {
      const data = await client.query<RepoProbesData>(REPO_PROBES, { ids: chunk });
      for (const n of data.nodes) if (n) probes.set(n.id, mapProbe(n));
    } catch (err) {
      if (isFatal(err)) throw err;
      errors.push(`probe: ${message(err)}`);
    }
  });

  return db.tx(() =>
    records.map((record, i) => {
      const probe = probes.get(record.nodeId) ?? null;
      if (probe) applyProbe(db, ids[i]!, probe);
      return { id: ids[i]!, record, probe };
    }),
  );
}

interface OpenPass {
  section: 'openPrs' | 'openIssues';
  table: 'pull_requests' | 'issues';
  /** GitHub's open count from the probe; undefined when the probe failed. */
  github: number | undefined;
  started: boolean;
  done: boolean;
  seen: Set<number>;
}

const openPass = (section: OpenPass['section'], table: OpenPass['table'], github: number | undefined): OpenPass => ({
  section,
  table,
  github,
  started: false,
  done: false,
  seen: new Set(),
});

interface RunContext {
  full: boolean;
  includeForks: boolean;
  backfillStart: string;
  nowMs: number;
  nowIso: string;
}

/** Syncs one repo's sections, paging all active sections together in one request per round. Returns new items. */
async function syncRepo(deps: SyncDeps, t: RepoTarget, run: RunContext): Promise<number> {
  const { db, client } = deps;
  const { id, record: r } = t;
  const state = getSyncState(db, id);
  if (r.isArchived && state.synced_at && !run.full) return 0;

  const plan = planRepo(r, t.probe, state, {
    full: run.full,
    includeForks: run.includeForks,
    backfillStart: run.backfillStart,
    now: run.nowMs,
    storedStars: storedStarInfo(db, id),
    isKnownRelease: (tag) => releaseExists(db, id, tag),
  });

  const active = new Set<Section>((Object.keys(plan) as (keyof RepoPlan)[]).filter((k) => plan[k] !== null));
  const cursor: Record<Section, string | null> = {
    commits: null, prs: null, issues: null, openPrs: null, openIssues: null, releases: null, stars: null,
  };
  let prsHwm = run.full ? null : state.prs_hwm;
  let issuesHwm = run.full ? null : state.issues_hwm;
  let starsMode = plan.stars?.mode ?? 'incremental';
  let starLogins: string[] = [];
  let newItems = 0;
  /** The default-branch walk: its first (newest) commit, and every oid it returned. */
  const commitWalk: { head: string | null | undefined; seen: string[] } = { head: undefined, seen: [] };

  const advance = (section: Section, hasMore: boolean, endCursor: string | null, onDone: () => void) => {
    if (hasMore && endCursor) cursor[section] = endCursor;
    else {
      active.delete(section);
      onDone();
    }
  };

  // Open items older than the backfill window are missed by the updatedAt passes. Whenever our open count
  // differs from GitHub's (checked after the updatedAt pass, or up front when there is none), list every
  // open item; stored-open items GitHub doesn't list are re-read by number after the loop.
  const open = {
    prs: openPass('openPrs', 'pull_requests', t.probe?.openPrs),
    issues: openPass('openIssues', 'issues', t.probe?.openIssues),
  };
  const startOpenPassIfNeeded = (o: OpenPass) => {
    if (o.started) return;
    if (run.full || o.github === undefined || storedOpenNumbers(db, id, o.table).length !== o.github) {
      o.started = true;
      active.add(o.section);
    }
  };
  if (!plan.prs || run.full) startOpenPassIfNeeded(open.prs);
  if (!plan.issues || run.full) startOpenPassIfNeeded(open.issues);

  while (active.size > 0) {
    const data = await client.query<RepoDetailData>(REPO_DETAIL, {
      owner: r.owner,
      name: r.name,
      withCommits: active.has('commits'),
      commitsAfter: cursor.commits,
      since: run.backfillStart,
      commitsFirst: 100,
      withPrs: active.has('prs'),
      prsAfter: cursor.prs,
      prsFirst: 50,
      withIssues: active.has('issues'),
      issuesAfter: cursor.issues,
      issuesFirst: 50,
      withOpenPrs: active.has('openPrs'),
      openPrsAfter: cursor.openPrs,
      withOpenIssues: active.has('openIssues'),
      openIssuesAfter: cursor.openIssues,
      withReleases: active.has('releases'),
      releasesAfter: cursor.releases,
      withStars: active.has('stars'),
      starsAfter: cursor.stars,
    });
    const repo = data.repository;
    if (!repo) throw new Error('repository not found');

    db.tx(() => {
      if (active.has('commits')) {
        const hist = repo.defaultBranchRef?.target?.history;
        const nodes = hist?.nodes ?? [];
        if (commitWalk.head === undefined) commitWalk.head = nodes[0]?.oid ?? null;
        let known = 0;
        let reachedPrevious = false;
        for (const n of nodes) {
          commitWalk.seen.push(n.oid);
          if (upsertCommit(db, id, mapCommit(n, repo.nameWithOwner))) newItems++;
          else known++;
          if (n.oid === state.commits_head) reachedPrevious = true;
        }
        // Incremental walks stop at the head of the last complete walk; state from before commits_head existed
        // falls back to stopping at any stored commit.
        const stopped = plan.commits!.stopAtKnown && (state.commits_head ? reachedPrevious : known > 0);
        const more = !!hist?.pageInfo.hasNextPage && !stopped;
        advance('commits', more, hist?.pageInfo.endCursor ?? null, () => {
          // A walk that went through the whole window has seen every commit on the branch since backfillStart.
          if (hist && !hist.pageInfo.hasNextPage && !stopped) pruneCommits(db, id, run.backfillStart, commitWalk.seen);
          updateSyncState(db, id, { commits_pushed_at: r.pushedAt, commits_branch: r.defaultBranch, commits_head: commitWalk.head ?? null });
        });
      }

      if (active.has('prs')) {
        const conn = repo.pullRequests!;
        let reachedOld = false;
        for (const n of conn.nodes) {
          if (n.updatedAt < plan.prs!.stopBefore) {
            reachedOld = true;
            break;
          }
          if (upsertPr(db, id, mapPullRequest(n))) newItems++;
          if (!prsHwm || n.updatedAt > prsHwm) prsHwm = n.updatedAt;
        }
        advance('prs', conn.pageInfo.hasNextPage && !reachedOld, conn.pageInfo.endCursor, () => {
          updateSyncState(db, id, { prs_hwm: prsHwm ?? run.backfillStart });
          startOpenPassIfNeeded(open.prs);
        });
      }

      if (active.has('issues')) {
        const conn = repo.issues!;
        let reachedOld = false;
        for (const n of conn.nodes) {
          if (n.updatedAt < plan.issues!.stopBefore) {
            reachedOld = true;
            break;
          }
          if (upsertIssue(db, id, mapIssue(n))) newItems++;
          if (!issuesHwm || n.updatedAt > issuesHwm) issuesHwm = n.updatedAt;
        }
        advance('issues', conn.pageInfo.hasNextPage && !reachedOld, conn.pageInfo.endCursor, () => {
          updateSyncState(db, id, { issues_hwm: issuesHwm ?? run.backfillStart });
          startOpenPassIfNeeded(open.issues);
        });
      }

      if (active.has('openPrs')) {
        const conn = repo.openPrs!;
        for (const n of conn.nodes) {
          open.prs.seen.add(n.number);
          if (upsertPr(db, id, mapPullRequest(n))) newItems++;
        }
        advance('openPrs', conn.pageInfo.hasNextPage, conn.pageInfo.endCursor, () => (open.prs.done = true));
      }

      if (active.has('openIssues')) {
        const conn = repo.openIssues!;
        for (const n of conn.nodes) {
          open.issues.seen.add(n.number);
          if (upsertIssue(db, id, mapIssue(n))) newItems++;
        }
        advance('openIssues', conn.pageInfo.hasNextPage, conn.pageInfo.endCursor, () => (open.issues.done = true));
      }

      if (active.has('releases')) {
        const conn = repo.releases!;
        let hitKnown = false;
        for (const n of conn.nodes) {
          const rec = mapRelease(n);
          if (!rec) continue;
          if (plan.releases!.stopAtKnown && releaseExists(db, id, rec.tag)) {
            hitKnown = true;
            break;
          }
          if (upsertRelease(db, id, rec)) newItems++;
        }
        const last = conn.nodes.at(-1);
        const more = conn.pageInfo.hasNextPage && !hitKnown && !!last && last.createdAt >= run.backfillStart;
        advance('releases', more, conn.pageInfo.endCursor, () => updateSyncState(db, id, { releases_synced_at: run.nowIso }));
      }

      if (active.has('stars')) {
        const conn = repo.stargazers!;
        const capped = conn.totalCount >= FULL_STAR_DIFF_MAX;
        let stop = false;
        for (const e of conn.edges) {
          const rec = mapStar(e);
          if (starsMode === 'incremental' && starExists(db, id, rec.login)) {
            stop = true;
            break;
          }
          if (starsMode === 'full' && capped && rec.starredAt < run.backfillStart) {
            stop = true;
            break;
          }
          if (upsertStar(db, id, rec)) newItems++;
          starLogins.push(rec.login);
        }
        advance('stars', conn.pageInfo.hasNextPage && !stop, conn.pageInfo.endCursor, () => {
          if (starsMode === 'full' && !capped) {
            deleteStarsExcept(db, id, starLogins);
            updateSyncState(db, id, { stars_full_at: run.nowIso });
          }
          updateSyncState(db, id, { stars_synced_at: run.nowIso });
        });
        // An incremental pass that leaves our count out of step with GitHub means stars were removed: diff once.
        if (!active.has('stars') && starsMode === 'incremental' && !capped && storedStarInfo(db, id).count !== conn.totalCount) {
          starsMode = 'full';
          starLogins = [];
          cursor.stars = null;
          active.add('stars');
        }
      }
    });
  }

  const stale = (o: OpenPass) =>
    o.done ? storedOpenNumbers(db, id, o.table).filter((n) => !o.seen.has(n)) : [];
  await recheckItems(deps, t, stale(open.prs), stale(open.issues));
  return newItems;
}

/**
 * Re-reads PRs / issues we have as open but GitHub no longer lists as open (normally already fixed by the
 * updatedAt pass): updates them, or deletes them when they no longer exist in this repo (deleted/transferred).
 */
async function recheckItems(deps: SyncDeps, t: RepoTarget, prs: number[], issues: number[]): Promise<void> {
  const { db, client } = deps;
  for (let i = 0; i < prs.length || i < issues.length; i += RECHECK_CHUNK) {
    const prChunk = prs.slice(i, i + RECHECK_CHUNK);
    const issueChunk = issues.slice(i, i + RECHECK_CHUNK);
    const data = await client.query<RecheckData>(
      recheckQuery(prChunk, issueChunk),
      { owner: t.record.owner, name: t.record.name },
      { allowNotFound: true },
    );
    const repo = data.repository;
    if (!repo) throw new Error('repository not found');
    const here = (key: string) => {
      const node = repo[key];
      return node && node.repository.nameWithOwner === t.record.nameWithOwner ? node : null;
    };
    db.tx(() => {
      for (const n of prChunk) {
        const node = here(`pr${n}`);
        if (node) upsertPr(db, t.id, mapPullRequest(node as GqlPullRequest));
        else deleteItem(db, t.id, 'pull_requests', n);
      }
      for (const n of issueChunk) {
        const node = here(`issue${n}`);
        if (node) upsertIssue(db, t.id, mapIssue(node as GqlIssue));
        else deleteItem(db, t.id, 'issues', n);
      }
    });
  }
}
