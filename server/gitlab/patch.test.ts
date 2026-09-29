import { describe, expect, it } from 'vitest';
import { mapDiffFile } from './map';
import { countLines, hunks } from './patch';
import type { RestDiff } from './types';

const HUNKS = '@@ -1,3 +1,3 @@\n line\n-old\n+new\n@@ -10,2 +10,3 @@\n ctx\n+added\n\\ No newline at end of file\n';

const file = (over: Partial<RestDiff>): RestDiff => ({
  diff: HUNKS,
  old_path: 'src/a.ts',
  new_path: 'src/a.ts',
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  ...over,
});

describe('GitLab diff text → patch', () => {
  it('keeps the hunks from the first @@, without header lines or the trailing newline', () => {
    const expected = HUNKS.slice(0, -1);
    expect(hunks(HUNKS)).toBe(expected);
    // unidiff=true prepends ---/+++ lines; git's own headers are dropped too.
    expect(hunks(`--- a/src/a.ts\n+++ b/src/a.ts\n${HUNKS}`)).toBe(expected);
    expect(hunks(`diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${HUNKS}`)).toBe(expected);
  });

  it('has no patch for binary files and content-free changes', () => {
    expect(hunks('Binary files src/logo.png and src/logo.png differ\n')).toBeNull();
    expect(hunks('')).toBeNull();
  });

  it('counts added and removed lines, not headers or "no newline" markers', () => {
    expect(countLines(hunks(`--- a/x\n+++ b/x\n${HUNKS}`))).toEqual({ additions: 2, deletions: 1 });
    // Content that looks like a header still counts once it's inside a hunk.
    expect(countLines('@@ -1 +1 @@\n---- old rule\n++++ new rule')).toEqual({ additions: 1, deletions: 1 });
    expect(countLines(null)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('GitLab diff file → DiffFile', () => {
  it('maps statuses, keeping the old path of renames only', () => {
    expect(mapDiffFile(file({}))).toEqual({ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, patch: HUNKS.slice(0, -1) });
    expect(mapDiffFile(file({ new_file: true, diff: '@@ -0,0 +1,2 @@\n+a\n+b\n' }))).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(mapDiffFile(file({ deleted_file: true, diff: '@@ -1 +0,0 @@\n-a\n' }))).toMatchObject({ path: 'src/a.ts', status: 'removed', deletions: 1 });
    expect(mapDiffFile(file({ renamed_file: true, old_path: 'src/old.ts', diff: '' }))).toEqual({
      path: 'src/a.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null,
    });
  });

  it('has no patch (and no counts) for files over the diff limits or binary', () => {
    expect(mapDiffFile(file({ diff: '', too_large: true }))).toMatchObject({ patch: null, additions: 0, deletions: 0 });
    expect(mapDiffFile(file({ diff: '', collapsed: true }))).toMatchObject({ patch: null });
    // Collapsed wins even if some text came along.
    expect(mapDiffFile(file({ collapsed: true }))).toMatchObject({ patch: null });
    expect(mapDiffFile(file({ diff: 'Binary files a.png and a.png differ\n', new_path: 'a.png' }))).toMatchObject({ patch: null, status: 'modified' });
  });
});
