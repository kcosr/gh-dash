/**
 * Where comment threads belong in a diff. Pure (no DOM, no I/O): the diff viewer runs it in the browser, and a
 * server-side agent interface can run it on the same Diff.
 *
 * Rules:
 *  - A PR- or commit-level thread belongs to the whole diff.
 *  - A file or line thread needs its file (by DiffFile.path) in the diff; if the file is gone it is outdated.
 *  - Commit threads never go stale: a commit's diff never changes, so lines stay where they were made.
 *  - A PR line thread made on the diff's revision stays at its lines: same head for the new side, same head and merge
 *    base for the old side (the base branch can move the merge base under an unchanged head).
 *  - Otherwise it is relocated by its snippet: the lines must appear, exactly and consecutively, on the same side
 *    of the file's current patch. Of several matches the nearest to the original start line wins (the earlier one on a
 *    tie). A blank snippet (empty or whitespace-only lines) would match any blank line, so it is never relocated.
 *    Without a match, the thread is outdated.
 */
import type { CommentSide, CommentThread, Diff, DiffFile } from './api';

/** The thread fields placement reads. */
export type PlaceableThread = Pick<CommentThread, 'kind' | 'commitOid' | 'baseOid' | 'path' | 'side' | 'startLine' | 'endLine' | 'snippet'>;

/** The diff fields placement reads. */
export type PlacementDiff = Pick<Diff, 'headOid' | 'baseOid'> & { files: Pick<DiffFile, 'path' | 'patch'>[] };

/** `file`: the file isn't in this diff; `lines`: the file is, but the thread's lines aren't in its patch. */
export type OutdatedReason = 'file' | 'lines';

export type ThreadPlacement =
  /** A PR- or commit-level thread. */
  | { kind: 'target' }
  | { kind: 'file'; path: string }
  /** `relocated`: made on another revision and found again by its snippet (the lines may have moved). */
  | { kind: 'line'; path: string; side: CommentSide; startLine: number; endLine: number; relocated: boolean }
  | { kind: 'outdated'; path: string; reason: OutdatedReason };

/** One side of a patch: line number → text, for the lines the patch shows (hunk lines and their context). */
export type SideLines = ReadonlyMap<number, string>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Line text without a CRLF file's carriage return, so patches and full file contents compare alike. */
const text = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** One row of a patch as a unified diff shows it: a context line has both numbers, a change one. */
export interface PatchRow {
  old: number | null;
  new: number | null;
  text: string;
}

/**
 * The rows of a unified-diff patch (DiffFile.patch: hunks from the first "@@"), in order. Hunk headers' counts decide
 * what belongs to a hunk; a context line whose leading space was stripped (an empty line) still counts.
 */
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let o = 0, n = 0, oldLeft = 0, newLeft = 0;
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      o = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      n = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    // "\ No newline at end of file", or anything past a hunk's counts.
    if (line.startsWith('\\') || (oldLeft <= 0 && newLeft <= 0)) continue;
    const mark = line[0];
    const t = text(line.slice(1));
    if (mark === '+') {
      rows.push({ old: null, new: n++, text: t });
      newLeft--;
    } else if (mark === '-') {
      rows.push({ old: o++, new: null, text: t });
      oldLeft--;
    } else {
      rows.push({ old: o++, new: n++, text: t });
      oldLeft--;
      newLeft--;
    }
  }
  return rows;
}

/** The old and new side lines of a patch (see patchRows). */
export function patchLines(patch: string): { old: SideLines; new: SideLines } {
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  for (const r of patchRows(patch)) {
    if (r.old !== null) oldLines.set(r.old, r.text);
    if (r.new !== null) newLines.set(r.new, r.text);
  }
  return { old: oldLines, new: newLines };
}

/** The snippet for lines start..end (inclusive) of a side, as a new thread records it; null if any line is missing. */
export function snippetOf(lines: SideLines, start: number, end: number): string | null {
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const line = lines.get(i);
    if (line === undefined) return null;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Start line of the snippet's exact, consecutive occurrence in `lines` nearest to `near` (the earlier on a tie);
 * null when it doesn't occur, or when every line of it is blank.
 */
export function findSnippet(lines: SideLines, snippet: string, near: number): number | null {
  const want = snippet.split('\n').map(text);
  if (want.every((l) => l.trim() === '')) return null;
  let best: number | null = null;
  for (const [start, first] of lines) {
    if (first !== want[0]) continue;
    let k = 1;
    while (k < want.length && lines.get(start + k) === want[k]) k++;
    if (k < want.length) continue;
    const d = Math.abs(start - near);
    if (best === null || d < Math.abs(best - near) || (d === Math.abs(best - near) && start < best)) best = start;
  }
  return best;
}

/** A placement function for one diff; each file's patch is parsed once, when a thread first needs it. */
export function createPlacer(diff: PlacementDiff): (thread: PlaceableThread) => ThreadPlacement {
  const files = new Map(diff.files.map((f) => [f.path, f]));
  const parsed = new Map<string, { old: SideLines; new: SideLines } | null>();
  const sidesOf = (path: string) => {
    if (!parsed.has(path)) {
      const patch = files.get(path)?.patch;
      parsed.set(path, patch == null ? null : patchLines(patch));
    }
    return parsed.get(path)!;
  };

  return (t) => {
    if (t.path === null) return { kind: 'target' };
    const path = t.path;
    if (!files.has(path)) return { kind: 'outdated', path, reason: 'file' };
    if (t.side === null || t.startLine === null || t.endLine === null) return { kind: 'file', path };
    const side = t.side;
    const sameRevision = t.kind === 'commit' || (t.commitOid === diff.headOid && (side === 'new' || t.baseOid === diff.baseOid));
    if (sameRevision) return { kind: 'line', path, side, startLine: t.startLine, endLine: t.endLine, relocated: false };
    const lines = sidesOf(path)?.[side];
    const start = lines && t.snippet !== null ? findSnippet(lines, t.snippet, t.startLine) : null;
    if (start === null) return { kind: 'outdated', path, reason: 'lines' };
    return { kind: 'line', path, side, startLine: start, endLine: start + (t.endLine - t.startLine), relocated: true };
  };
}

/** Placement of every thread in `diff`, by thread id. */
export function placeThreads<T extends PlaceableThread & { id: number }>(threads: readonly T[], diff: PlacementDiff): Map<number, ThreadPlacement> {
  const place = createPlacer(diff);
  return new Map(threads.map((t) => [t.id, place(t)]));
}
