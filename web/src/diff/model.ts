/**
 * Diff → viewer model: parses GitHub's per-file patches into @pierre/diffs metadata, decides what
 * to say for files without a patch, and orders files the way the file list groups them.
 */
import { processFile, type FileDiffMetadata } from '@pierre/diffs';
import type { Diff, DiffFile } from '../../../shared/api';

/** Why a file has no diff body. */
export type FileNote = 'binary' | 'renamed' | 'unavailable' | null;

export interface ViewerFile {
  /** CodeView item id; paths are unique within a diff. */
  id: string;
  file: DiffFile;
  /** Identifies the highlighted result in the worker pool's cache: same diff, same file, same tokens. */
  cacheKey: string;
  /**
   * Parsed patch; null until parseFiles reaches this file. Stable once set: Pierre hydrates it in
   * place when context is expanded.
   */
  fileDiff: FileDiffMetadata | null;
  note: FileNote;
  /** Directory group in the file list ('' for the repository root). */
  dir: string;
  /**
   * Starts collapsed: deleted files (the header says it all; mass deletions would bury the rest) and
   * very long diffs (slow, and rarely read line by line).
   */
  folded: 'deleted' | 'large' | null;
}

/** Changed lines above which a file starts collapsed. */
export const LARGE_FILE_LINES = 1000;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|mp3|mp4|m4a|mov|webm|ogg|wav|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|jar|wasm|exe|dll|so|dylib|a|o|class|pyc|bin|dat|db|sqlite3?)$/i;

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * GitHub omits the patch for binary files, very large diffs and, on big PRs, files past its size
 * budget (those can even report 0/0 lines), so only a pure rename or a binary extension is certain.
 */
function noteFor(f: DiffFile): FileNote {
  if (f.patch != null) return null;
  if (f.status === 'renamed' && f.additions + f.deletions === 0) return 'renamed';
  return BINARY_EXT.test(f.path) ? 'binary' : 'unavailable';
}

/**
 * GitHub's patches start at the first "@@" with no file headers, and Pierre's parser needs them
 * (without one it takes the first hunk for the header). Placeholder names are enough: the name,
 * old name and change type are set from the API's fields afterwards.
 */
export function toFileDiff(f: DiffFile, cacheKey?: string): FileDiffMetadata {
  // isGitDiff spares Pierre a regex scan of the whole patch to find out.
  const parsed = f.patch ? processFile(`--- a\n+++ b\n${f.patch}\n`, { isGitDiff: false, cacheKey }) : undefined;
  const fd: FileDiffMetadata = parsed ?? {
    name: f.path, type: 'change', hunks: [], splitLineCount: 0, unifiedLineCount: 0, isPartial: true, deletionLines: [], additionLines: [],
  };
  fd.name = f.path;
  fd.prevName = f.previousPath ?? undefined;
  fd.type = f.status === 'added' ? 'new'
    : f.status === 'removed' ? 'deleted'
    : f.status === 'renamed' ? (fd.hunks.length ? 'rename-changed' : 'rename-pure')
    : 'change';
  return fd;
}

/** Compares directory paths segment by segment, so "a/" sorts before "a/b/" and "a-b/". */
function compareDirs(a: string, b: string): number {
  const as = a.split('/'), bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return as[i] === '' ? -1 : bs[i] === '' ? 1 : as[i] < bs[i] ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Files in file-list order: grouped by directory (root first, a directory's own files before its
 * subdirectories), GitHub's order within a directory. The diffs scroll in the same order, so j/k
 * and the list never disagree.
 */
export function buildFiles(diff: Diff): ViewerFile[] {
  const files = diff.files.map((file): ViewerFile => ({
    id: file.path,
    file,
    cacheKey: `${diff.baseOid}..${diff.headOid}:${file.path}`,
    fileDiff: null,
    note: noteFor(file),
    dir: dirOf(file.path),
    folded: file.patch == null ? null : file.status === 'removed' ? 'deleted' : file.additions + file.deletions > LARGE_FILE_LINES ? 'large' : null,
  }));
  const order = new Map(files.map((f, i) => [f, i]));
  return files.sort((a, b) => compareDirs(a.dir, b.dir) || order.get(a)! - order.get(b)!);
}

/**
 * Parses files[from..] in order until `budgetMs` has passed (at least one file); returns the index
 * after the last parsed file. A 1,700-file PR has ~10 MB of patches, about half a second of parsing.
 */
export function parseFiles(files: ViewerFile[], from: number, budgetMs: number, until = files.length): number {
  const end = performance.now() + budgetMs;
  let i = from;
  while (i < Math.min(until, files.length) && (i === from || performance.now() < end)) {
    files[i].fileDiff ??= toFileDiff(files[i].file, files[i].cacheKey);
    i++;
  }
  return i;
}

/**
 * A rename as one path with the changed part in braces, the way git prints it:
 * "src/{old → new}/file.ts". Falls back to "old → new" when nothing is shared.
 */
export function renameParts(from: string, to: string): { head: string; from: string; to: string; tail: string } {
  const a = from.split('/'), b = to.split('/');
  let pre = 0;
  while (pre < a.length - 1 && pre < b.length - 1 && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre - 1 && post < b.length - pre - 1 && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const head = a.slice(0, pre).join('/');
  const tail = a.slice(a.length - post).join('/');
  return {
    head: head ? `${head}/` : '',
    from: a.slice(pre, a.length - post).join('/'),
    to: b.slice(pre, b.length - post).join('/'),
    tail: tail ? `/${tail}` : '',
  };
}
