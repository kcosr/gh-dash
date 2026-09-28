import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import type { DiffCacheStats, Diff, DiffFile, DiffFileStatus } from '../../shared/api';
import { HttpError } from '../api/http';
import type { ResolvedToken } from '../config';
import type { Db } from '../db/db';
import { getSettings } from '../db/settings';
import { GitHubClient } from '../github/client';
import { GitHubRestClient } from '../github/rest';
import { defaultSleep, GitHubError } from '../github/transport';
import type { GqlRateLimit } from '../github/types';
import type { CacheEntry, DiffCache, PrEntry } from './cache';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** GitHub lists at most this many files for a PR or commit. */
export const MAX_FILES = 3000;
/** File contents larger than this aren't served (they feed a diff viewer in the browser). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
/** How long an open PR's cached diff is trusted before its merge base is re-checked: the base branch can move under an unchanged head. */
export const OPEN_PR_TTL_MS = 60 * 60_000;
/**
 * A diff build gives up after this. Deliberately longer than a reverse proxy's usual 60 s: a build that outlives its
 * request still lands in the cache, and the client's retry joins it in flight.
 */
const BUILD_TIMEOUT_MS = 120_000;
/** Full fetches of a PR diff before giving up on a PR that keeps changing underneath (each costs 3+ requests). */
const PR_SNAPSHOT_ATTEMPTS = 2;
/** After finding no token, don't run `gh auth token` (a blocking subprocess) again for this long. */
const NO_TOKEN_RETRY_MS = 30_000;
const MB = 1024 * 1024;

// GitHub REST shapes (only the fields used here).
interface RestFile {
  filename: string;
  previous_filename?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
}
interface RestPull {
  title: string;
  html_url: string;
  changed_files: number;
  additions: number;
  deletions: number;
  head: { sha: string };
  base: { sha: string; ref: string };
}
interface RestCommit {
  sha: string;
  html_url: string;
  commit: { message: string };
  parents: { sha: string }[];
  stats?: { additions: number; deletions: number };
  files?: RestFile[];
}
interface RestCompare {
  merge_base_commit: { sha: string };
}

