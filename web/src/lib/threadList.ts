/**
 * The Comments list's shape: threads across PRs and commits grouped per PR or commit, per repo, or not at all, and
 * ordered by activity or in file order. Pure, so the view and the tests share it.
 */
import type { CommentThread, ThreadListItem } from '../../../shared/api';
import { commitDiffId } from './urlState';
import type { ThreadGroup, ThreadOrder } from './urlState';

type Placed = Pick<CommentThread, 'id' | 'path' | 'startLine'>;

/** Reading order without a diff at hand: general threads first, then by path and line. */
export const byFileOrder = (a: Placed, b: Placed) =>
  (a.path ?? '').localeCompare(b.path ?? '') || (a.startLine ?? 0) - (b.startLine ?? 0) || a.id - b.id;

export const sortThreads = <T extends Placed>(list: readonly T[]): T[] => [...list].sort(byFileOrder);

/** The diff a thread is on, as the `diff` param names it: its PR ("<repo>#<n>"), or its commit with the full oid. */
export function threadTarget(t: Pick<CommentThread, 'kind' | 'repo' | 'number' | 'commitOid'>): string {
  return t.kind === 'pr' ? `${t.repo}#${t.number}` : commitDiffId(t.repo, t.commitOid);
}

export interface ThreadGroupOf<T> {
  /** The target (threadTarget), the repo's key, or '' for the one group of `none`. */
  key: string;
  /** The repo of a target or repo group; null for `none`. */
  repo: string | null;
  /** In display order. */
  items: T[];
  /** Unresolved threads in the group. */
  open: number;
  /** The newest activity in the group (`updatedAt`). */
  lastAt: string;
}

/**
 * Group and order threads. Activity is newest first ('recent', and the blocks of 'file') or oldest first, by `at`
 * (default `updatedAt`; the view holds rows in place after a change), ties by id like the server. Blocks (targets,
 * repos) come in the order of their first thread; 'file' keeps that order for the blocks and reads each PR or commit
 * top to bottom (byFileOrder). With 'file' and no grouping that is: by repo, target, path, line.
 */
export function groupThreads<T extends ThreadListItem>(
  items: readonly T[],
  group: ThreadGroup,
  sort: ThreadOrder,
  at: (t: T) => string = (t) => t.updatedAt,
): ThreadGroupOf<T>[] {
  const asc = sort === 'oldest';
  const byActivity = (a: T, b: T) => {
    const d = at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : a.id - b.id;
    return asc ? d : -d;
  };
  const sorted = [...items].sort(byActivity);
  const blocks = (list: T[], keyOf: (t: T) => string) => {
    const m = new Map<string, T[]>();
    for (const t of list) {
      const k = keyOf(t);
      const b = m.get(k);
      if (b) b.push(t);
      else m.set(k, [t]);
    }
    return m;
  };
  /** A repo's (or everything's) threads in file order: per target, in the targets' order. */
  const fileOrder = (list: T[]) => [...blocks(list, threadTarget).values()].flatMap((b) => b.sort(byFileOrder));
  const make = (key: string, repo: string | null, list: T[]): ThreadGroupOf<T> => ({
    key,
    repo,
    items: list,
    open: list.reduce((n, t) => n + (t.status === 'open' ? 1 : 0), 0),
    lastAt: list.reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), ''),
  });

  if (group === 'target') {
    return [...blocks(sorted, threadTarget)].map(([key, list]) => make(key, list[0]!.repo, sort === 'file' ? list.sort(byFileOrder) : list));
  }
  if (group === 'repo') {
    return [...blocks(sorted, (t) => t.repo)].map(([key, list]) => make(key, key, sort === 'file' ? fileOrder(list) : list));
  }
  if (!sorted.length) return [];
  const flat = sort === 'file' ? [...blocks(sorted, (t) => t.repo).values()].flatMap(fileOrder) : sorted;
  return [make('', null, flat)];
}
