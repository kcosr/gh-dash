/** react-query hooks over the API client. */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type {
  ActivityQuery,
  ActivityResponse,
  Commit,
  CommentThread,
  Diff,
  IssueQuery,
  NewPrThread,
  PrListResponse,
  PrQuery,
  PullRequest,
  PullRequestDetail,
  Repo,
  RepoSet,
  SavedView,
  ScopeQuery,
  Settings,
  Source,
  StatsQuery,
  SyncStatus,
} from '../../../shared/api';
import { GITHUB_HOST } from '../../../shared/api';
import { ApiError, api, isClientError, isUnreachable } from './client';
import { resolveApiBase } from '../lib/account';
import { defaultRepoScope } from '../../../shared/repos';
import { presentSources } from '../lib/contexts';
import type { SourceInfo } from '../lib/contexts';
import { sourceStatuses, workSources } from '../lib/sources';
import type { WorkSource } from '../lib/sources';
import { parseDiffId } from '../lib/urlState';

export const qk = {
  repos: ['repos'] as const,
  sets: ['sets'] as const,
  views: ['views'] as const,
  settings: ['settings'] as const,
  me: ['me'] as const,
  sync: ['sync-status'] as const,
  account: ['account'] as const,
  instance: ['instance'] as const,
  /** GET /sources: every source's account, sync state and repository counts. */
  sources: ['sources'] as const,
  /** DesktopState from the desktop app's bridge (not an HTTP query). */
  desktop: ['desktop-state'] as const,
  prs: (q: PrQuery) => ['prs', q] as const,
  issues: (q: IssueQuery) => ['issues', q] as const,
  pr: (repo: string, n: number) => ['pr', repo, n] as const,
  activity: (q: ActivityQuery) => ['activity', q] as const,
  releases: (q: ScopeQuery) => ['releases', q] as const,
  stats: (q: StatsQuery) => ['stats', q] as const,
  diff: (id: string) => ['diff', id] as const,
  /** A PR's ("<repo>#<n>") or a commit's ("<repo>@<full oid>") comment threads. */
  threads: (id: string) => ['threads', id] as const,
  blob: (repo: string, ref: string, path: string) => ['blob', repo, ref, path] as const,
  diffCache: ['diff-cache'] as const,
  /** The Add dialog's lists and access checks: read from GitHub, never refetched by a sync. */
  repoCandidates: ['repo-candidates'] as const,
  repoCandidatesOf: (source: string) => ['repo-candidates', source] as const,
  repoLookup: (source: string, key: string) => ['repo-lookup', source, key] as const,
};

/**
 * Queries a finished sync (or a settings change) should refetch. Diffs and file contents are fetched
 * from GitHub on demand, so a sync doesn't swap an open diff under the reader (the diff view has a
 * refresh); a PR diff is revalidated when it's next opened (useDiff).
 */
export const refetchAfterSync = (q: Query) =>
  !['sync-status', 'diff', 'blob', 'threads', 'instance', 'desktop-state', 'repo-candidates', 'repo-lookup'].includes(q.queryKey[0] as string);

/**
 * Queries whose answers follow the default selection: every list or stats request without an explicit `repos=`
 * (the views, the palette's PR search, the export previews). Hiding or showing a repo changes them.
 */
const SELECTION_QUERIES = ['prs', 'issues', 'activity', 'releases', 'commits', 'stars', 'stats', 'palette-prs', 'export-md', 'export-sample'];
export const followsDefaultSelection = (q: Query) => SELECTION_QUERIES.includes(q.queryKey[0] as string);

// ---------------------------------------------------------------- reference data

export function useRepos() {
  return useQuery({ queryKey: qk.repos, queryFn: api.repos, staleTime: 60_000, select: (d) => d.items });
}

export function useRepoMap(): Map<string, Repo> {
  const { data } = useRepos();
  return useMemo(() => new Map((data ?? []).map((r) => [r.key, r])), [data]);
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 5 * 60_000 });
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 5 * 60_000, retry: false });
}

/**
 * The GitHub account behind the server's token. Refetched when the window regains focus (e.g. after
 * `gh auth login` in a terminal) and, while there is no token, every 15 s so a new one shows up by itself.
 * A finished sync or a change of token source refetches it too (useSyncWatcher).
 */
