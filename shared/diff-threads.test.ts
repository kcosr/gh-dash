import { describe, expect, it } from 'vitest';
import type { CommentThread } from './api';
import { createPlacer, placeThreads } from './comment-placement';
import {
  annotationsFor, countsByFile, draftSnippet, draftSpot, notesByFile, readingOrder, selectionAnchor, stepThread,
} from '../web/src/diff/threadModel';
import { canonicalQuery, parseUrlState, patchSearch } from '../web/src/lib/urlState';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
// a.ts: lines 1-3 context, 4 changed, 5 context (new side 1-6: a header line added on top).
const PATCH = ['@@ -1,5 +1,6 @@', '+// header', ' one', ' two', ' three', '-four', '+FOUR', ' five'].join('\n');
const diff = { headOid: HEAD, baseOid: null, files: [{ path: 'a.ts', patch: PATCH }, { path: 'b.ts', patch: '@@ -1 +1 @@\n-x\n+y' }] };

let id = 0;
function thread(over: Partial<CommentThread>): CommentThread {
  return {
    id: ++id, kind: 'pr', repo: 'app', number: 1, commitOid: HEAD, baseOid: null, path: 'a.ts', side: 'new', startLine: 2, endLine: 2,
    snippet: 'one', status: 'open', resolvedAt: null, createdAt: '', updatedAt: '', comments: [], ...over,
  };
}
const shownIn = (sides: Record<string, Record<string, number[]>>) => (path: string, side: 'old' | 'new', line: number) => !!sides[path]?.[side]?.includes(line);

describe('threads → viewer model', () => {
  const general = thread({ path: null, side: null, startLine: null, endLine: null, snippet: null });
  const onTwo = thread({ startLine: 2, endLine: 2 });
  const alsoTwo = thread({ startLine: 1, endLine: 2, snippet: '// header\none', status: 'resolved' });
  const oldFour = thread({ side: 'old', startLine: 4, endLine: 4, snippet: 'four' });
  const fileLevel = thread({ path: 'b.ts', side: null, startLine: null, endLine: null, snippet: null });
  const outdated = thread({ commitOid: OLD, snippet: 'gone', startLine: 3, endLine: 3 });
  const hidden = thread({ startLine: 40, endLine: 40, snippet: 'far below' });
  const gone = thread({ path: 'c.ts', commitOid: OLD, snippet: 'x' });
  const all = [gone, hidden, outdated, fileLevel, oldFour, alsoTwo, onTwo, general];
  const placements = placeThreads(all, diff);
  const shown = shownIn({ 'a.ts': { new: [1, 2, 3, 4, 5, 6], old: [1, 2, 3, 4, 5] }, 'b.ts': { new: [1], old: [1] } });

  it('groups line threads by the line they end on, in line order, and sets the rest aside', () => {
    const notes = notesByFile(all, placements, shown);
    expect(notes.get('a.ts')).toEqual({
      lines: [{ side: 'new', line: 2, ids: [alsoTwo.id, onTwo.id] }, { side: 'old', line: 4, ids: [oldFour.id] }],
      file: [], outdated: [outdated.id], hidden: [hidden.id],
    });
    expect(notes.get('b.ts')).toEqual({ lines: [], file: [fileLevel.id], outdated: [], hidden: [] });
    expect(notes.has('c.ts')).toBe(false);
  });

  it('makes Pierre annotations: the file block at line 0 first, the composer last', () => {
    const notes = notesByFile(all, placements, shown);
    const draft = { at: 'line' as const, side: 'old' as const, startLine: 1, endLine: 2, relocated: false };
    expect(annotationsFor(notes.get('a.ts'), draft, 'additions')).toEqual([
      { side: 'additions', lineNumber: 0, metadata: { kind: 'file', ids: [hidden.id], outdated: [outdated.id], draft: false } },
      { side: 'additions', lineNumber: 2, metadata: { kind: 'threads', ids: [alsoTwo.id, onTwo.id] } },
      { side: 'deletions', lineNumber: 4, metadata: { kind: 'threads', ids: [oldFour.id] } },
      { side: 'deletions', lineNumber: 2, metadata: { kind: 'draft' } },
    ]);
    // A deleted file has no additions side for Pierre to put the block on.
    expect(annotationsFor(notes.get('b.ts'), null, 'deletions')).toEqual([{ side: 'deletions', lineNumber: 0, metadata: { kind: 'file', ids: [fileLevel.id], outdated: [], draft: false } }]);
    expect(annotationsFor(undefined, null, 'additions')).toEqual([]);
    // A draft whose lines aren't on screen waits in the file's top block, which it opens if need be.
    expect(annotationsFor(undefined, { at: 'file', why: 'outdated' }, 'additions')).toEqual([{ side: 'additions', lineNumber: 0, metadata: { kind: 'file', ids: [], outdated: [], draft: true } }]);
  });

  it('counts threads per file for the file list, outdated ones included', () => {
    expect(countsByFile(all, placements)).toEqual(new Map([['a.ts', { threads: 5, unresolved: 4 }], ['b.ts', { threads: 1, unresolved: 1 }]]));
  });

  it('orders threads for reading: general, then by file and line, then those outside the diff', () => {
    const order = readingOrder(all, placements, new Map([['a.ts', 0], ['b.ts', 1]])).map((t) => t.id);
    expect(order).toEqual([general.id, outdated.id, alsoTwo.id, onTwo.id, oldFour.id, hidden.id, fileLevel.id, gone.id]);
  });

  it('steps n/p through unresolved threads, from the focused one or the file in view', () => {
    const order = [{ id: 1, open: true }, { id: 2, open: false }, { id: 3, open: true }, { id: 4, open: true }];
    const rank = (id: number) => ({ 1: -1, 2: 0, 3: 1, 4: 2 })[id]!;
    expect(stepThread(order, 1, 1, rank, 0)).toBe(3);
    expect(stepThread(order, 2, -1, rank, 0)).toBe(1); // from a resolved one
    expect(stepThread(order, 4, 1, rank, 0)).toBeNull();
    expect(stepThread(order, null, 1, rank, 1)).toBe(3);
    expect(stepThread(order, null, -1, rank, 1)).toBe(1);
    expect(stepThread(order, null, 1, rank, 5)).toBeNull();
    expect(stepThread([], null, 1, rank, 0)).toBeNull();
  });
});

