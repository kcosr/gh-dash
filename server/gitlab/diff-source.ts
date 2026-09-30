import type { DiffFile } from '../../shared/api';
import type { ResolvedToken, TokenSupply } from '../credentials/types';
import type { SourceDiffSupply } from '../diff/service';
import { newestFirst } from '../provider/branches';
import { defaultSleep } from '../provider/transport';
import type { BlobResult, BranchRef, CommitDiff, CompareDiff, DiffRepo, DiffSource, PrRevision } from '../provider/types';
import { GitLabClient } from './client';
import { mapDiffFile, messageParts } from './map';
import { MR_REVISION } from './queries';
import { encodeSegment, GitLabRestClient } from './rest';
import { GitLabError, GitLabTransport, type GitLabOptions } from './transport';
import type { MrRevisionData, RestBranch, RestCommit, RestCompare, RestDiff, RestVersion, RestVersionFull } from './types';

/** Most files a diff lists, as for GitHub. GitLab itself stops at its diff_max_files setting (1000 unless raised). */
export const MAX_FILES = 3000;
/** How many of an MR's newest diff versions are searched for the revision's (a version appears per push). */
const VERSIONS_PAGE = 20;
/** Revisions tried before giving up on an MR whose diff versions don't include its current one. */
const REVISION_ATTEMPTS = 2;

/** What follows a rejected token's error when the source's credentials say nothing better. */
const DEFAULT_AUTH_HINT = 'check the GitLab token: it needs the read_api scope and must not have expired';

