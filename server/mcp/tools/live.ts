// wait_for_reply and show: the live side, over the comment bus. wait_for_reply reads the comment event log (so nothing
// between two calls is missed: `after` is an event id) and sleeps on the bus until something new is in scope; show asks
// the open gh-dash windows to look at a thread or a diff.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommentEventKind, ShowTarget, StreamMessage } from '../../../shared/api';
import type { Db } from '../../db/db';
import { Where } from '../../db/filters';
import { isFullSha } from '../../diff/service';
import { HttpError } from '../../lib/errors';
import * as comments from '../../services/comments';
import { repoKinds } from '../../services/lists';
import { byOf, commitArg, idArg, prArg, repoArg, targetRef } from '../format';
import { readTool, writeTool } from '../tool';
import { requireRepo } from './prs';

/** Most events one call returns; the rest come with the next call, at once. */
const MAX_EVENTS = 50;

interface EventRow {
  id: number;
  at: string;
  kind: CommentEventKind;
  thread_id: number;
  comment_id: number | null;
  pr_number: number | null;
  commit_oid: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  excerpt: string | null;
  actor_id: number;
  actor_kind: 'self' | 'agent';
  actor_name: string;
  repo: string;
  thread_status: 'open' | 'resolved' | null;
}

export const waitForReply = readTool({
  name: 'wait_for_reply',
  title: 'Wait for a reply',
  description:
    "Waits until someone else (usually the user) writes on the threads you care about, then returns what happened: " +
    'replies, new threads, edits, deletions, resolves and reopens, oldest first. Scope it by thread_ids, or a repo, PR or ' +
    'commit (nothing: everywhere). It returns at once when there are events after `after` (an event id: pass the cursor ' +
    'the previous call returned so nothing is missed; default: now), else waits up to timeout_s and returns no events. ' +
    'Keep timeout_s under your client\'s tool timeout (often 60 s) and call again to keep waiting.',
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

    const w = new Where().add('e.actor_id <> ?', principal.id);
    if (ids) w.add('e.thread_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids));
    if (ref) w.add('e.repo_id = ?', ref.id);
    if (args.pr !== undefined) w.add('e.pr_number = ?', args.pr);
    if (args.commit !== undefined) w.add('e.pr_number IS NULL AND e.commit_oid >= ? AND e.commit_oid < ?', args.commit, `${args.commit}g`);
    const after = (cursor: number) =>
      db.all<EventRow>(
        `SELECT e.id, e.at, e.kind, e.thread_id, e.comment_id, e.pr_number, e.commit_oid, e.path, e.start_line, e.end_line, e.excerpt,
           p.id AS actor_id, p.kind AS actor_kind, p.name AS actor_name, r.key AS repo, t.status AS thread_status
         FROM comment_events e JOIN principals p ON p.id = e.actor_id JOIN repos r ON r.id = e.repo_id
           LEFT JOIN comment_threads t ON t.id = e.thread_id
         WHERE e.id > ? AND ${w.toSql()} ORDER BY e.id LIMIT ?`,
        [cursor, ...w.params, MAX_EVENTS + 1],
      );
    // What the bus says happened, in the same scope (the log is the truth; this only wakes the wait).
    const matches = (m: StreamMessage) =>
      m.type === 'comments' &&
      m.by.id !== principal.id &&
      (!ids || ids.includes(m.threadId)) &&
      (!ref || m.repo === ref.key) &&
      (args.pr === undefined || (m.kind === 'pr' && m.number === args.pr)) &&
      (args.commit === undefined || (m.kind === 'commit' && m.commitOid.startsWith(args.commit)));

    const kindOf = repoKinds(db);
    const out = (rows: EventRow[]) =>
      rows.slice(0, MAX_EVENTS).map((e) => ({
        id: e.id,
        kind: e.kind,
        threadId: e.thread_id,
        ...(e.comment_id !== null ? { commentId: e.comment_id } : {}),
        ref: targetRef(kindOf(e.repo), e.repo, e.pr_number !== null ? { number: e.pr_number } : { oid: e.commit_oid }),
        ...(e.path !== null ? { path: e.path } : {}),
        ...(e.start_line !== null ? { lines: e.start_line === e.end_line ? `${e.start_line}` : `${e.start_line}-${e.end_line}` } : {}),
        by: byOf({ id: e.actor_id, kind: e.actor_kind, name: e.actor_name }, principal),
        at: e.at,
        excerpt: e.excerpt,
        threadStatus: e.thread_status ?? 'deleted',
      }));

    let cursor = args.after ?? db.get<{ id: number | null }>('SELECT max(id) AS id FROM comment_events')!.id ?? 0;
    const deadline = Date.now() + args.timeout_s * 1000;
    for (;;) {
      // Listen first, then look: whatever lands in between wakes the wait.
      const done = new AbortController();
      const woke = bus.waitFor(matches, { timeoutMs: Math.max(0, deadline - Date.now()), signal: AbortSignal.any([signal, done.signal]) });
      const rows = after(cursor);
      if (rows.length) {
        done.abort();
        const events = out(rows);
        cursor = events.at(-1)!.id;
        return { events, cursor, ...(rows.length > MAX_EVENTS ? { more: true } : {}) };
      }
      // Timed out, cancelled, or the server is stopping: nothing new.
      if (!(await woke)) return { events: [], cursor };
    }
  },
});

/** A commit's full oid from what gh-dash has seen of it (synced commits, PR commits, threads); null if unknown or ambiguous. */
function fullCommit(db: Db, repoId: number, prefix: string): string | null {
  if (isFullSha(prefix)) return prefix;
  const range = [prefix, `${prefix}g`];
  const hits = db.all<{ oid: string }>(
    `SELECT oid FROM commits WHERE repo_id = ? AND oid >= ? AND oid < ?
     UNION SELECT pc.oid FROM pr_commits pc JOIN pull_requests q ON q.id = pc.pr_id WHERE q.repo_id = ? AND pc.oid >= ? AND pc.oid < ?
     UNION SELECT commit_oid FROM comment_threads WHERE repo_id = ? AND commit_oid >= ? AND commit_oid < ? LIMIT 2`,
    [repoId, ...range, repoId, ...range, repoId, ...range],
  );
  return hits.length === 1 ? hits[0]!.oid : null;
}

export const show = writeTool({
  name: 'show',
  title: 'Show the user something',
  description:
    'Asks the gh-dash windows the user has open to show a thread (thread_id), or a PR\'s or commit\'s diff (repo with pr ' +
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
      const oid = commit !== undefined ? fullCommit(db, ref.id, commit) : null;
      if (commit !== undefined && !oid) throw new HttpError(400, `gh-dash doesn't know commit ${commit} by that prefix: give its full SHA`);
      target = { repo: ref.key, ...(pr !== undefined ? { pr } : { commit: oid! }), ...(path ? { path } : {}) };
    }
    const windows = bus.emit({ type: 'show', id: randomUUID(), agent: principal, target, message: message?.trim() || null, at: new Date().toISOString() });
    return { windows, ...(windows === 0 ? { note: 'No gh-dash window is open: nothing was shown' } : {}) };
  },
});