describe('new threads', () => {
  it("shows a draft where its lines are now, from the revision and text it was started on", () => {
    const started = { path: 'a.ts', side: 'new' as const, startLine: 2, endLine: 3, commitOid: OLD, baseOid: null, snippet: 'one\ntwo' };
    const all = () => true;
    // Same revision: at its lines.
    expect(draftSpot({ ...started, commitOid: HEAD }, 'pr', createPlacer(diff), all)).toEqual({ at: 'line', side: 'new', startLine: 2, endLine: 3, relocated: false });
    // A later push moved its lines down by one.
    const pushed = { ...diff, files: [{ path: 'a.ts', patch: PATCH.replace('@@ -1,5 +1,6 @@\n', '@@ -1,5 +1,7 @@\n+// pushed\n') }] };
    expect(draftSpot(started, 'pr', createPlacer(pushed), all)).toEqual({ at: 'line', side: 'new', startLine: 3, endLine: 4, relocated: true });
    // Its lines changed: at the file's top.
    expect(draftSpot({ ...started, snippet: 'gone\nnow' }, 'pr', createPlacer(diff), all)).toEqual({ at: 'file', why: 'outdated' });
    // Its file left the diff: nowhere.
    expect(draftSpot({ ...started, path: 'c.ts' }, 'pr', createPlacer(diff), all)).toBeNull();
    // A commit never changes.
    expect(draftSpot({ ...started, snippet: 'gone\nnow' }, 'commit', createPlacer(diff), all)).toMatchObject({ at: 'line', startLine: 2, relocated: false });
  });

  it('puts a draft whose lines the diff no longer shows (expanded context, reloaded) at its file top', () => {
    const onContext = { path: 'a.ts', side: 'new' as const, startLine: 40, endLine: 41, commitOid: HEAD, baseOid: null, snippet: 'a\nb' };
    const shown = (side: 'old' | 'new', line: number) => side === 'new' && line <= 6;
    expect(draftSpot(onContext, 'pr', createPlacer(diff), shown)).toEqual({ at: 'file', why: 'hidden' });
    expect(draftSpot({ ...onContext, startLine: 5, endLine: 6, snippet: 'FOUR\nfive' }, 'pr', createPlacer(diff), shown)).toMatchObject({ at: 'line', startLine: 5 });
  });

  it('anchors a selection to one side, in order, even across sides of a unified view', () => {
    expect(selectionAnchor('a.ts', PATCH, { start: 5, end: 3, side: 'additions' })).toEqual({ path: 'a.ts', side: 'new', startLine: 3, endLine: 5 });
    expect(selectionAnchor('a.ts', PATCH, { start: 2, end: 2 })).toEqual({ path: 'a.ts', side: 'new', startLine: 2, endLine: 2 });
    // From old line 4 (deleted) down to new line 6: the new side's lines between them.
    expect(selectionAnchor('a.ts', PATCH, { start: 4, side: 'deletions', end: 6, endSide: 'additions' })).toEqual({ path: 'a.ts', side: 'new', startLine: 5, endLine: 6 });
    // Upwards, from new 5 to old 1: old lines 1-4.
    expect(selectionAnchor('a.ts', PATCH, { start: 5, side: 'additions', end: 1, endSide: 'deletions' })).toEqual({ path: 'a.ts', side: 'old', startLine: 1, endLine: 4 });
    // An end outside the patch (expanded context): just the end line.
    expect(selectionAnchor('a.ts', PATCH, { start: 30, side: 'deletions', end: 31, endSide: 'additions' })).toEqual({ path: 'a.ts', side: 'new', startLine: 31, endLine: 31 });
  });

  it('takes the snippet from the patch, else from loaded contents', () => {
    expect(draftSnippet(PATCH, undefined, { path: 'a.ts', side: 'new', startLine: 1, endLine: 2 })).toBe('// header\none');
    expect(draftSnippet(PATCH, undefined, { path: 'a.ts', side: 'old', startLine: 4, endLine: 4 })).toBe('four');
    const contents = { old: null, new: ['// header', 'one', 'two', 'three', 'FOUR', 'five', 'six\r', 'seven'] };
    expect(draftSnippet(PATCH, contents, { path: 'a.ts', side: 'new', startLine: 6, endLine: 7 })).toBe('five\nsix');
    expect(draftSnippet(PATCH, contents, { path: 'a.ts', side: 'new', startLine: 8, endLine: 9 })).toBeNull();
    expect(draftSnippet(PATCH, undefined, { path: 'a.ts', side: 'new', startLine: 7, endLine: 7 })).toBeNull();
  });
});

