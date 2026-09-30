// A git unified diff as DiffFiles. Provider-neutral on purpose: the GitHub source reads a compare's files from its
// `.diff` when the JSON lacks patches, and a source that runs `git diff` on a checkout can use the same parser.

import type { DiffFile, DiffFileStatus } from '../../shared/api';

const HEADER = 'diff --git ';
/** What ends a file's block: the newline before the next file's header (no line of a hunk starts with "diff"). */
const NEXT_HEADER = `\n${HEADER}`;

/**
 * The files of `text`, a `git diff` with git's default prefixes (`a/` and `b/`, which is also what GitHub writes; a
 * caller running git itself must not change them) or GitHub's `application/vnd.github.diff`, in the order the diff has
 * them. Each file is what the code hosts' JSON gives: `path` on the new side (the old one for a removed file),
 * `previousPath` for a rename or copy, the `patch` as hunks from the first "@@" line to the last, without the diff's
 * own header lines and without the newline that ends the last line, and additions and deletions counted from those
 * hunks. A file with no hunks (binary, a mode change, a pure rename, an empty file) has a null patch.
 *
 * Lenient, because the text comes from outside: whatever precedes the first "diff --git" line is ignored, header
 * lines it doesn't know are skipped, and a file whose path can't be found is left out. It never throws.
 *
 * Content is kept byte for byte: only the "\n" that ends the last line goes, so a CRLF file's lines keep their "\r".
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  let start = 0;
  if (!text.startsWith(HEADER)) {
    const at = text.indexOf(NEXT_HEADER);
    if (at < 0) return [];
    start = at + 1;
  }
  const files: DiffFile[] = [];
  const last = text.endsWith('\n') ? text.length - 1 : text.length;
  while (start <= last) {
    const next = text.indexOf(NEXT_HEADER, start);
    const file = parseFile(text, start, next < 0 ? last : next);
    if (file) files.push(file);
    if (next < 0) break;
    start = next + 1;
  }
  return files;
}

/** The file whose block is `text[start, end)`: its "diff --git" line, header lines, then hunks; null when it has no path. */
function parseFile(text: string, start: number, end: number): DiffFile | null {
  /** The line at `from`, without its "\n", and where the next one starts. */
  const lineAt = (from: number) => {
    const nl = text.indexOf('\n', from);
    const stop = nl < 0 || nl > end ? end : nl;
    return { line: text.slice(from, stop), next: stop + 1 };
  };
  const first = lineAt(start);
  let pos = first.next;

  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let copyFrom: string | undefined;
  let copyTo: string | undefined;
  let created = false;
  let deleted = false;
  let modeChanged = false;
  let binary = false;
  let hunkStart = -1;
  while (pos <= end) {
    if (text.startsWith('@@', pos)) {
      hunkStart = pos;
      break;
    }
    const { line, next } = lineAt(pos);
    if (line.startsWith('--- ')) oldPath = sidePath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) newPath = sidePath(line.slice(4), 'b/');
    else if (line.startsWith('rename from ')) renameFrom = unquote(line.slice(12));
    else if (line.startsWith('rename to ')) renameTo = unquote(line.slice(10));
    else if (line.startsWith('copy from ')) copyFrom = unquote(line.slice(10));
    else if (line.startsWith('copy to ')) copyTo = unquote(line.slice(8));
    else if (line.startsWith('new file mode ')) created = true;
    else if (line.startsWith('deleted file mode ')) deleted = true;
    else if (line.startsWith('old mode ') || line.startsWith('new mode ')) modeChanged = true;
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      // What follows is the file's encoded contents (or the next file): nothing to read.
      binary = true;
      break;
    }
    pos = next;
  }

  // `null` is "/dev/null": the file has no such side.
  if (oldPath === null) created = true;
  if (newPath === null) deleted = true;
  const path = renameTo ?? copyTo ?? (deleted ? oldPath : newPath) ?? oldPath ?? headerPath(first.line.slice(HEADER.length));
  if (!path) return null;
  const previous = renameFrom ?? copyFrom;
  const status: DiffFileStatus =
    previous !== undefined ? (renameFrom !== undefined ? 'renamed' : 'copied') : deleted ? 'removed' : created ? 'added' : modeChanged && hunkStart < 0 && !binary ? 'changed' : 'modified';
  const patch = hunkStart < 0 ? null : text.slice(hunkStart, end);
  return { path, previousPath: previous ?? null, status, ...countLines(patch), patch };
}

/** Added and removed lines of hunks: what starts with "+" or "-" (a hunk header starts with "@", "\ No newline" with "\"). */
function countLines(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (let pos = 0; patch !== null && pos < patch.length; ) {
    const c = patch.charCodeAt(pos);
    if (c === 43) additions++;
    else if (c === 45) deletions++;
    const nl = patch.indexOf('\n', pos);
    pos = nl < 0 ? patch.length : nl + 1;
  }
  return { additions, deletions };
}

/**
 * A path of a "---" or "+++" line, without the `prefix` its side has ("a/" or "b/"); null for "/dev/null" (no such side)
 * and undefined for a name without the prefix, which isn't one of ours. git ends a name that has a space with a tab, so
 * that tools reading the line can tell where it ends; an unquoted name never has a tab of its own.
 */
function sidePath(raw: string, prefix: string): string | null | undefined {
  const name = raw.startsWith('"') ? (readQuoted(raw, 0)?.value ?? raw) : raw.split('\t', 1)[0]!;
  if (name === '/dev/null') return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}

/**
 * The path of a file whose "diff --git a/OLD b/NEW" line is all that names it (a mode change, an empty or binary file:
 * anything else has "---"/"+++" or rename lines). Both sides are then the same path, so the separating space is the
 * middle character of the unquoted line, whatever spaces the path has; a quoted name can be read outright.
 */
function headerPath(names: string): string | undefined {
  if (names.startsWith('"')) {
    const a = readQuoted(names, 0);
    if (!a) return undefined;
    const rest = names.slice(a.end + 2);
    // Both sides are quoted alike; the new side is the one to report.
    const b = rest.startsWith('"') ? readQuoted(rest, 0)?.value : rest;
    const named = b?.startsWith('b/') ? b : a.value;
    return named.slice(2);
  }
  const mid = (names.length - 1) / 2;
  const oldSide = names.slice(0, mid);
  const newSide = names.slice(mid + 1);
  return names[mid] === ' ' && oldSide.startsWith('a/') && newSide.startsWith('b/') && oldSide.slice(2) === newSide.slice(2) ? newSide.slice(2) : undefined;
}

/** The C-quoted string starting at `s[from]` (a double quote), unescaped, and the index of its closing quote. */
function readQuoted(s: string, from: number): { value: string; end: number } | null {
  for (let i = from + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return { value: unquote(s.slice(from, i + 1)), end: i };
  }
  return null;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A name as git writes one that has characters it quotes (a tab, a quote, a backslash, and bytes over 127 unless
 * core.quotepath is off): in double quotes, with C escapes and three-digit octal for a byte, the bytes being UTF-8.
 * A name without quotes is returned as it is.
 */
function unquote(name: string): string {
  if (name.length < 2 || !name.startsWith('"') || !name.endsWith('"')) return name;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (const m of name.slice(1, -1).matchAll(/\\([0-7]{3}|[abtnvfr"\\])|\\|[^\\]+/g)) {
    const escape = m[1];
    if (escape === undefined) bytes.push(...encoder.encode(m[0]));
    else bytes.push(/^\d/.test(escape) ? parseInt(escape, 8) : ESCAPES[escape]!);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