export function useAccount() {
  return useQuery({
    queryKey: qk.account,
    queryFn: api.account,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.source === 'none' ? 15_000 : false),
    refetchIntervalInBackground: false,
    retry: (count, err) => count < 1 && !isClientError(err),
  });
}

/** Re-resolve the token and validate it with GitHub (POST /account/check). */
export function useCheckAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.checkAccount,
    onSuccess: (a) => {
      qc.setQueryData(qk.account, a);
      invalidateAccountData(qc);
    },
  });
}

/** What depends on the token besides the account itself: "me" and the sync status (token source, viewer). */
export function invalidateAccountData(qc: QueryClient) {
  for (const queryKey of [qk.me, qk.sync]) void qc.invalidateQueries({ queryKey });
}

/**
 * Every source with its account, sync state and repository counts (Settings → Sources). GET /sources never calls a
 * code host, so it is refetched freely: on focus (after `glab auth login` in a terminal, say) and after every sync.
 */
export function useSources() {
  return useQuery({
    queryKey: qk.sources,
    queryFn: api.sources,
    select: (d) => d.items,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: (count, err) => count < 1 && !isClientError(err),
  });
}

function putSource(qc: QueryClient, source: Source) {
  const prev = qc.getQueryData<{ items: Source[] }>(qk.sources);
  if (prev) qc.setQueryData(qk.sources, { items: prev.items.map((s) => (s.host === source.host ? source : s)) });
}

const isSource = (x: unknown): x is Source => !!x && typeof x === 'object' && typeof (x as Source).host === 'string' && 'sync' in x;

/**
 * Re-resolve a source's token and validate it now (POST /sources/:host/check). With no token the server answers 503
 * with the source as it stands, which is shown too; the error still reaches the caller.
 */
export function useCheckSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (host: string) => api.checkSource(host),
    onSuccess: (source) => putSource(qc, source),
    onError: (e) => {
      if (e instanceof ApiError && isSource(e.details)) putSource(qc, e.details);
    },
    onSettled: (_s, _e, host) => {
      void qc.invalidateQueries({ queryKey: qk.sync });
      if (host === 'github.com') void qc.invalidateQueries({ queryKey: qk.account });
    },
  });
}

/** Remove a source this server no longer configures, with all its data (DELETE /sources/:host). */
export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (host: string) => api.deleteSource(host),
    onSuccess: (_r, host) => {
      const prev = qc.getQueryData<{ items: Source[] }>(qk.sources);
      if (prev) qc.setQueryData(qk.sources, { items: prev.items.filter((s) => s.host !== host) });
      // Its repositories, and everything synced from them, are gone.
      void qc.invalidateQueries({ predicate: refetchAfterSync });
    },
  });
}

/** How this server runs. Changes only when it restarts (the desktop app invalidates it then). */
export function useInstance() {
  return useQuery({
    queryKey: qk.instance,
    queryFn: api.instance,
    staleTime: 5 * 60_000,
    retry: (count, err) => count < 1 && !isClientError(err),
  });
}

/**
 * Base URL for links to this API from outside the app (docs, curl, copied URLs); null when nothing listens
 * on the network (the desktop app with the Local API off). See resolveApiBase.
 */
export function useApiBase(): string | null {
  const { data } = useInstance();
  return resolveApiBase(data, !!window.ghDashDesktop, window.location.origin);
}

export function useSets() {
  return useQuery({ queryKey: qk.sets, queryFn: api.sets, staleTime: 60_000, select: (d) => d.items });
}

export function useViews() {
  return useQuery({ queryKey: qk.views, queryFn: api.views, staleTime: 60_000, select: (d) => d.items });
}

