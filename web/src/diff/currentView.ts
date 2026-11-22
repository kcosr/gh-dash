import type { Hunk } from '@pierre/diffs';
import { MAX_VIEW_RANGES, MAX_VIEW_SELECTION_CHARS } from '../../../shared/api';
import type { CurrentView } from '../../../shared/current-view';

export type DiffViewContext = Pick<CurrentView, 'file' | 'viewport' | 'selection' | 'threadId'>;
type Viewport = NonNullable<DiffViewContext['viewport']>;
type TextSelection = Extract<DiffViewContext['selection'], { kind: 'text' }>;
type Side = Viewport['first']['side'];

export interface RenderedDiff {
  path: string;
  root: ShadowRoot;
}

const CODE_ROWS = '[data-line][data-line-type]:not([data-resolved-fold])';

function codeLine(row: HTMLElement): Viewport['first'] | null {
  const lineNumber = Number(row.dataset.line);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null;
  // Unified context displays the new number. Split context already uses that column's own number.
  const side = row.dataset.lineType === 'change-deletion' || row.closest('[data-deletions]') ? 'old' : 'new';
  return { side, lineNumber };
}

function visibleRanges(lines: Record<Side, Set<number>>): Viewport['visible'] {
  const ranges: Viewport['visible'] = [];
  for (const side of ['old', 'new'] as const) {
    const numbers = [...lines[side]].sort((a, b) => a - b);
    for (const lineNumber of numbers) {
      const last = ranges.at(-1);
      if (last?.side === side && last.endLine + 1 === lineNumber) last.endLine = lineNumber;
      else {
        if (ranges.length === MAX_VIEW_RANGES) return ranges;
        ranges.push({ side, startLine: lineNumber, endLine: lineNumber });
      }
    }
  }
  return ranges;
}

/** Pierre mounts a buffer around the viewport; only intersecting rows below the sticky header count. */
export function readViewport(root: ShadowRoot, top: number, bottom: number, hunks: readonly Hunk[]): Viewport | null {
  let first: Viewport['first'] | null = null;
  let firstTop = Infinity;
  const lines = { old: new Set<number>(), new: new Set<number>() };
  for (const row of root.querySelectorAll<HTMLElement>(CODE_ROWS)) {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top || rect.top >= bottom || !row.checkVisibility({ visibilityProperty: true })) continue;
    const line = codeLine(row);
    if (!line) continue;
    const { side, lineNumber } = line;
    lines[side].add(lineNumber);
    if (side === 'new' && row.dataset.lineType?.startsWith('context') && !row.closest('[data-additions]')) {
      const oldLine = Number(row.dataset.altLine);
      if (oldLine > 0) lines.old.add(oldLine);
    }
    const rowTop = Math.max(top, rect.top);
    // At the same vertical position in split view, prefer the new side for the primary anchor.
    if (rowTop < firstTop || (rowTop === firstTop && side === 'new' && first?.side === 'old')) {
      first = line;
      firstTop = rowTop;
    }
  }
  if (!first) return null;
  const { side, lineNumber } = first;
  const hunk = hunks.find((h) => side === 'new'
    ? lineNumber >= h.additionStart && lineNumber < h.additionStart + h.additionCount
    : lineNumber >= h.deletionStart && lineNumber < h.deletionStart + h.deletionCount);
  return {
    first,
    visible: visibleRanges(lines),
    hunk: hunk ? { oldStart: hunk.deletionStart, oldCount: hunk.deletionCount, newStart: hunk.additionStart, newCount: hunk.additionCount } : null,
  };
}

interface BoundaryPoint { node: Node; offset: number }
type FilePoint = BoundaryPoint | -1 | 1;

