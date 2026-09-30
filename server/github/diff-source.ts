// GitHub behind the provider-neutral DiffSource: PR and commit diffs from the REST API (plus a GraphQL file count), and
// raw file contents. The diff service decides when to ask and what the API answers; this only knows how to ask GitHub.

import type { DiffFile, DiffFileStatus } from '../../shared/api';
import type { SourceDiffSupply } from '../diff/service';
import { parseUnifiedDiff } from '../diff/unified';
import { newestFirst } from '../provider/branches';
import { defaultSleep } from '../provider/transport';
import type { BlobResult, BranchRef, CommitDiff, CompareDiff, DiffRepo, DiffSource, PrRevision, RateLimitInfo } from '../provider/types';
import { noTokenMessage, type TokenSupply } from '../token';
import { GitHubClient } from './client';
import { GitHubRestClient } from './rest';
import { GitHubError } from './transport';
import type { GqlRateLimit } from './types';

/** GitHub lists at most this many files for a PR or commit. */
const MAX_FILES = 3000;
/** Full fetches of a PR's files before giving up on a PR that keeps changing underneath (each costs 2+ requests). */
const PR_SNAPSHOT_ATTEMPTS = 2;
/** A compare's JSON lists at most this many files, however many the comparison changes, and has no next page for the rest. */
const COMPARE_FILES = 300;
/** A comparison's `.diff` is read up to this size (it can be as large as the change is); past it the JSON's files are all there is. */
const MAX_COMPARE_DIFF_BYTES = 20 * 1024 * 1024;
/** Pages of 100 branches read to find the newest, which GitHub can't list them by: 1 GraphQL point each. */
const BRANCH_PAGES = 5;

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
  /** On the first page only, at most COMPARE_FILES. */
  files?: RestFile[];
}
/** What a file of this status shows: without a patch it is binary, or GitHub left the patch out (see compare). */
const HAS_CONTENT = new Set<DiffFileStatus>(['added', 'removed', 'modified']);

/**
 * Whether GitHub may have left a file's patch out (see compare): a file of a status that shows content, or any file
 * whose lines GitHub counted (a renamed or copied file with changes: its patch has lines, a pure rename's has none).
 */
const mayLackPatch = (f: DiffFile) => f.patch === null && (HAS_CONTENT.has(f.status) || f.additions + f.deletions > 0);

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

// GitHub can't list branches newest first: `orderBy: {field: TAG_COMMIT_DATE}` is accepted for refs/heads/ and ignored, they
// come alphabetically (checked against cli/cli, 254 branches). `query` matches a name's substring, case-insensitively.
const BRANCHES = `query($owner: String!, $name: String!, $query: String, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 100, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { oid ... on Commit { committedDate } } }
    }
  }
  rateLimit { limit remaining resetAt cost }
}`;
interface BranchesData {
  repository: {
    refs: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ({ name: string; target: { oid: string; committedDate?: string } | null } | null)[] } | null;
  } | null;
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
/**
 * A branch as a ref in the path of `commits/{ref}` and `compare/{basehead}`. "heads/" is GitHub's own spelling for a
 * branch (a bare name could be a tag, or an abbreviated SHA, as well), and the name is encoded whole: "feature/x" as
 * "heads%2Ffeature%2Fx" is read like "heads/feature/x" (both checked against cli/cli).
 */
