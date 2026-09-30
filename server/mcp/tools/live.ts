// wait_for_reply and show: the live side, over the comment bus. wait_for_reply reads the comment event log (so nothing
// between two calls is missed: `after` is an event id) and sleeps on the bus until something new is in scope; show asks
// the open gh-dash windows to look at a thread or a diff.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ShowTarget, StreamMessage } from '../../../shared/api';
import { type CommentEventItem, commentEventsAfter, lastCommentEventId } from '../../db/comment-events';
import type { Db } from '../../db/db';
import { isFullSha } from '../../diff/service';
import { HttpError } from '../../lib/errors';
import * as comments from '../../services/comments';
import { repoKinds } from '../../services/lists';
import { byOf, commitArg, idArg, prArg, repoArg, targetRef } from '../format';
import { readTool, writeTool } from '../tool';
import { requireRepo } from './prs';

/** Most events one call returns; the rest come with the next call, at once. */
const MAX_EVENTS = 50;

/** A commit's full oid from what gh-dash has seen of it (synced commits, PR commits, threads); 400 if unknown or ambiguous. */
function fullCommit(db: Db, repoId: number, prefix: string): string {
  if (isFullSha(prefix)) return prefix;
  const range = [prefix, `${prefix}g`];
  const hits = db.all<{ oid: string }>(
    `SELECT oid FROM commits WHERE repo_id = ? AND oid >= ? AND oid < ?
     UNION SELECT pc.oid FROM pr_commits pc JOIN pull_requests q ON q.id = pc.pr_id WHERE q.repo_id = ? AND pc.oid >= ? AND pc.oid < ?
     UNION SELECT commit_oid FROM comment_threads WHERE repo_id = ? AND commit_oid >= ? AND commit_oid < ? LIMIT 2`,
    [repoId, ...range, repoId, ...range, repoId, ...range],
  );
  if (hits.length !== 1) throw new HttpError(400, `gh-dash doesn't know commit ${prefix} by that prefix: give its full SHA`);
  return hits[0]!.oid;
}

export const waitForReply = readTool({
  name: 'wait_for_reply',
  title: 'Wait for a reply',
  description:
    'Waits until someone else (usually the user) writes on the threads you care about, then returns what happened: ' +
    'replies, new threads, edits, deletions, resolves and reopens, oldest first. Scope it by thread_ids, or a repo, PR or ' +
    'commit (nothing: everywhere). It returns at once when there are events after `after` (an event id: pass the cursor ' +
    'the previous call returned so nothing is missed; default: now), else waits up to timeout_s and returns no events. ' +
    "Keep timeout_s under your client's tool timeout (often 60 s) and call again to keep waiting.",
  input: z
    .object({
      thread_ids: z.array(idArg('Thread id')).min(1).max(100).optional(),
      repo: repoArg.optional(),
      pr: prArg.optional(),
      commit: commitArg.optional(),
      after: z.number().int().min(0).max(2 ** 53 - 1).optional().describe('Event id: the cursor of a previous call (default: now)'),
      timeout_s: z.number().int().min(1).max(300).default(45).describe('Longest wait in seconds (default 45)'),
    })
    .strict()
    .refine((a) => a.repo !== undefined || (a.pr === undefined && a.commit === undefined), 'pr and commit need repo')
    .refine((a) => a.pr === undefined || a.commit === undefined, 'give pr or commit, not both'),
  run: async (args, { deps, principal, signal }) => {
    const { db, bus } = deps;
    const ref = args.repo !== undefined ? requireRepo(db, args.repo) : null;
    const ids = args.thread_ids ? [...new Set(args.thread_ids)] : null;
    for (const id of ids ?? []) {
      // A deleted thread still has its events; one that never was is a mistake worth saying.
      if (!db.get('SELECT 1 FROM comment_threads WHERE id = ? UNION ALL SELECT 1 FROM comment_events WHERE thread_id = ?', [id, id])) {
        throw new HttpError(404, `Thread ${id} not found`);
      }
    }
    const commit = args.commit !== undefined ? fullCommit(db, ref!.id, args.commit) : null;
    const scope = {
      ...(ids ? { threadIds: ids } : {}),
      ...(ref ? { repoId: ref.id } : {}),
      ...(args.pr !== undefined ? { prNumber: args.pr } : {}),
      ...(commit ? { commitOid: commit } : {}),
    };
    // What the bus says happened, in the same scope: the log is the truth, this only wakes the wait.
    const matches = (m: StreamMessage) =>
      m.type === 'comments' &&
      m.by.id !== principal.id &&
      (!ids || ids.includes(m.threadId)) &&
      (!ref || m.repo === ref.key) &&
      (args.pr === undefined || (m.kind === 'pr' && m.number === args.pr)) &&
      (!commit || (m.kind === 'commit' && m.commitOid === commit));

    const kindOf = repoKinds(db);
    const out = (e: CommentEventItem) => ({
      id: e.id,
      kind: e.kind,
      threadId: e.threadId,
      ...(e.commentId !== null ? { commentId: e.commentId } : {}),
      ref: targetRef(kindOf(e.repo), e.repo, e.target),
      ...(e.path !== null ? { path: e.path } : {}),
      ...(e.startLine !== null ? { lines: e.startLine === e.endLine ? `${e.startLine}` : `${e.startLine}-${e.endLine}` } : {}),
      by: byOf(e.by, principal),
      at: e.at,
      excerpt: e.excerpt,
      threadStatus: e.threadStatus ?? 'deleted',
    });

    const cursor = args.after ?? lastCommentEventId(db);
    const deadline = Date.now() + args.timeout_s * 1000;
    for (;;) {
      // Listen first, then look: whatever lands in between wakes the wait.
      const done = new AbortController();
      const woke = bus.waitFor(matches, { timeoutMs: Math.max(0, deadline - Date.now()), signal: AbortSignal.any([signal, done.signal]) });
      const found = commentEventsAfter(db, cursor, { scope, exceptActor: principal.id, limit: MAX_EVENTS + 1 });
      if (found.length) {
        done.abort();
        const events = found.slice(0, MAX_EVENTS).map(out);
        return { events, cursor: events.at(-1)!.id, ...(found.length > MAX_EVENTS ? { more: true } : {}) };
      }
      // Timed out, cancelled, or the server is stopping: nothing new.
      if (!(await woke)) return { events: [], cursor };
    }
  },
});

