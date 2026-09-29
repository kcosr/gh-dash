// The sync engine, provider-neutral: one run syncs one source (a SyncSource for its token, and its row in `sources`).
// It plans what to fetch from the stored high-water marks and the source's cheap probes, pages every changed section
// of a repo together (one round() per page), and writes what comes back. The source speaks its provider's API; this
// file only ever sees the normalized records of db/records.ts, and decides and writes.

import type { Settings, TrackedBy } from '../../shared/api';
import type { Db } from '../db/db';
import type { RepoProbe, RepoRecord } from '../db/records';
import { resolveRepo } from '../db/repo-key';
import { type ClaimedViewer, GITHUB_SOURCE_ID, type SourceRow, sourceKey, sourceLabel, tryClaimViewer } from '../db/sources';
import {
  applyProbe,
  deleteItem,
  deleteStarsExcept,
  getSyncState,
  linkCommitsToPrs,
  markReposRemoved,
  markUnavailable,
  pruneCommits,
  refreshManual,
  storedRepoRecord,
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
import { chunked, pool } from '../lib/pool';
import { DAY_MS, isoSec } from '../lib/time';
import { accessLost, reasonOf } from '../provider/access';
import { isFatalSourceError } from '../provider/errors';
import type { RepoRead, RoundRequest, RoundResult, SyncSource } from '../provider/types';

/** Repos with more stars than this are never fully re-listed (unstar detection is skipped for them). */
const FULL_STAR_DIFF_MAX = 3000;
/**
 * Repos added by hand re-read per refresh() call, and calls at a time. Each call's answers are written as they land,
 * so a fatal failure of one leaves the others' written.
 */
const REFRESH_CHUNK = 25;
const REFRESH_CALLS = 4;

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
  /** The provider, for this run's token: every request goes through it. */
  source: SyncSource;
  /** The source this run syncs: its repos, its keys and the account its data belongs to. */
  src: SourceRow;
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
  /** Stargazers are synced for repos the viewer owns only. */
  syncStars: boolean;
  /**
   * Whether the probe's latestStarredAt tells of new stars (SyncSource.probesStars). When not, new stars are told by
   * the star count moving since the last stars pass (sync_state.stars_count).
   */
  probesStars: boolean;
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
  if (ctx.syncStars) {
    const canDiff = r.stars < FULL_STAR_DIFF_MAX;
    const diffDue = !s.stars_full_at || ctx.now - Date.parse(s.stars_full_at) >= DAY_MS;
    const { count, latest } = ctx.storedStars;
    const starred = ctx.probesStars
      ? !probe || (!!probe.latestStarredAt && (!latest || probe.latestStarredAt > latest))
      : r.stars !== s.stars_count;
    if (full || !s.stars_synced_at) stars = { mode: 'full' };
    else if (canDiff && (r.stars > 0 || count > 0) && (diffDue || r.stars < count)) stars = { mode: 'full' };
    else if (starred) stars = { mode: 'incremental' };
  }

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
  trackedBy: TrackedBy;
  /** Why this repo was only read in part (fields the token may not read): the run reports it as failed. */
  problem: string | null;
}

