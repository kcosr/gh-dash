/**
 * Threads → what the viewer shows: per-file annotations (Pierre's), thread counts for the file list, and the order
 * n/p step through. Pure, so it's tested without a browser (shared/diff-threads.test.ts).
 */
import type { DiffLineAnnotation } from '@pierre/diffs';
import type { CommentCounts, CommentSide, CommentThread } from '../../../shared/api';
import { patchLines, patchRows, type PlaceableThread, type SideLines, snippetOf, type ThreadPlacement } from '../../../shared/comment-placement';

/** What one annotation carries: threads ending on a line, a file's own and outdated threads, or the new-thread composer. */
export type Note =
  | { kind: 'threads'; ids: number[] }
  /** `draft`: the composer is here too (its lines aren't on screen: see DraftSpot). */
  | { kind: 'file'; ids: number[]; outdated: number[]; draft: boolean }
  | { kind: 'draft' };

/** Pierre's name for a side. */
export const pierreSide = (side: CommentSide) => (side === 'old' ? 'deletions' : 'additions');

/** Lines on one side of one file. */
export interface LineRange {
  path: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
}

/**
 * A new thread being written: the lines it was started on, with the revision (the diff's head and base then) and
 * their text. It's submitted as that, so it records the code the reader saw even if the diff moved on meanwhile (a
 * push, then a refresh or a reload); placement then finds it again or marks it outdated, as for any thread.
 */
export interface DraftAnchor extends LineRange {
  commitOid: string;
  baseOid: string | null;
  snippet: string;
}

/**
 * Where a draft's composer shows in the diff on screen: under its lines (`relocated` when a later push moved them),
 * or at its file's top: when its lines changed since it was started (`outdated`), or when the diff doesn't show them
 * (`hidden`: expanded context, which a reload folds away again, and Pierre draws nothing on lines it doesn't show).
 * null when its file left the diff.
 */
export type DraftSpot =
  | { at: 'line'; side: CommentSide; startLine: number; endLine: number; relocated: boolean }
  | { at: 'file'; why: 'outdated' | 'hidden' }
  | null;

/** `visible`: whether the diff on screen shows a line of the draft's file. */
export function draftSpot(
  d: DraftAnchor,
  kind: 'pr' | 'commit',
  place: (t: PlaceableThread) => ThreadPlacement,
  visible: (side: CommentSide, line: number) => boolean,
): DraftSpot {
  const p = place({ kind, commitOid: d.commitOid, baseOid: d.baseOid, path: d.path, side: d.side, startLine: d.startLine, endLine: d.endLine, snippet: d.snippet });
  if (p.kind === 'line') {
    if (!visible(p.side, p.endLine)) return { at: 'file', why: 'hidden' };
    return { at: 'line', side: p.side, startLine: p.startLine, endLine: p.endLine, relocated: p.relocated };
  }
  return p.kind === 'outdated' && p.reason === 'lines' ? { at: 'file', why: 'outdated' } : null;
}

export interface FileNotes {
  /** Line threads, grouped by the line they end on (where they show), in line order. */
  lines: { side: CommentSide; line: number; ids: number[] }[];
  /** File-level threads. */
  file: number[];
  outdated: number[];
  /**
   * Threads on lines the patch doesn't show (made on expanded context). Pierre renders no annotation there until the
   * context is expanded, so they show at the file's top with their snippet.
   */
  hidden: number[];
}

/** Whether the file's patch shows a line (Pierre renders annotations only on lines it renders). */
export type LineShown = (path: string, side: CommentSide, line: number) => boolean;

/** Placed threads per file path (DiffFile.path, the viewer's item id). */
export function notesByFile(threads: readonly CommentThread[], placements: ReadonlyMap<number, ThreadPlacement>, shown: LineShown): Map<string, FileNotes> {
  const out = new Map<string, FileNotes>();
  const of = (path: string) => {
    let n = out.get(path);
    if (!n) out.set(path, (n = { lines: [], file: [], outdated: [], hidden: [] }));
    return n;
  };
  for (const t of threads) {
    const p = placements.get(t.id);
    if (!p || p.kind === 'target' || (p.kind === 'outdated' && p.reason === 'file')) continue;
    if (p.kind === 'file') of(p.path).file.push(t.id);
    else if (p.kind === 'outdated') of(p.path).outdated.push(t.id);
    else if (!shown(p.path, p.side, p.endLine)) of(p.path).hidden.push(t.id);
    else {
      const n = of(p.path);
      const at = n.lines.find((l) => l.side === p.side && l.line === p.endLine);
      if (at) at.ids.push(t.id);
      else n.lines.push({ side: p.side, line: p.endLine, ids: [t.id] });
    }
  }
  // Pierre keys annotation wrappers by position: a stable order keeps each thread's component (and its state) put.
  for (const n of out.values()) n.lines.sort((a, b) => a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1));
  return out;
}

/**
 * Pierre annotations for a file: its notes and, when it's this file's, the composer: under its lines (last, after any
 * thread on the line), or in the file's top block. `fileSide`: the side a file-level block goes on (Pierre shows none
 * on the missing side of an added or deleted file).
 */
