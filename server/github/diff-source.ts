// GitHub behind the provider-neutral DiffSource: PR and commit diffs from the REST API (plus a GraphQL file count), and
// raw file contents. The diff service decides when to ask and what the API answers; this only knows how to ask GitHub.

import type { DiffFile, DiffFileStatus } from '../../shared/api';
import type { DiffSources } from '../diff/service';
import { defaultSleep } from '../provider/transport';
import type { BlobResult, CommitDiff, DiffRepo, DiffSource, PrRevision, RateLimitInfo } from '../provider/types';
import { noTokenMessage, type TokenSupply } from '../token';
import { GitHubClient } from './client';
import { GitHubRestClient } from './rest';
import { GitHubError } from './transport';
import type { GqlRateLimit } from './types';

/** GitHub lists at most this many files for a PR or commit. */
const MAX_FILES = 3000;
/** Full fetches of a PR's files before giving up on a PR that keeps changing underneath (each costs 2+ requests). */
const PR_SNAPSHOT_ATTEMPTS = 2;

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

/** `pulls/N` with its ETag: a PrRevision's handle, for the conditional re-read that proves a snapshot of its files. */
interface Pull {
  body: RestPull;
  etag: string | null;
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

const toFile = (f: RestFile): DiffFile => ({
  path: f.filename,
  previousPath: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
});

const enc = (segment: string) => encodeURIComponent(segment);
const repoPath = (repo: DiffRepo) => `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
/** The compare that yields a PR's merge base, which is a function of (base.sha, head). */
const rangeOf = (p: RestPull) => `${p.base.sha}...${p.head.sha}`;

function revision(pull: Pull, mergeBase: string): PrRevision {
  const p = pull.body;
  return {
    headOid: p.head.sha,
    baseRef: p.base.ref,
    baseOid: mergeBase,
    title: p.title,
    totalFiles: p.changed_files,
    additions: p.additions,
    deletions: p.deletions,
    url: `${p.html_url}/files`,
    handle: pull,
  };
}

export interface GitHubDiffSourceOptions {
  rest: GitHubRestClient;
  /** Only for counting the files of a commit whose list GitHub capped. */
  graphql: GitHubClient;
  log?: (line: string) => void;
}

export class GitHubDiffSource implements DiffSource {
  readonly kind = 'github' as const;
  readonly authHint = 'check GITHUB_TOKEN or run `gh auth login`';
  readonly maxFiles = MAX_FILES;
  private readonly rest: GitHubRestClient;
  private readonly graphql: GitHubClient;
  private readonly log: (line: string) => void;

  constructor(opts: GitHubDiffSourceOptions) {
    this.rest = opts.rest;
    this.graphql = opts.graphql;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  get requests(): number {
    return this.rest.requests + this.graphql.requests;
  }

  /** REST's hourly bucket, which every request but the occasional file count spends. */
  get rateLimit(): RateLimitInfo | null {
    return this.rest.rateLimit;
  }

  /** A conditional request for the head's SHA: a 304, which GitHub doesn't count, while it is still `knownHead`. */
  async prHeadIs(repo: DiffRepo, number: number, knownHead: string, signal: AbortSignal): Promise<boolean> {
    return (await this.rest.sha(`${repoPath(repo)}/commits/pull/${number}/head`, knownHead, { signal })) === knownHead;
  }

  /** `pulls/N` and its merge base: 2 requests. */
  async prRevision(repo: DiffRepo, number: number, signal: AbortSignal): Promise<PrRevision> {
    const pull = (await this.rest.versioned<RestPull>(`${repoPath(repo)}/pulls/${number}`, null, { signal }))!;
    return revision(pull, await this.mergeBase(repo, pull.body, signal));
  }

  /**
   * `pulls/N/files` is pinned to neither head nor base: a push, retarget or moved merge base during pagination would mix
   * pages or label files with the wrong sides. So the files are only returned once a conditional re-read of `pulls/N`
   * confirms that the head, base branch and merge base didn't change meanwhile: a 304 (free) proves head and base
   * unchanged; otherwise the head and base branch must match, and the merge base unless base.sha is the same. A
   * snapshot therefore costs one request per 100 files and a (normally free) 304. If the PR did change, this starts over
   * from the fresh metadata, up to PR_SNAPSHOT_ATTEMPTS times in all, and then fails as 'transient' (a retryable 502).
   */
  async prFiles(repo: DiffRepo, number: number, rev: PrRevision, signal: AbortSignal): Promise<{ rev: PrRevision; files: DiffFile[] }> {
    const pullPath = `${repoPath(repo)}/pulls/${number}`;
    let pull = rev.handle as Pull;
    // Starting with `rev`'s own: a retarget to a branch at the same commit restarts on a range already asked about.
    const mergeBases = new Map([[rangeOf(pull.body), Promise.resolve(rev.baseOid)]]);
    const mergeBaseOf = (p: RestPull) => {
      const range = rangeOf(p);
      if (!mergeBases.has(range)) mergeBases.set(range, this.mergeBase(repo, p, signal));
      return mergeBases.get(range)!;
    };
    for (let attempt = 1; ; attempt++) {
      const head = pull.body.head.sha;
      const mergeBase = await mergeBaseOf(pull.body);
      const files = await this.rest.paginate<RestFile[], RestFile>(`${pullPath}/files`, (page) => page, MAX_FILES, {
        query: { per_page: 100 },
        signal,
      });
      const after = await this.rest.versioned<RestPull>(pullPath, pull.etag, { signal });
      const latest = after ?? pull;
      const consistent =
        latest.body.head.sha === head &&
        latest.body.base.ref === pull.body.base.ref &&
        (latest.body.base.sha === pull.body.base.sha || (await mergeBaseOf(latest.body)) === mergeBase);
      if (consistent) return { rev: revision(latest, mergeBase), files: files.items.map(toFile) };
      this.log(`[diff] ${repo.key}#${number} changed while its files were being fetched (attempt ${attempt} of ${PR_SNAPSHOT_ATTEMPTS})`);
      // Never return a mixed snapshot: start over from the fresh metadata, or give up with a retryable error.
      if (attempt >= PR_SNAPSHOT_ATTEMPTS) throw new GitHubError('transient', 'The pull request changed while its diff was being fetched; try again');
      pull = after!;
    }
  }

  /**
   * Any compare page but the first omits the compare's own file list (up to 300 files with patches, ~1 MB for a big
   * PR), so page 2 of 1-commit pages costs a few KB.
   */
  private async mergeBase(repo: DiffRepo, p: RestPull, signal: AbortSignal): Promise<string> {
    const compare = await this.rest.json<RestCompare>(`${repoPath(repo)}/compare/${rangeOf(p)}`, { query: { per_page: 1, page: 2 }, signal });
    return compare.merge_base_commit.sha;
  }

  async commit(repo: DiffRepo, ref: string, signal: AbortSignal): Promise<CommitDiff> {
    // Without per_page GitHub lists 300 files a page (per_page=100 would take 30 requests for 3000 files).
    const { first, items } = await this.rest
      .paginate<RestCommit, RestFile>(`${repoPath(repo)}/commits/${enc(ref)}`, (page) => page.files ?? [], MAX_FILES, { signal })
      .catch((err: unknown) => {
        // An unknown SHA is a 422 "No commit found for SHA".
        if (err instanceof GitHubError && err.status === 422) throw new GitHubError('not-found', err.message, { status: 422 });
        throw err;
      });
    return {
      title: first.commit.message.split('\n')[0]!.replace(/\r$/, ''),
      baseOid: first.parents[0]?.sha ?? null,
      headOid: first.sha,
      files: items.map(toFile),
      totalFiles: items.length >= MAX_FILES ? await this.changedFiles(repo, first.sha, items.length, signal) : items.length,
      additions: first.stats?.additions ?? items.reduce((n, f) => n + f.additions, 0),
      deletions: first.stats?.deletions ?? items.reduce((n, f) => n + f.deletions, 0),
      url: first.html_url,
    };
  }

  /** The real file count of a commit whose list GitHub capped (1 GraphQL point); `fallback` if unavailable in time. */
  private async changedFiles(repo: DiffRepo, sha: string, fallback: number, signal: AbortSignal): Promise<number> {
    try {
      const data = await this.graphql.query<ChangedFilesData>(CHANGED_FILES, { owner: repo.owner, name: repo.name, oid: sha }, { signal });
      return Math.max(fallback, data.repository?.object?.changedFilesIfAvailable ?? fallback);
    } catch (err) {
      this.log(`[diff] could not count the files of ${repo.key}@${sha.slice(0, 7)}: ${(err as Error).message}`);
      return fallback;
    }
  }

  async blob(repo: DiffRepo, sha: string, path: string, maxBytes: number, signal: AbortSignal): Promise<BlobResult> {
    const file = await this.rest.raw(`${repoPath(repo)}/contents/${path.split('/').map(enc).join('/')}`, maxBytes, { query: { ref: sha }, signal });
    // A directory's (or submodule's) JSON description is no file, however large.
    if (!file.isFile) return { kind: 'not-file' };
    return file.tooLarge ? { kind: 'too-large' } : { kind: 'file', bytes: file.bytes };
  }
}