type Section = keyof RoundRequest;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runSync(deps: SyncDeps, req: SyncRequest = {}): Promise<SyncResult> {
  const { db, settings, src } = deps;
  const nowMs = deps.now?.() ?? Date.now();
  const nowIso = isoSec(nowMs);
  const backfillStart = isoSec(nowMs - settings.backfillDays * DAY_MS);
  const full = !!req.full;
  const errors: string[] = [];

  const targets = req.repo ? await fetchOneRepo(deps, req.repo, nowIso, errors) : await fetchAllRepos(deps, nowIso, errors);

  const progress: SyncProgress = { done: 0, total: targets.length, current: null };
  deps.onProgress?.({ ...progress });
  let newItems = 0;
  let fatal: string | null = null;

  await pool(targets, deps.concurrency ?? 3, async (t) => {
    if (fatal) return;
    const key = sourceKey(src, t.record.nameWithOwner);
    progress.current = key;
    deps.onProgress?.({ ...progress });
    try {
      // Await first: `newItems += await …` would read newItems before the await and lose concurrent updates.
      const added = await syncRepo(deps, t, { full, includeForks: settings.includeForks, backfillStart, nowMs, nowIso });
      writeTx(db, t, () => updateSyncState(db, t.id, t.problem ? { last_error: t.problem } : { synced_at: nowIso, last_error: null }));
      newItems += added;
      if (t.problem) errors.push(`${key}: ${t.problem}`);
    } catch (err) {
      if (isFatalSourceError(err)) fatal = message(err);
      try {
        writeTx(db, t, () => {
          if (fatal) return;
          // The repository itself can no longer be read (not one of its sections): a repo added by hand is set aside.
          const lost = t.trackedBy === 'manual' ? accessLost(err) : null;
          if (lost) markUnavailable(db, t.id, t.record.nodeId, reasonOf(lost), nowIso);
          errors.push(`${key}: ${lost ? `unavailable: ${reasonOf(lost)}` : message(err)}`);
        });
        writeTx(db, t, () => updateSyncState(db, t.id, { last_error: message(err) }));
      } catch (gone) {
        if (!(gone instanceof RepoGone)) throw gone;
      }
    }
    progress.done++;
    deps.onProgress?.({ ...progress });
  });
  if (fatal) errors.push(`Sync stopped: ${fatal}`);
  const forksSkipped = settings.includeForks ? 0 : targets.filter((t) => t.record.isFork && t.record.defaultBranch).length;
  return { repos: targets.length, newItems, errors, forksSkipped };
}

/**
 * The target stopped being the repo this run is syncing: deleted (DELETE /repos) or no longer live while its answers
 * were pending. Its id may even belong to another repo by now (ids of deleted rows could be reused before v5 added
 * AUTOINCREMENT), so nothing of this run may be written under it.
 */
class RepoGone extends Error {
  constructor() {
    super('repository no longer tracked');
  }
}

/** A write transaction for target `t`: checks first that its row is still the same live repo (id and node id). */
function writeTx<T>(db: Db, t: { id: number; record: RepoRecord }, fn: () => T): T {
  return db.tx(() => {
    if (!db.get('SELECT 1 FROM repos WHERE id = ? AND node_id = ? AND removed_at IS NULL', [t.id, t.record.nodeId])) throw new RepoGone();
    return fn();
  });
}

/** Runs before anything is written: a token for another account fails the sync and leaves the database as it was. */
function claimViewer(db: Db, src: SourceRow, v: ClaimedViewer): void {
  const mismatch = tryClaimViewer(db, src.id, v);
  if (mismatch) throw new Error(mismatch);
}

/**
 * A read's record, keeping what the database has for the fields the token may not read (a denied default branch is
 * not an empty repository).
 */
function withStored(db: Db, src: SourceRow, read: Extract<RepoRead, { ok: true }>): RepoRecord {
  if (!read.denied.length) return read.record;
  const stored = storedRepoRecord(db, src, read.record.nodeId);
  return stored ? { ...read.record, ...Object.fromEntries(read.denied.map((f) => [f, stored[f]])) } : read.record;
}

/**
 * One repository: `repo` is a key or, on github.com, an owned repo's short name. A tracked repo is read by node id (it
 * may have been renamed since). A bare name nothing tracks yet may name a repo the viewer just created: that is looked
 * up among the viewer's own. A repo added by hand that can't be read is marked unavailable, and there is nothing to
 * sync.
 */
async function fetchOneRepo(deps: SyncDeps, repo: string, nowIso: string, errors: string[]): Promise<RepoTarget[]> {
  const { db, source, src } = deps;
  const label = sourceLabel(src);
  const ref = resolveRepo(db, repo);
  if (ref && ref.sourceId !== src.id) throw new Error(`${ref.key} isn't on ${label}`);
  if (!ref) {
    // Short names are github.com's (an owned repo's name); other sources' keys all carry their host.
    if (repo.includes('/') || src.id !== GITHUB_SOURCE_ID) throw new Error(`Repository isn't tracked: ${repo}`);
    const { viewer, found } = await source.repo(repo);
    claimViewer(db, src, viewer);
    if (!found) throw new Error(`Repository not found on ${label}: ${repo}`);
    const { record, probe } = found;
    const id = db.tx(() => {
      const repoId = upsertOwned(db, src, record, nowIso);
      applyProbe(db, repoId, probe);
      return repoId;
    });
    return [{ id, record, probe, trackedBy: 'owned', problem: null }];
  }

  const { viewer, read } = await source.repoByNode({ nodeId: ref.nodeId, path: ref.path });
  claimViewer(db, src, viewer);
  if (!read.ok) {
    if (ref.trackedBy === 'owned') throw new Error(`Repository not found on ${label}: ${ref.key}`);
    const reason = reasonOf(read.access);
    markUnavailable(db, ref.id, ref.nodeId, reason, nowIso);
    errors.push(`${ref.key}: unavailable: ${reason}`);
    return [];
  }
  const record = withStored(db, src, read);
  const id = db.tx(() => {
    const repoId = ref.trackedBy === 'owned' ? upsertOwned(db, src, record, nowIso) : refreshManual(db, src, record, nowIso);
    if (repoId !== null && read.probe) applyProbe(db, repoId, read.probe);
    return repoId;
  });
  return id === null ? [] : [{ id, record, probe: read.probe, trackedBy: ref.trackedBy, problem: read.problem }];
}

