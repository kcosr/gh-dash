import type { CommentEventKind, Principal, ThreadStatus } from '../../shared/api';
import type { Db, Param } from './db';
import { repoKeySql } from './repo-key';

/**
 * The comment event log read in id order, for whoever waits on it (MCP's wait_for_reply): what happened after a cursor,
 * in some scope, by anyone but the one asking. Activity reads the same table as the `comment` event type (lists.ts).
 */

/**
 * Where to look: some threads, or a repo (by id) and optionally one PR's own threads of it or one commit's (not a PR's or
 * a branch's made on it).
 */
export interface CommentEventScope {
  threadIds?: number[];
  repoId?: number;
  prNumber?: number;
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

/** The newest event's id (0 when there is none): "from now on" as a cursor. */
export function lastCommentEventId(db: Db): number {
  return db.get<{ id: number | null }>('SELECT max(id) AS id FROM comment_events')?.id ?? 0;
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
  if (scope.threadIds) {
    where.push('ce.thread_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(scope.threadIds));
  }
  if (scope.repoId !== undefined) {
    where.push('ce.repo_id = ?');
    params.push(scope.repoId);
  }
  if (scope.prNumber !== undefined) {
    where.push('ce.pr_number = ?');
    params.push(scope.prNumber);
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
     FROM comment_events ce JOIN repos r ON r.id = ce.repo_id JOIN principals p ON p.id = ce.actor_id
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
