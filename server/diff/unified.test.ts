import { describe, expect, it } from 'vitest';
import { hunks } from '../gitlab/patch';
import { parseUnifiedDiff } from './unified';

/** A diff from its lines, ending in the newline git ends its last line with. */
const diff = (...lines: string[]) => `${lines.join('\n')}\n`;

const MODIFIED = diff(
  'diff --git a/src/app.ts b/src/app.ts',
  'index 4cb29ea..6addb9b 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '+four',
  '@@ -20,2 +21,2 @@ function later() {',
  ' keep',
  '-old',
  '+new',
);

describe('parseUnifiedDiff', () => {
  it('reads a modified file: the hunks from the first "@@" without headers or the last newline, counted', () => {
    expect(parseUnifiedDiff(MODIFIED)).toEqual([
      {
        path: 'src/app.ts',
        previousPath: null,
        status: 'modified',
        additions: 3,
        deletions: 2,
        patch: '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n@@ -20,2 +21,2 @@ function later() {\n keep\n-old\n+new',
      },
    ]);
    // The same shape as GitLab's hunks() gives for a file's diff, which the JSON of both hosts follows too.
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file!.patch).toBe(hunks(MODIFIED));
  });

  it('reads several files in order, and does not need the last newline', () => {
    const two = `${MODIFIED}${diff('diff --git a/b.txt b/b.txt', 'index 1..2 100644', '--- a/b.txt', '+++ b/b.txt', '@@ -1 +1 @@', '-x', '+y').slice(0, -1)}`;
    const files = parseUnifiedDiff(two);
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([['src/app.ts', 3, 2], ['b.txt', 1, 1]]);
    expect(files[1]!.patch).toBe('@@ -1 +1 @@\n-x\n+y');
    expect(parseUnifiedDiff(`${two}\n`)[1]!.patch).toBe('@@ -1 +1 @@\n-x\n+y');
  });

  it('reads added and removed files, with their content or without ("--- /dev/null", empty files)', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..d5a09df',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1 @@',
        '+brand new',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        'index c118916..0000000',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-del me',
        '-and me',
        'diff --git a/empty.txt b/empty.txt',
        'new file mode 100644',
        'index 0000000..e69de29',
        'diff --git a/was-empty.txt b/was-empty.txt',
        'deleted file mode 100644',
        'index e69de29..0000000',
      ),
    );
    expect(files).toEqual([
      { path: 'new.txt', previousPath: null, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+brand new' },
      { path: 'gone.txt', previousPath: null, status: 'removed', additions: 0, deletions: 2, patch: '@@ -1,2 +0,0 @@\n-del me\n-and me' },
      { path: 'empty.txt', previousPath: null, status: 'added', additions: 0, deletions: 0, patch: null },
      { path: 'was-empty.txt', previousPath: null, status: 'removed', additions: 0, deletions: 0, patch: null },
    ]);
  });

  it('reads renames and copies, with or without changes, from their own lines', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/old dir/a b.txt b/new dir/a b.txt',
        'similarity index 100%',
        'rename from old dir/a b.txt',
        'rename to new dir/a b.txt',
        'diff --git a/old-name.txt b/new-name.txt',
        'similarity index 80%',
        'rename from old-name.txt',
        'rename to new-name.txt',
        'index adc80cf..945c85a 100644',
        '--- a/old-name.txt',
        '+++ b/new-name.txt',
        '@@ -2,4 +2,4 @@ rename me',
        ' with some',
        '-high enough',
        '+high enough!',
        'diff --git a/orig.txt b/copy.txt',
        'similarity index 88%',
        'copy from orig.txt',
        'copy to copy.txt',
        'index 5e721f9..f91784a 100644',
        '--- a/orig.txt',
        '+++ b/copy.txt',
        '@@ -4,3 +4,4 @@ line c',
        ' line f',
        '+extra',
      ),
    );
    expect(files).toEqual([
      { path: 'new dir/a b.txt', previousPath: 'old dir/a b.txt', status: 'renamed', additions: 0, deletions: 0, patch: null },
      { path: 'new-name.txt', previousPath: 'old-name.txt', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -2,4 +2,4 @@ rename me\n with some\n-high enough\n+high enough!' },
      { path: 'copy.txt', previousPath: 'orig.txt', status: 'copied', additions: 1, deletions: 0, patch: '@@ -4,3 +4,4 @@ line c\n line f\n+extra' },
    ]);
  });

  it('reads a mode change as "changed" with no patch, and a mode change with content as modified', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/tool.sh b/tool.sh',
        'old mode 100644',
        'new mode 100755',
        'index 1..2',
        '--- a/tool.sh',
        '+++ b/tool.sh',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(files).toEqual([
      { path: 'script.sh', previousPath: null, status: 'changed', additions: 0, deletions: 0, patch: null },
      { path: 'tool.sh', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
    ]);
  });

  it('reads binary files (as GitHub and as git --binary write them) without a patch, and goes on to the next file', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/logo.png b/logo.png',
        'index c94be36..c74e00f 100644',
        'Binary files a/logo.png and b/logo.png differ',
        'diff --git a/new.zip b/new.zip',
        'new file mode 100644',
        'index 0000000..adf6411',
        'Binary files /dev/null and b/new.zip differ',
        'diff --git a/data.bin b/data.bin',
        'index c94be360bed0ec4a68f71962ebea3a94282471b1..c74e00f86b76e67e07c5cbca202d9a405c5aa55a 100644',
        'GIT binary patch',
        'literal 11',
        'ScmZQzWJ=1+ODw8nU<LpU#R7}~',
        '',
        'literal 10',
        'RcmZQzWJ=1+ODw8n000X)0*L?s',
        '',
        'diff --git a/gone.bin b/gone.bin',
        'deleted file mode 100644',
        'index c94be36..0000000',
        'GIT binary patch',
        'delta 5',
        '@@@@@',
        '',
        'diff --git a/next.txt b/next.txt',
        'index 1..2 100644',
        '--- a/next.txt',
        '+++ b/next.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect(files.map((f) => [f.path, f.status, f.patch, f.additions, f.deletions])).toEqual([
      ['logo.png', 'modified', null, 0, 0],
      ['new.zip', 'added', null, 0, 0],
      ['data.bin', 'modified', null, 0, 0],
      ['gone.bin', 'removed', null, 0, 0],
      ['next.txt', 'modified', '@@ -1 +1 @@\n-a\n+b', 1, 1],
    ]);
  });

  it('keeps "\\ No newline at end of file" in the patch and out of the counts', () => {
    const [file] = parseUnifiedDiff(
      diff('diff --git a/n.txt b/n.txt', 'index 1..2 100644', '--- a/n.txt', '+++ b/n.txt', '@@ -1 +1 @@', '-no newline', '\\ No newline at end of file', '+no newline!', '\\ No newline at end of file'),
    );
    expect(file).toMatchObject({ additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-no newline\n\\ No newline at end of file\n+no newline!\n\\ No newline at end of file' });
  });

  it('keeps the "\\r" of CRLF content lines, the last one included, and counts them', () => {
    const [file] = parseUnifiedDiff(
      diff('diff --git a/crlf.txt b/crlf.txt', 'index 1..2 100644', '--- a/crlf.txt', '+++ b/crlf.txt', '@@ -1,2 +1,3 @@', ' crlf1\r', '-crlf2\r', '+CRLF2\r', '+new\r'),
    );
    expect(file).toMatchObject({ additions: 2, deletions: 1, patch: '@@ -1,2 +1,3 @@\n crlf1\r\n-crlf2\r\n+CRLF2\r\n+new\r' });
  });

  it('counts lines that look like headers: a removed "-- x" is a deletion, an added "++ x" an addition', () => {
    const [file] = parseUnifiedDiff(
      diff('diff --git a/q.sql b/q.sql', 'index 1..2 100644', '--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,2 @@', '--- a comment', '+-- b comment', '+++ counter', ' same'),
    );
    expect(file).toMatchObject({ additions: 2, deletions: 1 });
    expect(file!.patch).toBe('@@ -1,2 +1,2 @@\n--- a comment\n+-- b comment\n+++ counter\n same');
  });

  it('does not take lines of a hunk for a file header, even those that look like one', () => {
    // A patch file that is itself changed: every one of its lines has a prefix in this diff.
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/x.patch b/x.patch',
        'index 1..2 100644',
        '--- a/x.patch',
        '+++ b/x.patch',
        '@@ -1,3 +1,3 @@',
        ' diff --git a/y b/y',
        '-@@ -1 +1 @@',
        '+@@ -2 +2 @@',
        ' +++ b/y',
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'x.patch', additions: 1, deletions: 1 });
  });

  it('finds paths with spaces, from "+++"/"---" (which git ends with a tab), rename lines or the header itself', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git a/dir with space/inner file.txt b/dir with space/inner file.txt',
        'new file mode 100644',
        'index 0000000..d2cebd4',
        '--- /dev/null',
        '+++ b/dir with space/inner file.txt\t',
        '@@ -0,0 +1 @@',
        '+in dir',
        'diff --git a/sp ace.txt b/sp ace.txt',
        'index 2fa992c..fe5841d 100644',
        '--- a/sp ace.txt\t',
        '+++ b/sp ace.txt\t',
        '@@ -1 +1,2 @@',
        ' keep',
        '+more',
        'diff --git a/a b/c d.txt b/a b/c d.txt',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/spaces only.txt b/spaces only.txt',
        'new file mode 100644',
        'index 0000000..e69de29',
        'diff --git a/gone file.txt b/gone file.txt',
        'deleted file mode 100644',
        'index e69de29..0000000',
      ),
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['dir with space/inner file.txt', 'added'],
      ['sp ace.txt', 'modified'],
      ['a b/c d.txt', 'changed'],
      ['spaces only.txt', 'added'],
      ['gone file.txt', 'removed'],
    ]);
  });

  it('unquotes git\'s C-quoted paths: escapes, quotes, tabs and octal bytes of UTF-8 names', () => {
    const files = parseUnifiedDiff(
      diff(
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        'new file mode 100644',
        'index 0000000..aee5fdc',
        '--- /dev/null',
        '+++ "b/caf\\303\\251.txt"',
        '@@ -0,0 +1 @@',
        '+x',
        'diff --git "a/quo\\"te.txt" "b/quo\\"te.txt"',
        'index bca70f3..92812c3 100644',
        '--- "a/quo\\"te.txt"',
        '+++ "b/quo\\"te.txt"',
        '@@ -1 +1,2 @@',
        ' q',
        '+q2',
        'diff --git "a/ta\\tb\\\\c.txt" "b/ta\\tb\\\\c.txt"',
        'old mode 100644',
        'new mode 100755',
        'diff --git "a/sp ace/\\346\\227\\245\\346\\234\\254.txt" "b/sp ace/\\346\\227\\245\\346\\234\\254.txt"',
        'new file mode 100644',
        'index 0000000..e69de29',
        'diff --git "a/old \\303\\266.txt" "b/new \\303\\266.txt"',
        'similarity index 100%',
        'rename from "old \\303\\266.txt"',
        'rename to "new \\303\\266.txt"',
        'diff --git a/plain.txt "b/quoted\\001.txt"',
        'similarity index 100%',
        'rename from plain.txt',
        'rename to "quoted\\001.txt"',
      ),
    );
    expect(files.map((f) => [f.path, f.previousPath])).toEqual([
      ['café.txt', null],
      ['quo"te.txt', null],
      ['ta\tb\\c.txt', null],
      ['sp ace/日本.txt', null],
      ['new ö.txt', 'old ö.txt'],
      ['quoted\u0001.txt', 'plain.txt'],
    ]);
  });

  it('reads names git left unquoted (core.quotepath off) as they are', () => {
    const [file] = parseUnifiedDiff(diff('diff --git a/smörgås.txt b/smörgås.txt', 'new file mode 100644', 'index 0000000..7898192', '--- /dev/null', '+++ b/smörgås.txt', '@@ -0,0 +1 @@', '+a'));
    expect(file).toMatchObject({ path: 'smörgås.txt', status: 'added' });
  });

  it('ignores what precedes the first file header, and finds nothing in text that has none', () => {
    expect(parseUnifiedDiff(`warning: something\nfrom git\n${MODIFIED}`).map((f) => f.path)).toEqual(['src/app.ts']);
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n')).toEqual([]);
    expect(parseUnifiedDiff('not a diff\nat all\n')).toEqual([]);
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([]);
  });

  it('leaves out a file it cannot name (other prefixes) and reads the rest', () => {
    const files = parseUnifiedDiff(
      diff('diff --git i/x.txt w/x.txt', 'index 1..2 100644', '--- i/x.txt', '+++ w/x.txt', '@@ -1 +1 @@', '-a', '+b', 'diff --git a/y.txt b/y.txt', 'index 1..2 100644', '--- a/y.txt', '+++ b/y.txt', '@@ -1 +1 @@', '-a', '+b'),
    );
    expect(files.map((f) => f.path)).toEqual(['y.txt']);
  });

  it('reads a large diff quickly', () => {
    const block = (i: number) => diff(`diff --git a/f${i}.ts b/f${i}.ts`, 'index 1..2 100644', `--- a/f${i}.ts`, `+++ b/f${i}.ts`, '@@ -1,3 +1,3 @@', ' a', '-b', '+c', ' d');
    const text = Array.from({ length: 20_000 }, (_, i) => block(i)).join('');
    const started = performance.now();
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(20_000);
    expect(files[19_999]).toMatchObject({ path: 'f19999.ts', additions: 1, deletions: 1 });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
