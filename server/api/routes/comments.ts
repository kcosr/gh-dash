import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Principal, ThreadAnchor } from '../../../shared/api';
import { threadsMarkdown } from '../../../shared/comment-markdown';
import {
  addComment,
  createThread,
  deleteComment,
  deleteThread,
  editComment,
  getCommentRef,
  getPrincipal,
  getThread,
  listThreads,
  mayDelete,
  mayEdit,
  SELF_PRINCIPAL_ID,
  setThreadStatus,
  threadRepo,
  type ThreadTarget,
} from '../../db/comments';
import type { Db } from '../../db/db';
import { resolveRepo } from '../../db/repo-key';
import type { AppDeps } from '../app';
import { HttpError, jsonBody, parseWith } from '../http';

/** Longest comment body, as on GitHub. */
const MAX_BODY_CHARS = 65_536;
/** Most lines one thread may span. */
const MAX_THREAD_LINES = 1000;
const MAX_SNIPPET_CHARS = 256 * 1024;

const fullOid = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, 'expected a full 40-character commit SHA')
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

/** POST /prs/:repo/:number/threads: `commitOid` is the head of the diff the thread is made on. */
const prThreadBody = z.object({ ...threadFields, commitOid: fullOid }).strict().superRefine(checkAnchor);
/** POST /commits/:repo/:oid/threads: the commit is the revision; a `commitOid` sent anyway must be it. */
const commitThreadBody = z.object({ ...threadFields, commitOid: fullOid.optional() }).strict().superRefine(checkAnchor);

const replyBody = z.object({ body: commentBody }).strict();
const statusBody = z.object({ status: z.enum(['open', 'resolved']) }).strict();
const listQuery = z.object({ format: z.enum(['json', 'md']).optional() });

/** The local repos.id for a route's repo key, by the shared resolver (removed repos are not found). */
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
  const owner = threadRepo(db, threadId);
  if (!owner || owner.removed) throw new HttpError(404, `${what} not found`);
}

/**
 * Who is acting. Every request is the dashboard's own user today; once agents get API tokens, this is where a token
 * maps to its principal.
 */
const actingPrincipal = (db: Db): Principal => getPrincipal(db, SELF_PRINCIPAL_ID)!;

function idParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

function prNumberParam(c: Context): number {
  const number = Number(c.req.param('number'));
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, 'Invalid PR number');
  return number;
}

function oidParam(c: Context): string {
  const oid = fullOid.safeParse(c.req.param('oid'));
  if (!oid.success) throw new HttpError(400, 'Invalid oid: expected a full 40-character commit SHA');
  return oid.data;
}

const prTarget = (db: Db, c: Context, number: number): ThreadTarget & { kind: 'pr' } => ({
  repoId: repoIdForKey(db, c.req.param('repo')!),
  kind: 'pr',
  number,
});
const commitTarget = (db: Db, c: Context, oid: string): ThreadTarget & { kind: 'commit' } => ({
  repoId: repoIdForKey(db, c.req.param('repo')!),
  kind: 'commit',
  oid,
});

const found = <T>(value: T | null, what: string): T => {
  if (value === null) throw new HttpError(404, `${what} not found`);
  return value;
};

export function commentRoutes({ db }: AppDeps): Hono {
  const r = new Hono();

  const list = (c: Context, target: ThreadTarget, title: string) => {
    const { format } = parseWith(listQuery, c.req.query());
    const items = listThreads(db, target);
    if (format === 'md') return c.body(threadsMarkdown(items, { title }), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return c.json({ items });
  };

  // Routes with a body read it first (after checking the URL's own syntax), then find their target and write with no
  // await in between: a thread, comment or repo may go while a slow body is still arriving.

  r.get('/prs/:repo/:number/threads', (c) => {
    const target = prTarget(db, c, prNumberParam(c));
    return list(c, target, `${c.req.param('repo')}#${target.number}`);
  });

  r.post('/prs/:repo/:number/threads', async (c) => {
    const number = prNumberParam(c);
    const f = parseWith(prThreadBody, await jsonBody(c));
    const target = prTarget(db, c, number);
    // Listing works for a PR the sync has since dropped; a new thread needs one the dashboard knows.
    if (!db.get('SELECT 1 FROM pull_requests WHERE repo_id = ? AND number = ?', [target.repoId, number])) {
      throw new HttpError(404, 'Pull request not found');
    }
    const input = { commitOid: f.commitOid, baseOid: f.baseOid ?? null, anchor: toAnchor(f), body: f.body };
    return c.json(createThread(db, target, input, actingPrincipal(db)));
  });

  // Commits need not be synced (like their diffs): PR branch commits aren't.
  r.get('/commits/:repo/:oid/threads', (c) => {
    const target = commitTarget(db, c, oidParam(c));
    return list(c, target, `${c.req.param('repo')}@${target.oid.slice(0, 7)}`);
  });

  r.post('/commits/:repo/:oid/threads', async (c) => {
    const oid = oidParam(c);
    const f = parseWith(commitThreadBody, await jsonBody(c));
    if (f.commitOid !== undefined && f.commitOid !== oid) throw new HttpError(400, "commitOid must be the commit's own oid");
    const target = commitTarget(db, c, oid);
    const input = { commitOid: oid, baseOid: f.baseOid ?? null, anchor: toAnchor(f), body: f.body };
    return c.json(createThread(db, target, input, actingPrincipal(db)));
  });

  // By id: every route checks the thread's repo, as the key-based routes do through repoIdForKey.
  const liveComment = (id: number) => {
    const ref = found(getCommentRef(db, id), 'Comment');
    requireLiveThread(db, ref.threadId, 'Comment');
    return ref;
  };

  r.get('/threads/:id', (c) => {
    const id = idParam(c.req.param('id'));
    requireLiveThread(db, id);
    return c.json(getThread(db, id));
  });

  r.patch('/threads/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const { status } = parseWith(statusBody, await jsonBody(c));
    requireLiveThread(db, id);
    return c.json(found(setThreadStatus(db, id, status), 'Thread'));
  });

  r.delete('/threads/:id', (c) => {
    const id = idParam(c.req.param('id'));
    requireLiveThread(db, id);
    const thread = getThread(db, id)!;
    if (!mayDelete(actingPrincipal(db), thread.comments[0]!.author.id)) throw new HttpError(403, 'Only its author can delete this thread');
    deleteThread(db, id);
    return c.body(null, 204);
  });

  r.post('/threads/:id/comments', async (c) => {
    const id = idParam(c.req.param('id'));
    const { body } = parseWith(replyBody, await jsonBody(c));
    requireLiveThread(db, id);
    return c.json(found(addComment(db, id, actingPrincipal(db), body), 'Thread'));
  });

  r.patch('/comments/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const { body } = parseWith(replyBody, await jsonBody(c));
    const comment = liveComment(id);
    if (!mayEdit(actingPrincipal(db), comment.authorId)) throw new HttpError(403, 'You can only edit your own comments');
    return c.json(found(editComment(db, id, body), 'Comment'));
  });

  // The first comment's author is the thread's: deleting it deletes the thread, which mayDelete allows them.
  r.delete('/comments/:id', (c) => {
    const id = idParam(c.req.param('id'));
    const comment = liveComment(id);
    if (!mayDelete(actingPrincipal(db), comment.authorId)) throw new HttpError(403, 'Only its author can delete this comment');
    return c.json(found(deleteComment(db, id), 'Comment'));
  });

  return r;
}