describe('comment URL state', () => {
  it('keeps the focused thread and the file filter with the diff only', () => {
    const s = parseUrlState('?diff=app%232&file=a.ts&thread=12&only=unresolved', 'prs');
    expect(s).toMatchObject({ diff: 'app#2', thread: 12, only: 'unresolved' });
    expect(parseUrlState('?thread=12&only=commented', 'prs')).toMatchObject({ thread: null, only: null });
    expect(parseUrlState('?diff=app%232&thread=x&only=all', 'prs')).toMatchObject({ thread: null, only: null });
    expect(patchSearch('?diff=app%232&file=a.ts', 'prs', { thread: 7, only: 'commented' })).toBe('?diff=app%232&file=a.ts&thread=7&only=commented');
    // Closing the diff drops them.
    expect(patchSearch('?diff=app%232&thread=7&only=commented', 'prs', { diff: null })).toBe('');
    expect(canonicalQuery('state=open&diff=app%232&thread=7&only=commented')).toBe('state=open');
  });

  it('filters the PR list by comments', () => {
    expect(parseUrlState('?comments=unresolved', 'prs').comments).toBe('unresolved');
    expect(parseUrlState('?comments=nope', 'prs').comments).toBeNull();
    expect(parseUrlState('?comments=any', 'issues').comments).toBeNull();
    expect(patchSearch('?state=open', 'prs', { comments: 'any' })).toBe('?state=open&comments=any');
    expect(canonicalQuery('comments=any&state=open')).toBe('comments=any&state=open');
  });
});
