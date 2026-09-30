// What an agent may reach: every source, or only those the user limited it to (Settings → Agents, `agents scope`), as
// the route read them for this request (CallContext.sources). Tools find repositories, threads and comments, and scope
// their lists and event waits, through these helpers, so that out of reach a repository reads exactly as one gh-dash
// doesn't track, a thread or comment as one that doesn't exist, and a source as a host that isn't one: an agent learns
// nothing of what it can't reach, not even that it is there.

import { parseSources, requireSources } from '../api/scope';
import type { Param } from '../db/db';
import type { QueryCtx, Scope } from '../db/filters';
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

/**
 * SQL true for the rows of the repo aliased `alias` that are within reach, with its parameters: `1` for an agent that
 * reaches every source.
 */
export function reachSql(sources: SourceIds, alias: string): { sql: string; params: Param[] } {
  return sources === null ? { sql: '1', params: [] } : { sql: `${alias}.source_id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(sources)] };
}

/** A repository a tool can't find: one gh-dash doesn't track and one out of reach, alike. */
export const repoNotTracked = (key: string): HttpError => new HttpError(404, `Repository ${key} isn't tracked in gh-dash (list_repos lists the ones that are)`);

/** The live repo a tool argument names (a key, or an owned github.com repo's short name), within reach; 404 names it. */
export function requireRepo(reach: Reach, key: string): RepoRef {
  const ref = resolveRepo(reach.deps.db, key);
  if (!ref || !reaches(reach.sources, ref.sourceId)) throw repoNotTracked(key);
  return ref;
}

/**
 * Whether the repo a key names is within reach, live or removed (the bus's messages name repos by key; a key belongs to
 * one source, whose host it carries).
 */
export function repoKeyInReach(reach: Reach, key: string): boolean {
  if (reach.sources === null) return true;
  const row = reach.deps.db.get<{ source_id: number }>('SELECT source_id FROM repos WHERE key = ? COLLATE NOCASE LIMIT 1', [key]);
  return !!row && reaches(reach.sources, row.source_id);
}

const THREAD_SOURCE = 'SELECT r.source_id FROM comment_threads t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?';
const COMMENT_SOURCE = 'SELECT r.source_id FROM comments c JOIN comment_threads t ON t.id = c.thread_id JOIN repos r ON r.id = t.repo_id WHERE c.id = ?';

function outOfReach(reach: Reach, sql: string, id: number): boolean {
  if (reach.sources === null) return false;
  const row = reach.deps.db.get<{ source_id: number }>(sql, [id]);
  return !!row && !reaches(reach.sources, row.source_id);
}

/**
 * 404 "Thread not found" for a thread on a source out of reach, before anything else is said of it (its status, whose
 * comments it holds): the comment service's words for a thread that doesn't exist, which it goes on to say for those.
 */
export function requireThreadInReach(reach: Reach, threadId: number): void {
  if (outOfReach(reach, THREAD_SOURCE, threadId)) throw new HttpError(404, 'Thread not found');
}

/** 404 "Comment not found" for a comment whose thread is on a source out of reach, as requireThreadInReach. */
export function requireCommentInReach(reach: Reach, commentId: number): void {
  if (outOfReach(reach, COMMENT_SOURCE, commentId)) throw new HttpError(404, 'Comment not found');
}

/** A 400 for hosts that aren't sources within reach, in the words used for hosts that aren't sources at all. */
export function requireSourcesInReach(reach: Reach, hosts: readonly string[] | null): void {
  requireSources(reach.deps.db, hosts, reachableHosts(reach));
}

/** Of these repos (Repo.source is a host), those within reach. */
export function reposInReach<T extends { source: string }>(reach: Reach, repos: T[]): T[] {
  if (reach.sources === null) return repos;
  const hosts = reachableHosts(reach);
  return repos.filter((r) => hosts.includes(r.source));
}

/**
 * scopedQuery (services/lists.ts) for an agent: its scope narrowed to the sources within reach, and none for an agent
 * that reaches none (Scope.source is a list of hosts, and an empty one selects nothing). A `source` in the query must be
 * within reach, as it must be a source.
 */
export function reachScope(reach: Reach, query: ScopeParams): { scope: Scope; ctx: QueryCtx } {
  if (reach.sources !== null) requireSourcesInReach(reach, parseSources(query.source));
  const out = scopedQuery(reach.deps.db, reach.deps.config, query);
  if (reach.sources === null) return out;
  const hosts = reachableHosts(reach);
  return { ...out, scope: { ...out.scope, source: (out.scope.source ?? hosts).filter((h) => hosts.includes(h)) } };
}
