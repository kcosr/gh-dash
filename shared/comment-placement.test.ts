import { describe, expect, it } from 'vitest';
import { createPlacer, findSnippet, type PlaceableThread, type PlacementDiff, patchLines, placeThreads, snippetOf } from './comment-placement';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const B1 = 'b'.repeat(40);
const B2 = 'c'.repeat(40);

// Revision 1 changes f's return value; revision 2 also adds a header above, shifting the new side by 2.
const PATCH_1 = ['@@ -1,5 +1,5 @@', ' import a', ' ', ' function f() {', '-  return 1;', '+  return 2;', ' }'].join('\n');
const PATCH_2 = ['@@ -1,5 +1,7 @@', '+// header', '+', ' import a', ' ', ' function f() {', '-  return 1;', '+  return 2;', ' }'].join('\n');
// The same change twice, far apart.
const TWICE = ['@@ -10,2 +10,2 @@', ' x', '-y', '+z', '@@ -50,2 +50,2 @@', ' x', '-y', '+z'].join('\n');

const diff = (patch: string | null, headOid = H2, baseOid: string | null = B1, path = 'src/a.ts'): PlacementDiff => ({
  headOid, baseOid, files: [{ path, patch }, { path: 'other.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
});

const thread = (over: Partial<PlaceableThread> = {}): PlaceableThread => ({
  kind: 'pr', commitOid: H1, baseOid: B1, path: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, snippet: '  return 2;', ...over,
});

describe('patchLines', () => {
  it('numbers each side from the hunk headers', () => {
    const { old, new: neu } = patchLines(PATCH_2);
    expect([...old]).toEqual([[1, 'import a'], [2, ''], [3, 'function f() {'], [4, '  return 1;'], [5, '}']]);
    expect([...neu]).toEqual([[1, '// header'], [2, ''], [3, 'import a'], [4, ''], [5, 'function f() {'], [6, '  return 2;'], [7, '}']]);
  });

  it('handles omitted counts, several hunks, missing newlines, CRLF and stripped context spaces', () => {
    const { old, new: neu } = patchLines(['@@ -3 +3 @@', '-a\r', '\\ No newline at end of file', '+b', '\\ No newline at end of file', '@@ -9,3 +9,3 @@ fn x()', ' c', '', '-d', '+e'].join('\n'));
    expect([...old]).toEqual([[3, 'a'], [9, 'c'], [10, ''], [11, 'd']]);
    expect([...neu]).toEqual([[3, 'b'], [9, 'c'], [10, ''], [11, 'e']]);
  });

  it('ignores lines past a hunk\'s counts (a trailing newline) and an empty patch', () => {
    expect([...patchLines('@@ -1 +1 @@\n-a\n+b\n').new]).toEqual([[1, 'b']]);
    expect(patchLines('')).toEqual({ old: new Map(), new: new Map() });
  });
});

describe('snippetOf / findSnippet', () => {
  const { new: neu } = patchLines(TWICE);

  it('reads a range of lines, or null when the patch lacks one', () => {
    const lines = patchLines(PATCH_2).new;
    expect(snippetOf(lines, 5, 6)).toBe('function f() {\n  return 2;');
    expect(snippetOf(lines, 7, 8)).toBeNull();
    expect(snippetOf(neu, 11, 50)).toBeNull();
  });

  it('prefers the match nearest the original line, the earlier on a tie', () => {
    expect(findSnippet(neu, 'z', 48)).toBe(51);
    expect(findSnippet(neu, 'z', 12)).toBe(11);
    expect(findSnippet(neu, 'z', 31)).toBe(11);
    expect(findSnippet(neu, 'x\nz', 40)).toBe(50);
  });

  it('matches whole lines, consecutively, and never across a gap between hunks', () => {
    expect(findSnippet(neu, 'z ', 11)).toBeNull();
    expect(findSnippet(neu, 'x\ny', 10)).toBeNull();
    expect(findSnippet(neu, 'z\nx', 11)).toBeNull();
    expect(findSnippet(neu, 'nope', 11)).toBeNull();
  });

  it('never relocates a blank snippet, and ignores carriage returns', () => {
    const lines = patchLines('@@ -1,3 +1,3 @@\n a\r\n \r\n-b\n+c\r').new;
    expect(findSnippet(lines, '', 2)).toBeNull();
    expect(findSnippet(lines, '  \n', 2)).toBeNull();
    expect(findSnippet(lines, 'a\r\n', 5)).toBe(1);
    expect(findSnippet(lines, '\nc', 1)).toBe(2);
  });
});

describe('thread placement', () => {
  it('puts PR- and commit-level threads on the whole diff, whatever the revision', () => {
    const place = createPlacer(diff(PATCH_2));
    const general = { path: null, side: null, startLine: null, endLine: null, snippet: null };
    expect(place(thread(general))).toEqual({ kind: 'target' });
    expect(place(thread({ ...general, kind: 'commit' }))).toEqual({ kind: 'target' });
  });

  it('keeps file threads on their file while it is in the diff', () => {
    const place = createPlacer(diff(PATCH_2));
    const file = { side: null, startLine: null, endLine: null, snippet: null };
    expect(place(thread(file))).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(place(thread({ ...file, path: 'gone.ts' }))).toEqual({ kind: 'outdated', path: 'gone.ts', reason: 'file' });
  });

  it('never moves commit threads (a commit never changes), even outside the patch', () => {
    const place = createPlacer(diff(PATCH_1, 'e'.repeat(40)));
    const t = thread({ kind: 'commit', startLine: 40, endLine: 42, snippet: 'a\nb\nc' });
    expect(place(t)).toEqual({ kind: 'line', path: 'src/a.ts', side: 'new', startLine: 40, endLine: 42, relocated: false });
    expect(place({ ...t, path: 'gone.ts' })).toEqual({ kind: 'outdated', path: 'gone.ts', reason: 'file' });
  });

  it('keeps threads made on the current head at their lines; the old side needs the same merge base too', () => {
    const current = createPlacer(diff(PATCH_2, H2, B2));
    const line = (side: 'old' | 'new', startLine: number, relocated = false) => ({ kind: 'line', path: 'src/a.ts', side, startLine, endLine: startLine, relocated });
    // Past the patch (expanded context) is fine: the revision is the same.
    expect(current(thread({ commitOid: H2, baseOid: B1, startLine: 90, endLine: 90, snippet: 'x' }))).toEqual(line('new', 90));
    expect(current(thread({ commitOid: H2, baseOid: B2, side: 'old', startLine: 90, endLine: 90, snippet: 'x' }))).toEqual(line('old', 90));
    // The merge base moved: old-side lines are found again by their text.
    expect(current(thread({ commitOid: H2, baseOid: B1, side: 'old', startLine: 4, endLine: 4, snippet: '  return 1;' }))).toEqual(line('old', 4, true));
    expect(current(thread({ commitOid: H2, baseOid: null, side: 'old', startLine: 90, endLine: 90, snippet: 'x' }))).toMatchObject({ kind: 'outdated', reason: 'lines' });
  });

  it('relocates threads from an earlier head by their snippet, on the same side only', () => {
    const place = createPlacer(diff(PATCH_2));
    expect(place(thread())).toEqual({ kind: 'line', path: 'src/a.ts', side: 'new', startLine: 6, endLine: 6, relocated: true });
    expect(place(thread({ startLine: 3, endLine: 4, snippet: 'function f() {\n  return 2;' }))).toMatchObject({ startLine: 5, endLine: 6 });
    expect(place(thread({ side: 'old', snippet: '  return 1;' }))).toEqual({ kind: 'line', path: 'src/a.ts', side: 'old', startLine: 4, endLine: 4, relocated: true });
    expect(place(thread({ side: 'old' }))).toEqual({ kind: 'outdated', path: 'src/a.ts', reason: 'lines' });
    expect(place(thread({ snippet: '  return 3;' }))).toEqual({ kind: 'outdated', path: 'src/a.ts', reason: 'lines' });
  });

  it('marks threads outdated when their file has no patch or has left the diff', () => {
    expect(createPlacer(diff(null))(thread())).toEqual({ kind: 'outdated', path: 'src/a.ts', reason: 'lines' });
    expect(createPlacer(diff(PATCH_2, H2, B1, 'src/b.ts'))(thread())).toEqual({ kind: 'outdated', path: 'src/a.ts', reason: 'file' });
  });

  it('places many threads by id', () => {
    const placed = placeThreads([{ ...thread(), id: 7 }, { ...thread({ snippet: 'nope' }), id: 9 }], diff(PATCH_2));
    expect([...placed]).toEqual([
      [7, { kind: 'line', path: 'src/a.ts', side: 'new', startLine: 6, endLine: 6, relocated: true }],
      [9, { kind: 'outdated', path: 'src/a.ts', reason: 'lines' }],
    ]);
  });
});
