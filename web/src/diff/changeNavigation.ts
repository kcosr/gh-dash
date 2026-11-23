import type { Hunk } from '@pierre/diffs';

export interface DiffLine {
  side: 'old' | 'new';
  lineNumber: number;
}

export type ChangeDirection = -1 | 1;

interface LineRange {
  first: number;
  last: number;
  changeStart: number;
}

export interface ChangeHunk {
  index: number;
  target: DiffLine;
  old: LineRange;
  new: LineRange;
}

function hunkRange(start: number, count: number, changeStart: number): LineRange {
  // An empty side lies between the line named by the patch and the next line.
  return count > 0 ? { first: start, last: start + count - 1, changeStart } : { first: start + 0.5, last: start + 0.5, changeStart };
}

function firstChange(hunk: Hunk): { target: DiffLine; oldStart: number; newStart: number } | undefined {
  let context = 0;
  for (const block of hunk.hunkContent) {
    if (block.type === 'context') {
      context += block.lines;
      continue;
    }
    if (!block.deletions && !block.additions) continue;
    const oldLine = hunk.deletionStart + context + (hunk.deletionCount === 0 ? 1 : 0);
    const newLine = hunk.additionStart + context + (hunk.additionCount === 0 ? 1 : 0);
    return {
      // A mixed block starts with deletions in unified view. The first deletion shares a row
      // with the first addition in split view.
      target: block.deletions > 0 ? { side: 'old', lineNumber: oldLine } : { side: 'new', lineNumber: newLine },
      oldStart: oldLine - (block.deletions > 0 ? 0 : 0.5),
      newStart: newLine - (block.additions > 0 ? 0 : 0.5),
    };
  }
}

/** The original patch hunks are the same navigation stops in either context mode. */
export function changeHunks(hunks: readonly Hunk[]): readonly ChangeHunk[] {
  const changes: ChangeHunk[] = [];
  for (const hunk of hunks) {
    const first = firstChange(hunk);
    if (!first) continue;
    changes.push({
      index: changes.length,
      target: first.target,
      old: hunkRange(hunk.deletionStart, hunk.deletionCount, first.oldStart),
      new: hunkRange(hunk.additionStart, hunk.additionCount, first.newStart),
    });
  }
  return changes;
}

/** Retain a just-jumped hunk as the starting point until normal scrolling resumes. */
export function stepChange(
  changes: readonly ChangeHunk[],
  from: DiffLine | null,
  direction: ChangeDirection,
  current?: ChangeHunk,
  split = false,
): ChangeHunk | undefined {
  if (current && changes[current.index] === current) return changes[current.index + direction];
  if (!from) return direction === 1 ? changes[0] : undefined;
  if (direction === 1) return changes.find((change) => change[from.side].first > from.lineNumber);
  return changes.findLast((change) => {
    const { changeStart } = change[from.side];
    // The first added line in a mixed block is already below its first deletion in unified view.
    return changeStart < from.lineNumber || (
      !split && from.side === 'new' && change.target.side === 'old' && changeStart === from.lineNumber
    );
  });
}

/** Find the closest original hunk on the same side, including changes across an empty side. */
export function nearestChange(changes: readonly ChangeHunk[], from: DiffLine): ChangeHunk | undefined {
  let nearest: ChangeHunk | undefined;
  let distance = Infinity;
  for (const change of changes) {
    const { first, last } = change[from.side];
    const gap = Math.max(first - from.lineNumber, from.lineNumber - last, 0);
    if (gap >= distance) continue;
    nearest = change;
    distance = gap;
  }
  return nearest;
}
