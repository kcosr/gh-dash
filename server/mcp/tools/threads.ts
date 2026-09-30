// list_threads, get_thread: gh-dash's comment threads on PRs, branches and commits, placed on the current diff.

import { z } from 'zod';
import type { ThreadView } from '../../../shared/api';
import { decodeCursor, encodeCursor } from '../../api/scope';
import { SELF_PRINCIPAL_ID, viewOfThread } from '../../db/comments';
import { listThreadItems, type ThreadFilter } from '../../db/thread-list';
import { HttpError } from '../../lib/errors';
import * as comments from '../../services/comments';
import { repoKinds } from '../../services/lists';
import { branchArg, commitArg, idArg, limitArg, prArg, repoArg } from '../format';
import { placeThreads, type ViewTarget } from '../placement';
import { reachScope, requireRepo, requireThreadInReach } from '../reach';
import { LIST_SNIPPET_CHARS, targetTitle, threadOut } from '../threads';
import { readTool } from '../tool';

const BY_DOC = '`by` is "me" (you), "you" (the user) or "agent:<name>".';
const ANCHOR_DOC =
  'The anchor is where the thread was made: the revision (commit), file (path), side (new: the head\'s lines, old: the ' +
  "base's) and lines, with their text (snippet).";
const PLACEMENT_DOC =
  "placement is where it is on the current diff (a PR's or branch's head): line (startLine..endLine; relocated when it was " +
  'made on an earlier push and found again by its text), file, target (the whole PR, branch or commit), outdated (its ' +
  "file or lines are gone), or unknown (the diff wasn't available). A branch thread made before one of the branch's PRs " +
  'was merged belongs to that merged PR: its placement is on that PR, and `shownIn` names it.';

