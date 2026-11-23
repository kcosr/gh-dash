import type { Hunk } from '@pierre/diffs';

export interface DiffLine {
  side: 'old' | 'new';
  lineNumber: number;
}

export type ChangeDirection = -1 | 1;

interface LineRange {
  first: number;
  last: number;
}

export interface ChangeHunk {
  index: number;
  target: DiffLine;
  old: LineRange;
  new: LineRange;
}

function hunkRange(start: number, count: number): LineRange {
  // An empty side lies between the line named by the patch and the next line.
  return count > 0 ? { first: start, last: start + count - 1 } : { first: start + 0.5, last: start + 0.5 };
}

function firstChange(hunk: Hunk): DiffLine | undefined {
  let context = 0;
  for (const block of hunk.hunkContent) {
    if (block.type === 'context') context += block.lines;
    else if (block.additions > 0) return { side: 'new', lineNumber: hunk.additionStart + context };
    else if (block.deletions > 0) return { side: 'old', lineNumber: hunk.deletionStart + context };
  }
}

/** The original patch hunks are the same navigation stops in either context mode. */
export function changeHunks(hunks: readonly Hunk[]): readonly ChangeHunk[] {
  const changes: ChangeHunk[] = [];
  for (const hunk of hunks) {
    const target = firstChange(hunk);
    if (!target) continue;
    changes.push({
      index: changes.length,
      target,
      old: hunkRange(hunk.deletionStart, hunk.deletionCount),
      new: hunkRange(hunk.additionStart, hunk.additionCount),
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
): ChangeHunk | undefined {
  if (current && changes[current.index] === current) return changes[current.index + direction];
  if (!from) return direction === 1 ? changes[0] : undefined;
  return direction === 1
    ? changes.find((change) => change[from.side].first > from.lineNumber)
    : changes.findLast((change) => change[from.side].last < from.lineNumber);
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
