import type { FileDiffMetadata } from '@pierre/diffs';
import type { CommentSide, CommentThread } from '../../../shared/api';
import type { ThreadPlacement } from '../../../shared/comment-placement';
import type { LineRange, LineShown } from './threadModel';

type Range = Pick<LineRange, 'side' | 'startLine' | 'endLine'>;
export type FileFolds = { hide: Range[]; keep: Range[] };
const contains = (r: Range, side: CommentSide, line: number) => r.side === side && r.startLine <= line && line <= r.endLine;

/** Exact placed ranges remain attached to the revision, even when their rendered rows fold. */
export function resolvedFolds(
  threads: readonly CommentThread[], placements: ReadonlyMap<number, ThreadPlacement>,
  expanded: (thread: CommentThread) => boolean, shown: LineShown, draft: LineRange | null,
) {
  const files = new Map<string, FileFolds>();
  const ranges = new Map<number, ThreadPlacement & { kind: 'line' }>();
  const forPath = (path: string) => {
    let f = files.get(path);
    if (!f) files.set(path, f = { hide: [], keep: [] });
    return f;
  };
  for (const thread of threads) {
    const at = placements.get(thread.id);
    if (at?.kind !== 'line') continue;
    const f = forPath(at.path);
    const { side, startLine, endLine } = at;
    if (thread.status === 'resolved' && !expanded(thread)) {
      // File-level notes stay at the top, even if a quick context expansion reveals their anchor.
      // Fold rows only when the inline thread is there to expand them again.
      if (!shown(at.path, side, endLine)) continue;
      f.hide.push({ side, startLine, endLine });
      ranges.set(thread.id, at);
    } else f.keep.push({ side, startLine, endLine });
  }
  if (draft && files.has(draft.path)) forPath(draft.path).keep.push(draft);
  for (const [path, f] of files) if (!f.hide.length) files.delete(path);
  return { files, ranges };
}

function rowFolds(folds: FileFolds, old: number, next: number): boolean {
  const matches = (r: Range) => contains(r, 'old', old) || contains(r, 'new', next);
  return folds.hide.some(matches) && !folds.keep.some(matches);
}

/** The icon on an inline title describes code it actually folds, including context shared between both sides. */
export function hasFoldedCode(diff: FileDiffMetadata, folds: FileFolds, at: Range): boolean {
  for (const hunk of diff.hunks) {
    let old = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
    let next = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
    for (const block of hunk.hunkContent) {
      const oldCount = block.type === 'context' ? block.lines : block.deletions;
      const nextCount = block.type === 'context' ? block.lines : block.additions;
      const [start, size] = at.side === 'old' ? [old, oldCount] : [next, nextCount];
      if (start > at.endLine) return false;
      const first = Math.max(0, at.startLine - start);
      const last = Math.min(size - 1, at.endLine - start);
      for (let i = first; i <= last; i++) {
        const oldLine = block.type === 'context' || at.side === 'old' ? old + i : 0;
        const nextLine = block.type === 'context' || at.side === 'new' ? next + i : 0;
        if (rowFolds(folds, oldLine, nextLine)) return true;
      }
      old += oldCount;
      next += nextCount;
    }
  }
  return false;
}

interface Cell {
  node: HTMLElement;
  gutter: HTMLElement | undefined;
  line: number;
  side: CommentSide;
  context: boolean;
  alternate: number;
}

interface Buffer { node: HTMLElement; start: number; size: number }

/**
 * Pierre keeps indexed grid rows for the old and new sides and measures their heights for virtualization. A zero-height
 * row keeps that index and leaves its annotation in place. When only one split cell folds, the other stays readable.
 */
export function paintResolvedFolds(root: ShadowRoot, folds: FileFolds | undefined): boolean {
  const hadFolds = root.querySelector('[data-resolved-fold]') !== null;
  for (const node of root.querySelectorAll<HTMLElement>('[data-resolved-fold], [data-resolved-buffer]')) {
    node.removeAttribute('data-resolved-fold');
    if (node.hasAttribute('data-resolved-buffer')) {
      node.removeAttribute('data-resolved-buffer');
      node.style.removeProperty('--dvr-visible-buffer-lines');
    }
  }
  if (!folds) return hadFolds;
  const rows = new Map<number, Cell[]>();
  const buffers: Buffer[] = [];
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    const content = code.querySelector('[data-content]');
    const gutter = code.querySelector('[data-gutter]');
    if (!content || !gutter) continue;
    const gutterLines = new Map([...gutter.querySelectorAll<HTMLElement>('[data-column-number]')].map((n) => [n.dataset.lineIndex, n]));
    let index = 0;
    for (const node of content.children) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.dataset.line) {
        const line = Number(node.dataset.line);
        const side = code.hasAttribute('data-deletions') || node.dataset.lineType === 'change-deletion' ? 'old' : 'new';
        const context = node.dataset.lineType === 'context' || node.dataset.lineType === 'context-expanded';
        const alternate = context && !code.hasAttribute('data-deletions') && !code.hasAttribute('data-additions') ? Number(node.dataset.altLine) : NaN;
        let row = rows.get(index);
        if (!row) rows.set(index, row = []);
        row.push({ node, gutter: gutterLines.get(node.dataset.lineIndex), line, side, context, alternate });
      }
      const size = Number(node.dataset.bufferSize ?? 1);
      if (node.hasAttribute('data-content-buffer')) buffers.push({ node, start: index, size });
      index += size;
    }
    index = 0;
    for (const node of gutter.children) {
      if (!(node instanceof HTMLElement) || node.hasAttribute('data-gutter-utility-slot')) continue;
      const size = Number(node.dataset.bufferSize ?? 1);
      if (node.dataset.gutterBuffer === 'buffer') buffers.push({ node, start: index, size });
      index += size;
    }
  }
  const whole = new Set<number>();
  let changed = false;
  for (const [index, row] of rows) {
    const hidden = row[0]!.context
      ? rowFolds(folds, row.find((c) => c.side === 'old')?.line ?? row[0]!.alternate, row.find((c) => c.side === 'new')?.line ?? 0) ? row : []
      : row.filter((c) => rowFolds(folds, c.side === 'old' ? c.line : 0, c.side === 'new' ? c.line : 0));
    if (!hidden.length) continue;
    const hideRow = hidden.length === row.length;
    if (hideRow) whole.add(index);
    for (const { node, gutter } of hidden) {
      node.dataset.resolvedFold = hideRow ? 'row' : 'side';
      if (gutter) gutter.dataset.resolvedFold = node.dataset.resolvedFold;
    }
    changed = true;
  }
  for (const { node, start, size } of buffers) {
    let remaining = size;
    for (let i = start; i < start + size; i++) if (whole.has(i)) remaining--;
    if (remaining === size) continue;
    node.dataset.resolvedBuffer = '';
    node.style.setProperty('--dvr-visible-buffer-lines', String(remaining));
  }
  return changed || hadFolds;
}
