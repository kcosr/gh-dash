// Every comment read and write as a plain function, with the principal acting named: the HTTP routes call these as the
// dashboard's own user, MCP tools as the agent whose token came with the request. No Hono context; failures are
// HttpError. Each write is one transaction that also records its comment_events row(s) (db/comments.ts); once it has
// committed, the bus hears of it (GET /stream tells the windows, wait_for_reply wakes up).

import { z } from 'zod';
import type { CommentEventKind, CommentThread, Principal, ProviderKind, ThreadAnchor, ThreadStatus } from '../../shared/api';
import type { CommentBus } from '../comments/bus';
import * as store from '../db/comments';
import type { ThreadTarget } from '../db/comments';
import type { Db } from '../db/db';
import { resolveRepo } from '../db/repo-key';
import { HttpError, parseWith } from '../lib/errors';

export interface CommentDeps {
  db: Db;
  /** Told of every write once it has committed. Absent: nobody listens (tests, one-off tools). */
  bus?: CommentBus;
}

/** Longest comment body, as on GitHub. */
export const MAX_BODY_CHARS = 65_536;
/** Most lines one thread may span. */
export const MAX_THREAD_LINES = 1000;
const MAX_SNIPPET_CHARS = 256 * 1024;

// A full commit SHA: 40 characters, or 64 for a SHA-256 repository (GitLab can host those).
export const fullOid = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'expected a full commit SHA (40 or 64 characters)')
  .transform((s) => s.toLowerCase());
const commentBody = z.string().max(MAX_BODY_CHARS).refine((s) => s.trim() !== '', 'must not be empty');
const repoPath = z
  .string()
  .max(4096)
  .refine((p) => !/[\x00-\x1f\x7f]/.test(p) && p.split('/').every((s) => s && s !== '.' && s !== '..'), 'must be a file path in the repository');
const lineNumber = z.number().int().min(1);

const threadFields = {
  baseOid: fullOid.nullable().optional(),
  path: repoPath.nullable().optional(),
  side: z.enum(['old', 'new']).nullable().optional(),
  startLine: lineNumber.nullable().optional(),
  endLine: lineNumber.nullable().optional(),
  snippet: z.string().max(MAX_SNIPPET_CHARS).nullable().optional(),
  body: commentBody,
};
type ThreadFields = z.infer<z.ZodObject<typeof threadFields>>;

/** The anchor's level decides which fields it needs (see ThreadAnchor); a message for the first thing wrong, if any. */
function anchorProblem({ path, side, startLine, endLine, snippet }: ThreadFields): string | null {
  if (side == null) return startLine != null || endLine != null || snippet != null ? 'startLine, endLine and snippet need a side' : null;
  if (path == null) return 'a line thread needs a path';
  if (startLine == null || endLine == null || snippet == null) return 'a line thread needs startLine, endLine and snippet';
  if (endLine < startLine) return 'endLine must not be before startLine';
  if (endLine - startLine >= MAX_THREAD_LINES) return `a thread spans at most ${MAX_THREAD_LINES} lines`;
  if (snippet.split('\n').length !== endLine - startLine + 1) return 'snippet must hold the anchored lines, one per line (endLine - startLine + 1 lines joined with \\n)';
  return null;
}

const toAnchor = (f: ThreadFields): ThreadAnchor => ({
  path: f.path ?? null,
  side: f.side ?? null,
  startLine: f.startLine ?? null,
  endLine: f.endLine ?? null,
  snippet: f.snippet ?? null,
});

const checkAnchor = (f: ThreadFields, ctx: z.RefinementCtx) => {
  const problem = anchorProblem(f);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
};

/** A new PR thread: `commitOid` is the head of the diff the thread is made on. */
const prThreadBody = z.object({ ...threadFields, commitOid: fullOid }).strict().superRefine(checkAnchor);
/** A new commit thread: the commit is the revision; a `commitOid` sent anyway must be it. */
const commitThreadBody = z.object({ ...threadFields, commitOid: fullOid.optional() }).strict().superRefine(checkAnchor);
/** A reply's or an edit's request body. */
export const replyBody = z.object({ body: commentBody }).strict();
const statusValue = z.enum(['open', 'resolved']);
/** PATCH /threads/:id's request body. */
export const statusBody = z.object({ status: statusValue }).strict();

/** POST /prs/:repo/:number/threads's body (validated here: the anchor's fields, the body, the full head SHA). */
export type NewPrThread = z.input<typeof prThreadBody>;
/** POST /commits/:repo/:oid/threads's body. */
export type NewThread = z.input<typeof commitThreadBody>;

