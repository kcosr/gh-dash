import type { FileDiffMetadata } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import type { Diff, DiffFile } from './api';
import { LARGE_FILE_LINES, buildFiles, parseFiles, renameParts, toFileDiff } from '../web/src/diff/model';
import commit6df2155 from '../web/src/diff/fixtures/gh-dash-commit-6df2155.json';
import pr2 from '../web/src/diff/fixtures/gh-dash-pr-2.json';
import pr3 from '../web/src/diff/fixtures/gh-dash-pr-3.json';
import sedes16 from '../web/src/diff/fixtures/sedes-pr-16.json';

// Real GitHub diffs, as the API returns them (the committed ones; the big fixtures are git-ignored).
const FIXTURES = { 'gh-dash-pr-2': pr2, 'gh-dash-pr-3': pr3, 'gh-dash-commit-6df2155': commit6df2155, 'sedes-pr-16': sedes16 } as Record<string, Diff>;

const file = (path: string, patch: string | null, more: Partial<DiffFile> = {}): DiffFile => ({
  path, previousPath: null, status: 'modified', additions: 0, deletions: 0, patch, ...more,
});

const diff = (files: DiffFile[], more: Partial<Diff> = {}): Diff => ({
  kind: 'pr', repo: 'kcosr/gh-dash', number: 2, title: 'T', baseOid: 'b'.repeat(40), headOid: 'h'.repeat(40), files,
  totalFiles: files.length, additions: 0, deletions: 0, fetchedAt: '2026-09-28T00:00:00Z', url: 'https://github.com/o/gh-dash/pull/2/files', ...more,
});

/** Lines the parsed hunks add and delete. */
const counted = (fd: FileDiffMetadata) => ({
  additions: fd.hunks.reduce((n, h) => n + h.additionLines, 0),
  deletions: fd.hunks.reduce((n, h) => n + h.deletionLines, 0),
});