/** A date GitLab sends (with the committer's UTC offset) as UTC, which is what BranchRef says; null when it is missing or isn't one. */
function utc(date: string | null | undefined): string | null {
  const time = date ? Date.parse(date) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** What prRevision hands prFiles: the start SHA, which with head and base identifies a diff version. */
interface Handle {
  startSha: string;
}

/**
 * Diffs and file contents from GitLab, on demand. A merge request's files come from one of its diff versions, which
 * GitLab never changes once created, so a snapshot is consistent without re-reading the MR afterwards.
 */
export class GitLabDiffSource implements DiffSource {
  readonly kind = 'gitlab';
  readonly authHint: string;
  readonly maxFiles = MAX_FILES;
  private readonly transport: GitLabTransport;
  private readonly rest: GitLabRestClient;
  private readonly graphql: GitLabClient;

  /** `authHint` is the source's credentials' (gitlabAuthHint: it names the host); the default stands alone. */
  constructor({ authHint = DEFAULT_AUTH_HINT, ...opts }: GitLabOptions & { authHint?: string }) {
    this.authHint = authHint;
    // Few attempts and short waits: a person is waiting for the response.
    this.transport = new GitLabTransport(opts, { maxAttempts: 3, maxRetryWaitMs: 10_000 });
    this.rest = new GitLabRestClient(this.transport);
    this.graphql = new GitLabClient(this.transport);
  }

  get requests(): number {
    return this.transport.requests;
  }

  get rateLimit() {
    return this.transport.rateLimit;
  }

  /** GitLab has no free conditional request to ask with: prRevision costs the same single request. */
  async prHeadIs(_repo: DiffRepo, _number: number, _knownHead: string, _signal: AbortSignal): Promise<null> {
    return null;
  }

  /**
   * From GraphQL, which (unlike REST) has the diff's totals. Without a merge base (the branches share no history)
   * GitLab diffs against the start SHA, and so does the revision.
   */
  async prRevision(repo: DiffRepo, number: number, signal: AbortSignal): Promise<PrRevision> {
    const data = await this.graphql.query<MrRevisionData>(MR_REVISION, { path: repo.path, iid: String(number) }, signal);
    const mr = data.project?.mergeRequest;
    if (!mr) throw new GitLabError('not-found', `Merge request !${number} not found in ${repo.path}`);
    const refs = mr.diffRefs;
    if (!refs) throw new GitLabError('transient', `GitLab has no diff for !${number} in ${repo.path} yet`);
    const stats = mr.diffStatsSummary;
    const handle: Handle = { startSha: refs.startSha };
    const page = mr.webUrl ?? `${this.transport.base}/${repo.path}/-/merge_requests/${number}`;
    return {
      headOid: refs.headSha,
      baseRef: mr.targetBranch,
      baseOid: refs.baseSha ?? refs.startSha,
      title: mr.title,
      totalFiles: stats?.fileCount ?? 0,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      url: `${page}/diffs`,
      handle,
    };
  }

  /**
   * The files of the diff version `rev` stands for (same head, base and start). GitLab creates a version per push (and
   * when the target branch moves) and never changes it, so the files can't mix two states of the MR, and `rev` stays
   * right even if the MR moves on meanwhile. Only when the version isn't among the newest is the MR read again.
   */
  async prFiles(repo: DiffRepo, number: number, rev: PrRevision, signal: AbortSignal): Promise<{ rev: PrRevision; files: DiffFile[] }> {
    const mr = `/projects/${encodeSegment(repo.path)}/merge_requests/${number}`;
    for (let attempt = 1; ; attempt++) {
      const start = (rev.handle as Handle | undefined)?.startSha;
      // Newest first.
      const versions = await this.rest.json<RestVersion[]>(`${mr}/versions`, { query: { per_page: VERSIONS_PAGE }, signal });
      const version = versions.find(
        (v) => v.head_commit_sha === rev.headOid && (v.base_commit_sha ?? v.start_commit_sha) === rev.baseOid && (!start || v.start_commit_sha === start),
      );
      if (version) {
        const full = await this.rest.json<RestVersionFull>(`${mr}/versions/${encodeSegment(String(version.id))}`, { signal });
        return { rev, files: full.diffs.slice(0, MAX_FILES).map(mapDiffFile) };
      }
      if (attempt >= REVISION_ATTEMPTS) throw new GitLabError('transient', `!${number} in ${repo.path} changed while its diff was being fetched; try again`);
      rev = await this.prRevision(repo, number, signal);
    }
  }

  /**
   * The commit (with its totals), then its diff against the first parent, 100 files a page. GitLab stops listing at the
   * instance's diff_max_files (1000 by default) and counts only what it lists, so totalFiles can't go beyond that.
   */
  async commit(repo: DiffRepo, ref: string, signal: AbortSignal): Promise<CommitDiff> {
    const commits = `/projects/${encodeSegment(repo.path)}/repository/commits`;
    const c = await this.rest.json<RestCommit>(`${commits}/${encodeSegment(ref)}`, { signal });
    const { items, total } = await this.rest.all<RestDiff>(`${commits}/${encodeSegment(c.id)}/diff`, MAX_FILES, { query: { per_page: 100 }, signal });
    const files = items.map(mapDiffFile);
    return {
      title: messageParts(c.message ?? c.title).headline,
      baseOid: c.parent_ids[0] ?? null,
      headOid: c.id,
      files,
      totalFiles: Math.max(total ?? 0, files.length),
      additions: c.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0),
      deletions: c.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
      url: c.web_url,
    };
  }

  /**
   * The commit a branch points to, 1 request: GitLab has no conditional request that would make this free, so `knownHead`
   * isn't used. 404 (`not-found`) for a branch the project doesn't have.
   */
  async branchHead(repo: DiffRepo, branch: string, _knownHead: string | null, signal: AbortSignal): Promise<string> {
    const found = await this.rest.json<RestBranch>(`/projects/${encodeSegment(repo.path)}/repository/branches/${encodeSegment(branch)}`, { signal });
    return found.commit.id;
  }

  /**
   * The merge base of `base` and `head`, then the comparison from that commit to `head` (both SHAs: pinned, so the files
   * are those of the merge base returned, however the branches move meanwhile). GitLab counts no lines, so they are
   * counted from the hunks, as for merge requests. A comparison that exceeded GitLab's limits or timed out
   * (`compare_timeout`) may list fewer files than there are, without saying how many: totalFiles is then one above the
   * files listed, so that the diff shows as cut off. A 404 from either request is a base or head GitLab doesn't have, or
   * branches that share no history (there is then no merge base).
   */
  async compare(repo: DiffRepo, base: string, head: string, signal: AbortSignal): Promise<CompareDiff> {
    const repository = `/projects/${encodeSegment(repo.path)}/repository`;
    const mergeBase = await this.rest.json<RestCommit>(`${repository}/merge_base`, { query: { 'refs[]': [base, head] }, signal });
    const compare = await this.rest.json<RestCompare>(`${repository}/compare`, { query: { from: mergeBase.id, to: head }, signal });
    const files = compare.diffs.slice(0, MAX_FILES).map(mapDiffFile);
    return {
      baseOid: mergeBase.id,
      headOid: head,
      files,
      totalFiles: compare.diffs.length + (compare.compare_timeout ? 1 : 0),
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }

  /**
   * One page of branches whose name contains `query` (GitLab's `search`, which also takes `^prefix` and `suffix$`), newest
   * head commit first. GitLab does that itself with `sort=updated_desc`, which its code has but its docs don't ("sorted
   * by name"), so they are sorted here as well, in case an instance goes by name. `more` when GitLab names a next page,
   * or counts more than it sent, or (it counts nothing for large lists) the page is full.
   */
  async branches(repo: DiffRepo, query: string | null, limit: number, signal: AbortSignal): Promise<{ items: BranchRef[]; more: boolean }> {
    const perPage = Math.min(limit, 100);
    const page = await this.rest.page<RestBranch[]>(`/projects/${encodeSegment(repo.path)}/repository/branches`, {
      query: { per_page: perPage, sort: 'updated_desc', ...(query ? { search: query } : {}) },
      signal,
    });
    const items = page.body.map((b) => ({ name: b.name, headOid: b.commit.id, committedAt: utc(b.commit.committed_date) })).sort(newestFirst);
    return { items, more: page.nextPage !== null || (page.total !== null ? page.total > items.length : items.length >= perPage) };
  }

  /**
   * GitLab answers 404 for a directory as for a missing file (and an empty file for a submodule), so 'not-file' never
   * comes from here. It sends files of any size: the cap is enforced while reading.
   */
  async blob(repo: DiffRepo, sha: string, path: string, maxBytes: number, signal: AbortSignal): Promise<BlobResult> {
    const target = `/projects/${encodeSegment(repo.path)}/repository/files/${encodeSegment(path)}/raw`;
    const file = await this.rest.raw(target, maxBytes, { query: { ref: sha }, signal });
    return file.tooLarge ? { kind: 'too-large' } : { kind: 'file', bytes: file.bytes };
  }
}

export interface GitLabDiffSourcesOptions {
  /** The instance URL, relative root included. */
  baseUrl: string;
  /** The source's token (shared with its sync), and the 503 text when there is none. */
  tokens: TokenSupply & { noTokenMessage(resolved: ResolvedToken): string };
  /** What to do when GitLab rejects the token, after its message (the source's credentials' authHint); a generic one by default. */
  authHint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A GitLabDiffSource for one source's current token (which its provider caches): a new token gets a new source, and a
 * token GitLab rejected is resolved again before the next fetch. The GitHubDiffSources pattern, per GitLab source.
 */
export class GitLabDiffSources implements SourceDiffSupply {
  private readonly opts: GitLabDiffSourcesOptions;
  private current: GitLabDiffSource | null = null;
  /** The token each source was made with, to invalidate the one that was rejected (the current one may be newer). */
  private readonly tokens = new WeakMap<DiffSource, string>();

  constructor(opts: GitLabDiffSourcesOptions) {
    this.opts = opts;
  }

  async get(): Promise<DiffSource> {
    const resolved = await this.opts.tokens.get();
    const { token } = resolved;
    if (!token) throw new GitLabError('auth', this.opts.tokens.noTokenMessage(resolved));
    if (this.current && this.tokens.get(this.current) === token) return this.current;
    // Explicit defaults: an undefined option would override the transport's own.
    const { baseUrl, authHint, fetchImpl = fetch, sleep = defaultSleep } = this.opts;
    this.current = new GitLabDiffSource({ baseUrl, token, authHint, fetchImpl, sleep });
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