const branchRef = (name: string) => enc(`heads/${name}`);
const sum = (files: DiffFile[], field: 'additions' | 'deletions') => files.reduce((n, f) => n + f[field], 0);
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

  /**
   * The commit `branch` points to: a conditional request for its SHA, a 304 (which GitHub doesn't count) while it is still
   * `knownHead`. A name GitHub doesn't have is a 422 ("No commit found for SHA: heads/x"), not a 404.
   */
  async branchHead(repo: DiffRepo, branch: string, knownHead: string | null, signal: AbortSignal): Promise<string> {
    return this.rest.sha(`${repoPath(repo)}/commits/${branchRef(branch)}`, knownHead ?? undefined, { signal }).catch((err: unknown) => {
      if (err instanceof GitHubError && err.status === 422) throw new GitHubError('not-found', err.message, { status: 422 });
      throw err;
    });
  }

  /**
   * The change of `head` against its merge base with the branch `base`. `compare/<base>...<head>` names the merge base and
   * lists the files, on its first page and at most COMPARE_FILES (`per_page=1` only trims the commits it lists too). That
   * list is complete when it is shorter than that and every file with content has its patch. GitHub leaves a patch out,
   * and counts the file's lines as 0, once the response's patches pass a size budget (a 300-file comparison of cli/cli had
   * 140 of them), and for a file that alone is too large: a "modified" file without patch, just like a binary file, so the
   * two can't be told apart. Whenever the list may be short or a patch may be missing, the change is read again as one
   * `.diff` from the merge base found (so pinned: the base branch may move meanwhile) to `head`, and its files replace the
   * JSON's: a diff has no file limit and every text file's patch, with lines to count (a change with a binary file in it
   * pays that second request too). Its hunks are grouped as git does, so a patch can differ a little from the JSON's.
   *
   * With a diff over MAX_COMPARE_DIFF_BYTES, or one GitHub won't build, the JSON's files stay: totalFiles is their number
   * (300 at most, though the change may have more: nothing else counts them) and those without a patch stay without. A
   * 404 is a base GitHub doesn't have, or (with "No common ancestor" in its message) branches that share no history, as an
   * orphan gh-pages doesn't.
   */
  async compare(repo: DiffRepo, base: string, head: string, signal: AbortSignal): Promise<CompareDiff> {
    const path = repoPath(repo);
    const compare = await this.rest.json<RestCompare>(`${path}/compare/${branchRef(base)}...${head}`, { query: { per_page: 1 }, signal });
    const mergeBase = compare.merge_base_commit.sha;
    const listed = (compare.files ?? []).map(toFile);
    const changes = (files: DiffFile[], totalFiles: number): CompareDiff => ({
      baseOid: mergeBase, headOid: head, files: files.slice(0, MAX_FILES), totalFiles, additions: sum(files, 'additions'), deletions: sum(files, 'deletions'),
    });
    if (listed.length < COMPARE_FILES && !listed.some(mayLackPatch)) return changes(listed, listed.length);

    const diff = await this.rest.diff(`${path}/compare/${mergeBase}...${head}`, MAX_COMPARE_DIFF_BYTES, { signal }).catch((err: unknown) => {
      // GitHub answers a diff it won't build (say, a pull request's: 406) with a client error.
      if (err instanceof GitHubError && err.kind === 'http' && [406, 413, 422].includes(err.status ?? 0)) return { text: '', tooLarge: true };
      throw err;
    });
    const files = parseUnifiedDiff(diff.text);
    // A diff that has fewer files than the list can't be of the same change: the parser lost some, or GitHub cut it short.
    if (diff.tooLarge || files.length < listed.length) {
      this.log(
        `[diff] ${repo.key}: the diff of ${base}...${head.slice(0, 7)} ${diff.tooLarge ? `is over ${MAX_COMPARE_DIFF_BYTES / (1024 * 1024)} MB` : 'lacks files the compare lists'}; listing what the compare has`,
      );
      return changes(listed, listed.length);
    }
    return changes(files, files.length);
  }

  /**
   * The branches whose name contains `query`, newest head commit first. GitHub can't sort them (see BRANCHES), so up to
   * BRANCH_PAGES pages of 100 are read, sorted here and cut to `limit`; `more` is set when there are others, or the
   * branches past those pages (alphabetically) weren't read.
   */
  async branches(repo: DiffRepo, query: string | null, limit: number, signal: AbortSignal): Promise<{ items: BranchRef[]; more: boolean }> {
    const found: BranchRef[] = [];
    let after: string | null = null;
    let hasNext = true;
    for (let page = 0; hasNext && page < BRANCH_PAGES; page++) {
      const data: BranchesData = await this.graphql.query<BranchesData>(BRANCHES, { owner: repo.owner, name: repo.name, query, after }, { signal });
      const refs = data.repository?.refs;
      if (!refs) throw new GitHubError('not-found', `Repository ${repo.path} not found`);
      for (const node of refs.nodes) {
        if (node?.target) found.push({ name: node.name, headOid: node.target.oid, committedAt: node.target.committedDate ?? null });
      }
      ({ hasNextPage: hasNext, endCursor: after } = refs.pageInfo);
    }
    found.sort(newestFirst);
    return { items: found.slice(0, limit), more: hasNext || found.length > limit };
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
export class GitHubDiffSources implements SourceDiffSupply {
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
