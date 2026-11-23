import { hydratePartialDiff } from '@pierre/diffs';
import { expect, it } from 'vitest';
import { findFileMatches, type FileMatches } from '../web/src/diff/fileFind';
import { fullContextDiff } from '../web/src/diff/fullContext';
import { toFileDiff } from '../web/src/diff/model';

function diff(patch: string) {
  return toFileDiff({ path: 'main.ts', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch });
}

const all = (matches: FileMatches) => Array.from({ length: matches.length }, (_, i) => matches.at(i)!);

it('finds literal matches and visits both sides in the active layout’s reading order', () => {
  const patch = diff('@@ -12,3 +9,4 @@\n Shared {\n-Old {\n-Old {\n+New {\n+New {\n+New {');
  const matchOrder = (split: boolean) => all(findFileMatches(patch, '{', split)).map(({ side, lineNumber }) => `${side}:${lineNumber}`);
  expect(matchOrder(false)).toEqual(['new:9', 'old:13', 'old:14', 'new:10', 'new:11', 'new:12']);
  expect(matchOrder(true)).toEqual(['new:9', 'old:13', 'new:10', 'old:14', 'new:11', 'new:12']);
  expect(all(findFileMatches(patch, 'shared {', true))).toEqual([{ side: 'new', lineNumber: 9, start: 0, end: 8, oldLineNumber: 12 }]);
  expect(findFileMatches(patch, '', false).length).toBe(0);
  expect(findFileMatches(patch, '{', true).firstNear({ side: 'old', lineNumber: 12 })).toBe(0);
  expect(findFileMatches(patch, '{', true).firstNear({ side: 'new', lineNumber: 11 })).toBe(4);
});

it('keeps UTF-16 offsets after a Unicode case-insensitive match', () => {
  const patch = diff('@@ -1 +1 @@\n-💡 K {x} {x}\n+replacement');
  expect(all(findFileMatches(patch, 'k {X}', false))).toEqual([{ side: 'old', lineNumber: 1, start: 3, end: 8 }]);
  expect(all(findFileMatches(patch, '{x}', false)).map(({ start, end }) => [start, end])).toEqual([[5, 8], [9, 12]]);
});

it.each([false, true])('starts at the next visual match after insertions shift line numbers (split=%s)', (split) => {
  const patch = diff('@@ -1,4 +1,6 @@\n-needle before\n+prefix 1\n+prefix 2\n+needle before\n anchor\n-needle after\n+replacement\n needle footer');
  const matches = findFileMatches(patch, 'needle', split);
  for (const anchor of [{ side: 'new', lineNumber: 4 }, { side: 'old', lineNumber: 2 }] as const) {
    expect(matches.at(matches.firstNear(anchor))).toMatchObject({ side: 'old', lineNumber: 3 });
  }
});

it.each([false, true])('starts at the next visual match after deletions shift line numbers (split=%s)', (split) => {
  const patch = diff('@@ -1,6 +1,4 @@\n-prefix 1\n-prefix 2\n-needle before\n+needle before\n anchor\n-replacement\n+needle after\n needle footer');
  const matches = findFileMatches(patch, 'needle', split);
  for (const anchor of [{ side: 'new', lineNumber: 2 }, { side: 'old', lineNumber: 4 }] as const) {
    expect(matches.at(matches.firstNear(anchor))).toMatchObject({ side: 'new', lineNumber: 3 });
  }
});

it('orders changed rows after an anchor according to the active layout', () => {
  const patch = diff('@@ -1,2 +1,2 @@\n-old text\n-needle old\n+new text\n+needle new');
  const anchor = { side: 'new', lineNumber: 1 } as const;
  const unified = findFileMatches(patch, 'needle', false);
  const split = findFileMatches(patch, 'needle', true);
  expect(unified.at(unified.firstNear(anchor))).toMatchObject({ side: 'new', lineNumber: 2 });
  expect(split.at(split.firstNear(anchor))).toMatchObject({ side: 'old', lineNumber: 2 });
});

it('searches rendered context in a hydrated patch and all context in full-file mode', () => {
  const patch = diff('@@ -2 +1,0 @@\n-remove\n@@ -3,0 +3 @@\n+insert');
  const revisions = {
    oldFile: { name: 'main.ts', contents: 'outside start\nremove\noutside between\noutside end' },
    newFile: { name: 'main.ts', contents: 'outside start\noutside between\ninsert\noutside end' },
  };
  const hydrated = hydratePartialDiff('clone', patch, revisions);
  expect(findFileMatches(hydrated, 'outside', false).length).toBe(0);
  const coordinates = (matches: FileMatches) => all(matches).map(({ oldLineNumber, lineNumber }) => [oldLineNumber, lineNumber]);
  expect(coordinates(findFileMatches(hydrated, 'outside', false, (line) => line === 2 || line === 4))).toEqual([[3, 2], [4, 4]]);
  expect(coordinates(findFileMatches(fullContextDiff(patch, revisions), 'outside', false))).toEqual([[1, 1], [3, 2], [4, 4]]);
});

it('keeps all matches navigable in a line with a million hits', () => {
  const patch = diff(`@@ -1,2 +1,2 @@\n old a\n-${'a'.repeat(1_000_000)}\n+new a`);
  const matches = findFileMatches(patch, 'a', true);
  expect(matches.length).toBe(1_000_002);
  expect(matches.lineMatches('old', 2)).toEqual({ start: 1, end: 1_000_001 });
  expect(matches.lineMatches('new', 2)).toEqual({ start: 1_000_001, end: 1_000_002 });
  for (const index of [1, 16_383, 16_384, 1_000_000]) {
    const match = matches.at(index)!;
    expect(match).toEqual({ side: 'old', lineNumber: 2, start: index - 1, end: index });
    expect(matches.indexOf(match)).toBe(index);
  }
  expect(matches.at(1_000_002)).toBeUndefined();
});
