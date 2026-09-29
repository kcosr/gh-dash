import type { CommentThread, Principal, ThreadAnchor, ThreadComment, ThreadStatus } from '../../shared/api';
import type { Db } from './db';

/** The dashboard's own user ("You"): principals row 1, created by the migration. */
export const SELF_PRINCIPAL_ID = 1;

/** What a thread is on: a PR by number or a commit by full oid, in a local repo. */
export type ThreadTarget = { repoId: number; kind: 'pr'; number: number } | { repoId: number; kind: 'commit'; oid: string };

export interface ThreadInput {
  /** The revision the thread is made on (see CommentThread.commitOid); a commit target's own oid. */
  commitOid: string;
  baseOid: string | null;
  anchor: ThreadAnchor;
  /** The first comment. */
  body: string;
}

interface ThreadRow {
  id: number;
  repo: string;
  pr_number: number | null;
  commit_oid: string;
  base_oid: string | null;
  path: string | null;
  side: CommentThread['side'];
  start_line: number | null;
  end_line: number | null;
  snippet: string | null;
  status: ThreadStatus;
  resolved_at: string | null;
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

const THREAD_SELECT = 'SELECT t.*, r.name AS repo FROM comment_threads t JOIN repos r ON r.id = t.repo_id';
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

/** Threads with their comments (two queries, whatever the number of threads). */
function hydrate(db: Db, rows: ThreadRow[]): CommentThread[] {
  if (rows.length === 0) return [];
  const byThread = new Map<number, ThreadComment[]>(rows.map((r) => [r.id, []]));
  const comments = db.all<CommentRow>(`${COMMENT_SELECT} WHERE c.thread_id IN (SELECT value FROM json_each(?)) ORDER BY c.id`, [
    JSON.stringify(rows.map((r) => r.id)),
  ]);
  for (const c of comments) byThread.get(c.thread_id)!.push(toComment(c));
  return rows.map((r) => ({
    id: r.id,
    kind: r.pr_number === null ? 'commit' : 'pr',
    repo: r.repo,
    number: r.pr_number,
    commitOid: r.commit_oid,
    baseOid: r.base_oid,
    path: r.path,
    side: r.side,
    startLine: r.start_line,
    endLine: r.end_line,
    snippet: r.snippet,
    status: r.status,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    comments: byThread.get(r.id)!,
  }));
}

export function getPrincipal(db: Db, id: number): Principal | null {
  return db.get<Principal>('SELECT id, kind, name FROM principals WHERE id = ?', [id]) ?? null;
}

/** A target's threads, oldest first. A PR's are listed whether or not its row is still synced. */
export function listThreads(db: Db, target: ThreadTarget): CommentThread[] {
  const rows =
    target.kind === 'pr'
      ? db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.repo_id = ? AND t.pr_number = ? ORDER BY t.id`, [target.repoId, target.number])
      : db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.repo_id = ? AND t.pr_number IS NULL AND t.commit_oid = ? ORDER BY t.id`, [
          target.repoId,
          target.oid,
        ]);
  return hydrate(db, rows);
}

export function getThread(db: Db, id: number): CommentThread | null {
  return hydrate(db, db.all<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?`, [id]))[0] ?? null;
}

/** Opens a thread with its first comment. The anchor must be one of ThreadAnchor's three levels (CHECK constraints). */
export function createThread(db: Db, target: ThreadTarget, input: ThreadInput, author: Principal, now = nowIso()): CommentThread {
  const { anchor } = input;
  const id = db.tx(() => {
    const threadId = db.run(
      `INSERT INTO comment_threads (repo_id, pr_number, commit_oid, base_oid, path, side, start_line, end_line, snippet, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        target.repoId, target.kind === 'pr' ? target.number : null, input.commitOid, input.baseOid,
        anchor.path, anchor.side, anchor.startLine, anchor.endLine, anchor.snippet, now, now,
      ],
    ).lastInsertRowid;
    db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [threadId, author.id, input.body, now]);
    return threadId;
  });
  return getThread(db, id)!;
}

const touch = (db: Db, threadId: number, now: string) => db.run('UPDATE comment_threads SET updated_at = ? WHERE id = ?', [now, threadId]);

/** Adds a reply; null when the thread doesn't exist. A reply leaves the thread's status alone. */
export function addComment(db: Db, threadId: number, author: Principal, body: string, now = nowIso()): CommentThread | null {
  const added = db.tx(() => {
    if (!db.get('SELECT 1 FROM comment_threads WHERE id = ?', [threadId])) return false;
    db.run('INSERT INTO comments (thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?)', [threadId, author.id, body, now]);
    touch(db, threadId, now);
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
 * it's their database. A thread counts as written by its first comment's author.
 */
export const mayDelete = (actor: Principal, authorId: number): boolean => actor.kind === 'self' || actor.id === authorId;

export function editComment(db: Db, id: number, body: string, now = nowIso()): CommentThread | null {
  const ref = getCommentRef(db, id);
  if (!ref) return null;
  db.tx(() => {
    db.run('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?', [body, now, id]);
    touch(db, ref.threadId, now);
  });
  return getThread(db, ref.threadId);
}

/**
 * Deletes a comment. The first comment is the thread's opening statement: deleting it deletes the whole thread,
 * replies included (thread null), rather than leaving replies to nothing. null when there is no such comment.
 */
export function deleteComment(db: Db, id: number, now = nowIso()): { thread: CommentThread | null } | null {
  const ref = getCommentRef(db, id);
  if (!ref) return null;
  if (ref.first) {
    deleteThread(db, ref.threadId);
    return { thread: null };
  }
  db.tx(() => {
    db.run('DELETE FROM comments WHERE id = ?', [id]);
    touch(db, ref.threadId, now);
  });
  return { thread: getThread(db, ref.threadId) };
}

/** Resolves or reopens a thread; null when it doesn't exist. Setting the current status again changes nothing. */
export function setThreadStatus(db: Db, id: number, status: ThreadStatus, now = nowIso()): CommentThread | null {
  db.run(
    `UPDATE comment_threads SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status <> ?`,
    [status, status === 'resolved' ? now : null, now, id, status],
  );
  return getThread(db, id);
}

/** Deletes a thread and its comments; false when it doesn't exist. */
export function deleteThread(db: Db, id: number): boolean {
  return db.run('DELETE FROM comment_threads WHERE id = ?', [id]).changes > 0;
}
