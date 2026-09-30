import type { CommentEventKind, CommentThread, Principal, ThreadAnchor, ThreadComment, ThreadStatus, ThreadView } from '../../shared/api';
import { commentExcerpt } from '../../shared/comment-markdown';
import type { Db } from './db';
import { repoKeySql } from './repo-key';

/** The dashboard's own user ("You"): principals row 1, created by the migration. */
export const SELF_PRINCIPAL_ID = 1;

/** What a thread is on: a PR by number, a branch by name or a commit by full oid, in a local repo. */
export type ThreadTarget =
  | { repoId: number; kind: 'pr'; number: number }
  | { repoId: number; kind: 'branch'; branch: string }
  | { repoId: number; kind: 'commit'; oid: string };

export interface ThreadInput {
  /** The revision the thread is made on (see CommentThread.commitOid); a commit target's own oid. */
  commitOid: string;
  baseOid: string | null;
  anchor: ThreadAnchor;
  /** The first comment. */
  body: string;
  /**
   * A PR thread's branch (CommentThread.branch), which the caller reads from the PR's row: its head branch when the PR is
   * from the same repo, else null (the default). A branch thread's is its target's; a commit thread has none.
   */
  prBranch?: string | null;
}

export interface ThreadRow {
  id: number;
  repo: string;
  pr_number: number | null;
  branch: string | null;
  commit_oid: string;
  base_oid: string | null;
  path: string | null;
  side: CommentThread['side'];
  start_line: number | null;
  end_line: number | null;
  snippet: string | null;
  status: ThreadStatus;
  resolved_at: string | null;
  /** Who resolved it; null while open (v8 attributed the threads resolved before it to the dashboard user). */
  resolved_by: number | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: number;
  thread_id: number;
  author_id: number;
  author_kind: Principal['kind'];
  author_name: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

const THREAD_SELECT = `SELECT t.*, ${repoKeySql('r')} AS repo FROM comment_threads t JOIN repos r ON r.id = t.repo_id`;
const COMMENT_SELECT =
  'SELECT c.*, p.kind AS author_kind, p.name AS author_name FROM comments c JOIN principals p ON p.id = c.author_id';

const nowIso = () => new Date().toISOString();

const toComment = (r: CommentRow): ThreadComment => ({
  id: r.id,
  author: { id: r.author_id, kind: r.author_kind, name: r.author_name },
  body: r.body,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});

/** Threads with their comments and resolvers (three queries at most, whatever the number of threads), in the order of `rows`. */
export function hydrate(db: Db, rows: ThreadRow[]): CommentThread[] {
  if (rows.length === 0) return [];
  const byThread = new Map<number, ThreadComment[]>(rows.map((r) => [r.id, []]));
  const comments = db.all<CommentRow>(`${COMMENT_SELECT} WHERE c.thread_id IN (SELECT value FROM json_each(?)) ORDER BY c.id`, [
    JSON.stringify(rows.map((r) => r.id)),
  ]);
  for (const c of comments) byThread.get(c.thread_id)!.push(toComment(c));
  const resolverIds = [...new Set(rows.flatMap((r) => (r.resolved_by === null ? [] : [r.resolved_by])))];
  const resolvers = new Map(
    resolverIds.length
      ? db.all<Principal>('SELECT id, kind, name FROM principals WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(resolverIds)]).map((p) => [p.id, p])
      : [],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.pr_number !== null ? 'pr' : r.branch !== null ? 'branch' : 'commit',
    repo: r.repo,
    number: r.pr_number,
    branch: r.branch,
    commitOid: r.commit_oid,
    baseOid: r.base_oid,
    path: r.path,
    side: r.side,
    startLine: r.start_line,
    endLine: r.end_line,
    snippet: r.snippet,
    status: r.status,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by === null ? null : (resolvers.get(r.resolved_by) ?? null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    comments: byThread.get(r.id)!,
  }));
}

export function getPrincipal(db: Db, id: number): Principal | null {
  return db.get<Principal>('SELECT id, kind, name FROM principals WHERE id = ?', [id]) ?? null;
}

// ---------------------------------------------------------------------------
// Branch groups (shared/api.ts): which of a branch's threads its review and the PRs from it show. Written once, as SQL
// over a comment_threads alias and a pull_requests one, for every query that needs them: the target lists below, GET
// /threads' target filters and the PR list's comment counts.
// ---------------------------------------------------------------------------

/**
 * A code host's time (whole seconds: `2026-09-21T10:00:00Z`) written as gh-dash writes its own (`…T10:00:00.000Z`), so
 * a thread's created_at compares with it as text. NULL stays NULL.
 */
const asThreadTime = (sql: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${sql})`;

/**
 * The merges that end a line of work on a branch, as the FROM clause of a subquery over pull_requests `mp`: the merged
 * PRs from branch `branch` of repo `repo` (SQL expressions) that are from the same repo. A fork's PR from a branch of
 * that name is from another repo's branch, and ends nothing here.
 */
const mergesOf = (repo: string, branch: string) =>
  `FROM pull_requests mp WHERE mp.repo_id = ${repo} AND mp.head_ref = ${branch} AND mp.cross_repo = 0 AND mp.merged_at IS NOT NULL`;

/**
 * SQL: whether thread `t` (an alias of comment_threads) is in the current group of branch `branch` (an SQL expression:
 * `?`, or a column) in its repo, which the branch's review shows: the branch's threads made after its last merge (all
 * of them, for a branch never merged). Found by the (repo_id, branch) index.
 */
export const branchGroupSql = (t: string, branch: string): string =>
  `${t}.branch = ${branch} AND IFNULL(${t}.created_at > (SELECT ${asThreadTime('max(mp.merged_at)')} ${mergesOf(`${t}.repo_id`, `${t}.branch`)}), 1)`;

/**
 * SQL: when PR `p` ended its line of work: its merge, else its closing. NULL while it is open, and for a closed PR the
 * host gave no time for: neither has ended, so their group runs on.
 */
const prEndSql = (p: string) => `CASE WHEN ${p}.state = 'open' THEN NULL ELSE COALESCE(${p}.merged_at, ${p}.closed_at) END`;

/**
 * SQL: whether thread `t` (an alias of comment_threads) is in the branch group of PR `p` (an alias of pull_requests): a
 * thread of the PR's head branch made after the branch's last merge before the PR's end, and no later than its first
 * merge at or after that end (the PR's own, for a merged PR). A bound with no merge is open, so an open PR's group is
 * its branch's current one. A PR from a fork, or one the sync hasn't said of yet (cross_repo NULL), has none. Not every
 * thread of the PR's own is in it (one made after the PR's merge is in the next group): prViewSql adds them.
 */
export function prGroupSql(t: string, p: string): string {
  const end = prEndSql(p);
  const merges = mergesOf(`${p}.repo_id`, `${p}.head_ref`);
  return (
    `${p}.cross_repo = 0 AND ${t}.repo_id = ${p}.repo_id AND ${t}.branch = ${p}.head_ref` +
    ` AND IFNULL(${t}.created_at > (SELECT ${asThreadTime('max(mp.merged_at)')} ${merges} AND (${end} IS NULL OR mp.merged_at < ${end})), 1)` +
    ` AND IFNULL(${t}.created_at <= (SELECT ${asThreadTime('min(mp.merged_at)')} ${merges} AND mp.merged_at >= ${end}), 1)`
  );
}

/**
 * SQL: whether thread `t` is in the view of PR `p` (a synced row): the PR's own threads (keyed by repo and number, so
 * they match its current row) and its branch group. SQLite finds each half by its own index (a MULTI-INDEX OR).
 */
export const prViewSql = (t: string, p: string): string =>
  `(${t}.repo_id = ${p}.repo_id AND ${t}.pr_number = ${p}.number) OR (${prGroupSql(t, p)})`;

/**
 * SQL: the number of the merged PR whose view shows branch thread `t` (an alias of comment_threads) of an earlier line of
 * work: the first merge of its branch the thread was made no later than, the end of the group it is in (prGroupSql puts
 * it in that PR's). NULL for a branch thread of the current group (the branch's review shows it), and for PR and
 * commit threads, which their own targets show.
 */
export const endedByPrSql = (t: string): string =>
  `(SELECT mp.number ${mergesOf(`${t}.repo_id`, `${t}.branch`)} AND ${t}.pr_number IS NULL AND ${t}.created_at <= ${asThreadTime('mp.merged_at')}` +
  ' ORDER BY mp.merged_at, mp.number LIMIT 1)';

/** Which diff shows a thread, given its row and endedByPrSql's answer for it (see ThreadListItem.view). */
export function threadView(t: Pick<ThreadRow, 'pr_number' | 'branch' | 'commit_oid'>, endedByPr: number | null): ThreadView {
  if (t.pr_number !== null) return { kind: 'pr', number: t.pr_number };
  if (t.branch !== null) return endedByPr === null ? { kind: 'branch', branch: t.branch } : { kind: 'pr', number: endedByPr };
  return { kind: 'commit', oid: t.commit_oid };
}

/** Which diff shows thread `id` (see ThreadListItem.view); null when there is no such thread. */
export function viewOfThread(db: Db, id: number): ThreadView | null {
  const row = db.get<Pick<ThreadRow, 'pr_number' | 'branch' | 'commit_oid'> & { ended_by_pr: number | null }>(
    `SELECT t.pr_number, t.branch, t.commit_oid, ${endedByPrSql('t')} AS ended_by_pr FROM comment_threads t WHERE t.id = ?`,
    [id],
  );
  return row ? threadView(row, row.ended_by_pr) : null;
}

/** The ids of the threads in the branch group of PR number ?2 of repo ?1: none when the sync doesn't hold the PR. */
const PR_GROUP_IDS = `SELECT g.id FROM pull_requests gp JOIN comment_threads g ON ${prGroupSql('g', 'gp')} WHERE gp.repo_id = ?1 AND gp.number = ?2`;

/**
 * A target's threads, oldest first, as its view shows them (shared/api.ts, "Branch groups"):
 *  - a PR: its own, whether or not its row is still synced, and its branch group (known from the row);
 *  - a branch: its current group;
 *  - a commit: its own, not a PR's or a branch's made on it.
 */
export function listThreads(db: Db, target: ThreadTarget): CommentThread[] {
  const { repoId } = target;
  const rows =
    target.kind === 'pr'
      ? db.all<ThreadRow>(`${THREAD_SELECT} WHERE (t.repo_id = ?1 AND t.pr_number = ?2) OR t.id IN (${PR_GROUP_IDS}) ORDER BY t.id`, [repoId, target.number])
      : target.kind === 'branch'
        ? db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.repo_id = ? AND ${branchGroupSql('t', '?')} ORDER BY t.id`, [repoId, target.branch])
        : db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.repo_id = ? AND t.pr_number IS NULL AND t.branch IS NULL AND t.commit_oid = ? ORDER BY t.id`, [
            repoId,
            target.oid,
          ]);
  return hydrate(db, rows);
}

/** The repo a thread belongs to, and whether the sync has marked it removed; null when there is no such thread. */
export function threadRepo(db: Db, threadId: number): { repoId: number; removed: boolean } | null {
  const row = db.get<{ repo_id: number; removed: number }>(
    'SELECT t.repo_id, r.removed_at IS NOT NULL AS removed FROM comment_threads t JOIN repos r ON r.id = t.repo_id WHERE t.id = ?',
    [threadId],
  );
  return row ? { repoId: row.repo_id, removed: !!row.removed } : null;
}

export function getThread(db: Db, id: number): CommentThread | null {
  return hydrate(db, db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?`, [id]))[0] ?? null;
}