/**
 * Every repo of the source: the viewer's own (the list claims the account before anything is written, and repos no
 * longer in it are marked removed), then the ones added by hand, then the owned ones' probes. A repo whose probe
 * failed syncs as if everything in it had changed.
 */
async function fetchAllRepos(deps: SyncDeps, nowIso: string, errors: string[]): Promise<RepoTarget[]> {
  const { db, source, src } = deps;
  const { viewer, repos: records } = await source.ownedRepos();
  claimViewer(db, src, viewer);

  const ids = db.tx(() => {
    const out = records.map((r) => upsertOwned(db, src, r, nowIso));
    markReposRemoved(db, src, records.map((r) => r.nodeId), nowIso);
    return out;
  });

  const manual = await fetchManualRepos(deps, nowIso, errors);

  const { probes, errors: probeErrors } = await source.probes(records);
  errors.push(...probeErrors.map((e) => `probe: ${e}`));

  const owned = db.tx(() =>
    records.map((record, i) => {
      const probe = probes.get(record.nodeId) ?? null;
      if (probe) applyProbe(db, ids[i]!, probe);
      return { id: ids[i]!, record, probe, trackedBy: 'owned' as const, problem: null };
    }),
  );
  return [...owned, ...manual];
}

/**
 * Refreshes the source's live repos added by hand by node id (they follow renames and transfers), unavailable ones
 * included so they are checked again every run. One that can't be read is marked unavailable: its data is kept and it
 * isn't synced. A request failing for another reason skips its repos this run.
 */
async function fetchManualRepos(deps: SyncDeps, nowIso: string, errors: string[]): Promise<RepoTarget[]> {
  const { db, source, src } = deps;
  const rows = db.all<{ id: number; node_id: string; key: string; path: string }>(
    `SELECT id, node_id, key, name_with_owner AS path FROM repos WHERE source_id = ? AND tracked_by = 'manual' AND removed_at IS NULL ORDER BY id`,
    [src.id],
  );
  const targets = new Map<number, RepoTarget>();
  await pool(chunked(rows, REFRESH_CHUNK), REFRESH_CALLS, async (chunk) => {
    const { reads, errors: failed } = await source.refresh(chunk.map((r) => ({ nodeId: r.node_id, path: r.path })));
    errors.push(...failed.map((e) => `manual repos: ${e}`));
    db.tx(() =>
      chunk.forEach((row) => {
        const read = reads.get(row.node_id);
        if (!read) return;
        if (!read.ok) {
          markUnavailable(db, row.id, row.node_id, reasonOf(read.access), nowIso);
          return;
        }
        const record = withStored(db, src, read);
        const id = refreshManual(db, src, record, nowIso);
        if (id === null) return;
        if (read.probe) applyProbe(db, id, read.probe);
        targets.set(row.id, { id, record, probe: read.probe, trackedBy: 'manual', problem: read.problem });
      }),
    );
  });
  return rows.flatMap((r) => targets.get(r.id) ?? []);
}

interface OpenPass {
  section: 'openPrs' | 'openIssues';
  table: 'pull_requests' | 'issues';
  /** The provider's open count from the probe; undefined when the probe failed. */
  expected: number | undefined;
  started: boolean;
  done: boolean;
  seen: Set<number>;
}

