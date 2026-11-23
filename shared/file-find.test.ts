import { hydratePartialDiff } from '@pierre/diffs';
import { expect, it } from 'vitest';
import { findFileMatches } from '../web/src/diff/fileFind';
import { fullContextDiff } from '../web/src/diff/fullContext';
import { toFileDiff } from '../web/src/diff/model';

function diff(patch: string) {
  return toFileDiff({ path: 'main.ts', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch });
}

it('finds literal matches and visits both sides in the active layout’s reading order', () => {
  const patch = diff('@@ -12,3 +9,4 @@\n Shared {\n-Old {\n-Old {\n+New {\n+New {\n+New {');
  const matchOrder = (split: boolean) => findFileMatches(patch, '{', split).map(({ side, lineNumber }) => `${side}:${lineNumber}`);
  expect(matchOrder(false)).toEqual(['new:9', 'old:13', 'old:14', 'new:10', 'new:11', 'new:12']);
  expect(matchOrder(true)).toEqual(['new:9', 'old:13', 'new:10', 'old:14', 'new:11', 'new:12']);
  expect(findFileMatches(patch, 'shared {', true)).toEqual([{ side: 'new', lineNumber: 9, start: 0, end: 8, oldLineNumber: 12 }]);
  expect(findFileMatches(patch, '', false)).toEqual([]);
});

it('keeps UTF-16 offsets after a Unicode case-insensitive match', () => {
  const patch = diff('@@ -1 +1 @@\n-💡 K {x} {x}\n+replacement');
  expect(findFileMatches(patch, 'k {X}', false)).toEqual([{ side: 'old', lineNumber: 1, start: 3, end: 8 }]);
  expect(findFileMatches(patch, '{x}', false).map(({ start, end }) => [start, end])).toEqual([[5, 8], [9, 12]]);
});

it('searches rendered context in a hydrated patch and all context in full-file mode', () => {
  const patch = diff('@@ -2 +1,0 @@\n-remove\n@@ -3,0 +3 @@\n+insert');
  const revisions = {
    oldFile: { name: 'main.ts', contents: 'outside start\nremove\noutside between\noutside end' },
    newFile: { name: 'main.ts', contents: 'outside start\noutside between\ninsert\noutside end' },
  };
  const hydrated = hydratePartialDiff('clone', patch, revisions);
  expect(findFileMatches(hydrated, 'outside', false)).toEqual([]);
  const coordinates = (matches: ReturnType<typeof findFileMatches>) => matches.map(({ oldLineNumber, lineNumber }) => [oldLineNumber, lineNumber]);
  expect(coordinates(findFileMatches(hydrated, 'outside', false, (line) => line === 2 || line === 4))).toEqual([[3, 2], [4, 4]]);
  expect(coordinates(findFileMatches(fullContextDiff(patch, revisions), 'outside', false))).toEqual([[1, 1], [3, 2], [4, 4]]);
});
