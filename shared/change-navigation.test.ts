import { describe, expect, it } from 'vitest';
import { changeHunks, nearestChange, stepChange, type DiffLine } from '../web/src/diff/changeNavigation';
import { toFileDiff } from '../web/src/diff/model';

const patch = [
  '@@ -2,3 +2,4 @@', ' before', '-old', '+new', '+another', ' after',
  '@@ -20 +20,0 @@', '-removed',
  '@@ -30,0 +31 @@', '+added',
].join('\n');
const changes = changeHunks(toFileDiff({
  path: 'src/cache.ts', previousPath: null, status: 'modified', additions: 3, deletions: 2, patch,
}).hunks);
const line = (side: DiffLine['side'], lineNumber: number): DiffLine => ({ side, lineNumber });

describe('change navigation', () => {
  it('uses the first changed line on the appropriate side of each original hunk', () => {
    expect(changes.map((change) => change.target)).toEqual([line('new', 3), line('old', 20), line('new', 31)]);
  });

  it('steps from either side of the visible hunk or from unchanged context between hunks', () => {
    expect(stepChange(changes, line('new', 5), 1)).toBe(changes[1]);
    expect(stepChange(changes, line('old', 20), -1)).toBe(changes[0]);
    expect(stepChange(changes, line('new', 22), 1)).toBe(changes[2]);
    expect(stepChange(changes, line('new', 22), -1)).toBe(changes[1]);
  });

  it('steps across a zero-length side between its preceding and following lines', () => {
    expect(stepChange(changes, line('new', 20), 1)).toBe(changes[1]);
    expect(stepChange(changes, line('new', 21), -1)).toBe(changes[1]);
    expect(stepChange(changes, line('old', 30), 1)).toBe(changes[2]);
    expect(stepChange(changes, line('old', 31), -1)).toBe(changes[2]);
  });

  it('honors an in-flight jump and stops at the ends', () => {
    expect(stepChange(changes, null, 1)).toBe(changes[0]);
    expect(stepChange(changes, null, -1)).toBeUndefined();
    expect(stepChange(changes, line('old', 2), 1, changes[1])).toBe(changes[2]);
    expect(stepChange(changes, line('new', 22), 1, changes[2])).toBeUndefined();
    expect(stepChange(changes, line('new', 31), 1)).toBeUndefined();
    expect(stepChange(changes, line('old', 2), -1)).toBeUndefined();
  });

  it('maps a context anchor to its closest hunk on the same side', () => {
    expect(nearestChange(changes, line('new', 8))).toBe(changes[0]);
    expect(nearestChange(changes, line('new', 20))).toBe(changes[1]);
    expect(nearestChange(changes, line('old', 41))).toBe(changes[2]);
    expect(nearestChange([], line('old', 41))).toBeUndefined();
  });
});
