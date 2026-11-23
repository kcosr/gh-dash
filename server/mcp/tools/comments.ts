// add_comment, reply, edit_comment, delete_comment, resolve_thread, reopen_thread: writes through the comment service
// as the calling agent (its permissions: its own comments only; resolve and reopen any thread), on what it may reach
// (reach.ts: out of reach is not found). Each is recorded in the comment event log and announced to open windows by the
// service.

import { z } from 'zod';
import type { CommentThread } from '../../../shared/api';
import { createPlacer } from '../../../shared/comment-placement';
import * as comments from '../../services/comments';
import { repoKinds } from '../../services/lists';
import { branchAnchor, commitAnchor, prAnchor } from '../anchor';
import { bodyArg, branchArg, commitArg, idArg, prArg, repoArg } from '../format';
import { compactPlacement, type Placement } from '../placement';
import { requireCommentInReach, requireRepo, requireRepoInReach, requireThreadInReach } from '../reach';
import { LIST_SNIPPET_CHARS, targetTitle, threadOut } from '../threads';
import { type ToolContext, writeTool } from '../tool';

/** Check access and write under the same database lock. Announce only after the transaction commits. */
function writeAuthorizedComment<T>({ deps: { db, bus } }: ToolContext, write: (deps: comments.CommentDeps) => T): T {
  const events: Parameters<typeof bus.emit>[0][] = [];
  const result = db.tx(() => write({ db, bus: { emit: (event) => { events.push(event); return 0; } } }));
  for (const event of events) bus.emit(event);
  return result;
}

/** A written thread as the tools return it: compact, with its last comment (the one just written, for a reply). */
function written(t: CommentThread, { deps, principal }: ToolContext, placement?: Placement) {
  const { db } = deps;
  return threadOut(t, principal, { kind: repoKinds(db)(t.repo), title: targetTitle(db, t), placement, comments: false, snippetChars: LIST_SNIPPET_CHARS });
}

const threadId = idArg('Thread id (list_threads, get_thread)');
const commentId = idArg('Comment id (get_thread lists them)');

export const addComment = writeTool({
  name: 'add_comment',
  title: 'Add a comment',
  description:
    'Opens a comment thread on a PR (at its current head, unless at_commit names an earlier push), on a pushed branch (its ' +
    'diff against the default branch, at its head: review work that has no PR yet) or on a commit, shown to the user in ' +
    "gh-dash's diff. A branch's comments are shared with the PRs later opened from it. Leave path out to comment on the " +
    'whole PR, branch or commit; give path for a file of its diff, and start_line (end_line for a range) for lines: side ' +
    '"new" numbers lines as in the file at the head, "old" as at the base (for removed lines). The lines must exist; ' +
    'gh-dash records their text. Branches and commits must be on the code host: push first.',
  input: z
    .object({
      repo: repoArg,
      pr: prArg.optional(),
      branch: branchArg.optional(),
      commit: commitArg.optional(),
      body: bodyArg,
      path: z.string().min(1).max(4096).optional().describe('File path in the repository, as the diff lists it (get_pr or get_branch files)'),
      side: z.enum(['new', 'old']).default('new').describe('new: the head\'s lines (added or unchanged); old: the base\'s (removed)'),
      start_line: z.number().int().min(1).optional().describe('First line (1-based)'),
      end_line: z.number().int().min(1).optional().describe('Last line, inclusive (default: start_line)'),
      at_commit: commitArg.optional().describe('PR only: the revision the comment is on (default: the PR head)'),
    })
    .strict()
    .refine((a) => [a.pr, a.branch, a.commit].filter((x) => x !== undefined).length === 1, 'give exactly one of pr, branch or commit'),
  run: async (args, ctx) => {
    const { deps, principal, signal } = ctx;
    const ref = requireRepo(ctx, args.repo);
    const kind = repoKinds(deps.db)(ref.key);
    const anchored = await (
      args.pr !== undefined
        ? prAnchor(deps, ref, kind, args.pr, args, signal)
        : args.branch !== undefined
          ? branchAnchor(deps, ref, kind, args.branch, args, signal)
          : commitAnchor(deps, ref, kind, args.commit!, args, signal)
    ).catch((err: unknown) => {
      requireRepoInReach(ctx, ref, args.repo);
      throw err;
    });
    const { diff, ...fields } = anchored;
    const input = { ...fields, body: args.body };
    const thread = writeAuthorizedComment(ctx, (writeDeps) => {
      requireRepoInReach(ctx, ref, args.repo);
      return args.pr !== undefined
        ? comments.createPrThread(writeDeps, principal, ref.key, args.pr, input)
        : args.branch !== undefined
          ? comments.createBranchThread(writeDeps, principal, ref.key, args.branch, input)
          : comments.createCommitThread(writeDeps, principal, ref.key, fields.commitOid, input);
    });
    // Where the diff viewer shows it now (the diff is at hand: no fetch).
    return written(thread, ctx, diff && thread.commitOid === diff.headOid ? compactPlacement(createPlacer(diff)(thread)) : undefined);
  },
});

