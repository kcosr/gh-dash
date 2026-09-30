// wait_for_reply and show: the live side, over the comment bus. wait_for_reply reads the comment event log (so nothing
// between two calls is missed: `after` is an event id) and sleeps on the bus until something new is in scope; show asks
// the open gh-dash windows to look at a thread or a diff. Both keep to what the agent may reach (reach.ts): the log's
// query and the bus's wake-up alike.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ShowTarget, StreamMessage } from '../../../shared/api';
import { type CommentEventItem, commentEventsAfter, lastCommentEventId } from '../../db/comment-events';
import { viewOfThread } from '../../db/comments';
import type { Db } from '../../db/db';
import { isFullSha } from '../../diff/service';
import { HttpError } from '../../lib/errors';
import * as comments from '../../services/comments';
import { repoKinds } from '../../services/lists';
import { branchArg, byOf, commitArg, idArg, prArg, repoArg, targetRef } from '../format';
import { reachSql, repoKeyInReach, requireRepo, requireThreadInReach } from '../reach';
import { readTool, writeTool } from '../tool';

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
    'replies, new threads, edits, deletions, resolves and reopens, oldest first. Scope it by thread_ids, or a repo, PR, ' +
    "branch or commit (nothing: everywhere). A PR's or branch's scope covers what list_threads lists for it, the threads " +
    "shared with its branch's other PRs and the branch itself included. It returns at once when there are events after " +
    '`after` (an event id: pass the cursor the previous call returned so nothing is missed; default: now), else waits up ' +
    "to timeout_s and returns no events. Keep timeout_s under your client's tool timeout (often 60 s) and call again to " +
    'keep waiting.',
  input: z
    .object({
      thread_ids: z.array(idArg('Thread id')).min(1).max(100).optional(),
      repo: repoArg.optional(),
      pr: prArg.optional(),
      branch: branchArg.optional().describe("A branch of repo (its review's threads, shared with its PRs)"),
      commit: commitArg.optional(),
      after: z.number().int().min(0).max(2 ** 53 - 1).optional().describe('Event id: the cursor of a previous call (default: now)'),
      timeout_s: z.number().int().min(1).max(300).default(45).describe('Longest wait in seconds (default 45)'),
    })
    .strict()
    .refine((a) => a.repo !== undefined || (a.pr === undefined && a.branch === undefined && a.commit === undefined), 'pr, branch and commit need repo')
    .refine((a) => [a.pr, a.branch, a.commit].filter((x) => x !== undefined).length <= 1, 'give only one of pr, branch or commit'),
  run: async (args, ctx) => {
    const { deps, principal, signal, sources } = ctx;
    const { db, bus } = deps;
    const ref = args.repo !== undefined ? requireRepo(ctx, args.repo) : null;
    // As list_threads checks it: a valid name, not the default branch (which has no threads to wait on).
    if (ref && args.branch !== undefined) comments.resolveTarget(deps, { repo: ref.key, kind: 'branch', branch: args.branch });
    const ids = args.thread_ids ? [...new Set(args.thread_ids)] : null;
    const inReach = reachSql(sources, 'r');
    for (const id of ids ?? []) {
      // A deleted thread still has its events; one that never was is a mistake worth saying, and so is one out of reach.
      const known = db.get(
        `SELECT 1 FROM comment_threads t JOIN repos r ON r.id = t.repo_id WHERE t.id = ? AND ${inReach.sql}
         UNION ALL SELECT 1 FROM comment_events e JOIN repos r ON r.id = e.repo_id WHERE e.thread_id = ? AND ${inReach.sql}`,
        [id, ...inReach.params, id, ...inReach.params],
      );
      if (!known) throw new HttpError(404, `Thread ${id} not found`);
    }
    const commit = args.commit !== undefined ? fullCommit(db, ref!.id, args.commit) : null;
    const scope = {
      ...(sources !== null ? { sourceIds: sources } : {}),
      ...(ids ? { threadIds: ids } : {}),
      ...(ref ? { repoId: ref.id } : {}),
      ...(args.pr !== undefined ? { prNumber: args.pr } : {}),
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(commit ? { commitOid: commit } : {}),
    };
    // The branch a PR's threads are shared on: its head branch when it is from this repo (as its view has it, read afresh
    // as the sync can learn it while we wait).
    const prBranch = (): string | null => {
      const pr = db.get<{ head_ref: string; cross_repo: number | null }>('SELECT head_ref, cross_repo FROM pull_requests WHERE repo_id = ? AND number = ?', [ref!.id, args.pr!]);
      return pr && pr.cross_repo === 0 && pr.head_ref !== '' ? pr.head_ref : null;
    };
    // What the bus says happened, in the same scope: the log is the truth, this only wakes the wait. A PR's or a branch's
    // scope wakes for any thread of the branch (the log then tells which are in its group, at which times). Nothing out of
    // reach wakes it.
    const matches = (m: StreamMessage) =>
      m.type === 'comments' &&
      m.by.id !== principal.id &&
      (!ids || ids.includes(m.threadId)) &&
      (!ref || m.repo === ref.key) &&
      repoKeyInReach(ctx, m.repo) &&
      (args.pr === undefined || (m.kind === 'pr' && m.number === args.pr) || (m.branch !== null && m.branch === prBranch())) &&
      (args.branch === undefined || m.branch === args.branch) &&
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

    // Without `after`, from the end of the log within reach: a limited agent's cursor never moves with other sources' events.
    const cursor = args.after ?? lastCommentEventId(db, sources ?? undefined);
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
    "Asks the gh-dash windows the user has open to show a thread (thread_id), or a PR's, branch's or commit's diff (repo " +
    'with pr, branch or commit), optionally at a file (path), with a short message. The window offers it (or opens it, ' +
    'if the user follows agents). Returns how many windows it reached; 0 means none is open.',
  input: z
    .object({
      thread_id: idArg('Thread id').optional(),
      repo: repoArg.optional(),
      pr: prArg.optional(),
      branch: branchArg.optional().describe('A branch of repo, to show its diff'),
      commit: commitArg.optional(),
      path: z.string().min(1).max(4096).optional().describe('A file of the diff'),
      message: z.string().max(500).optional().describe('What to look at, in a sentence'),
    })
    .strict()
    .refine((a) => (a.thread_id === undefined) !== (a.repo === undefined), 'give thread_id, or repo with pr, branch or commit')
    .refine((a) => a.thread_id === undefined || (a.pr === undefined && a.branch === undefined && a.commit === undefined && a.path === undefined), 'thread_id goes alone')
    .refine((a) => a.repo === undefined || [a.pr, a.branch, a.commit].filter((x) => x !== undefined).length === 1, 'give repo with exactly one of pr, branch or commit'),
  run: ({ thread_id, repo, pr, branch, commit, path, message }, ctx) => {
    const { deps, principal } = ctx;
    const { db, bus } = deps;
    let target: ShowTarget;
    if (thread_id !== undefined) {
      requireThreadInReach(ctx, thread_id);
      const t = comments.getThread(deps, thread_id);
      // Where the thread is shown: its own PR, branch or commit, but a branch thread of an earlier line of work is shown by the
      // merged PR that ended it, not by the branch's current review.
      const view = viewOfThread(db, t.id)!;
      const on = view.kind === 'pr' ? { pr: view.number } : view.kind === 'branch' ? { branch: view.branch } : { commit: view.oid };
      target = { repo: t.repo, ...on, threadId: t.id, ...(t.path ? { path: t.path } : {}) };
    } else {
      const ref = requireRepo(ctx, repo!);
      if (pr !== undefined && !db.get('SELECT 1 FROM pull_requests WHERE repo_id = ? AND number = ?', [ref.id, pr])) {
        throw new HttpError(404, `${targetRef(repoKinds(db)(ref.key), ref.key, { number: pr })} isn't in gh-dash`);
      }
      if (branch !== undefined) comments.resolveTarget(deps, { repo: ref.key, kind: 'branch', branch });
      const on = pr !== undefined ? { pr } : branch !== undefined ? { branch } : { commit: fullCommit(db, ref.id, commit!) };
      target = { repo: ref.key, ...on, ...(path ? { path } : {}) };
    }
    const windows = bus.emit({ type: 'show', id: randomUUID(), agent: principal, target, message: message?.trim() || null, at: new Date().toISOString() });
    return { windows, ...(windows === 0 ? { note: 'No gh-dash window is open: nothing was shown' } : {}) };
  },
});