// REST can't count a commit's files beyond the 3000 it lists; GraphQL can.
const CHANGED_FILES = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { changedFilesIfAvailable } } }
  rateLimit { limit remaining resetAt cost }
}`;
interface ChangedFilesData {
  repository: { object: { changedFilesIfAvailable?: number | null } | null } | null;
  rateLimit: GqlRateLimit;
}

/** A response body as stored in the cache (gzip), plus the plain text when it is at hand anyway. */
export interface Payload {
  gz: Uint8Array;
  text?: string;
}

export async function payloadText(p: Payload): Promise<string> {
  return p.text ?? (await gunzip(p.gz)).toString('utf8');
}

interface RepoRow {
  id: number;
  name: string;
  owner: string;
  nwo: string;
}

interface PrRow {
  head_oid: string | null;
  base_ref: string;
  state: 'open' | 'merged' | 'closed';
  updated_at: string;
}

export interface DiffServiceOptions {
  db: Db;
  cache: DiffCache;
  resolveToken: () => ResolvedToken;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  buildTimeoutMs?: number;
}

type Fetcher = (rest: GitHubRestClient, signal: AbortSignal) => Promise<Payload>;

const toFile = (f: RestFile): DiffFile => ({
  path: f.filename,
  previousPath: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
});

const enc = (segment: string) => encodeURIComponent(segment);

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

const noToken = () => new HttpError(503, 'No GitHub token: set GITHUB_TOKEN or run `gh auth login`');

/**
 * Diffs and file contents fetched from GitHub's REST API on demand (never during sync) and kept in the diff
 * cache. Commits and file contents at a full SHA never change; PR diffs are revalidated as described at prDiff.
 */
export class DiffService {
  private readonly db: Db;
  private readonly cache: DiffCache;
  private readonly opts: DiffServiceOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private clients: { rest: GitHubRestClient; graphql: GitHubClient } | null = null;
  private noTokenUntil = 0;
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

  /** Cache trouble (a full disk, another instance holding the lock too long) mustn't fail a request GitHub can answer. */
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
      const repos = this.db.all<{ name: string }>('SELECT name FROM repos WHERE removed_at IS NULL').map((r) => r.name);
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

  private repo(name: string): RepoRow {
    const row = this.db.get<RepoRow>('SELECT id, name, owner, name_with_owner AS nwo FROM repos WHERE name = ? AND removed_at IS NULL', [name]);
    if (!row) throw new HttpError(404, 'Repository not found');
    return row;
  }

  /** Full SHA for an abbreviated one, from synced commits or cached commit diffs, when unambiguous. */
  private expandOid(repo: RepoRow, oid: string): string | null {
    if (oid.length === 40) return oid;
    const rows = this.db.all<{ oid: string }>('SELECT oid FROM commits WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2', [
      repo.id,
      oid,
      `${oid}g`,
    ]);
    if (rows.length === 1) return rows[0]!.oid;
    return rows.length ? null : this.safely('lookup', () => this.cache.findCommit(repo.name, oid), null);
  }

  private github(): { rest: GitHubRestClient; graphql: GitHubClient } {
    if (this.clients) return this.clients;
    if (this.now() < this.noTokenUntil) throw noToken();
    const { token } = this.opts.resolveToken();
    if (!token) {
      this.noTokenUntil = this.now() + NO_TOKEN_RETRY_MS;
      throw noToken();
    }
    // Explicit defaults: an undefined option would override the clients' own.
    const { fetchImpl = fetch, sleep = defaultSleep } = this.opts;
    this.clients = {
      rest: new GitHubRestClient({ token, fetchImpl, sleep }),
      graphql: new GitHubClient({ token, fetchImpl, sleep, maxAttempts: 2, maxRetryWaitMs: 10_000 }),
    };
    return this.clients;
  }

  private once(key: string, fn: () => Promise<Payload>): Promise<Payload> {
    let p = this.inflight.get(key);
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Runs a GitHub-backed fetch under the build deadline, mapping failures to API errors and logging what it cost. */
  private async fetching(label: string, fn: Fetcher): Promise<Payload> {
    const gh = this.github();
    const started = Date.now();
    const before = gh.rest.requests + gh.graphql.requests;
    try {
      const out = await fn(gh.rest, AbortSignal.timeout(this.opts.buildTimeoutMs ?? BUILD_TIMEOUT_MS));
      const rl = gh.rest.rateLimit;
      const requests = gh.rest.requests + gh.graphql.requests - before;
      if (requests) {
        this.log(
          `[diff] ${label}: ${requests} GitHub request${requests === 1 ? '' : 's'} in ${((Date.now() - started) / 1000).toFixed(1)}s` +
            (rl ? ` (${rl.remaining}/${rl.limit} left)` : ''),
        );
      }
      return out;
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      this.log(`[diff] ${label} failed: ${err.message}`);
      if (err.kind === 'auth') this.clients = null; // pick up a new token next time
      throw httpError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // PR diffs
  // ---------------------------------------------------------------------------

  /**
   * The PR's diff against its merge base (three-dot, like GitHub's "Files changed"). A cached diff depends on the
   * head, the merge base and the PR's own fields (title), and is served without asking GitHub while, per the last sync:
   * the head is the cached one, the base branch is the same, the PR hasn't been updated since the diff was fetched
   * (pushes, retargets and edits all bump updatedAt), and the PR is merged/closed (final) or the diff is younger than
   * OPEN_PR_TTL_MS (the base branch can absorb head commits, moving the merge base, without touching the PR).
   * Otherwise, and always with `refresh`, it is revalidated: `pulls/N` and the merge base (2 requests), and the files
   * are fetched again only if the head or merge base changed. A head the sync hasn't seen yet is first checked with a
   * conditional request, which costs nothing when unchanged.
   *
   * Fetched files are only served (and cached) once a conditional re-read of `pulls/N` confirms that the head, base
   * branch and merge base didn't change during pagination. A cache miss therefore costs `pulls/N`, the merge base,
   * one request per 100 files and a (normally free) 304. If the PR did change, the diff is rebuilt from the fresh
   * metadata, up to PR_SNAPSHOT_ATTEMPTS times in all, and then fails with a retryable 502.
   */
  async prDiff(repoName: string, number: number, refresh = false): Promise<Payload> {
    const repo = this.repo(repoName);
    const pr = this.db.get<PrRow>('SELECT head_oid, base_ref, state, updated_at FROM pull_requests WHERE repo_id = ? AND number = ?', [
      repo.id,
      number,
    ]);
    if (!pr) throw new HttpError(404, 'Pull request not found');
    const entry = this.safely('lookup', () => this.cache.prEntry(repo.name, number), null);
    const current = !refresh && entry && this.stillCurrent(entry, pr) ? entry : null;
    if (current && current.oid === pr.head_oid) {
      const hit = this.cached(current.key);
      if (hit) return hit;
    }

    const fetched = this.once(`pr/${repo.name}/${number}/${refresh}`, () =>
      this.fetching(`${repo.name}#${number}`, async (rest, signal) => {
        const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
        if (current && (await rest.sha(`${base}/commits/pull/${number}/head`, current.oid, { signal })) === current.oid) {
          const hit = this.cached(current.key);
          if (hit) return hit;
        }
        const mergeBases = new Map<string, Promise<string>>();
        // Any page but the first omits the compare's own file list (up to 300 files with patches, ~1 MB for a big PR),
        // so page 2 of 1-commit pages costs a few KB. The merge base is a function of (base.sha, head).
        const mergeBaseOf = (p: RestPull) => {
          const range = `${p.base.sha}...${p.head.sha}`;
          if (!mergeBases.has(range)) {
            const compare = rest.json<RestCompare>(`${base}/compare/${range}`, { query: { per_page: 1, page: 2 }, signal });
            mergeBases.set(range, compare.then((c) => c.merge_base_commit.sha));
          }
          return mergeBases.get(range)!;
        };
        const save = async (p: RestPull, mergeBase: string, diff: Diff) => {
          const key = `pr/${repo.name}/${number}/${p.head.sha}`;
          const entry = { key, kind: 'pr' as const, repo: repo.name, number, oid: p.head.sha, baseRef: p.base.ref, baseOid: mergeBase, fetchedAt: this.now() };
          const out = await this.store(entry, JSON.stringify(diff));
          this.safely('cleanup', () => this.cache.dropOthers(repo.name, number, key), undefined);
          return out;
        };
        const fieldsOf = (p: RestPull) => ({
          title: p.title,
          totalFiles: p.changed_files,
          additions: p.additions,
          deletions: p.deletions,
          fetchedAt: new Date(this.now()).toISOString(),
          url: `${p.html_url}/files`,
        });

        const pullPath = `${base}/pulls/${number}`;
        let pull = (await rest.versioned<RestPull>(pullPath, null, { signal }))!;
        for (let attempt = 1; ; attempt++) {
          const head = pull.body.head.sha;
          const mergeBase = await mergeBaseOf(pull.body);
          // Same head and merge base as the cached diff: its files still apply; refresh the PR's own fields only.
          const same = entry && entry.oid === head && entry.baseOid === mergeBase ? this.cached(entry.key) : null;
          if (same) return save(pull.body, mergeBase, { ...(JSON.parse(await payloadText(same)) as Diff), ...fieldsOf(pull.body) });

          const files = await rest.paginate<RestFile[], RestFile>(`${base}/pulls/${number}/files`, (page) => page, MAX_FILES, {
            query: { per_page: 100 },
            signal,
          });
          // `pulls/N/files` is pinned to neither head nor base: a push, retarget or moved merge base during pagination
          // would mix pages or label files with the wrong sides. Re-read the PR: a 304 (free) proves head and base
          // unchanged; otherwise the head and base branch must match, and the merge base unless base.sha is the same.
          const after = await rest.versioned<RestPull>(pullPath, pull.etag, { signal });
          const latest = after?.body ?? pull.body;
          const consistent =
            latest.head.sha === head &&
            latest.base.ref === pull.body.base.ref &&
            (latest.base.sha === pull.body.base.sha || (await mergeBaseOf(latest)) === mergeBase);
          if (consistent) {
            const fields = fieldsOf(latest);
            return save(latest, mergeBase, {
              kind: 'pr', repo: repo.name, number, title: fields.title, baseOid: mergeBase, headOid: head, files: files.items.map(toFile),
              totalFiles: fields.totalFiles, additions: fields.additions, deletions: fields.deletions, fetchedAt: fields.fetchedAt, url: fields.url,
            });
          }
          this.log(`[diff] ${repo.name}#${number} changed while its files were being fetched (attempt ${attempt} of ${PR_SNAPSHOT_ATTEMPTS})`);
          // Never serve a mixed snapshot: start over from the fresh metadata, or give up with a retryable error.
          if (attempt >= PR_SNAPSHOT_ATTEMPTS) throw new HttpError(502, 'The pull request changed while its diff was being fetched; try again');
          pull = after!;
        }
      }),
    );
    // When GitHub can't be asked, a cached copy that agrees with the last sync (same head and base branch) beats an
    // error. refresh=1 wants GitHub's answer, so it fails instead.
    if (refresh || !entry || entry.oid !== pr.head_oid || entry.baseRef !== pr.base_ref) return fetched;
    return fetched.catch((err: unknown) => this.staleCopy(err, entry.key, `${repo.name}#${number}`));
  }

  /**
   * The cached payload under `key` marked `stale: true`, for a fetch that failed with `err` because GitHub couldn't
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
    const repo = this.repo(repoName);
    const full = this.expandOid(repo, short);
    const key = (sha: string) => `commit/${repo.name}/${sha}`;
    const hit = full && !refresh ? this.cached(key(full)) : null;
    if (hit) return hit;

    const ref = full ?? short;
    return this.once(`commit/${repo.name}/${ref}/${refresh}`, () =>
      this.fetching(`${repo.name}@${ref.slice(0, 7)}`, async (rest, signal) => {
        // Without per_page GitHub lists 300 files a page (per_page=100 would take 30 requests for 3000 files).
        const { first, items } = await rest
          .paginate<RestCommit, RestFile>(`/repos/${enc(repo.owner)}/${enc(repo.name)}/commits/${ref}`, (page) => page.files ?? [], MAX_FILES, { signal })
          .catch((err: unknown) => {
            // An unknown SHA is a 422 "No commit found for SHA".
            if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) throw new HttpError(404, `Commit ${ref} not found on GitHub`);
            throw err;
          });
        const diff: Diff = {
          kind: 'commit',
          repo: repo.name,
          number: null,
          title: first.commit.message.split('\n')[0]!.replace(/\r$/, ''),
          baseOid: first.parents[0]?.sha ?? null,
          headOid: first.sha,
          files: items.map(toFile),
          totalFiles: items.length >= MAX_FILES ? await this.changedFiles(repo, first.sha, items.length) : items.length,
          additions: first.stats?.additions ?? items.reduce((n, f) => n + f.additions, 0),
          deletions: first.stats?.deletions ?? items.reduce((n, f) => n + f.deletions, 0),
          fetchedAt: new Date(this.now()).toISOString(),
          url: first.html_url,
        };
        const entry = { key: key(first.sha), kind: 'commit' as const, repo: repo.name, oid: first.sha, fetchedAt: this.now() };
        return this.store(entry, JSON.stringify(diff));
      }),
    );
  }

  /** The real file count of a commit whose list GitHub capped (1 GraphQL point); `fallback` if unavailable. */
  private async changedFiles(repo: RepoRow, sha: string, fallback: number): Promise<number> {
    try {
      const data = await this.github().graphql.query<ChangedFilesData>(CHANGED_FILES, { owner: repo.owner, name: repo.name, oid: sha });
      return Math.max(fallback, data.repository?.object?.changedFilesIfAvailable ?? fallback);
    } catch (err) {
      this.log(`[diff] could not count the files of ${repo.name}@${sha.slice(0, 7)}: ${(err as Error).message}`);
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // File contents
  // ---------------------------------------------------------------------------

  /** UTF-8 text of a file at a commit, for expanding diff context. Only contents at a full SHA are cached. */
  async blob(repoName: string, ref: string, path: string): Promise<Payload> {
    const short = hexOid(ref, 'ref');
    checkPath(path);
    const repo = this.repo(repoName);
    const sha = this.expandOid(repo, short) ?? short;
    const key = `blob/${repo.name}/${sha}/${path}`;
    const hit = sha.length === 40 ? this.cached(key) : null;
    if (hit) return hit;

    return this.once(key, () =>
      this.fetching(`${repo.name}@${sha.slice(0, 7)}:${path}`, async (rest, signal) => {
        const file = await rest
          .raw(`/repos/${enc(repo.owner)}/${enc(repo.name)}/contents/${path.split('/').map(enc).join('/')}`, MAX_BLOB_BYTES, { query: { ref: sha }, signal })
          .catch((err: unknown) => {
            if (err instanceof GitHubError && err.kind === 'not-found') throw new HttpError(404, `${path} not found at ${sha.slice(0, 7)}`);
            throw err;
          });
        if (!file.isFile) throw new HttpError(404, `${path} is not a file at ${sha.slice(0, 7)}`);
        if (file.tooLarge) throw new HttpError(413, `${path} is larger than ${MAX_BLOB_BYTES / MB} MB`);
        // Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
        if (file.bytes.subarray(0, 8000).includes(0)) throw new HttpError(415, `${path} is a binary file`);
        // What a short ref names isn't fixed (it can become ambiguous, or name another commit later): don't keep it.
        const entry = sha.length === 40 ? { key, kind: 'blob' as const, repo: repo.name, oid: sha, fetchedAt: this.now() } : null;
        return this.store(entry, new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes));
      }),
    );
  }
}

/** GitHub failures as API errors: 404 missing, 429 rate limited (with the reset time), 503 token problems, else 502. */
function httpError(err: GitHubError): HttpError {
  switch (err.kind) {
    case 'not-found':
      return new HttpError(404, `Not found on GitHub: ${err.message}`);
    case 'rate-limit':
      return new HttpError(429, err.message, { resetAt: err.resetAt });
    case 'auth':
      return new HttpError(503, `${err.message}; check GITHUB_TOKEN or run \`gh auth login\``);
    default:
      return new HttpError(502, err.message);
  }
}