export const listThreads = readTool({
  name: 'list_threads',
  title: 'List comment threads',
  description:
    'Comment threads in gh-dash, most recent activity first: everywhere, or on one repo, PR (repo and pr), branch (repo and ' +
    "branch) or commit (repo and commit), optionally one file or directory (path). A PR's or branch's list includes the " +
    "threads it shares with the branch's other PRs and the branch itself (`ref` says which), all placed on its diff. " +
    'waiting_on "me": open threads whose last comment isn\'t ' +
    'yours, so someone (usually the user) is waiting for your answer; "you": open threads whose last comment isn\'t the ' +
    "user's, so they wait on the user. author is who opened the thread (me, you: the user, agents). Items have the " +
    `thread id, its target, status, anchor, placement and last comment (include_comments: the whole conversation). ${BY_DOC} ` +
    `${ANCHOR_DOC} ${PLACEMENT_DOC} Pass cursor from nextCursor for the next page.`,
  input: z
    .object({
      repo: repoArg.optional(),
      pr: prArg.optional().describe('A PR (or MR) number of repo'),
      branch: branchArg.optional().describe("A pushed branch of repo (its review's threads, shared with its PRs)"),
      commit: commitArg.optional().describe("A commit of repo (its own threads, not its PR's)"),
      path: z.string().min(1).max(4096).optional().describe('A file, or a directory for the files under it'),
      status: z.enum(['open', 'resolved', 'all']).default('open'),
      author: z.enum(['me', 'you', 'agents', 'any']).default('any').describe('Who opened the thread'),
      waiting_on: z.enum(['me', 'you']).optional().describe('Open threads whose last comment is not by me (this agent) / you (the user)'),
      since: z.string().max(40).optional().describe('Only threads with activity since this ISO date or time'),
      q: z.string().max(200).optional().describe('Words in any comment, or in the path'),
      include_comments: z.boolean().default(false).describe('Every comment of each thread, not just the last'),
      limit: limitArg(100, 20),
      cursor: z.string().max(500).optional(),
    })
    .strict()
    .refine((a) => a.repo !== undefined || (a.pr === undefined && a.branch === undefined && a.commit === undefined), 'pr, branch and commit need repo')
    .refine((a) => [a.pr, a.branch, a.commit].filter((x) => x !== undefined).length <= 1, 'give only one of pr, branch or commit'),
  run: async (args, reach) => {
    const { deps, principal, signal } = reach;
    const { db } = deps;
    const ref = args.repo !== undefined ? requireRepo(reach, args.repo) : null;
    // A branch is checked as a new thread's is (a valid name, not the default branch), so a mistake isn't an empty list.
    if (ref && args.branch !== undefined) comments.resolveTarget(deps, { repo: ref.key, kind: 'branch', branch: args.branch });
    let since: string | undefined;
    if (args.since !== undefined) {
      const t = Date.parse(args.since);
      if (Number.isNaN(t)) throw new HttpError(400, 'since: expected an ISO date or time, like 2026-09-28 or 2026-09-28T14:00:00Z');
      since = new Date(t).toISOString();
    }
    const after = decodeCursor(args.cursor, 2);
    if (after && (typeof after[0] !== 'string' || typeof after[1] !== 'number')) throw new HttpError(400, 'Invalid cursor');
    // The threads the agent may reach.
    const { scope, ctx } = reachScope(reach, { repos: args.repo, q: args.q });
    const filter: ThreadFilter = {
      status: args.status,
      kind: 'all',
      sort: 'recent',
      ...(args.author === 'me' ? { author: principal.id } : args.author === 'you' ? { author: 'self' } : args.author === 'agents' ? { author: 'agents' } : {}),
      ...(args.waiting_on ? { waitingOn: args.waiting_on === 'me' ? principal.id : SELF_PRINCIPAL_ID } : {}),
      ...(args.pr !== undefined
        ? { target: { pr: args.pr } }
        : args.branch !== undefined
          ? { target: { branch: args.branch } }
          : args.commit !== undefined
            ? { target: { commit: args.commit } }
            : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(since ? { since } : {}),
    };
    const res = listThreadItems(db, ctx, scope, filter, { limit: args.limit, after });
    // A PR's or branch's view shows its group's threads on its own diff.
    const against: ViewTarget | undefined =
      ref && args.pr !== undefined
        ? { repo: ref.key, kind: 'pr', number: args.pr }
        : ref && args.branch !== undefined
          ? { repo: ref.key, kind: 'branch', branch: args.branch }
          : undefined;
    const placements = await placeThreads(deps, res.items, signal, { against });
    // What `shownIn` names is where each is placed: the listed PR or branch for all but commit threads (a thread its merged
    // PR shows may be shared with a PR closed before that merge, whose diff differs), else the thread's own view.
    const shownOn: ThreadView | undefined = against && (against.kind === 'pr' ? { kind: 'pr', number: against.number } : { kind: 'branch', branch: against.branch });
    const kindOf = repoKinds(db);
    return {
      items: res.items.map((t) =>
        threadOut(t, principal, {
          kind: kindOf(t.repo),
          title: t.targetTitle,
          placement: placements.get(t.id)!,
          view: shownOn && t.kind !== 'commit' ? shownOn : t.view,
          comments: args.include_comments,
          snippetChars: LIST_SNIPPET_CHARS,
        }),
      ),
      total: res.total,
      counts: res.counts,
      nextCursor: encodeCursor(res.nextCursor),
    };
  },
});

export const getThreadTool = readTool({
  name: 'get_thread',
  title: 'Get a comment thread',
  description: `One comment thread with its whole conversation (comment ids for edit_comment and delete_comment). ${BY_DOC} ${ANCHOR_DOC} ${PLACEMENT_DOC}`,
  input: z.object({ id: idArg('Thread id') }).strict(),
  run: async ({ id }, ctx) => {
    const { deps, principal, signal } = ctx;
    requireThreadInReach(ctx, id);
    const t = { ...comments.getThread(deps, id), view: viewOfThread(deps.db, id) ?? undefined };
    const placement = (await placeThreads(deps, [t], signal)).get(t.id)!;
    return threadOut(t, principal, { kind: repoKinds(deps.db)(t.repo), title: targetTitle(deps.db, t), placement, view: t.view, comments: true, snippetChars: null });
  },
});