export const show = writeTool({
  name: 'show',
  title: 'Show the user something',
  description:
    "Asks the gh-dash windows the user has open to show a thread (thread_id), or a PR's or commit's diff (repo with pr " +
    'or commit), optionally at a file (path), with a short message. The window offers it (or opens it, if the user ' +
    'follows agents). Returns how many windows it reached; 0 means none is open.',
  input: z
    .object({
      thread_id: idArg('Thread id').optional(),
      repo: repoArg.optional(),
      pr: prArg.optional(),
      commit: commitArg.optional(),
      path: z.string().min(1).max(4096).optional().describe('A file of the diff'),
      message: z.string().max(500).optional().describe('What to look at, in a sentence'),
    })
    .strict()
    .refine((a) => (a.thread_id === undefined) !== (a.repo === undefined), 'give thread_id, or repo with pr or commit')
    .refine((a) => a.thread_id === undefined || (a.pr === undefined && a.commit === undefined && a.path === undefined), 'thread_id goes alone')
    .refine((a) => a.repo === undefined || (a.pr === undefined) !== (a.commit === undefined), 'give repo with exactly one of pr or commit'),
  run: ({ thread_id, repo, pr, commit, path, message }, { deps, principal }) => {
    const { db, bus } = deps;
    let target: ShowTarget;
    if (thread_id !== undefined) {
      const t = comments.getThread(deps, thread_id);
      target = { repo: t.repo, ...(t.kind === 'pr' ? { pr: t.number! } : { commit: t.commitOid }), threadId: t.id, ...(t.path ? { path: t.path } : {}) };
    } else {
      const ref = requireRepo(db, repo!);
      if (pr !== undefined && !db.get('SELECT 1 FROM pull_requests WHERE repo_id = ? AND number = ?', [ref.id, pr])) {
        throw new HttpError(404, `${targetRef(repoKinds(db)(ref.key), ref.key, { number: pr })} isn't in gh-dash`);
      }
      target = { repo: ref.key, ...(pr !== undefined ? { pr } : { commit: fullCommit(db, ref.id, commit!) }), ...(path ? { path } : {}) };
    }
    const windows = bus.emit({ type: 'show', id: randomUUID(), agent: principal, target, message: message?.trim() || null, at: new Date().toISOString() });
    return { windows, ...(windows === 0 ? { note: 'No gh-dash window is open: nothing was shown' } : {}) };
  },
});
