/** Typed client for the gh-dash API (contract: shared/api.ts). */
import type {
  AccountStatus,
  ActivityQuery,
  AddRepoResponse,
  ActivityResponse,
  Commit,
  CommentThread,
  Diff,
  DiffCacheStats,
  InstanceInfo,
  Issue,
  IssueQuery,
  ListResponse,
  Me,
  NewPrThread,
  NewThread,
  PageQuery,
  PrListResponse,
  PrQuery,
  PullRequestDetail,
  Release,
  Repo,
  RepoCandidatesResponse,
  RepoLookup,
  RepoSet,
  SavedView,
  ScopeQuery,
  Settings,
  Source,
  Star,
  StatsQuery,
  StatsResponse,
  SyncStatus,
  ThreadListQuery,
  ThreadListResponse,
} from '../../../shared/api';

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

/**
 * A proxy in front of the server (Vite in dev, nginx in production) answers 502/503/504 without a
 * JSON body when the Node process is down: report that the same way as a refused connection.
 */
const UNREACHABLE = 'Cannot reach the gh-dash server';
const gatewayDown = (status: number) => status === 502 || status === 503 || status === 504;

/** The server itself is down or unreachable (as opposed to an error it reported, e.g. a 503 for a missing token). */
export const isUnreachable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.message.startsWith(UNREACHABLE));

/** A 4xx answer won't change on retry. */
export const isClientError = (e: unknown) => {
  const status = (e as { status?: number } | null)?.status ?? 0;
  return status >= 400 && status < 500;
};

/**
 * When GitHub's rate limit resets, from a 429's details: `{ resetAt }` (ISO or epoch seconds),
 * `{ reset }`, or the bare value. null when absent or unparseable.
 */
export function rateLimitResetAt(e: unknown): Date | null {
  const d = (e as { details?: unknown } | null)?.details;
  const raw = d !== null && typeof d === 'object' ? (d as { resetAt?: unknown; reset?: unknown }).resetAt ?? (d as { reset?: unknown }).reset : d;
  const t = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw)) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Build a query string. `undefined`/`null` are omitted; empty strings are kept
 * (`repos=` means "no repos"). Commas stay readable.
 */
