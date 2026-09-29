import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import type { DiffCacheStats, Diff } from '../../shared/api';
import { HttpError } from '../api/http';
import type { Db } from '../db/db';
import { repoKeySql, resolveRepo } from '../db/repo-key';
import { getSettings } from '../db/settings';
import { SourceError } from '../provider/errors';
import type { DiffRepo, DiffSource, PrRevision, ProviderKind } from '../provider/types';
import type { CacheEntry, DiffCache, PrEntry } from './cache';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** File contents larger than this aren't served (they feed a diff viewer in the browser). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
/** How long an open PR's cached diff is trusted before its merge base is re-checked: the base branch can move under an unchanged head. */
export const OPEN_PR_TTL_MS = 60 * 60_000;
/**
 * A diff build gives up after this. Deliberately longer than a reverse proxy's usual 60 s: a build that outlives its
 * request still lands in the cache, and the client's retry joins it in flight.
 */
const BUILD_TIMEOUT_MS = 120_000;
const MB = 1024 * 1024;

/** How messages name each provider. */
const HOSTS: Record<ProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** A response body as stored in the cache (gzip), plus the plain text when it is at hand anyway. */
export interface Payload {
  gz: Uint8Array;
  text?: string;
}

export async function payloadText(p: Payload): Promise<string> {
  return p.text ?? (await gunzip(p.gz)).toString('utf8');
}

interface PrRow {
  head_oid: string | null;
  base_ref: string;
  state: 'open' | 'merged' | 'closed';
  updated_at: string;
}

/** Where the diff service gets the source each fetch asks. */
export interface DiffSources {
  /** Rejects with a SourceError when there is none to use (say, no token): the API answers 503 with its message. */
  get(): Promise<DiffSource>;
  /** `source` failed to authenticate (a revoked or replaced token): don't hand it out again. */
  authFailed(source: DiffSource): void;
}

export interface DiffServiceOptions {
  db: Db;
  cache: DiffCache;
  sources: DiffSources;
  log?: (line: string) => void;
  now?: () => number;
  buildTimeoutMs?: number;
}

type Fetcher = (source: DiffSource, signal: AbortSignal) => Promise<Payload>;

function hexOid(value: string, what: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new HttpError(400, `Invalid ${what}: expected 7-40 hex characters`);
  return value.toLowerCase();
}

/** A repository-relative path: no empty, "." or ".." segments, and no control characters (they'd end up in logs). */
function checkPath(value: string): void {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new HttpError(400, 'Invalid path');
  }
}

/**
 * Diffs and file contents fetched from the code host on demand (never during sync) and kept in the diff cache. Commits
 * and file contents at a full SHA never change; PR diffs are revalidated as described at prDiff. A DiffSource does the
 * asking; this decides when to ask, and what the API answers.
 */
export class DiffService {
  private readonly db: Db;
  private readonly cache: DiffCache;
  private readonly opts: DiffServiceOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Identical requests in flight share one fetch (a double click doesn't spend twice). */
  private readonly inflight = new Map<string, Promise<Payload>>();

  constructor(opts: DiffServiceOptions) {
    this.db = opts.db;
    this.cache = opts.cache;
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Cache housekeeping
  // ---------------------------------------------------------------------------

  private maxBytes(): number {
    return getSettings(this.db).diffCacheMb * MB;
  }

  stats(): DiffCacheStats {
    return { ...this.cache.stats(), maxBytes: this.maxBytes() };
  }

  clear(): DiffCacheStats {
    this.cache.clear();
    return this.stats();
  }

  /** Cache trouble (a full disk, another instance holding the lock too long) mustn't fail a request the host can answer. */
  private safely<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.log(`[diff] cache ${what} failed: ${(err as Error).message}`);
      return fallback;
    }
  }

  /** Applies the size cap and drops entries of removed repos (at startup, after inserts, when the cap changes). */
  evict(): void {
    this.safely('eviction', () => {
      const repos = this.db.all<{ key: string }>(`SELECT ${repoKeySql('repos')} AS key FROM repos WHERE removed_at IS NULL`).map((r) => r.key);
      const removed = this.cache.evict(this.maxBytes(), repos);
      if (removed) this.log(`[diff] evicted ${removed} cache entries`);
    }, undefined);
  }

