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
import type { CacheKind, DiffCache } from './cache';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** GitHub lists at most this many files for a PR or commit. */
export const MAX_FILES = 3000;
/** File contents larger than this aren't served (they feed a diff viewer in the browser). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
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
  base: { sha: string };
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
  gz: Buffer;
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

export interface DiffServiceOptions {
  db: Db;
  cache: DiffCache;
  resolveToken: () => ResolvedToken;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

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

/** A repository-relative path: no empty, "." or ".." segments. */
function checkPath(value: string): void {
  if (!value || value.length > 4096 || value.includes('\0') || value.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new HttpError(400, 'Invalid path');
  }
}

/**
 * Diffs and file contents fetched from GitHub's REST API on demand (never during sync) and kept in the diff
 * cache. PR diffs are keyed by head commit, so an unchanged PR is served without any request; commits and
 * file contents at a commit never change.
 */
export class DiffService {
  private readonly db: Db;
  private readonly cache: DiffCache;
  private readonly opts: DiffServiceOptions;
  private readonly log: (line: string) => void;
  private clients: { rest: GitHubRestClient; graphql: GitHubClient } | null = null;
  /** Identical requests in flight share one fetch (a double click doesn't spend twice). */
  private readonly inflight = new Map<string, Promise<Payload>>();

  constructor(opts: DiffServiceOptions) {
    this.db = opts.db;
    this.cache = opts.cache;
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.log(line));
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

  /** Applies the size cap and drops entries of removed repos (at startup, after inserts, when the cap changes). */
  evict(): void {
    const repos = this.db.all<{ name: string }>('SELECT name FROM repos WHERE removed_at IS NULL').map((r) => r.name);
    const removed = this.cache.evict(this.maxBytes(), repos);
    if (removed) this.log(`[diff] evicted ${removed} cache entries`);
  }

  private async store(kind: CacheKind, key: string, repo: string, oid: string, text: string, number: number | null = null): Promise<Payload> {
    const gz = await gzip(text);
    // An entry that alone would fill most of the cache is served but not kept.
    if (gz.byteLength < this.maxBytes() / 2) {
      this.cache.put({ key, kind, repo, number, oid, data: gz });
      this.evict();
    }
    return { gz, text };
  }