describe('toFileDiff', () => {
  it("parses GitHub's header-less patches with the line counts the API reports", () => {
    let parsed = 0;
    for (const [name, d] of Object.entries(FIXTURES)) {
      for (const f of d.files) {
        if (f.patch == null) continue;
        const fd = toFileDiff(f);
        const at = `${name}: ${f.path}`;
        // Without a synthesized header Pierre would take the first hunk for one.
        expect(fd.hunks.length, at).toBe(f.patch.match(/^@@ /gm)!.length);
        expect(counted(fd), at).toEqual({ additions: f.additions, deletions: f.deletions });
        expect(fd, at).toMatchObject({ name: f.path, prevName: undefined, type: f.status === 'added' ? 'new' : 'change', isPartial: true });
        parsed++;
      }
    }
    expect(parsed).toBe(74);
  });

  it('names and types removed and renamed files from the API fields', () => {
    const removed = toFileDiff(file('old/gone.ts', '@@ -1,3 +0,0 @@\n-a\n-b\n-c', { status: 'removed', deletions: 3 }));
    expect(removed).toMatchObject({ name: 'old/gone.ts', type: 'deleted', additionLines: [], deletionLines: ['a\n', 'b\n', 'c\n'] });
    expect(counted(removed)).toEqual({ additions: 0, deletions: 3 });

    const renamed = toFileDiff(file('src/new.ts', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c', { status: 'renamed', previousPath: 'lib/old.ts', additions: 1, deletions: 1 }), 'key');
    expect(renamed).toMatchObject({ name: 'src/new.ts', prevName: 'lib/old.ts', type: 'rename-changed', cacheKey: 'key' });
    expect(counted(renamed)).toEqual({ additions: 1, deletions: 1 });

    const pure = toFileDiff(file('src/moved.ts', null, { status: 'renamed', previousPath: 'lib/moved.ts' }));
    expect(pure).toMatchObject({ name: 'src/moved.ts', prevName: 'lib/moved.ts', type: 'rename-pure', hunks: [], isPartial: true });
  });

  it('keeps lines that look like file headers, and the no-newline markers, in their hunk', () => {
    // A deleted SQL comment and an added line starting with "++".
    const sql = toFileDiff(file('db/schema.sql', '@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n keep', { additions: 1, deletions: 1 }));
    expect(sql.hunks).toHaveLength(1);
    expect(sql.deletionLines).toEqual(['-- old comment\n', 'keep\n']);
    expect(sql.additionLines).toEqual(['++ new comment\n', 'keep\n']);

    const noEol = toFileDiff(file('a.txt', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file'));
    expect(noEol.additionLines).toEqual(['a\n', 'c']);
    expect(noEol.hunks[0]).toMatchObject({ noEOFCRAdditions: true, noEOFCRDeletions: true });
  });
});

describe('buildFiles', () => {
  it('says why a file has no diff body', () => {
    const notes = (d: Diff) => Object.fromEntries(buildFiles(d).map((f) => [f.id, f.note]));
    expect(notes(FIXTURES['gh-dash-pr-3'])).toEqual({
      'README.md': null,
      'docs/images/activity.png': 'binary',
      'docs/images/insights.png': 'binary',
      'docs/images/pull-requests.png': 'binary',
      'docs/images/repositories.png': 'binary',
    });
    expect(notes(diff([
      file('assets/Logo.PNG', null, { status: 'removed' }),
      // GitHub drops the patch past its size budget, sometimes reporting 0/0 lines.
      file('src/huge.ts', null, { additions: 4200, deletions: 12 }),
      file('src/budget.ts', null),
      file('src/moved.ts', null, { status: 'renamed', previousPath: 'lib/moved.ts' }),
      file('src/moved-and-big.ts', null, { status: 'renamed', previousPath: 'lib/moved-and-big.ts', additions: 3000 }),
    ]))).toEqual({
      'assets/Logo.PNG': 'binary',
      'src/huge.ts': 'unavailable',
      'src/budget.ts': 'unavailable',
      'src/moved.ts': 'renamed',
      'src/moved-and-big.ts': 'unavailable',
    });
  });

  it('starts deleted files and diffs over the size limit folded', () => {
    const patch = '@@ -1 +1 @@\n-a\n+b';
    const folded = (files: DiffFile[]) => Object.fromEntries(buildFiles(diff(files)).map((f) => [f.id, f.folded]));
    expect(folded([
      file('gone.ts', '@@ -1,2 +0,0 @@\n-a\n-b', { status: 'removed', deletions: 2 }),
      file('gone-big.ts', patch, { status: 'removed', deletions: LARGE_FILE_LINES + 1 }),
      file('gone.png', null, { status: 'removed' }),
      file('at-limit.ts', patch, { additions: LARGE_FILE_LINES - 10, deletions: 10 }),
      file('over-limit.ts', patch, { additions: LARGE_FILE_LINES - 10, deletions: 11 }),
      file('new-big.ts', patch, { status: 'added', additions: LARGE_FILE_LINES + 1 }),
      file('no-patch-big.ts', null, { additions: LARGE_FILE_LINES + 1 }),
      file('small.ts', patch, { additions: 1, deletions: 1 }),
    ])).toEqual({
      'gone.ts': 'deleted',
      'gone-big.ts': 'deleted',
      // Nothing to unfold: the header's note says it all.
      'gone.png': null,
      'at-limit.ts': null,
      'over-limit.ts': 'large',
      'new-big.ts': 'large',
      'no-patch-big.ts': null,
      'small.ts': null,
    });
  });

  it("groups files by directory, root first, subdirectories after a directory's own files", () => {
    const files = buildFiles(diff(['web/src/b.ts', 'README.md', 'web/a.ts', 'a-b/x.ts', 'web/src/a.ts', 'a/b/z.ts', 'a/y.ts', 'LICENSE'].map((p) => file(p, null))));
    expect(files.map((f) => [f.dir, f.id])).toEqual([
      ['', 'README.md'],
      ['', 'LICENSE'],
      ['a/', 'a/y.ts'],
      ['a/b/', 'a/b/z.ts'],
      ['a-b/', 'a-b/x.ts'],
      ['web/', 'web/a.ts'],
      // GitHub's order within a directory.
      ['web/src/', 'web/src/b.ts'],
      ['web/src/', 'web/src/a.ts'],
    ]);

    // One run per directory on a real PR.
    const dirs = buildFiles(FIXTURES['sedes-pr-16']).map((f) => f.dir).filter((d, i, all) => d !== all[i - 1]);
    expect(dirs).toEqual([
      '',
      'docs/internals/',
      'docs/operator/',
      'docs/user/',
      'src/client/components/',
      'src/client/components/thread/',
      'src/client/lib/',
      'src/server/application/',
      'src/server/conversations/',
      'src/server/events/',
      'src/shared/protocol/',
      'tests/e2e/',
      'tests/unit/',
    ]);
  });

  it('keys each file by revision and path, and parsing hands the key to Pierre', () => {
    const d = FIXTURES['gh-dash-pr-2'];
    const files = buildFiles(d);
    expect(files[0].cacheKey).toBe(`${d.baseOid}..${d.headOid}:LICENSE`);
    expect(new Set(files.map((f) => f.cacheKey)).size).toBe(files.length);
    // A new head, or the same head on a new merge base, is new content for the same path.
    const keys = [d, { ...d, headOid: 'c'.repeat(40) }, { ...d, baseOid: 'd'.repeat(40) }].map((x) => buildFiles(x)[0].cacheKey);
    expect(new Set(keys).size).toBe(3);

    expect(files.every((f) => f.fileDiff === null)).toBe(true);
    expect(parseFiles(files, 0, Infinity)).toBe(files.length);
    for (const f of files) expect(f.fileDiff?.cacheKey).toBe(f.cacheKey);
  });
});

describe('parseFiles', () => {
  it('parses at least one file per call, stops at `until`, and never replaces a parsed file', () => {
    const files = buildFiles(FIXTURES['sedes-pr-16']);
    expect(parseFiles(files, 0, 0)).toBe(1);
    expect(parseFiles(files, 1, Infinity, 5)).toBe(5);
    expect(files.map((f) => f.fileDiff != null).lastIndexOf(true)).toBe(4);
    const first = files[0].fileDiff;
    parseFiles(files, 0, Infinity);
    expect(files[0].fileDiff).toBe(first);
  });
});

describe('renameParts', () => {
  it('puts the changed part of a rename in braces, git style', () => {
    expect(renameParts('src/old/file.ts', 'src/new/file.ts')).toEqual({ head: 'src/', from: 'old', to: 'new', tail: '/file.ts' });
    expect(renameParts('web/src/a.ts', 'web/src/b.ts')).toEqual({ head: 'web/src/', from: 'a.ts', to: 'b.ts', tail: '' });
    expect(renameParts('lib/x.ts', 'src/lib/x.ts')).toEqual({ head: '', from: 'lib', to: 'src/lib', tail: '/x.ts' });
    expect(renameParts('a.ts', 'b.ts')).toEqual({ head: '', from: 'a.ts', to: 'b.ts', tail: '' });
  });
});