  /** Compresses `text` and caches it under `entry` (null: serve only). */
  private async store(entry: Omit<CacheEntry, 'data'> | null, text: string): Promise<Payload> {
    const gz = await gzip(text);
    // An entry that alone would fill most of the cache is served but not kept.
    if (entry && gz.byteLength < this.maxBytes() / 2) {
      this.safely('write', () => this.cache.put({ ...entry, data: gz }), undefined);
      this.evict();
    }
    return { gz, text };
  }

  private cached(key: string): Payload | null {
    return this.safely('read', () => {
      const gz = this.cache.get(key);
      return gz ? { gz } : null;
    }, null);
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /** A tracked repository by its key: its row id (synced PRs and commits hang off it) and what sources are told. */
  private repo(key: string): { id: number; repo: DiffRepo } {
    const ref = resolveRepo(this.db, key);
    if (!ref) throw new HttpError(404, 'Repository not found');
    return { id: ref.id, repo: { key: ref.key, owner: ref.owner, name: ref.name, path: ref.path } };
  }

  /** Full SHA for an abbreviated one, from synced commits or cached commit diffs, when unambiguous. */
  private expandOid(id: number, repo: DiffRepo, oid: string): string | null {
    if (oid.length === 40) return oid;
    const rows = this.db.all<{ oid: string }>('SELECT oid FROM commits WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2', [
      id,
      oid,
      `${oid}g`,
    ]);
    if (rows.length === 1) return rows[0]!.oid;
    return rows.length ? null : this.safely('lookup', () => this.cache.findCommit(repo.key, oid), null);
  }

  /** The source for a fetch; none to use (say, no token) is a 503 with the reason. */
  private async source(): Promise<DiffSource> {
    try {
      return await this.opts.sources.get();
    } catch (err) {
      throw err instanceof SourceError ? new HttpError(503, err.message) : err;
    }
  }

  private once(key: string, fn: () => Promise<Payload>): Promise<Payload> {
    let p = this.inflight.get(key);
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Runs a fetch from the source under the build deadline, mapping failures to API errors and logging what it cost. */
  private async fetching(label: string, fn: Fetcher): Promise<Payload> {
    const source = await this.source();
    const started = Date.now();
    const before = source.requests;
    try {
      const out = await fn(source, AbortSignal.timeout(this.opts.buildTimeoutMs ?? BUILD_TIMEOUT_MS));
      const rl = source.rateLimit;
      const requests = source.requests - before;
      if (requests) {
        this.log(
          `[diff] ${label}: ${requests} ${HOSTS[source.kind]} request${requests === 1 ? '' : 's'} in ${((Date.now() - started) / 1000).toFixed(1)}s` +
            (rl ? ` (${rl.remaining}/${rl.limit} left)` : ''),
        );
      }
      return out;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      this.log(`[diff] ${label} failed: ${err.message}`);
      // Revoked or replaced: resolve the credentials again next time.
      if (err.kind === 'auth') this.opts.sources.authFailed(source);
      throw httpError(err, source);
    }
  }

  // ---------------------------------------------------------------------------
  // PR diffs
  // ---------------------------------------------------------------------------

  /**
   * The PR's diff against its merge base (three-dot, like the host's "Files changed"). A cached diff depends on the
   * head, the merge base and the PR's own fields (title), and is served without asking the host while, per the last
   * sync: the head is the cached one, the base branch is the same, the PR hasn't been updated since the diff was fetched
   * (pushes, retargets and edits all bump updatedAt), and the PR is merged/closed (final) or the diff is younger than
   * OPEN_PR_TTL_MS (the base branch can absorb head commits, moving the merge base, without touching the PR).
   * Otherwise, and always with `refresh`, it is revalidated: the PR's revision is read again (GitHub: `pulls/N` and the
   * merge base, 2 requests), and the files are fetched again only if the head or merge base changed. A head the sync
   * hasn't seen yet is first checked cheaply if the source can (GitHub: a conditional request, free when unchanged).
   *
   * Fetched files are only served (and cached) as one consistent snapshot, which the source's prFiles guarantees: a PR
   * that changes while its files are fetched is started over from the fresh revision, and one that keeps changing fails
   * with a retryable 502.
   */
  async prDiff(repoName: string, number: number, refresh = false): Promise<Payload> {
    const { id, repo } = this.repo(repoName);
    const pr = this.db.get<PrRow>('SELECT head_oid, base_ref, state, updated_at FROM pull_requests WHERE repo_id = ? AND number = ?', [
      id,
      number,
    ]);
    if (!pr) throw new HttpError(404, 'Pull request not found');
    const entry = this.safely('lookup', () => this.cache.prEntry(repo.key, number), null);
    const current = !refresh && entry && this.stillCurrent(entry, pr) ? entry : null;
    if (current && current.oid === pr.head_oid) {
      const hit = this.cached(current.key);
      if (hit) return hit;
    }

    const fetched = this.once(`pr/${repo.key}/${number}/${refresh}`, () =>
      this.fetching(`${repo.key}#${number}`, async (source, signal) => {
        if (current && (await source.prHeadIs(repo, number, current.oid, signal))) {
          const hit = this.cached(current.key);
          if (hit) return hit;
        }
        const rev = await source.prRevision(repo, number, signal);
        // Same head and merge base as the cached diff: its files still apply; refresh the PR's own fields only.
        const same = entry && entry.oid === rev.headOid && entry.baseOid === rev.baseOid ? this.cached(entry.key) : null;
        if (same) return this.savePr(repo, number, rev, { ...(JSON.parse(await payloadText(same)) as Diff), ...this.prFields(rev) });

        const snapshot = await source.prFiles(repo, number, rev, signal);
        const { title, totalFiles, additions, deletions, fetchedAt, url } = this.prFields(snapshot.rev);
        return this.savePr(repo, number, snapshot.rev, {
          kind: 'pr', repo: repo.key, number, title, baseOid: snapshot.rev.baseOid, headOid: snapshot.rev.headOid, files: snapshot.files,
          totalFiles, additions, deletions, fetchedAt, url,
        });
      }),
    );
    // When the host can't be asked, a cached copy that agrees with the last sync (same head and base branch) beats an
    // error. refresh=1 wants the host's answer, so it fails instead.
    if (refresh || !entry || entry.oid !== pr.head_oid || entry.baseRef !== pr.base_ref) return fetched;
    return fetched.catch((err: unknown) => this.staleCopy(err, entry.key, `${repo.key}#${number}`));
  }

  /** The diff's fields that come from the PR itself, as of `rev`. */
  private prFields(rev: PrRevision) {
    return {
      title: rev.title,
      totalFiles: rev.totalFiles,
      additions: rev.additions,
      deletions: rev.deletions,
      fetchedAt: new Date(this.now()).toISOString(),
      url: rev.url,
    };
  }

  /** Caches `diff` as the PR's diff at `rev`, superseding its other cached diffs. */
  private async savePr(repo: DiffRepo, number: number, rev: PrRevision, diff: Diff): Promise<Payload> {
    const key = `pr/${repo.key}/${number}/${rev.headOid}`;
    const entry = { key, kind: 'pr' as const, repo: repo.key, number, oid: rev.headOid, baseRef: rev.baseRef, baseOid: rev.baseOid, fetchedAt: this.now() };
    const out = await this.store(entry, JSON.stringify(diff));
    this.safely('cleanup', () => this.cache.dropOthers(repo.key, number, key), undefined);
    return out;
  }

  /**
   * The cached payload under `key` marked `stale: true`, for a fetch that failed with `err` because the host couldn't
   * answer: no token (503), rate limited (429) or failing (502). Any other error, or a cache miss, rethrows `err`.
   */
  private async staleCopy(err: unknown, key: string, label: string): Promise<Payload> {
    if (!(err instanceof HttpError) || ![429, 502, 503].includes(err.status)) throw err;
    const hit = this.cached(key);
    if (!hit) throw err;
    this.log(`[diff] ${label}: serving the cached copy (${err.message})`);
    // A diff can be megabytes of JSON: patch the flag in before the closing brace rather than parse and re-serialize.
    const text = `${(await payloadText(hit)).slice(0, -1)},"stale":true}`;
    return { gz: await gzip(text), text };
  }

  /** Whether a cached PR diff still matches the PR as of the last sync (head aside: see prDiff). */
  private stillCurrent(e: PrEntry, pr: PrRow): boolean {
    if (e.baseRef !== pr.base_ref || Date.parse(pr.updated_at) > e.fetchedAt) return false;
    return pr.state !== 'open' || this.now() - e.fetchedAt < OPEN_PR_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Commit diffs
  // ---------------------------------------------------------------------------

  /** A commit's diff against its first parent. The commit needn't be synced (PR branch commits aren't). */
  async commitDiff(repoName: string, oid: string, refresh = false): Promise<Payload> {
    const short = hexOid(oid, 'commit');
    const { id, repo } = this.repo(repoName);
    const full = this.expandOid(id, repo, short);
    const key = (sha: string) => `commit/${repo.key}/${sha}`;
    const hit = full && !refresh ? this.cached(key(full)) : null;
    if (hit) return hit;

    const ref = full ?? short;
    return this.once(`commit/${repo.key}/${ref}/${refresh}`, () =>
      this.fetching(`${repo.key}@${ref.slice(0, 7)}`, async (source, signal) => {
        const commit = await source.commit(repo, ref, signal).catch((err: unknown) => {
          if (err instanceof SourceError && err.kind === 'not-found') throw new HttpError(404, `Commit ${ref} not found on ${HOSTS[source.kind]}`);
          throw err;
        });
        const diff: Diff = {
          kind: 'commit', repo: repo.key, number: null, title: commit.title, baseOid: commit.baseOid, headOid: commit.headOid, files: commit.files,
          totalFiles: commit.totalFiles, additions: commit.additions, deletions: commit.deletions, fetchedAt: new Date(this.now()).toISOString(),
          url: commit.url,
        };
        const entry = { key: key(commit.headOid), kind: 'commit' as const, repo: repo.key, oid: commit.headOid, fetchedAt: this.now() };
        return this.store(entry, JSON.stringify(diff));
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // File contents
  // ---------------------------------------------------------------------------

  /** UTF-8 text of a file at a commit, for expanding diff context. Only contents at a full SHA are cached. */
  async blob(repoName: string, ref: string, path: string): Promise<Payload> {
    const short = hexOid(ref, 'ref');
    checkPath(path);
    const { id, repo } = this.repo(repoName);
    const sha = this.expandOid(id, repo, short) ?? short;
    const key = `blob/${repo.key}/${sha}/${path}`;
    const hit = sha.length === 40 ? this.cached(key) : null;
    if (hit) return hit;

    return this.once(key, () =>
      this.fetching(`${repo.key}@${sha.slice(0, 7)}:${path}`, async (source, signal) => {
        const file = await source.blob(repo, sha, path, MAX_BLOB_BYTES, signal).catch((err: unknown) => {
          if (err instanceof SourceError && err.kind === 'not-found') throw new HttpError(404, `${path} not found at ${sha.slice(0, 7)}`);
          throw err;
        });
        if (file.kind === 'not-file') throw new HttpError(404, `${path} is not a file at ${sha.slice(0, 7)}`);
        if (file.kind === 'too-large') throw new HttpError(413, `${path} is larger than ${MAX_BLOB_BYTES / MB} MB`);
        // Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
        if (file.bytes.subarray(0, 8000).includes(0)) throw new HttpError(415, `${path} is a binary file`);
        // What a short ref names isn't fixed (it can become ambiguous, or name another commit later): don't keep it.
        const entry = sha.length === 40 ? { key, kind: 'blob' as const, repo: repo.key, oid: sha, fetchedAt: this.now() } : null;
        return this.store(entry, new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes));
      }),
    );
  }
}

/** Source failures as API errors: 404 missing, 429 rate limited (with the reset time), 503 token problems, else 502. */
function httpError(err: SourceError, source: DiffSource): HttpError {
  switch (err.kind) {
    case 'not-found':
      return new HttpError(404, `Not found on ${HOSTS[source.kind]}: ${err.message}`);
    case 'rate-limit':
      return new HttpError(429, err.message, { resetAt: err.resetAt });
    case 'auth':
      return new HttpError(503, `${err.message}; ${source.authHint}`);
    default:
      return new HttpError(502, err.message);
  }
}
