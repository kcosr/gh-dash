/** react-query hooks over the API client. */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  ActivityQuery,
  ActivityResponse,
  IssueQuery,
  PrListResponse,
  PrQuery,
  PullRequest,
  Repo,
  RepoSet,
  SavedView,
  ScopeQuery,
  Settings,
  StatsQuery,
  SyncStatus,
} from '../../../shared/api';
import { api } from './client';
import { defaultRepoScope } from '../../../shared/repos';

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
};

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
      // "me" and default scope can change (myEmails, includeForks)
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'sync-status' && q.queryKey[0] !== 'settings' });
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