  private cached(key: string): Payload | null {
    const gz = this.cache.get(key);
    return gz ? { gz } : null;
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private repo(name: string): RepoRow {
    const row = this.db.get<RepoRow>(
      'SELECT id, name, owner, name_with_owner AS nwo FROM repos WHERE name = ? AND removed_at IS NULL',
      [name],
    );
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
    return rows.length ? null : this.cache.findCommit(repo.name, oid);
  }

  private github(): { rest: GitHubRestClient; graphql: GitHubClient } {
    if (this.clients) return this.clients;
    const { token } = this.opts.resolveToken();
    if (!token) throw new HttpError(503, 'No GitHub token: set GITHUB_TOKEN or run `gh auth login`');
    // Explicit defaults: an undefined option would override the clients' own.
    const { fetchImpl = fetch, sleep = defaultSleep } = this.opts;
    this.clients = { rest: new GitHubRestClient({ token, fetchImpl, sleep }), graphql: new GitHubClient({ token, fetchImpl, sleep, maxAttempts: 2 }) };
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

  /** Runs a GitHub-backed fetch, mapping failures to API errors and logging what it cost. */
  private async fetching(label: string, fn: (rest: GitHubRestClient) => Promise<Payload>): Promise<Payload> {
    const gh = this.github();
    const started = Date.now();
    const before = gh.rest.requests + gh.graphql.requests;
    try {
      const out = await fn(gh.rest);
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
   * The PR's diff against its merge base. The synced head is trusted unless `refresh`; without one (not synced
   * yet, or refresh) a cached diff is revalidated with a conditional request that costs nothing when unchanged.
   */
  async prDiff(repoName: string, number: number, refresh = false): Promise<Payload> {
    const repo = this.repo(repoName);
    const row = this.db.get<{ head_oid: string | null }>('SELECT p.head_oid FROM pull_requests p WHERE p.repo_id = ? AND p.number = ?', [
      repo.id,
      number,
    ]);
    if (!row) throw new HttpError(404, 'Pull request not found');
    const key = (head: string) => `pr/${repo.name}/${number}/${head}`;
    const trusted = refresh ? null : row.head_oid;
    const hit = trusted ? this.cached(key(trusted)) : null;
    if (hit) return hit;

    return this.once(`pr/${repo.name}/${number}/${refresh}`, () =>
      this.fetching(`${repo.name}#${number}`, async (rest) => {
        const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
        const known = trusted ? null : this.cache.prHead(repo.name, number);
        if (known) {
          const head = await rest.sha(`${base}/commits/pull/${number}/head`, known);
          const again = head === known ? this.cached(key(head)) : null;
          if (again) return again;
        }
        const pull = await rest.json<RestPull>(`${base}/pulls/${number}`);
        const head = pull.head.sha;
        const current = this.cached(key(head));
        if (current) return current;
        // Three-dot diff: files are relative to the merge base. Any page but the first omits the compare's own file
        // list (up to 300 files with patches, ~1 MB for a big PR), so page 2 of 1-commit pages costs a few KB.
        const compare = await rest.json<RestCompare>(`${base}/compare/${pull.base.sha}...${head}`, { per_page: 1, page: 2 });
        const files = await rest.paginate<RestFile[], RestFile>(`${base}/pulls/${number}/files`, { per_page: 100 }, (page) => page, MAX_FILES);
        const diff: Diff = {
          kind: 'pr',
          repo: repo.name,
          number,
          title: pull.title,
          baseOid: compare.merge_base_commit.sha,
          headOid: head,
          files: files.items.map(toFile),
          totalFiles: pull.changed_files,
          additions: pull.additions,
          deletions: pull.deletions,
          fetchedAt: new Date().toISOString(),
          url: `${pull.html_url}/files`,
        };
        const out = await this.store('pr', key(head), repo.name, head, JSON.stringify(diff), number);
        this.cache.dropOtherHeads(repo.name, number, head);
        return out;
      }),
    );
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
      this.fetching(`${repo.name}@${ref.slice(0, 7)}`, async (rest) => {
        // Without per_page GitHub lists 300 files a page (per_page=100 would take 30 requests for 3000 files).
        const { first, items } = await rest
          .paginate<RestCommit, RestFile>(`/repos/${enc(repo.owner)}/${enc(repo.name)}/commits/${ref}`, {}, (page) => page.files ?? [], MAX_FILES)
          .catch((err: unknown) => {
            // An unknown SHA is a 422 "No commit found for SHA".
            if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) throw new HttpError(404, `Commit ${ref} not found on GitHub`);
            throw err;
          });
        const diff: Diff = {
          kind: 'commit',
          repo: repo.name,
          number: null,
          title: first.commit.message.split('\n')[0]!,
          baseOid: first.parents[0]?.sha ?? null,
          headOid: first.sha,
          files: items.map(toFile),
          totalFiles: items.length >= MAX_FILES ? await this.changedFiles(repo, first.sha, items.length) : items.length,
          additions: first.stats?.additions ?? items.reduce((n, f) => n + f.additions, 0),
          deletions: first.stats?.deletions ?? items.reduce((n, f) => n + f.deletions, 0),
          fetchedAt: new Date().toISOString(),
          url: first.html_url,
        };
        return this.store('commit', key(first.sha), repo.name, first.sha, JSON.stringify(diff));
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

  /** UTF-8 text of a file at a commit, for expanding diff context. */
  async blob(repoName: string, ref: string, path: string): Promise<Payload> {
    const short = hexOid(ref, 'ref');
    checkPath(path);
    const repo = this.repo(repoName);
    const sha = this.expandOid(repo, short) ?? short;
    const key = `blob/${repo.name}/${sha}/${path}`;
    const hit = this.cached(key);
    if (hit) return hit;

    return this.once(key, () =>
      this.fetching(`${repo.name}@${sha.slice(0, 7)}:${path}`, async (rest) => {
        const file = await rest
          .raw(`/repos/${enc(repo.owner)}/${enc(repo.name)}/contents/${path.split('/').map(enc).join('/')}`, { ref: sha }, MAX_BLOB_BYTES)
          .catch((err: unknown) => {
            if (err instanceof GitHubError && err.kind === 'not-found') throw new HttpError(404, `${path} not found at ${sha.slice(0, 7)}`);
            throw err;
          });
        if (!file.isFile) throw new HttpError(404, `${path} is not a file at ${sha.slice(0, 7)}`);
        if (file.tooLarge) throw new HttpError(413, `${path} is larger than ${MAX_BLOB_BYTES / MB} MB`);
        // Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
        if (file.bytes.subarray(0, 8000).includes(0)) throw new HttpError(415, `${path} is a binary file`);
        return this.store('blob', key, repo.name, sha, new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes));
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