/** Locate the selection endpoint in this file's shadow tree, or before (-1) or after (1) its host. */
function filePoint(point: BoundaryPoint, root: ShadowRoot): FilePoint | null {
  if (point.node.getRootNode() === root) return point;

  // The header and review threads are light DOM rendered in slots. Clip at the slot's place in the code
  // instead of treating its text as the start or end of the entire file.
  let ancestor: Node | null = point.node;
  while (ancestor && ancestor !== root.host) {
    const slot: HTMLSlotElement | null = ancestor instanceof Element || ancestor instanceof Text ? ancestor.assignedSlot : null;
    if (slot?.getRootNode() === root) return { node: slot, offset: 0 };
    ancestor = slot ?? (ancestor instanceof ShadowRoot ? ancestor.host : ancestor.parentNode);
  }
  if (ancestor === root.host) return null;

  // A point in another file's shadow tree sits within that file's host in the surrounding document.
  let { node, offset } = point;
  for (let owner = node.getRootNode(); owner instanceof ShadowRoot; owner = node.getRootNode()) {
    node = owner.host;
    offset = 0;
  }
  if (node.getRootNode() !== root.host.getRootNode()) return null;
  const edge = document.createRange();
  edge.setStartBefore(root.host);
  edge.collapse(true);
  if (edge.comparePoint(node, offset) <= 0) return -1;
  edge.setStartAfter(root.host);
  edge.collapse(true);
  if (edge.comparePoint(node, offset) >= 0) return 1;
  return null;
}

function clipToFile(start: BoundaryPoint, end: BoundaryPoint, root: ShadowRoot): Range | null {
  if (!root.host.isConnected) return null;
  let a = filePoint(start, root);
  let b = filePoint(end, root);
  if (a === null || b === null || a === b) return null;
  if (a === 1 || b === -1) [a, b] = [b, a];

  const range = document.createRange();
  range.selectNodeContents(root);
  if (typeof a !== 'number') range.setStart(a.node, a.offset);
  if (typeof b !== 'number') range.setEnd(b.node, b.offset);
  // Native endpoints can arrive in DOM order rather than slot/render order. Setting the end before
  // the start collapses the Range, so try the opposite order when both endpoints project into this file.
  if (range.collapsed && typeof a !== 'number' && typeof b !== 'number') {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  return range.collapsed ? null : range;
}

/** Take only characters inside code rows. File headers, gutter numbers, threads and drafts are outside them. */
export function readTextSelection(files: readonly RenderedDiff[]): TextSelection | null {
  const selection = document.getSelection();
  const ranges = selection?.getComposedRanges?.({ shadowRoots: files.map((f) => f.root) });
  if (!ranges?.length) return null;
  const inCode = (node: Node) => files.some((f) => f.root === node.getRootNode())
    && !!(node instanceof Element ? node : node.parentElement)?.closest(CODE_ROWS);

  const picked: TextSelection['ranges'] = [];
  let remaining = MAX_VIEW_SELECTION_CHARS;
  let truncated = false;
  for (const selected of ranges) {
    if (selected.collapsed || (!inCode(selected.startContainer) && !inCode(selected.endContainer))) continue;
    const start = { node: selected.startContainer, offset: selected.startOffset };
    const end = { node: selected.endContainer, offset: selected.endOffset };
    for (const { path, root } of files) {
      const range = clipToFile(start, end, root);
      if (!range) continue;
      for (const row of root.querySelectorAll<HTMLElement>(CODE_ROWS)) {
        if (!range.intersectsNode(row) || !row.checkVisibility({ visibilityProperty: true })) continue;
        const line = codeLine(row);
        if (!line) continue;

        // A native selection can begin or end partway through a Shiki token span inside this row.
        const part = document.createRange();
        part.selectNodeContents(row);
        if (row.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
        if (row.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
        const text = part.toString();
        if (!text) continue;
        const { side, lineNumber } = line;
        const last = picked.at(-1);
        const extend = last?.path === path && last.side === side && last.endLine + 1 === lineNumber;
        const join = extend && !last.text.endsWith('\n') ? '\n' : '';
        const fragment = text.slice(0, Math.max(0, remaining - join.length)).replace(/[\uD800-\uDBFF]$/, '');
        if (fragment !== text || (!extend && picked.length === MAX_VIEW_RANGES)) truncated = true;
        if (!fragment || (!extend && picked.length === MAX_VIEW_RANGES)) break;
        if (extend) {
          last.endLine = lineNumber;
          last.text += join + fragment;
        } else picked.push({ path, side, startLine: lineNumber, endLine: lineNumber, text: fragment });
        remaining -= join.length + fragment.length;
        if (truncated) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return picked.length ? { kind: 'text', ranges: picked, truncated } : null;
}
