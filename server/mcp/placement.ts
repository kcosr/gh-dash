// Where threads are now: shared/comment-placement.ts run against each target's current diff (a PR's head, or the
// commit), as the diff viewer places them. Diffs come from the diff service's cache or the code host, for at most
// MAX_TARGETS targets per call and under a deadline; the rest, and any that fail, are `unknown`.

import type { CommentThread } from '../../shared/api';
import { createPlacer, type ThreadPlacement } from '../../shared/comment-placement';
import { HttpError } from '../lib/errors';
import { type DiffTarget, loadDiff } from './diffs';
import type { McpDeps } from './tool';

/** Distinct PRs and commits one call fetches diffs for. */
export const MAX_TARGETS = 10;
/** How long one call waits for them (together: they are fetched at once). */
export const PLACEMENT_WAIT_MS = 10_000;

/**
 * A thread's place, as a tool reports it. `target`: on the whole PR or commit. `file`: on a file that is in the diff.
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

const targetOf = (t: CommentThread): DiffTarget =>
  t.kind === 'pr' ? { repo: t.repo, kind: 'pr', number: t.number! } : { repo: t.repo, kind: 'commit', oid: t.commitOid };
const keyOf = (t: DiffTarget) => (t.kind === 'pr' ? `pr ${t.repo}#${t.number}` : `commit ${t.repo}@${t.oid}`);

/** Placement of each thread, by id. Threads on the whole target need no diff. */
export async function placeThreads(
  deps: McpDeps,
  threads: readonly CommentThread[],
  signal: AbortSignal,
  opts: { maxTargets?: number; waitMs?: number } = {},
): Promise<Map<number, Placement>> {
  const out = new Map<number, Placement>();
  const groups = new Map<string, { target: DiffTarget; threads: CommentThread[] }>();
  for (const t of threads) {
    if (t.path === null) {
      out.set(t.id, { kind: 'target' });
      continue;
    }
    const target = targetOf(t);
    const key = keyOf(target);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { target, threads: [] }));
    g.threads.push(t);
  }
  const max = opts.maxTargets ?? MAX_TARGETS;
  await Promise.all(
    [...groups.values()].map(async ({ target, threads: group }, i) => {
      let place: (t: CommentThread) => Placement;
      if (i >= max) {
        place = () => ({ kind: 'unknown', reason: `not checked: more than ${max} PRs and commits in one call` });
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