/** What a thread is on, by repo key: a PR by number, or a commit by full oid. */
export type TargetRef = { repo: string; kind: 'pr'; number: number } | { repo: string; kind: 'commit'; oid: string };

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The local repos.id for a repo key, by the shared resolver (removed repos are not found). */
function repoIdForKey(db: Db, key: string): number {
  const ref = resolveRepo(db, key);
  if (!ref) throw new HttpError(404, 'Repository not found');
  return ref.id;
}

/**
 * The rule repoIdForKey applies, for a thread reached by its id (or a comment's): 404 unless the thread exists in a
 * repo that isn't removed. A removed repo's threads are kept, and come back with the repo if the sync finds it again.
 */
function requireLiveThread(db: Db, threadId: number, what: 'Thread' | 'Comment' = 'Thread'): void {
  const owner = store.threadRepo(db, threadId);
  if (!owner || owner.removed) throw new HttpError(404, `${what} not found`);
}

const found = <T>(value: T | null, what: string): T => {
  if (value === null) throw new HttpError(404, `${what} not found`);
  return value;
};

/** A positive integer id (a thread's, a comment's); 400 otherwise. */
export function parseId(value: string | number): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

/** A PR number; 400 unless a positive integer. */
function prNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'Invalid PR number');
  return value;
}

/** A full commit oid, lower-cased; 400 otherwise. */
export function parseOid(value: string): string {
  const oid = fullOid.safeParse(value);
  if (!oid.success) throw new HttpError(400, 'Invalid oid: expected a full commit SHA (40 or 64 characters)');
  return oid.data;
}

/** A target by repo key, for db/comments.ts: 404 for an unknown or removed repo, 400 for a bad number or oid. */
export function resolveTarget({ db }: CommentDeps, target: TargetRef): ThreadTarget {
  if (target.kind === 'pr') {
    const number = prNumber(target.number);
    return { repoId: repoIdForKey(db, target.repo), kind: 'pr', number };
  }
  const oid = parseOid(target.oid);
  return { repoId: repoIdForKey(db, target.repo), kind: 'commit', oid };
}

/** The code host of a local repo (its source's kind): a GitLab MR's threads say "!12" and "Merge request". */
export function providerKindOf(db: Db, repoId: number): ProviderKind {
  const row = db.get<{ kind: string }>('SELECT s.kind FROM repos r JOIN sources s ON s.id = r.source_id WHERE r.id = ?', [repoId]);
  return row?.kind === 'gitlab' ? 'gitlab' : 'github';
}

/** A PR's or commit's threads, oldest first. A PR's are listed whether or not its row is still synced; a commit need not be synced. */
export function listTargetThreads(deps: CommentDeps, target: TargetRef): CommentThread[] {
  return store.listThreads(deps.db, resolveTarget(deps, target));
}

/** One thread, in a repo that isn't removed; 404 otherwise. */
export function getThread({ db }: CommentDeps, id: number): CommentThread {
  requireLiveThread(db, id);
  return found(store.getThread(db, id), 'Thread');
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Who may delete a thread (or its first comment, which takes the thread along): the dashboard's user any thread (it's
 * their database); an agent only one whose every comment is its own, so it can't wipe out what someone else wrote.
 */
function mayDeleteThread(actor: Principal, thread: CommentThread): boolean {
  if (actor.kind === 'self') return true;
  return thread.comments.every((c) => c.author.id === actor.id);
}

const THREAD_NOT_YOURS = 'Only a thread whose comments are all yours can be deleted';

// ---------------------------------------------------------------------------
// Writes. Each validates its input, finds its target and writes with no await in between, then tells the bus.
// ---------------------------------------------------------------------------

function announce(deps: CommentDeps, thread: Pick<CommentThread, 'id' | 'repo' | 'kind' | 'number' | 'commitOid'>, event: CommentEventKind, by: Principal): void {
  deps.bus?.emit({ type: 'comments', repo: thread.repo, kind: thread.kind, number: thread.number, commitOid: thread.commitOid, threadId: thread.id, event, by });
}

/** Opens a thread on a PR the dashboard knows (404 for one the sync never saw, or has dropped). */
export function createPrThread(deps: CommentDeps, actor: Principal, repo: string, number: number, input: NewPrThread): CommentThread {
  const n = prNumber(number);
  const f = parseWith(prThreadBody, input);
  const target = resolveTarget(deps, { repo, kind: 'pr', number: n });
  // Listing works for a PR the sync has since dropped; a new thread needs one the dashboard knows.
  if (!deps.db.get('SELECT 1 FROM pull_requests WHERE repo_id = ? AND number = ?', [target.repoId, n])) {
    throw new HttpError(404, 'Pull request not found');
  }
  const thread = store.createThread(deps.db, target, { commitOid: f.commitOid, baseOid: f.baseOid ?? null, anchor: toAnchor(f), body: f.body }, actor);
  announce(deps, thread, 'thread_opened', actor);
  return thread;
}

