// Where threads are now: shared/comment-placement.ts run against each target's current diff (a PR's or branch's head, or
// the commit), as the diff viewer places them. Diffs come from the diff service's cache or the code host, for at most
// MAX_TARGETS targets per call and under a deadline; the rest, and any that fail, are `unknown`.

import type { CommentThread, ThreadView } from '../../shared/api';
import { createPlacer, type ThreadPlacement } from '../../shared/comment-placement';
import { HttpError } from '../lib/errors';
import { type DiffTarget, loadDiff } from './diffs';
import type { McpDeps } from './tool';

/** Distinct PRs, branches and commits one call fetches diffs for. */
export const MAX_TARGETS = 10;
/** How long one call waits for them (together: they are fetched at once). */
export const PLACEMENT_WAIT_MS = 10_000;

/**
 * A thread's place, as a tool reports it. `target`: on the whole PR, branch or commit. `file`: on a file that is in the diff.
 * `line`: at these lines of the current diff (`relocated`: made on an earlier revision and found again by its text).
 * `outdated`: its file (`file`) or its lines (`lines`) aren't in the current diff. `unknown`: the diff wasn't available.
 */
export type Placement =
  | { kind: 'target' }
  | { kind: 'file' }
  | { kind: 'line'; startLine: number; endLine: number; relocated: boolean }
  | { kind: 'outdated'; reason: 'file' | 'lines' }
  | { kind: 'unknown'; reason: string };

/** A placement as tools report it (the anchor already says the path and side). */
export function compactPlacement(p: ThreadPlacement): Placement {
  switch (p.kind) {
    case 'target':
      return { kind: 'target' };
    case 'file':
      return { kind: 'file' };
    case 'line':
      return { kind: 'line', startLine: p.startLine, endLine: p.endLine, relocated: p.relocated };
    case 'outdated':
      return { kind: 'outdated', reason: p.reason };
  }
}

/** A thread, with the diff that shows it when that is known (ThreadListItem.view, viewOfThread). */
export type PlaceableThread = CommentThread & { view?: ThreadView };

/**
 * The diff a thread is shown on: its `view` when it has one (a branch thread of an earlier line of work is shown by the
 * merged PR that ended it), else its own PR's head, its branch's, or the commit itself.
 */
const targetOf = (t: PlaceableThread): DiffTarget => {
  const on: ThreadView = t.view ?? (t.kind === 'pr' ? { kind: 'pr', number: t.number! } : t.kind === 'branch' ? { kind: 'branch', branch: t.branch! } : { kind: 'commit', oid: t.commitOid });
  if (on.kind === 'pr') return { repo: t.repo, kind: 'pr', number: on.number };
  return on.kind === 'branch' ? { repo: t.repo, kind: 'branch', branch: on.branch } : { repo: t.repo, kind: 'commit', oid: on.oid };
};
const keyOf = (t: DiffTarget) => (t.kind === 'pr' ? `pr ${t.repo}#${t.number}` : t.kind === 'branch' ? `branch ${t.repo}~${t.branch}` : `commit ${t.repo}@${t.oid}`);

/** A target with a view that lists more than its own threads: a PR, or a branch. */
export type ViewTarget = Extract<DiffTarget, { kind: 'pr' | 'branch' }>;

/**
 * Placement of each thread, by id. Threads on the whole target need no diff. Each is placed on its own target's diff, or,
 * with `against`, every PR and branch thread on that one: the view of a PR or a branch lists the threads made on its
 * branch's other PRs and on the branch too (shared/api.ts, "Branch groups"), and shows them on its own diff. Commit
 * threads stay on their commit.
 */
export async function placeThreads(
  deps: McpDeps,
  threads: readonly PlaceableThread[],
  signal: AbortSignal,
  opts: { against?: ViewTarget; maxTargets?: number; waitMs?: number } = {},
): Promise<Map<number, Placement>> {
  const out = new Map<number, Placement>();
  const groups = new Map<string, { target: DiffTarget; threads: PlaceableThread[] }>();
  for (const t of threads) {
    if (t.path === null) {
      out.set(t.id, { kind: 'target' });
      continue;
    }
    const target = opts.against && t.kind !== 'commit' ? opts.against : targetOf(t);
    const key = keyOf(target);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { target, threads: [] }));
    g.threads.push(t);
  }
  const max = opts.maxTargets ?? MAX_TARGETS;
  await Promise.all(
    [...groups.values()].map(async ({ target, threads: group }, i) => {
      let place: (t: PlaceableThread) => Placement;
      if (i >= max) {
        place = () => ({ kind: 'unknown', reason: `not checked: more than ${max} PRs, branches and commits in one call` });
      } else {
        try {
          const placer = createPlacer(await loadDiff(deps, target, signal, opts.waitMs ?? PLACEMENT_WAIT_MS));
          place = (t) => compactPlacement(placer(t));
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          const reason = `no diff: ${err.message}`;
          place = () => ({ kind: 'unknown', reason });
        }
      }
      for (const t of group) out.set(t.id, place(t));
    }),
  );
  return out;
}