/** Polls every 2 s while a sync runs, every 30 s otherwise. */
export function useSyncStatus() {
  return useQuery({
    queryKey: qk.sync,
    queryFn: api.syncStatus,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : 30_000),
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

/**
 * The sources present (see `presentSources`), from the repos and GET /sources. `complete`: /sources has answered (or
 * failed, and the repos alone decide), so a source missing from `sources` isn't one. Null until the repos load.
 */
export function usePresentSources(): { sources: SourceInfo[]; complete: boolean } | null {
  const repos = useRepos().data;
  const all = useSources();
  const loaded = all.data ?? null;
  const failed = all.isError;
  return useMemo(() => (repos ? { sources: presentSources(repos, loaded), complete: !!loaded || failed } : null), [repos, loaded, failed]);
}

/**
 * The sources the app works with (see `workSources`): each one's sync status, problem and where it lives. Empty until
 * the sync status has loaded; github.com alone until /sources has.
 */
export function useWorkSources(): WorkSource[] {
  const st = useSyncStatus().data;
  const sources = useSources().data ?? null;
  const repos = useRepos().data;
  const githubMismatch = !!useAccount().data?.mismatch;
  return useMemo(() => workSources(sources, sourceStatuses(st), repos ?? [], { githubMismatch }), [sources, st, repos, githubMismatch]);
}

/** The default selection: not archived, not hidden, not a fork (unless includeForks). */
export function defaultScope(repos: Repo[], settings?: Settings): string[] {
  return defaultRepoScope(repos, settings?.includeForks);
}

// ---------------------------------------------------------------- lists

/**
 * Whether a list in a source's context may be asked for: once that source is known to be present (it has repos, or
 * /sources says it is set up here). The API refuses a host that isn't a source (400); the address bar drops such a
 * `source` once the sources are known (useCanonicalRepoUrl), so the list waits for that rather than failing first.
 * The repos (and /sources) come first on a cold load only (they're cached after), and only when the URL names a source.
 */
export function useSourceReady(source: string | undefined): boolean {
  const present = usePresentSources();
  return useMemo(() => !source || !!present?.sources.some((s) => s.host === source), [source, present]);
}

/** PR lists for 30–90 days are small; fetch up to 1000 in one go. */
export const PR_LIMIT = 1000;

export function usePrList(q: PrQuery, enabled = true) {
  const params = { ...q, limit: q.limit ?? PR_LIMIT };
  const ready = useSourceReady(q.source);
  return useQuery({ queryKey: qk.prs(params), queryFn: () => api.prs(params), placeholderData: keepPreviousData, enabled: enabled && ready });
}

export function useReleases(q: ScopeQuery, enabled = true) {
  const params = { ...q, limit: 200 };
  const ready = useSourceReady(q.source);
  return useQuery({ queryKey: qk.releases(params), queryFn: () => api.releases(params), placeholderData: keepPreviousData, enabled: enabled && ready });
}

export function useIssueList(q: IssueQuery) {
  const params = { ...q, limit: 100 };
  const ready = useSourceReady(q.source);
  return useInfiniteQuery({
    queryKey: qk.issues(params),
    queryFn: ({ pageParam }) => api.issues({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: ready,
  });
}

export const ACTIVITY_PAGE = 200;

export function useActivityFeed(q: ActivityQuery, enabled = true) {
  const params = { ...q, limit: ACTIVITY_PAGE };
  const ready = useSourceReady(q.source);
  return useInfiniteQuery({
    queryKey: qk.activity(params),
    queryFn: ({ pageParam }) => api.activity({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: enabled && ready,
  });
}

export function useStats(q: StatsQuery, enabled = true) {
  const ready = useSourceReady(q.source);
  return useQuery({ queryKey: qk.stats(q), queryFn: () => api.stats(q), placeholderData: keepPreviousData, enabled: enabled && ready });
}

export function usePrDetail(id: string | null) {
  const [repo, n] = splitPrId(id);
  return useQuery({
    queryKey: qk.pr(repo ?? '', n ?? 0),
    queryFn: () => api.pr(repo!, n!),
    enabled: !!repo && !!n,
    staleTime: 60_000,
    retry: (count, err) => count < 1 && (err as { status?: number }).status !== 404,
  });
}

export function splitPrId(id: string | null): [string | null, number | null] {
  if (!id) return [null, null];
  const i = id.lastIndexOf('#');
  if (i < 1) return [null, null];
  const n = Number(id.slice(i + 1));
  return Number.isInteger(n) && n > 0 ? [id.slice(0, i), n] : [null, null];
}

/** Find a PR already loaded by any list query (for instant drawer rendering). */
export function findCachedPr(qc: QueryClient, id: string): PullRequest | undefined {
  for (const [, data] of qc.getQueriesData<PrListResponse>({ queryKey: ['prs'] })) {
    const hit = data?.items?.find((p) => p.id === id);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<InfiniteData<ActivityResponse>>({ queryKey: ['activity'] })) {
    for (const page of data?.pages ?? []) {
      for (const e of page.items) if (e.type === 'pr' && e.pr.id === id) return e.pr;
    }
  }
  const [repo, n] = splitPrId(id);
  if (repo && n) return qc.getQueryData<PullRequest>(qk.pr(repo, n));
  return undefined;
}

/** A commit already loaded by the activity feed or a PR's details (for the diff header while it loads). */
export function findCachedCommit(qc: QueryClient, repo: string, oid: string): Pick<Commit, 'headline' | 'url'> & Partial<Commit> | undefined {
  for (const [, data] of qc.getQueriesData<InfiniteData<ActivityResponse>>({ queryKey: ['activity'] })) {
    for (const page of data?.pages ?? []) {
      for (const e of page.items) if (e.type === 'commit' && e.repo === repo && e.commit.oid.startsWith(oid)) return e.commit;
    }
  }
  for (const [, data] of qc.getQueriesData<PullRequestDetail>({ queryKey: ['pr', repo] })) {
    const hit = data?.commits.find((c) => c.oid.startsWith(oid));
    if (hit) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------- diffs

/**
 * The diff for a `diff` URL param. Fetched only when the diff view opens. A commit's diff never
 * changes. A PR's can (new pushes, a moved base), so reopening one asks the server again: it answers
 * from its own cache, checking GitHub only when the synced PR says the diff may be out of date.
 */
export function useDiff(id: string) {
  const t = parseDiffId(id);
  return useQuery({
    queryKey: qk.diff(id),
    queryFn: () => fetchDiff(id, false),
    enabled: !!t,
    staleTime: t?.kind === 'commit' ? Infinity : 0,
    // Once, for a GitHub hiccup or the server restarting; not for a missing token or the rate limit.
    retry: (count, err) => count < 1 && (isUnreachable(err) || (err as { status?: number }).status === 502),
  });
}

function fetchDiff(id: string, refresh: boolean): Promise<Diff> {
  const t = parseDiffId(id);
  if (!t) return Promise.reject(new Error(`Not a diff: ${id}`));
  return t.kind === 'pr' ? api.prDiff(t.repo, t.number, refresh) : api.commitDiff(t.repo, t.oid, refresh);
}

/**
 * Re-check GitHub and replace the cached diff. A plain fetch still in flight (the revalidation when
 * a PR diff reopens) is cancelled first: it may answer later with the older head and overwrite this.
 */
export async function refreshDiff(qc: QueryClient, id: string, fetch = fetchDiff): Promise<Diff> {
  await qc.cancelQueries({ queryKey: qk.diff(id) });
  const d = await fetch(id, true);
  qc.setQueryData(qk.diff(id), d);
  return d;
}

/** Re-check GitHub (a PR may have new commits since the last sync) and replace the cached diff. */
export function useRefreshDiff(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => refreshDiff(qc, id) });
}

/** The viewer's `loadFile`: file contents at a commit, cached per (repo, ref, path); null when unavailable. */
export function useLoadFile(repo: string) {
  const qc = useQueryClient();
  return useCallback(
    (ref: string, path: string) => qc.fetchQuery({
      queryKey: qk.blob(repo, ref, path),
      queryFn: () => api.blob(repo, ref, path),
      staleTime: Infinity,
      retry: (count, err) => count < 1 && !isClientError(err),
    }),
    [qc, repo],
  );
}

export function useDiffCacheStats() {
  return useQuery({ queryKey: qk.diffCache, queryFn: api.diffCache, staleTime: 0 });
}

export function useClearDiffCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.clearDiffCache,
    onSuccess: (stats) => {
      qc.setQueryData(qk.diffCache, stats);
      // Diffs not on screen are fetched again next time, like the server now will.
      qc.removeQueries({ queryKey: ['diff'], type: 'inactive' });
      qc.removeQueries({ queryKey: ['blob'], type: 'inactive' });
    },
  });
}

// ---------------------------------------------------------------- comment threads

/** Threads of a PR ("<repo>#<n>") or a commit (commitDiffId with the full oid, as a diff's headOid gives it). */
export function useThreads(id: string | null) {
  const t = parseDiffId(id);
  return useQuery({
    queryKey: qk.threads(id ?? ''),
    queryFn: () => (t!.kind === 'pr' ? api.prThreads(t!.repo, t!.number) : api.commitThreads(t!.repo, t!.oid)).then((r) => r.items),
    // Commit threads need the full oid; an abbreviated one waits for the diff.
    enabled: !!t && (t.kind === 'pr' || t.oid.length === 40 || t.oid.length === 64),
    staleTime: 30_000,
  });
}

/**
 * Everything that changes a target's threads. Each answer updates the list in place, and PR counts are refetched. A
 * list fetch still in flight may have read the threads before the change and would answer with them after it, undoing
 * it on screen: it is cancelled before the answer goes in, and the list is fetched again afterwards to settle.
 */
export function threadActions(qc: QueryClient, id: string) {
  const t = parseDiffId(id);
  const key = qk.threads(id);
  const put = (thread: CommentThread) => {
    qc.setQueryData<CommentThread[]>(key, (list = []) =>
      list.some((x) => x.id === thread.id) ? list.map((x) => (x.id === thread.id ? thread : x)) : [...list, thread]);
  };
  const drop = (threadId: number) => qc.setQueryData<CommentThread[]>(key, (list = []) => list.filter((x) => x.id !== threadId));
  const counts = () => {
    if (t?.kind !== 'pr') return;
    void qc.invalidateQueries({ queryKey: ['prs'] });
    void qc.invalidateQueries({ queryKey: qk.pr(t.repo, t.number) });
  };
  const done = async <T,>(p: Promise<T>, apply: (v: T) => void) => {
    const v = await p;
    await qc.cancelQueries({ queryKey: key });
    apply(v);
    void qc.invalidateQueries({ queryKey: key });
    counts();
    return v;
  };
  return {
    create: (body: NewPrThread) =>
      done(t?.kind === 'pr' ? api.createPrThread(t.repo, t.number, body) : api.createCommitThread(t!.repo, (t as { oid: string }).oid, body), put),
    reply: (threadId: number, body: string) => done(api.reply(threadId, body), put),
    setStatus: (threadId: number, status: 'open' | 'resolved') => done(api.setThreadStatus(threadId, status), put),
    edit: (commentId: number, body: string) => done(api.editComment(commentId, body), put),
    deleteComment: (threadId: number, commentId: number) =>
      done(api.deleteComment(commentId), (r) => (r.thread ? put(r.thread) : drop(threadId))),
    deleteThread: (threadId: number) => done(api.deleteThread(threadId), () => drop(threadId)),
  };
}

export function useThreadActions(id: string) {
  const qc = useQueryClient();
  return useMemo(() => threadActions(qc, id), [qc, id]);
}

// ---------------------------------------------------------------- mutations

export function usePatchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: { pinned?: boolean; hidden?: boolean } }) => api.patchRepo(key, patch),
    onMutate: async ({ key, patch }) => {
      await qc.cancelQueries({ queryKey: qk.repos });
      const prev = qc.getQueryData<{ items: Repo[] }>(qk.repos);
      if (prev) qc.setQueryData(qk.repos, { items: prev.items.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(qk.repos, ctx.prev); },
    // Hidden or shown: the default selection changed, and with it every list and chart that follows it. (Pinning
    // only reorders repos.) These callbacks run even when hiding unmounted the component that asked.
    onSuccess: (_r, { patch }) => { if (patch.hidden !== undefined) void qc.invalidateQueries({ predicate: followsDefaultSelection }); },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.repos }),
  });
}

