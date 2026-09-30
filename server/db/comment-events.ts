import type { CommentEventKind, Principal, ThreadStatus } from '../../shared/api';
import { branchGroupSql, prGroupSql } from './comments';
import type { Db, Param } from './db';
import { repoKeySql } from './repo-key';

/**
 * The comment event log read in id order, for whoever waits on it (MCP's wait_for_reply): what happened after a cursor,
 * in some scope, by anyone but the one asking. Activity reads the same table as the `comment` event type (lists.ts).
 */

/**
 * Where to look: some threads, or a repo (by id) and optionally one target of it, whose events are those of the threads its
 * view lists (shared/api.ts, "Branch groups"): `prNumber` a PR's own threads and its branch group, `branch` the branch's
 * current group (it needs `repoId`, as a name is the repo's), `commitOid` one commit's own (not a PR's or a branch's made
 * on it). `sourceIds`: only in repos on these sources (an agent's reach; none: nothing), whatever else it names.
 */
export interface CommentEventScope {
  sourceIds?: readonly number[];
  threadIds?: number[];
  repoId?: number;
  prNumber?: number;
  branch?: string;
  commitOid?: string;
}

export interface CommentEventItem {
  /** The cursor: ids only grow. */
  id: number;
  at: string;
  kind: CommentEventKind;
  threadId: number;
  /** The comment it is about (thread_opened: the first one); null for resolved, reopened and thread_deleted. */
  commentId: number | null;
  by: Principal;
  repo: string;
  /** What the thread is on, derived as its kind is (db/comments.ts hydrate). */
  target: { kind: 'pr'; number: number } | { kind: 'branch'; branch: string } | { kind: 'commit'; oid: string };
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  excerpt: string | null;
  /** The thread's status now; null once it is deleted. */
  threadStatus: ThreadStatus | null;
}

interface Row {
  id: number;
  at: string;
  kind: CommentEventKind;
  thread_id: number;
  comment_id: number | null;
  actor_id: number;
  actor_kind: Principal['kind'];
  actor_name: string;
  repo: string;
  pr_number: number | null;
  branch: string | null;
  commit_oid: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  excerpt: string | null;
  thread_status: ThreadStatus | null;
}

/**
 * The events, each with the place of its thread as a view sees it, for the branch groups' SQL (db/comments.ts), which
 * reads a thread's repo_id, branch and created_at. One place for all of a thread's events, as of the thread's last state:
 * while it exists, its row's; once it is deleted, that of its last event, thread_deleted, which deleteThread logs from the
 * row as it was just before (the branch a sync may have taken away or found since: an event's own copy is as of its
 * writing, and would put a thread's events in another group than its own view had it). Its creation time, once it is
 * gone, is that of its first event, thread_opened, written with it.
 */
const GROUPED_EVENTS =
  `(SELECT e.id, e.at, e.actor_id, e.kind, e.repo_id, e.pr_number, e.commit_oid, e.thread_id, e.comment_id, e.path, e.start_line, e.end_line, e.excerpt,
      CASE WHEN th.id IS NULL THEN (SELECT l.branch FROM comment_events l WHERE l.thread_id = e.thread_id ORDER BY l.id DESC LIMIT 1) ELSE th.branch END AS branch,
      COALESCE(th.created_at, (SELECT f.at FROM comment_events f WHERE f.thread_id = e.thread_id ORDER BY f.id LIMIT 1)) AS created_at
    FROM comment_events e LEFT JOIN comment_threads th ON th.id = e.thread_id)`;

/** The newest event's id (0 when there is none), in repos on `sourceIds` if given (none: 0): "from now on" as a cursor. */
export function lastCommentEventId(db: Db, sourceIds?: readonly number[]): number {
  if (!sourceIds) return db.get<{ id: number | null }>('SELECT max(id) AS id FROM comment_events')?.id ?? 0;
  // An agent's reach: the log's end as far as it can see, so a wait that starts there and times out hands back a cursor
  // that doesn't move with what happens on other sources. Ids are still one sequence across sources (as thread and
  // comment ids are): their gaps can say that something happened out of reach, never what (docs/agents.md).
  return (
    db.get<{ id: number | null }>(
      'SELECT max(ce.id) AS id FROM comment_events ce JOIN repos r ON r.id = ce.repo_id WHERE r.source_id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(sourceIds)],
    )?.id ?? 0
  );
}

/**
 * Events after `afterId`, oldest first, in `scope` (every repo when empty), leaving out `exceptActor`'s own and those
 * of removed repos; at most `limit`.
 */
export function commentEventsAfter(
  db: Db,
  afterId: number,
  opts: { scope?: CommentEventScope; exceptActor?: number; limit?: number } = {},
): CommentEventItem[] {
  const where = ['ce.id > ?', 'r.removed_at IS NULL'];
  const params: Param[] = [afterId];
  const { scope = {} } = opts;
  if (opts.exceptActor !== undefined) {
    where.push('ce.actor_id <> ?');
    params.push(opts.exceptActor);
  }
  if (scope.sourceIds) {
    where.push('r.source_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(scope.sourceIds));
  }
  if (scope.threadIds) {
    where.push('ce.thread_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(scope.threadIds));
  }
  if (scope.repoId !== undefined) {
    where.push('ce.repo_id = ?');
    params.push(scope.repoId);
  }
  // A PR's view: its own threads (listed whether or not the sync still has the PR), and its branch group where it does.
  if (scope.prNumber !== undefined) {
    where.push(
      `(ce.pr_number = ? OR EXISTS (SELECT 1 FROM pull_requests gp WHERE gp.repo_id = ce.repo_id AND gp.number = ? AND ${prGroupSql('ce', 'gp')}))`,
    );
    params.push(scope.prNumber, scope.prNumber);
  }
  if (scope.branch !== undefined) {
    where.push(`(${branchGroupSql('ce', '?')})`);
    params.push(scope.branch);
  }
  if (scope.commitOid !== undefined) {
    where.push('ce.pr_number IS NULL AND ce.branch IS NULL AND ce.commit_oid = ?');
    params.push(scope.commitOid);
  }
  params.push(opts.limit ?? 100);
  const rows = db.all<Row>(
    `SELECT ce.id, ce.at, ce.kind, ce.thread_id, ce.comment_id, ce.actor_id, p.kind AS actor_kind, p.name AS actor_name,
       ${repoKeySql('r')} AS repo, ce.pr_number, ce.branch, ce.commit_oid, ce.path, ce.start_line, ce.end_line, ce.excerpt,
       (SELECT status FROM comment_threads WHERE id = ce.thread_id) AS thread_status
     FROM ${scope.prNumber !== undefined || scope.branch !== undefined ? GROUPED_EVENTS : 'comment_events'} ce
       JOIN repos r ON r.id = ce.repo_id JOIN principals p ON p.id = ce.actor_id
     WHERE ${where.join(' AND ')} ORDER BY ce.id LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    kind: r.kind,
    threadId: r.thread_id,
    commentId: r.comment_id,
    by: { id: r.actor_id, kind: r.actor_kind, name: r.actor_name },
    repo: r.repo,
    target:
      r.pr_number !== null
        ? { kind: 'pr', number: r.pr_number }
        : r.branch !== null
          ? { kind: 'branch', branch: r.branch }
          : { kind: 'commit', oid: r.commit_oid },
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    excerpt: r.excerpt,
    threadStatus: r.thread_status,
  }));
}