export interface GitHubDiffSourcesOptions {
  /** Where the GitHub token comes from (shared with the sync). */
  tokens: TokenSupply;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * A GitHubDiffSource for the current token (which the provider caches): a new token, e.g. after `gh auth switch`, gets
 * a new source, and a token GitHub rejected is resolved again before the next fetch.
 */
export class GitHubDiffSources implements DiffSources {
  private readonly opts: GitHubDiffSourcesOptions;
  private current: GitHubDiffSource | null = null;
  /** The token each source was made with, to invalidate the one that was rejected (the current one may be newer). */
  private readonly tokens = new WeakMap<DiffSource, string>();

  constructor(opts: GitHubDiffSourcesOptions) {
    this.opts = opts;
  }

  async get(): Promise<DiffSource> {
    const resolved = await this.opts.tokens.get();
    const { token } = resolved;
    if (!token) throw new GitHubError('auth', noTokenMessage(resolved));
    if (this.current && this.tokens.get(this.current) === token) return this.current;
    // Explicit defaults: an undefined option would override the clients' own.
    const { fetchImpl = fetch, sleep = defaultSleep, log } = this.opts;
    this.current = new GitHubDiffSource({
      rest: new GitHubRestClient({ token, fetchImpl, sleep }),
      graphql: new GitHubClient({ token, fetchImpl, sleep, maxAttempts: 2, maxRetryWaitMs: 10_000 }),
      log,
    });
    this.tokens.set(this.current, token);
    return this.current;
  }

  authFailed(source: DiffSource): void {
    const token = this.tokens.get(source);
    if (token === undefined) return;
    if (this.current === source) this.current = null;
    this.opts.tokens.invalidate(token);
  }
}