// ---------------------------------------------------------------- adding and removing repositories

/**
 * What the Add dialog offers: the token's repositories of other owners and recent contributions. Fetched only while
 * the dialog is open; the server caches the lists for 5 minutes too, and the dialog filters them locally as you type.
 */
export function useRepoCandidates(enabled: boolean, source: string = GITHUB_HOST) {
  return useQuery({
    queryKey: qk.repoCandidatesOf(source),
    // github.com is the API's default source: its requests stay as they were.
    queryFn: () => api.repoCandidates(false, source === GITHUB_HOST ? undefined : source),
    enabled,
    staleTime: 5 * 60_000,
    retry: (count, err) => count < 1 && !isClientError(err),
  });
}

/** Whether the source's token can read the repo `key` (owner/name, or a GitLab key), with a preview; idle while `key` is null. One GraphQL point. */
export function useRepoLookup(key: string | null, source: string = GITHUB_HOST) {
  return useQuery({
    queryKey: qk.repoLookup(source, key ?? ''),
    queryFn: () => api.repoLookup(key!, source === GITHUB_HOST ? undefined : source),
    enabled: !!key,
    staleTime: 60_000,
    retry: false,
  });
}

/** Tracking changed: previews and candidates carry "tracked" (the server recomputes it; lookups are asked again). */
function trackingChanged(qc: QueryClient) {
  qc.removeQueries({ queryKey: ['repo-lookup'] });
  void qc.invalidateQueries({ queryKey: qk.repoCandidates });
}