/**
 * Records a write in the comment event log, inside the write's transaction. The thread's place (repo, target, anchor)
 * is copied from its row, so for a delete this runs first; `text` is the comment's words (the thread's first comment for
 * thread events), kept as a plain excerpt. Returns the event's id.
 */
function logEvent(
  db: Db,
  actor: Principal,
  kind: CommentEventKind,
  threadId: number,
  commentId: number | null,
  text: string | null,
  now: string,
): number {
  return db.run(
    `INSERT INTO comment_events (at, actor_id, kind, repo_id, pr_number, branch, commit_oid, thread_id, comment_id, path, side, start_line, end_line, excerpt)
     SELECT ?, ?, ?, repo_id, pr_number, branch, commit_oid, id, ?, path, side, start_line, end_line, ? FROM comment_threads WHERE id = ?`,
    [now, actor.id, kind, commentId, text === null ? null : commentExcerpt(text), threadId],
  ).lastInsertRowid;
}

const firstBody = (db: Db, threadId: number): string | null =>
  db.get<{ body: string }>('SELECT body FROM comments WHERE thread_id = ? ORDER BY id LIMIT 1', [threadId])?.body ?? null;

/** Opens a thread with its first comment. The anchor must be one of ThreadAnchor's three levels (CHECK constraints). */
export function createThread(db: Db, target: ThreadTarget, input: ThreadInput, author: Principal, now = nowIso()): CommentThread {
  const { anchor } = input;
  const branch = target.kind === 'branch' ? target.branch : target.kind === 'pr' ? (input.prBranch ?? null) : null;
  const id = db.tx(() => {
    const threadId = db.run(
      `INSERT INTO comment_threads (repo_id, pr_number, branch, commit_oid, base_oid, path, side, start_line, end_line, snippet, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        target.repoId, target.kind === 'pr' ? target.number : null, branch, input.commitOid, input.baseOid,
        anchor.path, anchor.side, anchor.startLine, anchor.endLine, anchor.snippet, now, now,
      ],
    ).lastInsertRowid;
    const commentId = db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [threadId, author.id, input.body, now])
      .lastInsertRowid;
    logEvent(db, author, 'thread_opened', threadId, commentId, input.body, now);
    return threadId;
  });
  return getThread(db, id)!;
}

const touch = (db: Db, threadId: number, now: string) => db.run('UPDATE comment_threads SET updated_at = ? WHERE id = ?', [now, threadId]);

/** Adds a reply; null when the thread doesn't exist. A reply leaves the thread's status alone. */
export function addComment(db: Db, threadId: number, author: Principal, body: string, now = nowIso()): CommentThread | null {
  const added = db.tx(() => {
    if (!db.get('SELECT 1 FROM comment_threads WHERE id = ?', [threadId])) return false;
    const commentId = db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [threadId, author.id, body, now])
      .lastInsertRowid;
    touch(db, threadId, now);
    logEvent(db, author, 'replied', threadId, commentId, body, now);
    return true;
  });
  return added ? getThread(db, threadId) : null;
}

/** A comment's place: its thread, author, and whether it opened the thread. */
export interface CommentRef {
  threadId: number;
  authorId: number;
  first: boolean;
}

export function getCommentRef(db: Db, id: number): CommentRef | null {
  const row = db.get<{ thread_id: number; author_id: number; first_id: number }>(
    'SELECT thread_id, author_id, (SELECT min(id) FROM comments WHERE thread_id = c.thread_id) AS first_id FROM comments c WHERE id = ?',
    [id],
  );
  return row ? { threadId: row.thread_id, authorId: row.author_id, first: row.first_id === id } : null;
}

/** Only a comment's author may change its words. */
export const mayEdit = (actor: Principal, authorId: number): boolean => actor.id === authorId;

/**
 * Authors may delete what they wrote; the dashboard's own user may delete anything (an agent's noise included), as
 * it's their database. A thread counts as written by its first comment's author. (An agent deleting a thread needs
 * more: services/comments.ts.)
 */
export const mayDelete = (actor: Principal, authorId: number): boolean => actor.kind === 'self' || actor.id === authorId;

/**
 * Changes a comment's words, as `actor` (its author: the caller checks). The same words again change nothing, and
 * record nothing. null when there is no such comment.
 */
export function editComment(db: Db, id: number, body: string, actor: Principal, now = nowIso()): CommentThread | null {
  const ref = getCommentRef(db, id);
  if (!ref) return null;
  db.tx(() => {
    if (!db.run('UPDATE comments SET body = ?, edited_at = ? WHERE id = ? AND body <> ?', [body, now, id, body]).changes) return;
    touch(db, ref.threadId, now);
    logEvent(db, actor, 'edited', ref.threadId, id, body, now);
  });
  return getThread(db, ref.threadId);
}

/**
 * Deletes a comment. The first comment is the thread's opening statement: deleting it deletes the whole thread,
 * replies included (thread null), rather than leaving replies to nothing. null when there is no such comment.
 *
 * Deleted words go from the event log too: the log keeps who deleted what, where and when, but no event of the comment
 * (its reply, its edits, the delete) keeps its text.
 */
export function deleteComment(db: Db, id: number, actor: Principal, now = nowIso()): { thread: CommentThread | null } | null {
  const ref = getCommentRef(db, id);
  if (!ref) return null;
  if (ref.first) {
    deleteThread(db, ref.threadId, actor, now);
    return { thread: null };
  }
  db.tx(() => {
    logEvent(db, actor, 'comment_deleted', ref.threadId, id, null, now);
    // By thread first: comment_events_thread finds them.
    db.run('UPDATE comment_events SET excerpt = NULL WHERE thread_id = ? AND comment_id = ?', [ref.threadId, id]);
    db.run('DELETE FROM comments WHERE id = ?', [id]);
    touch(db, ref.threadId, now);
  });
  return { thread: getThread(db, ref.threadId) };
}

/**
 * Resolves or reopens a thread, as `actor` (who resolved it is kept; reopening clears it); null when it doesn't exist.
 * Setting the current status again changes nothing, and records nothing.
 */
export function setThreadStatus(db: Db, id: number, status: ThreadStatus, actor: Principal, now = nowIso()): CommentThread | null {
  db.tx(() => {
    const resolved = status === 'resolved';
    const changed = db.run(
      `UPDATE comment_threads SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ? AND status <> ?`,
      [status, resolved ? now : null, resolved ? actor.id : null, now, id, status],
    ).changes;
    if (changed) logEvent(db, actor, resolved ? 'resolved' : 'reopened', id, null, firstBody(db, id), now);
  });
  return getThread(db, id);
}

/**
 * Deletes a thread and its comments, as `actor`; false when it doesn't exist. Every event of the thread loses its text
 * (as deleteComment's do): the log keeps what happened, not what was said.
 */
export function deleteThread(db: Db, id: number, actor: Principal, now = nowIso()): boolean {
  return db.tx(() => {
    if (!db.get('SELECT 1 FROM comment_threads WHERE id = ?', [id])) return false;
    logEvent(db, actor, 'thread_deleted', id, null, null, now);
    db.run('UPDATE comment_events SET excerpt = NULL WHERE thread_id = ?', [id]);
    return db.run('DELETE FROM comment_threads WHERE id = ?', [id]).changes > 0;
  });
}
