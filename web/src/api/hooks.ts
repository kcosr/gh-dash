/** react-query hooks over the API client. */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type {
  ActivityQuery,
  ActivityResponse,
  Commit,
  Diff,
  IssueQuery,
  PrListResponse,
  PrQuery,
  PullRequest,
  PullRequestDetail,
  Repo,
  RepoSet,
  SavedView,
  ScopeQuery,
  Settings,
  StatsQuery,
  SyncStatus,
} from '../../../shared/api';
import { api, isClientError, isUnreachable } from './client';
import { defaultRepoScope } from '../../../shared/repos';
import { parseDiffId } from '../lib/urlState';

export const qk = {
  repos: ['repos'] as const,
  sets: ['sets'] as const,
  views: ['views'] as const,
  settings: ['settings'] as const,
  me: ['me'] as const,
  sync: ['sync-status'] as const,
  prs: (q: PrQuery) => ['prs', q] as const,
  issues: (q: IssueQuery) => ['issues', q] as const,
  pr: (repo: string, n: number) => ['pr', repo, n] as const,
  activity: (q: ActivityQuery) => ['activity', q] as const,
  releases: (q: ScopeQuery) => ['releases', q] as const,
  stats: (q: StatsQuery) => ['stats', q] as const,
  diff: (id: string) => ['diff', id] as const,
  blob: (repo: string, ref: string, path: string) => ['blob', repo, ref, path] as const,
  diffCache: ['diff-cache'] as const,
};

/**
 * Queries a finished sync (or a settings change) should refetch. Diffs and file contents are fetched
 * from GitHub on demand, so a sync doesn't swap an open diff under the reader (the diff view has a
 * refresh); a PR diff is revalidated when it's next opened (useDiff).
 */
export const refetchAfterSync = (q: Query) => !['sync-status', 'diff', 'blob'].includes(q.queryKey[0] as string);

// ---------------------------------------------------------------- reference data

export function useRepos() {
  return useQuery({ queryKey: qk.repos, queryFn: api.repos, staleTime: 60_000, select: (d) => d.items });
}

export function useRepoMap(): Map<string, Repo> {
  const { data } = useRepos();
  return useMemo(() => new Map((data ?? []).map((r) => [r.name, r])), [data]);
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 5 * 60_000 });
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 5 * 60_000, retry: false });
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

/** Default scope: not archived, not hidden, not a fork (unless includeForks). */
export function defaultScope(repos: Repo[], settings?: Settings): string[] {
  return defaultRepoScope(repos, settings?.includeForks);
}

// ---------------------------------------------------------------- lists

/** PR lists for 30–90 days are small; fetch up to 1000 in one go. */
export const PR_LIMIT = 1000;

export function usePrList(q: PrQuery, enabled = true) {
  const params = { ...q, limit: q.limit ?? PR_LIMIT };
  return useQuery({ queryKey: qk.prs(params), queryFn: () => api.prs(params), placeholderData: keepPreviousData, enabled });
}

export function useReleases(q: ScopeQuery, enabled = true) {
  const params = { ...q, limit: 200 };
  return useQuery({ queryKey: qk.releases(params), queryFn: () => api.releases(params), placeholderData: keepPreviousData, enabled });
}

export function useIssueList(q: IssueQuery) {
  const params = { ...q, limit: 100 };
  return useInfiniteQuery({
    queryKey: qk.issues(params),
    queryFn: ({ pageParam }) => api.issues({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

export const ACTIVITY_PAGE = 200;

export function useActivityFeed(q: ActivityQuery, enabled = true) {
  const params = { ...q, limit: ACTIVITY_PAGE };
  return useInfiniteQuery({
    queryKey: qk.activity(params),
    queryFn: ({ pageParam }) => api.activity({ ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useStats(q: StatsQuery, enabled = true) {
  return useQuery({ queryKey: qk.stats(q), queryFn: () => api.stats(q), placeholderData: keepPreviousData, enabled });
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

/** Re-check GitHub (a PR may have new commits since the last sync) and replace the cached diff. */
export function useRefreshDiff(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetchDiff(id, true),
    onSuccess: (d) => qc.setQueryData(qk.diff(id), d),
  });
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

// ---------------------------------------------------------------- mutations

export function usePatchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: { pinned?: boolean; hidden?: boolean } }) => api.patchRepo(name, patch),
    onMutate: async ({ name, patch }) => {
      await qc.cancelQueries({ queryKey: qk.repos });
      const prev = qc.getQueryData<{ items: Repo[] }>(qk.repos);
      if (prev) qc.setQueryData(qk.repos, { items: prev.items.map((r) => (r.name === name ? { ...r, ...patch } : r)) });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(qk.repos, ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.repos }),
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
      // "me" and default scope can change (myEmails, includeForks); the diff cache cap (diffCacheMb)
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
