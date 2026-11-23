// MCP tools intersect the agent's permitted sources for this request with live repository policy. A repository,
// thread or comment out of reach produces the same result as a missing one.

import { parseSources, requireSources } from '../api/scope';
import { agentRepoScope, type QueryCtx, type Scope } from '../db/filters';
import { type RepoRef, resolveRepo } from '../db/repo-key';
import { listSources, type SourceRow } from '../db/sources';
import { HttpError } from '../lib/errors';
import { type ScopeParams, scopedQuery } from '../services/lists';
import type { SourceIds, ToolContext } from './tool';

/** What the helpers need of a tool's context. */
export type Reach = Pick<ToolContext, 'deps' | 'sources'>;

/** Whether a source is within reach. */
export const reaches = (sources: SourceIds, sourceId: number): boolean => sources === null || sources.includes(sourceId);

/** The sources within reach, github.com first (whoami). */
export function reachableSources({ deps, sources }: Reach): SourceRow[] {
  return listSources(deps.db).filter((s) => reaches(sources, s.id));
}

/** Their hosts, as Scope.source and Repo.source name sources. */
const reachableHosts = (reach: Reach): string[] => reachableSources(reach).map((s) => s.host);

export const repoUnavailable = (key: string): HttpError => new HttpError(404, `Repository ${key} isn't available through gh-dash (see list_repos)`);

/** Check the original repository identity as well as the key, which can be reassigned during a sync. */
export function repoInReach({ deps, sources }: Reach, ref: Pick<RepoRef, 'id' | 'key'>): boolean {
  const { sql, params } = agentRepoScope('r', sources);
  return !!deps.db.get(`SELECT 1 FROM repos r WHERE r.id = ? AND r.key = ? AND ${sql}`, [ref.id, ref.key, ...params]);
}

export function requireRepoInReach(reach: Reach, ref: RepoRef, input = ref.key): void {
  if (!repoInReach(reach, ref)) throw repoUnavailable(input);
}

/** The live repo a tool argument names (a key, or an owned github.com repo's short name), within reach; 404 names it. */
export function requireRepo(reach: Reach, key: string): RepoRef {
  const ref = resolveRepo(reach.deps.db, key);
  if (!ref) throw repoUnavailable(key);
  requireRepoInReach(reach, ref, key);
  return ref;
}

/** A thread's authorizable repository, for target identity checks after fetching the diff. */
export function requireThreadInReach({ deps, sources }: Reach, threadId: number): Pick<RepoRef, 'id' | 'key'> {
  const { sql, params } = agentRepoScope('r', sources);
  const repo = deps.db.get<Pick<RepoRef, 'id' | 'key'>>(
    `SELECT r.id, r.key FROM comment_threads t JOIN repos r ON r.id = t.repo_id WHERE t.id = ? AND ${sql}`, [threadId, ...params],
  );
  if (!repo) throw new HttpError(404, 'Thread not found');
  return repo;
}

export function requireCommentInReach({ deps, sources }: Reach, commentId: number): void {
  const { sql, params } = agentRepoScope('r', sources);
  if (!deps.db.get(
    `SELECT 1 FROM comments c JOIN comment_threads t ON t.id = c.thread_id JOIN repos r ON r.id = t.repo_id WHERE c.id = ? AND ${sql}`,
    [commentId, ...params],
  )) throw new HttpError(404, 'Comment not found');
}

/** A 400 for hosts that aren't sources within reach, in the words used for hosts that aren't sources at all. */
export function requireSourcesInReach(reach: Reach, hosts: readonly string[] | null): void {
  requireSources(reach.deps.db, hosts, reachableHosts(reach));
}

/** The normal list scope with repository authorization applied before counts and pagination. */
export function reachScope(reach: Reach, query: ScopeParams): { scope: Scope; ctx: QueryCtx } {
  if (reach.sources !== null) requireSourcesInReach(reach, parseSources(query.source));
  const out = scopedQuery(reach.deps.db, reach.deps.config, query, reach.deps.now?.());
  return { ...out, scope: { ...out.scope, agentSources: reach.sources } };
}