export function annotationsFor(notes: FileNotes | undefined, draft: DraftSpot, fileSide: 'deletions' | 'additions'): DiffLineAnnotation<Note>[] {
  const out: DiffLineAnnotation<Note>[] = [];
  const atTop = draft?.at === 'file';
  if (atTop || (notes && (notes.file.length || notes.outdated.length || notes.hidden.length))) {
    out.push({ side: fileSide, lineNumber: 0, metadata: { kind: 'file', ids: [...(notes?.file ?? []), ...(notes?.hidden ?? [])], outdated: notes?.outdated ?? [], draft: atTop } });
  }
  for (const l of notes?.lines ?? []) out.push({ side: pierreSide(l.side), lineNumber: l.line, metadata: { kind: 'threads', ids: l.ids } });
  if (draft?.at === 'line') out.push({ side: pierreSide(draft.side), lineNumber: draft.endLine, metadata: { kind: 'draft' } });
  return out;
}

/** Thread counts per file, for the file list (outdated threads count for their file). */
export function countsByFile(threads: readonly CommentThread[], placements: ReadonlyMap<number, ThreadPlacement>): Map<string, CommentCounts> {
  const out = new Map<string, CommentCounts>();
  for (const t of threads) {
    const p = placements.get(t.id);
    if (!p || p.kind === 'target' || (p.kind === 'outdated' && p.reason === 'file')) continue;
    const c = out.get(p.path) ?? { threads: 0, unresolved: 0 };
    out.set(p.path, { threads: c.threads + 1, unresolved: c.unresolved + (t.status === 'open' ? 1 : 0) });
  }
  return out;
}

/**
 * Every thread in reading order: general ones first (the column's Conversation), then file by file in file-list
 * order (the file's own and outdated threads at its top, then lines), then those whose file left the diff.
 */
export function readingOrder(threads: readonly CommentThread[], placements: ReadonlyMap<number, ThreadPlacement>, fileIndex: ReadonlyMap<string, number>): CommentThread[] {
  const rank = (t: CommentThread): [number, number, number] => {
    const p = placements.get(t.id);
    if (!p || p.kind === 'target') return [0, 0, 0];
    if (p.kind === 'outdated' && p.reason === 'file') return [2, 0, 0];
    const file = fileIndex.get(p.path) ?? Number.MAX_SAFE_INTEGER;
    return [1, file, p.kind === 'line' ? p.startLine : 0];
  };
  return threads
    .map((t) => ({ t, r: rank(t) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.t.id - b.t.id)
    .map((x) => x.t);
}

/**
 * The unresolved thread n (dir 1) or p (dir -1) goes to, in reading order: the next open one after the focused
 * thread (resolved or not); with none focused, the first open one at or after the file in view (p: the last before
 * it). `fileRankOf` ranks a thread by its file's place in the list. null when there's none that way.
 */
export function stepThread(order: readonly { id: number; open: boolean }[], focused: number | null, dir: 1 | -1, fileRankOf: (id: number) => number, currentFileRank: number): number | null {
  const at = focused === null ? -1 : order.findIndex((t) => t.id === focused);
  if (at >= 0) {
    for (let i = at + dir; i >= 0 && i < order.length; i += dir) if (order[i]!.open) return order[i]!.id;
    return null;
  }
  const open = order.filter((t) => t.open);
  const hit = dir === 1 ? open.find((t) => fileRankOf(t.id) >= currentFileRank) : open.findLast((t) => fileRankOf(t.id) < currentFileRank);
  return hit?.id ?? null;
}

/**
 * The snippet a new thread records: from the patch when it shows every line, else from the file's full contents
 * (loaded when context was expanded). null when neither has them.
 */
export function draftSnippet(patch: string | null, contents: { old: string[] | null; new: string[] | null } | undefined, a: LineRange): string | null {
  if (patch) {
    const lines: SideLines = patchLines(patch)[a.side];
    const s = snippetOf(lines, a.startLine, a.endLine);
    if (s !== null) return s;
  }
  const full = contents?.[a.side];
  if (!full || a.endLine > full.length) return null;
  return full.slice(a.startLine - 1, a.endLine).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).join('\n');
}

/** Pierre's selection (or gutter drag): lines on one side, not normalized, possibly across sides. */
export interface PierreRange {
  start: number;
  end: number;
  side?: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

/**
 * The lines a selection anchors a new thread to. One side: its lines, in order. Across sides (a unified view's
 * deletions into additions, or back): the end's side, over that side's lines among the rows between the two ends;
 * when either end isn't in the patch (expanded context), just the end line.
 */
export function selectionAnchor(path: string, patch: string | null, r: PierreRange): LineRange {
  const startSide = r.side ?? 'additions';
  const endSide = r.endSide ?? startSide;
  const side: CommentSide = endSide === 'deletions' ? 'old' : 'new';
  if (startSide === endSide) return { path, side, startLine: Math.min(r.start, r.end), endLine: Math.max(r.start, r.end) };
  const rows = patch ? patchRows(patch) : [];
  const key = (s: 'deletions' | 'additions') => (s === 'deletions' ? 'old' : 'new');
  const i = rows.findIndex((row) => row[key(startSide)] === r.start);
  const j = rows.findIndex((row) => row[key(endSide)] === r.end);
  const lines = i < 0 || j < 0 ? [] : rows.slice(Math.min(i, j), Math.max(i, j) + 1).map((row) => row[side]).filter((n): n is number => n !== null);
  // Rows run in line order on each side, so the first and last are the range.
  return lines.length ? { path, side, startLine: lines[0]!, endLine: lines[lines.length - 1]! } : { path, side, startLine: r.end, endLine: r.end };
}