export const reply = writeTool({
  name: 'reply',
  title: 'Reply to a thread',
  description: 'Adds your reply to a comment thread; its status stays as it is (resolve_thread can reply and resolve at once).',
  input: z.object({ thread_id: threadId, body: bodyArg }).strict(),
  run: ({ thread_id, body }, ctx) => {
    const thread = writeAuthorizedComment(ctx, (deps) => {
      requireThreadInReach(ctx, thread_id);
      return comments.reply(deps, ctx.principal, thread_id, body);
    });
    return written(thread, ctx);
  },
});

export const editComment = writeTool(
  {
    name: 'edit_comment',
    title: 'Edit a comment',
    description: "Replaces the text of one of your own comments (not the user's or another agent's).",
    input: z.object({ comment_id: commentId, body: bodyArg }).strict(),
    run: ({ comment_id, body }, ctx) => {
      const thread = writeAuthorizedComment(ctx, (deps) => {
        requireCommentInReach(ctx, comment_id);
        return comments.editComment(deps, ctx.principal, comment_id, body);
      });
      return written(thread, ctx);
    },
  },
  { destructiveHint: true },
);

export const deleteComment = writeTool(
  {
    name: 'delete_comment',
    title: 'Delete a comment',
    description:
      "Deletes one of your own comments. A thread's first comment is the thread: deleting it deletes the whole thread, " +
      'which you may only do when every comment in it is yours.',
    input: z.object({ comment_id: commentId }).strict(),
    run: ({ comment_id }, ctx) => {
      const { thread } = writeAuthorizedComment(ctx, (deps) => {
        requireCommentInReach(ctx, comment_id);
        return comments.deleteComment(deps, ctx.principal, comment_id);
      });
      return thread ? { deleted: 'comment', thread: written(thread, ctx) } : { deleted: 'thread' };
    },
  },
  { destructiveHint: true, idempotentHint: true },
);

/** Replies first when there is a comment, then sets the status. */
function setStatus(status: 'resolved' | 'open') {
  return ({ thread_id, comment }: { thread_id: number; comment?: string }, ctx: ToolContext) => {
    const thread = writeAuthorizedComment(ctx, (deps) => {
      requireThreadInReach(ctx, thread_id);
      if (comment !== undefined) comments.reply(deps, ctx.principal, thread_id, comment);
      return comments.setThreadStatus(deps, ctx.principal, thread_id, status);
    });
    return written(thread, ctx);
  };
}

export const resolveThread = writeTool(
  {
    name: 'resolve_thread',
    title: 'Resolve a thread',
    description: 'Marks a thread resolved (say, once you have fixed what it asks), with an optional reply first. Any thread may be resolved.',
    input: z.object({ thread_id: threadId, comment: bodyArg.optional().describe('A reply to add first (Markdown)') }).strict(),
    run: setStatus('resolved'),
  },
);

export const reopenThread = writeTool(
  {
    name: 'reopen_thread',
    title: 'Reopen a thread',
    description: 'Reopens a resolved thread, with an optional reply first.',
    input: z.object({ thread_id: threadId, comment: bodyArg.optional().describe('A reply to add first (Markdown)') }).strict(),
    run: setStatus('open'),
  },
);