/** Opens a thread on a commit, synced or not (PR branch commits aren't). */
export function createCommitThread(deps: CommentDeps, actor: Principal, repo: string, oid: string, input: NewThread): CommentThread {
  const commit = parseOid(oid);
  const f = parseWith(commitThreadBody, input);
  if (f.commitOid !== undefined && f.commitOid !== commit) throw new HttpError(400, "commitOid must be the commit's own oid");
  const target = resolveTarget(deps, { repo, kind: 'commit', oid: commit });
  const thread = store.createThread(deps.db, target, { commitOid: commit, baseOid: f.baseOid ?? null, anchor: toAnchor(f), body: f.body }, actor);
  announce(deps, thread, 'thread_opened', actor);
  return thread;
}

/** Replies to a thread; its status stays as it is. */
export function reply(deps: CommentDeps, actor: Principal, threadId: number, body: string): CommentThread {
  const { body: text } = parseWith(replyBody, { body });
  requireLiveThread(deps.db, threadId);
  const thread = found(store.addComment(deps.db, threadId, actor, text), 'Thread');
  announce(deps, thread, 'replied', actor);
  return thread;
}

/** The comment by id, in a live thread (404 otherwise). */
function liveComment(db: Db, id: number): store.CommentRef {
  const ref = found(store.getCommentRef(db, id), 'Comment');
  requireLiveThread(db, ref.threadId, 'Comment');
  return ref;
}

/** Changes a comment's words: its author's only (403). */
export function editComment(deps: CommentDeps, actor: Principal, commentId: number, body: string): CommentThread {
  const { body: text } = parseWith(replyBody, { body });
  const comment = liveComment(deps.db, commentId);
  if (!store.mayEdit(actor, comment.authorId)) throw new HttpError(403, 'You can only edit your own comments');
  const thread = found(store.editComment(deps.db, commentId, text, actor), 'Comment');
  announce(deps, thread, 'edited', actor);
  return thread;
}

/**
 * Deletes a comment: the dashboard's user any, an agent its own (403). The first comment's author is the thread's:
 * deleting it deletes the thread (`thread` null), which an agent may do only when the whole thread is its own.
 */
export function deleteComment(deps: CommentDeps, actor: Principal, commentId: number): { thread: CommentThread | null } {
  const comment = liveComment(deps.db, commentId);
  if (!store.mayDelete(actor, comment.authorId)) throw new HttpError(403, 'Only its author can delete this comment');
  const before = store.getThread(deps.db, comment.threadId)!;
  if (comment.first && !mayDeleteThread(actor, before)) throw new HttpError(403, `Deleting the first comment deletes the thread. ${THREAD_NOT_YOURS}`);
  const result = found(store.deleteComment(deps.db, commentId, actor), 'Comment');
  announce(deps, before, comment.first ? 'thread_deleted' : 'comment_deleted', actor);
  return result;
}

/** Resolves or reopens a thread (anyone may). Setting the status it has changes nothing, and nobody is told. */
export function setThreadStatus(deps: CommentDeps, actor: Principal, threadId: number, status: ThreadStatus): CommentThread {
  const next = parseWith(statusValue, status);
  requireLiveThread(deps.db, threadId);
  const was = store.getThread(deps.db, threadId)?.status;
  const thread = found(store.setThreadStatus(deps.db, threadId, next, actor), 'Thread');
  if (was !== next) announce(deps, thread, next === 'resolved' ? 'resolved' : 'reopened', actor);
  return thread;
}

/** Deletes a thread with its comments: the dashboard's user any, an agent one whose comments are all its own (403). */
export function deleteThread(deps: CommentDeps, actor: Principal, threadId: number): void {
  requireLiveThread(deps.db, threadId);
  const thread = found(store.getThread(deps.db, threadId), 'Thread');
  if (!mayDeleteThread(actor, thread)) throw new HttpError(403, THREAD_NOT_YOURS);
  store.deleteThread(deps.db, threadId, actor);
  announce(deps, thread, 'thread_deleted', actor);
}

/** The dashboard's own user, who every HTTP request acts as (agents come through MCP, with a token). */
export const selfPrincipal = (db: Db): Principal => store.getPrincipal(db, store.SELF_PRINCIPAL_ID)!;
