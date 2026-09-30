import type { BranchRef } from './types';

/** Newest head commit first, those with no date last, ties by name: the order sources list branches in (see DiffSource.branches). */
export function newestFirst(a: BranchRef, b: BranchRef): number {
  const at = a.committedAt === null ? -Infinity : Date.parse(a.committedAt);
  const bt = b.committedAt === null ? -Infinity : Date.parse(b.committedAt);
  return at === bt ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : bt - at;
}