export function toQueryString(params: Params = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%2C/gi, ',')}`);
  }
  return parts.join('&');
}

export type Endpoint = 'prs' | 'activity' | 'stats' | 'releases' | 'repos' | 'commits' | 'issues' | 'stars' | 'threads' | 'settings' | 'sync/status';

/** "/api/v1/prs?repos=a,b&who=me…" */
export function apiUrl(endpoint: Endpoint | string, params?: Params): string {
  const qs = toQueryString(params);
  return `/api/v1/${endpoint}${qs ? `?${qs}` : ''}`;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, UNREACHABLE, e);
  }
  if (!res.ok) {
    let message = gatewayDown(res.status) ? `${UNREACHABLE} (HTTP ${res.status})` : `${res.status} ${res.statusText}`;
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: string; details?: unknown };
      if (j?.error) message = j.error;
      details = j?.details;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, message, details);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) return (await res.text()) as T;
  return (await res.json()) as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const enc = encodeURIComponent;

async function getText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError(0, UNREACHABLE, e);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = gatewayDown(res.status) ? `${UNREACHABLE} (HTTP ${res.status})` : `${res.status} ${res.statusText}`;
    try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* plain text */ }
    throw new ApiError(res.status, message);
  }
  return text;
}

export const api = {
  health: () => get<{ ok: true; version: string }>('/api/health'),
  me: () => get<Me>('/api/v1/me'),
  /** The GitHub account behind the server's token (never the token itself). */
  account: () => get<AccountStatus>('/api/v1/account'),
  /** Re-resolve the token and validate it with GitHub now. */
  checkAccount: () => request<AccountStatus>('POST', '/api/v1/account/check'),
  /** How this server runs: version, API URL, auth mode and instance settings with their sources. */
  instance: () => get<InstanceInfo>('/api/v1/instance'),

  /** Every source (github.com first) with its account, sync state and repository counts. Calls no code host. */
  sources: () => get<{ items: Source[] }>('/api/v1/sources'),
  source: (host: string) => get<Source>(`/api/v1/sources/${enc(host)}`),
  /** Resolve the source's token again and validate it now. 503 (the Source in `details`) when there is no token. */
  checkSource: (host: string) => request<Source>('POST', `/api/v1/sources/${enc(host)}/check`),
  /** Remove a source this server no longer configures, and everything synced from it (nothing changes on the host). */
  deleteSource: (host: string) => request<void>('DELETE', `/api/v1/sources/${enc(host)}`),

  repos: () => get<{ items: Repo[] }>('/api/v1/repos'),
  repo: (key: string) => get<Repo>(`/api/v1/repos/${enc(key)}`),
  patchRepo: (key: string, body: { pinned?: boolean; hidden?: boolean }) => request<Repo>('PATCH', `/api/v1/repos/${enc(key)}`, body),
  /** Repositories of other owners the token can read, and suggestions (the Add dialog). `source`: a host (default github.com). */
  repoCandidates: (refresh = false, source?: string) => get<RepoCandidatesResponse>(apiUrl('repo-candidates', { refresh: refresh ? '1' : undefined, source })),
  /** Whether the token can read `repo` (owner/name, a project path, a key or a URL), with a preview. */
  repoLookup: (repo: string, source?: string) => get<RepoLookup>(apiUrl('repo-lookup', { repo, source })),
  addRepo: (body: { repo: string; source?: string; includeInDefault?: boolean }) => request<AddRepoResponse>('POST', '/api/v1/repos', body),
  /** Stop tracking a repository added by hand and delete its data from this dashboard (not on GitHub). */
  removeRepo: (key: string) => request<void>('DELETE', `/api/v1/repos/${enc(key)}`),

  sets: () => get<{ items: RepoSet[] }>('/api/v1/sets'),
  createSet: (body: { name: string; repos: string[] }) => request<RepoSet>('POST', '/api/v1/sets', body),
  updateSet: (id: number, body: { name?: string; repos?: string[] }) => request<RepoSet>('PATCH', `/api/v1/sets/${id}`, body),
  deleteSet: (id: number) => request<void>('DELETE', `/api/v1/sets/${id}`),

  views: () => get<{ items: SavedView[] }>('/api/v1/views'),
  createView: (body: { name: string; path: string; query: string }) => request<SavedView>('POST', '/api/v1/views', body),
  deleteView: (id: number) => request<void>('DELETE', `/api/v1/views/${id}`),

  prs: (q: PrQuery) => get<PrListResponse>(apiUrl('prs', { ...q })),
  pr: (repo: string, number: number) => get<PullRequestDetail>(`/api/v1/prs/${enc(repo)}/${number}`),
  activity: (q: ActivityQuery) => get<ActivityResponse>(apiUrl('activity', { ...q })),
  commits: (q: ScopeQuery & PageQuery) => get<ListResponse<Commit>>(apiUrl('commits', { ...q })),
  issues: (q: IssueQuery) => get<ListResponse<Issue>>(apiUrl('issues', { ...q })),
  releases: (q: ScopeQuery & PageQuery) => get<ListResponse<Release>>(apiUrl('releases', { ...q })),
  stars: (q: ScopeQuery & PageQuery) => get<ListResponse<Star>>(apiUrl('stars', { ...q })),
  stats: (q: StatsQuery) => get<StatsResponse>(apiUrl('stats', { ...q })),

  syncStatus: () => get<SyncStatus>('/api/v1/sync/status'),
  /** `source`: sync that source (a host) alone; without it, every source with a token. */
  sync: (body: { repo?: string; full?: boolean; source?: string } = {}) => request<SyncStatus>('POST', '/api/v1/sync', body),

  /** refresh re-checks GitHub for the PR's current head instead of the last synced one. */
  prDiff: (repo: string, number: number, refresh = false) =>
    get<Diff>(apiUrl(`prs/${enc(repo)}/${number}/diff`, { refresh: refresh ? '1' : undefined })),
  commitDiff: (repo: string, oid: string, refresh = false) =>
    get<Diff>(apiUrl(`commits/${enc(repo)}/${enc(oid)}/diff`, { refresh: refresh ? '1' : undefined })),
  /** A file's contents at a commit; null when it doesn't exist there, is binary, or is too large. */
  blob: (repo: string, ref: string, path: string) =>
    getText(apiUrl(`blob/${enc(repo)}`, { ref, path })).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 413 || e.status === 415)) return null;
      throw e;
    }),
  diffCache: () => get<DiffCacheStats>('/api/v1/diff-cache'),
  clearDiffCache: () => request<DiffCacheStats>('DELETE', '/api/v1/diff-cache'),

  /** Local comment threads (never sent to GitHub). A commit's need its full oid. */
  prThreads: (repo: string, number: number) => get<{ items: CommentThread[] }>(`/api/v1/prs/${enc(repo)}/${number}/threads`),
  commitThreads: (repo: string, oid: string) => get<{ items: CommentThread[] }>(`/api/v1/commits/${enc(repo)}/${enc(oid)}/threads`),
  createPrThread: (repo: string, number: number, body: NewPrThread) => request<CommentThread>('POST', `/api/v1/prs/${enc(repo)}/${number}/threads`, body),
  createCommitThread: (repo: string, oid: string, body: NewThread) => request<CommentThread>('POST', `/api/v1/commits/${enc(repo)}/${enc(oid)}/threads`, body),
  reply: (threadId: number, body: string) => request<CommentThread>('POST', `/api/v1/threads/${threadId}/comments`, { body }),
  setThreadStatus: (threadId: number, status: 'open' | 'resolved') => request<CommentThread>('PATCH', `/api/v1/threads/${threadId}`, { status }),
  deleteThread: (threadId: number) => request<void>('DELETE', `/api/v1/threads/${threadId}`),
  editComment: (commentId: number, body: string) => request<CommentThread>('PATCH', `/api/v1/comments/${commentId}`, { body }),
  deleteComment: (commentId: number) => request<{ thread: CommentThread | null }>('DELETE', `/api/v1/comments/${commentId}`),
  /** Every thread in scope, across PRs and commits (the Comments list). */
  threadList: (q: ThreadListQuery) => get<ThreadListResponse>(apiUrl('threads', { ...q })),

  settings: () => get<Settings>('/api/v1/settings'),
  patchSettings: (body: Partial<Settings>) => request<Settings>('PATCH', '/api/v1/settings', body),

  /** Raw GET returning text (for format=md / csv exports). */
  text: getText,
  /** Raw GET returning parsed JSON (export samples). */
  json: <T = unknown>(url: string) => get<T>(url),
};