const openPass = (section: OpenPass['section'], table: OpenPass['table'], expected: number | undefined): OpenPass => ({
  section,
  table,
  expected,
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

/** A section the round asked for; the contract says it's there. */
function answered<K extends Section>(res: RoundResult, section: K): NonNullable<RoundResult[K]> {
  const page = res[section];
  if (!page) throw new Error(`The source answered a round without its ${section}`);
  return page as NonNullable<RoundResult[K]>;
}

/** Syncs one repo's sections, paging all active sections together in one round per page. Returns new items. */
async function syncRepo(deps: SyncDeps, t: RepoTarget, run: RunContext): Promise<number> {
  const { db, source } = deps;
  const { id, record: r } = t;
  const state = getSyncState(db, id);
  if (r.isArchived && state.synced_at && !run.full) return 0;

  const plan = planRepo(r, t.probe, state, {
    full: run.full,
    syncStars: t.trackedBy === 'owned',
    probesStars: source.probesStars,
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
  // The probe's newest releases we don't have: an incremental pass doesn't stop at a known release before it has them
  // (a draft published after a newer release was, say, is listed behind that one).
  const pendingTags = new Set(plan.releases?.stopAtKnown ? (t.probe?.releaseTags ?? []).filter((tag) => !releaseExists(db, id, tag)) : []);

  const advance = (section: Section, hasMore: boolean, endCursor: string | null, onDone: () => void) => {
    if (hasMore && endCursor) cursor[section] = endCursor;
    else {
      active.delete(section);
      onDone();
    }
  };

  // Open items older than the backfill window are missed by the updatedAt passes. Whenever our open count
  // differs from the provider's (checked after the updatedAt pass, or up front when there is none), list every
  // open item; stored-open items the provider doesn't list are re-read by number after the loop.
  const open = {
    prs: openPass('openPrs', 'pull_requests', t.probe?.openPrs),
    issues: openPass('openIssues', 'issues', t.probe?.openIssues),
  };
  const startOpenPassIfNeeded = (o: OpenPass) => {
    if (o.started) return;
    if (run.full || o.expected === undefined || storedOpenNumbers(db, id, o.table).length !== o.expected) {
      o.started = true;
      active.add(o.section);
    }
  };
  if (!plan.prs || run.full) startOpenPassIfNeeded(open.prs);
  if (!plan.issues || run.full) startOpenPassIfNeeded(open.issues);

  while (active.size > 0) {
    // What this round asks for. An open pass started while its answer is read waits for the next round.
    const asked = new Set(active);
    const req: RoundRequest = {};
    for (const s of asked) {
      if (s === 'commits') req.commits = { after: cursor.commits, since: run.backfillStart };
      else req[s] = { after: cursor[s] };
    }
    const res = await source.round(r, req);

    writeTx(db, t, () => {
      if (asked.has('commits')) {
        const page = answered(res, 'commits');
        if (commitWalk.head === undefined) commitWalk.head = page.items[0]?.oid ?? null;
        let known = 0;
        let reachedPrevious = false;
        for (const c of page.items) {
          commitWalk.seen.push(c.oid);
          if (upsertCommit(db, id, c)) newItems++;
          else known++;
          if (c.oid === state.commits_head) reachedPrevious = true;
        }
        // Incremental walks stop at the head of the last complete walk; state from before commits_head existed
        // falls back to stopping at any stored commit.
        const stopped = plan.commits!.stopAtKnown && (state.commits_head ? reachedPrevious : known > 0);
        advance('commits', page.hasMore && !stopped, page.endCursor, () => {
          // A walk that went through the whole window has seen every commit on the branch since backfillStart.
          if (!stopped) pruneCommits(db, id, run.backfillStart, commitWalk.seen);
          updateSyncState(db, id, { commits_pushed_at: r.pushedAt, commits_branch: r.defaultBranch, commits_head: commitWalk.head ?? null });
        });
      }

      if (asked.has('prs')) {
        const page = answered(res, 'prs');
        let reachedOld = false;
        for (const p of page.items) {
          if (p.updatedAt < plan.prs!.stopBefore) {
            reachedOld = true;
            break;
          }
          if (upsertPr(db, id, p)) newItems++;
          if (!prsHwm || p.updatedAt > prsHwm) prsHwm = p.updatedAt;
        }
        advance('prs', page.hasMore && !reachedOld, page.endCursor, () => {
          updateSyncState(db, id, { prs_hwm: prsHwm ?? run.backfillStart });
          startOpenPassIfNeeded(open.prs);
        });
      }

      if (asked.has('issues')) {
        const page = answered(res, 'issues');
        let reachedOld = false;
        for (const i of page.items) {
          if (i.updatedAt < plan.issues!.stopBefore) {
            reachedOld = true;
            break;
          }
          if (upsertIssue(db, id, i)) newItems++;
          if (!issuesHwm || i.updatedAt > issuesHwm) issuesHwm = i.updatedAt;
        }
        advance('issues', page.hasMore && !reachedOld, page.endCursor, () => {
          updateSyncState(db, id, { issues_hwm: issuesHwm ?? run.backfillStart });
          startOpenPassIfNeeded(open.issues);
        });
      }

      if (asked.has('openPrs')) {
        const page = answered(res, 'openPrs');
        for (const p of page.items) {
          open.prs.seen.add(p.number);
          if (upsertPr(db, id, p)) newItems++;
        }
        advance('openPrs', page.hasMore, page.endCursor, () => (open.prs.done = true));
      }

      if (asked.has('openIssues')) {
        const page = answered(res, 'openIssues');
        for (const i of page.items) {
          open.issues.seen.add(i.number);
          if (upsertIssue(db, id, i)) newItems++;
        }
        advance('openIssues', page.hasMore, page.endCursor, () => (open.issues.done = true));
      }

      if (asked.has('releases')) {
        const page = answered(res, 'releases');
        let hitKnown = false;
        for (const rel of page.items) {
          if (plan.releases!.stopAtKnown && pendingTags.size === 0 && releaseExists(db, id, rel.tag)) {
            hitKnown = true;
            break;
          }
          if (upsertRelease(db, id, rel)) newItems++;
          pendingTags.delete(rel.tag);
        }
        const oldest = page.oldestCreatedAt;
        const more = page.hasMore && !hitKnown && !!oldest && oldest >= run.backfillStart;
        advance('releases', more, page.endCursor, () => updateSyncState(db, id, { releases_synced_at: run.nowIso }));
      }

      if (asked.has('stars')) {
        const page = answered(res, 'stars');
        const capped = page.totalCount >= FULL_STAR_DIFF_MAX;
        let stop = false;
        for (const s of page.items) {
          if (starsMode === 'incremental' && starExists(db, id, s.login)) {
            stop = true;
            break;
          }
          if (starsMode === 'full' && capped && s.starredAt < run.backfillStart) {
            stop = true;
            break;
          }
          if (upsertStar(db, id, s)) newItems++;
          starLogins.push(s.login);
        }
        advance('stars', page.hasMore && !stop, page.endCursor, () => {
          if (starsMode === 'full' && !capped) {
            deleteStarsExcept(db, id, starLogins);
            updateSyncState(db, id, { stars_full_at: run.nowIso });
          }
          updateSyncState(db, id, { stars_synced_at: run.nowIso, stars_count: r.stars });
        });
        // An incremental pass that leaves our count out of step with the provider's means stars were removed: diff once.
        if (!active.has('stars') && starsMode === 'incremental' && !capped && storedStarInfo(db, id).count !== page.totalCount) {
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
  if (!source.linksCommits) writeTx(db, t, () => linkCommitsToPrs(db, id));
  return newItems;
}

/**
 * Re-reads PRs / issues we have as open but the provider no longer lists as open (normally already fixed by the
 * updatedAt pass): updates them, or deletes them when they no longer exist in this repo (deleted/transferred).
 */
async function recheckItems(deps: SyncDeps, t: RepoTarget, prs: number[], issues: number[]): Promise<void> {
  if (!prs.length && !issues.length) return;
  const { db } = deps;
  const res = await deps.source.recheck(t.record, prs, issues);
  writeTx(db, t, () => {
    for (const n of prs) {
      const pr = res.prs.get(n);
      if (pr) upsertPr(db, t.id, pr);
      else if (pr === null) deleteItem(db, t.id, 'pull_requests', n);
    }
    for (const n of issues) {
      const issue = res.issues.get(n);
      if (issue) upsertIssue(db, t.id, issue);
      else if (issue === null) deleteItem(db, t.id, 'issues', n);
    }
  });
}