export function useAddRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.addRepo,
    onSuccess: (res) => {
      const prev = qc.getQueryData<{ items: Repo[] }>(qk.repos);
      if (prev && !prev.items.some((r) => r.key === res.repo.key)) qc.setQueryData(qk.repos, { items: [...prev.items, res.repo] });
      void qc.invalidateQueries({ queryKey: qk.repos });
      // Its first sync started (or waits): the header shows it.
      void qc.invalidateQueries({ queryKey: qk.sync });
      trackingChanged(qc);
    },
  });
}

export function useRemoveRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.removeRepo(key),
    onSuccess: (_r, key) => {
      const prev = qc.getQueryData<{ items: Repo[] }>(qk.repos);
      if (prev) qc.setQueryData(qk.repos, { items: prev.items.filter((r) => r.key !== key) });
      // Its pull requests, issues, commits, releases and set memberships are gone as well.
      void qc.invalidateQueries({ predicate: refetchAfterSync });
      trackingChanged(qc);
    },
  });
}

export function useCreateSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createSet,
    onSuccess: (set: RepoSet) => {
      const prev = qc.getQueryData<{ items: RepoSet[] }>(qk.sets);
      if (prev) qc.setQueryData(qk.sets, { items: [...prev.items, set] });
      qc.invalidateQueries({ queryKey: qk.sets });
      qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

export function useDeleteSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteSet,
    onSuccess: (_r, id) => {
      const prev = qc.getQueryData<{ items: RepoSet[] }>(qk.sets);
      if (prev) qc.setQueryData(qk.sets, { items: prev.items.filter((s) => s.id !== id) });
      qc.invalidateQueries({ queryKey: qk.sets });
      qc.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

export function useCreateView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createView,
    onSuccess: (v: SavedView) => {
      const prev = qc.getQueryData<{ items: SavedView[] }>(qk.views);
      if (prev) qc.setQueryData(qk.views, { items: [...prev.items, v] });
      qc.invalidateQueries({ queryKey: qk.views });
    },
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteView,
    onSuccess: (_r, id) => {
      const prev = qc.getQueryData<{ items: SavedView[] }>(qk.views);
      if (prev) qc.setQueryData(qk.views, { items: prev.items.filter((v) => v.id !== id) });
      qc.invalidateQueries({ queryKey: qk.views });
    },
  });
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.patchSettings,
    onSuccess: (s: Settings) => {
      qc.setQueryData(qk.settings, s);
      // "me" and the default selection can change (myEmails, includeForks); the diff cache cap (diffCacheMb)
      qc.invalidateQueries({ predicate: (q) => refetchAfterSync(q) && q.queryKey[0] !== 'settings' });
    },
  });
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.sync,
    onSuccess: (status: SyncStatus) => { qc.setQueryData(qk.sync, status); },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.sync }),
  });
}
